const { App, LogLevel, Assistant } = require('@slack/bolt');
const { config } = require('dotenv');
const { OpenAI } = require('openai');

config();

/** Initialization */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

/** OpenAI Setup */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_SYSTEM_CONTENT = `You're an assistant in a Slack workspace.
Users in the workspace will ask you to help them write something or to think better about a specific topic.
You'll respond to those questions in a professional way.
When you include markdown text, convert them to Slack compatible ones.
When a prompt has Slack's special syntax like <@USER_ID> or <#CHANNEL_ID>, you must keep them as-is in your response.`;

const assistant = new Assistant({
  /**
   * (Recommended) A custom ThreadContextStore can be provided, inclusive of methods to
   * get and save thread context. When provided, these methods will override the `getThreadContext`
   * and `saveThreadContext` utilities that are made available in other Assistant event listeners.
   */
  // threadContextStore: {
  //   get: async ({ context, client, payload }) => {},
  //   save: async ({ context, client, payload }) => {},
  // },

  /**
   * `assistant_thread_started` is sent when a user opens the Assistant container.
   * This can happen via DM with the app or as a side-container within a channel.
   * https://api.slack.com/events/assistant_thread_started
   */
  threadStarted: async ({ event, logger, say, setSuggestedPrompts, saveThreadContext }) => {
    const { context } = event.assistant_thread;

    try {
      // Since context is not sent along with individual user messages, it's necessary to keep
      // track of the context of the conversation to better assist the user. Sending an initial
      // message to the user with context metadata facilitates this, and allows us to update it
      // whenever the user changes context (via the `assistant_thread_context_changed` event).
      // The `say` utility sends this metadata along automatically behind the scenes.
      // !! Please note: this is only intended for development and demonstrative purposes.
      await say('Hi, how can I help?');

      await saveThreadContext();

      const prompts = [
        {
          title: 'This is a suggested prompt',
          message:
            'When a user clicks a prompt, the resulting prompt message text can be passed ' +
            'directly to your LLM for processing.\n\nAssistant, please create some helpful prompts ' +
            'I can provide to my users.',
        },
      ];

      // If the user opens the Assistant container in a channel, additional
      // context is available.This can be used to provide conditional prompts
      // that only make sense to appear in that context (like summarizing a channel).
      if (context.channel_id) {
        prompts.push({
          title: 'Summarize channel',
          message: 'Assistant, please summarize the activity in this channel!',
        });
      }

      // 曖昧検索のサジェストプロンプト
      prompts.push({
        title: 'Fuzzy search',
        message: 'Assistant, please perform a fuzzy search for the following term!',
      });

      /**
       * Provide the user up to 4 optional, preset prompts to choose from.
       * The optional `title` prop serves as a label above the prompts. If
       * not, provided, 'Try these prompts:' will be displayed.
       * https://api.slack.com/methods/assistant.threads.setSuggestedPrompts
       */
      await setSuggestedPrompts({ prompts, title: 'Here are some suggested options:' });
    } catch (e) {
      logger.error(e);
    }
  },

  /**
   * `assistant_thread_context_changed` is sent when a user switches channels
   * while the Assistant container is open. If `threadContextChanged` is not
   * provided, context will be saved using the AssistantContextStore's `save`
   * method (either the DefaultAssistantContextStore or custom, if provided).
   * https://api.slack.com/events/assistant_thread_context_changed
   */
  threadContextChanged: async ({ logger, saveThreadContext }) => {
    // const { channel_id, thread_ts, context: assistantContext } = event.assistant_thread;
    try {
      await saveThreadContext();
    } catch (e) {
      logger.error(e);
    }
  },

  /**
   * Messages sent to the Assistant do not contain a subtype and must
   * be deduced based on their shape and metadata (if provided).
   * https://api.slack.com/events/message
   */
  userMessage: async ({ client, logger, message, getThreadContext, say, setTitle, setStatus }) => {
    const { channel, thread_ts } = message;

    try {
      /**
       * Set the title of the Assistant thread to capture the initial topic/question
       * as a way to facilitate future reference by the user.
       * https://api.slack.com/methods/assistant.threads.setTitle
       */
      await setTitle(message.text);

      /**
       * Set the status of the Assistant to give the appearance of active processing.
       * https://api.slack.com/methods/assistant.threads.setStatus
       */
      await setStatus('is typing..');

      /** Scenario 1: Handle suggested prompt selection
       * The example below uses a prompt that relies on the context (channel) in which
       * the user has asked the question (in this case, to summarize that channel).
       */
      if (message.text === 'Assistant, please summarize the activity in this channel!') {
        const threadContext = await getThreadContext();
        let channelHistory;

        try {
          channelHistory = await client.conversations.history({
            channel: threadContext.channel_id,
            limit: 50,
          });
        } catch (e) {
          // If the Assistant is not in the channel it's being asked about,
          // have it join the channel and then retry the API call
          if (e.data.error === 'not_in_channel') {
            await client.conversations.join({ channel: threadContext.channel_id });
            channelHistory = await client.conversations.history({
              channel: threadContext.channel_id,
              limit: 10,
            });
          } else {
            logger.error(e);
          }
        }

        // Prepare and tag the prompt and messages for LLM processing
        let llmPrompt = `Please generate a brief summary of the following messages from Slack channel <#${threadContext.channel_id}>: 出力は必ず日本語でお願いします！`;
        for (const m of channelHistory.messages.reverse()) {
          if (m.user) llmPrompt += `\n<@${m.user}> says: ${m.text}`;
        }

        const messages = [
          { role: 'system', content: DEFAULT_SYSTEM_CONTENT },
          { role: 'user', content: llmPrompt },
        ];

        // Send channel history and prepared request to LLM
        const llmResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          n: 1,
          messages,
        });

        // Provide a response to the user
        await say({ text: llmResponse.choices[0].message.content });

        return;
      }

      // 曖昧検索が選択された場合
      if (message.text.startsWith('Fuzzy search')) {
        const parts = message.text.split(':');
        if (parts.length < 2) {
          await say("検索ワードを指定してください。例: Fuzzy search: 進捗報告");
          return;
        }
        const query = parts[1].trim();
        const prompt = `
          ユーザーはSlackで「${query}」に関する過去のメッセージを探している。
          この検索を助けるために、以下のような検索ワードのバリエーションを生成し、Slackのsearch.messagesメソッドで適切に活用できる形式で出力せよ。

          - 「${query}」は単語かもしれませんし、文章（質問文）かもしれません。その意図を読み取り、適切な単語の同義語、略語、英語表記を考慮し、関連する検索ワードを生成する。
          - Slackの検索演算子を適切に適用し、キーワードと組み合わせた検索クエリを作成する。
          - 以下の検索演算子を考慮する：
      
            - OR を使うと、いずれかの単語を含むメッセージを検索できる。
          - 検索演算子は不必要に使う必要はない。ユーザーの要求に合わせて適切に判断せよ
          - 出力は「キーワードと検索演算子のみ」とし、説明文や番号を含めない。
          - キーワードをスペース区切りで出力したものをクエリとし、各クエリをカンマ区切りで出力してください
          - 検索ワードと検索演算子を組み合わせた具体的なクエリを10個以内で列挙せよ。
          - ユーザーの要求に沿った結果が効率よく出るように、OR検索を使って適切に探せるようにしてください。OR検索を多用しすぎると、ユーザーの要求とは違う結果を拾ってしまうので、そこを考慮してください
          - クエリの作成後、「${query}」について探せるクエリになっているかどうか、再評価して、最終的な出力をしてください

          ### **期待する出力例**
          videojs-overlay フルスクリーン from:@ItoMadoka  
          videojs-overlay fullscreen in:#onboarding-itomado  
          videojs-overlay フルスクリーン 検証 after:2024-01-01  
          videojs-overlay fullscreen has:link
          
        `;

        const llmResponseKeywords = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          n: 1,
          messages: [
            { role: 'system', content: DEFAULT_SYSTEM_CONTENT },
            { role: 'user', content: prompt }
          ]
        });
        const keywords = llmResponseKeywords.choices[0].message.content
          .split(/[\n,]+/)
          .map(k => k.trim())
          .filter(k => k);
        let allResults = [];
        console.log("キーワード: ", keywords);
        await say({ text: "キーワード" + keywords });
        for (const keyword of keywords) {
          try {
            const userToken = process.env.SLACK_USER_TOKEN;
            const searchResponse = await client.search.messages({ query: keyword, count: 20, token: userToken, search_exclude_bots: true });
            if (searchResponse.messages && searchResponse.messages.matches) {
              allResults = allResults.concat(searchResponse.messages.matches);
              console.log("検索クエリ：", keyword);
              // 成功した場合のログ出力を追加
              logger.info(`検索成功: ${searchResponse.messages.matches.length} 件のメッセージが見つかりました。`);
            } else {
              // 検索結果が0件の場合のログ出力
              logger.info('検索成功: 0 件のメッセージが見つかりました。');
            }
          } catch (error) {
            logger.error(error);
          }
        }
        if (allResults.length > 0) {
          const evaluationPrompt = `
            以下のメッセージリストから、クエリ「${query}」に最も関連する内容を選択し、それらのインデックスを関連性の高い順に列挙してください。重複する内容や関連性の低いメッセージは除外してください。出力はインデックスのみにしてください。Fuzzy search:という単語が含まれるものを除外してください
            再度言いますが、内容が重複するものを除外してください。
            クエリ: 「${query}」

            メッセージリスト:
            ${allResults.map((msg, index) => `${index + 1}: ${msg.text}`).join('\n')}

            期待する出力形式:
            1, 3, 5, ...
          `;

          const llmResponseEvaluation = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            n: 1,
            messages: [
              { role: 'system', content: DEFAULT_SYSTEM_CONTENT },
              { role: 'user', content: evaluationPrompt }
            ]
          });
          console.log("評価の回答: ", llmResponseEvaluation.choices[0].message.content);

          // LLMによる評価結果を基に並び替えたメッセージリストを取得
          const evaluatedIndexes = llmResponseEvaluation.choices[0].message.content
            .split(',')
            .map(index => parseInt(index.trim()) - 1) // インデックスを整数に変換し、1を引く
            .filter(index => !isNaN(index) && index >= 0 && index < allResults.length);

          // 評価結果に基づいて検索結果をフィルタリングし、並び替え、重複を排除
          const uniqueResults = {};
          evaluatedIndexes.forEach(index => {
            const msg = allResults[index];
            if (msg && !uniqueResults.hasOwnProperty(msg.permalink)) {
              uniqueResults[msg.permalink] = msg;
            }
          });
          const results = Object.values(uniqueResults).slice(0, 15);

          if (results.length === 0) {
            await say("該当するメッセージが見つかりませんでした。");
            return;
          }

          // メッセージのリンクを表示
          const responseText = results.map((msg, idx) =>
            `${idx + 1}. ${msg.text.substring(0, 30)}… → <${msg.permalink}|リンク>`
          ).join('\n');
          await say({ text: responseText });
          return;
        }
      }

      /**
       * Scenario 2: Format and pass user messages directly to the LLM
       */

      // Retrieve the Assistant thread history for context of question being asked
      const thread = await client.conversations.replies({
        channel,
        ts: thread_ts,
        oldest: thread_ts,
      });

      // Prepare and tag each message for LLM processing
      const userMessage = { role: 'user', content: message.text };
      const threadHistory = thread.messages.map((m) => {
        const role = m.bot_id ? 'assistant' : 'user';
        return { role, content: m.text };
      });

      const messages = [{ role: 'system', content: DEFAULT_SYSTEM_CONTENT }, ...threadHistory, userMessage];

      // Send message history and newest question to LLM
      const llmResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        n: 1,
        messages,
      });

      // Provide a response to the user
      await say({ text: llmResponse.choices[0].message.content });
    } catch (e) {
      logger.error(e);

      // Send message to advise user and clear processing status if a failure occurs
      await say({ text: 'Sorry, something went wrong!' });
    }
  },
});

app.assistant(assistant);

/** Start the Bolt App */
(async () => {
  try {
    await app.start();
    app.logger.info('⚡️ Bolt app is running!');
  } catch (error) {
    app.logger.error('Failed to start the app', error);
  }
})();
