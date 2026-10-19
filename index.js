
import "dotenv/config";
import { Bot } from "grammy";

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;

if (!telegramToken || !groqApiKey) {
  console.error("Configure TELEGRAM_BOT_TOKEN e GROQ_API_KEY nos Secrets.");
  process.exit(1);
}

const bot = new Bot(telegramToken);
const conversationHistory = new Map();
const inFlightChats = new Set();

const maxHistoryMessages = 12;
const conversationTimeoutMs = 30 * 60 * 1000;
const minTimeBetweenCallsMs = 2000;

let nextRequestAt = 0;
let queue = Promise.resolve();

const systemInstruction =
  "Você é a Suzie, uma pessoa simpática, curiosa, " +
  "brincalhona, carinhosa e um pouco atrevida nas brincadeiras, sem exagerar. " +
  "Converse em português brasileiro de forma natural e descontraída. " +
  "Prefira respostas curtas em assuntos casuais e não termine todas " +
  "as mensagens com perguntas. Use gírias, risadas e emojis quando " +
  "Seja interativa e um pouco sexy até o limite permitido" +
  "Você só envia texto pelo Telegram; não diga que enviou imagens.";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHttpStatus(error) {
  return error?.status ? Number(error.status) : undefined;
}

async function callGroq(messages) {
  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: systemInstruction },
          ...messages,
        ],
        max_completion_tokens: 800,
      }),
    },
  );

  if (!response.ok) {
    const error = new Error(`Groq HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

function requestGroq(messages) {
  const request = queue.then(async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait > 0) await delay(wait);

    nextRequestAt = Date.now() + minTimeBetweenCallsMs;
    return callGroq(messages);
  });

  queue = request.then(
    () => undefined,
    () => undefined,
  );

  return request;
}

function splitMessage(text, maxLength = 4000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

bot.command("start", async (ctx) => {
  const name = ctx.from?.first_name;
  await ctx.reply(
    `Oii${name ? `, ${name}` : ""}! Sou a Suzie. ❤️ ` +
    "Pode conversar comigo! Use /help para ver os comandos.",
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Comandos:\n/start — iniciar\n/help — ajuda\n/reset — limpar o contexto\n\n" +
    "O histórico fica temporariamente na memória do bot e pode ser perdido quando ele reinicia.",
  );
});

bot.command("reset", async (ctx) => {
  conversationHistory.delete(ctx.chat.id);
  await ctx.reply("Prontinho! Vamos começar uma conversa nova. ❤️");
});

bot.on("message:text", async (ctx) => {
  const userMessage = ctx.message.text.trim();
  if (!userMessage) return;

  const chatId = ctx.chat.id;

  if (inFlightChats.has(chatId)) {
    await ctx.reply("Calmaaa, ainda estou respondendo a mensagem anterior. Ksksk");
    return;
  }

  inFlightChats.add(chatId);

  try {
    let saved = conversationHistory.get(chatId);

    if (
      saved &&
      Date.now() - saved.lastActivityAt > conversationTimeoutMs
    ) {
      conversationHistory.delete(chatId);
      saved = undefined;
      await ctx.reply("Ficamos um tempinho sem conversar e reiniciei o contexto. ❤️");
    }

    const previousMessages = saved?.messages ?? [];
    const messages = [
      ...previousMessages,
      { role: "user", content: userMessage },
    ];

    await ctx.replyWithChatAction("typing");

    const answer = await requestGroq(messages);

    if (!answer) {
      await ctx.reply("Não consegui preparar uma resposta dessa vez. Tente novamente.");
      return;
    }

    conversationHistory.set(chatId, {
      messages: [
        ...messages,
        { role: "assistant", content: answer },
      ].slice(-maxHistoryMessages),
      lastActivityAt: Date.now(),
    });

    for (const chunk of splitMessage(answer)) {
      await ctx.reply(chunk);
    }
  } catch (error) {
    const status = getHttpStatus(error);
    console.error("Falha na chamada ao Groq:", status ?? error?.name ?? "erro");

    if (status === 429) {
      await ctx.reply("Atingi um limite temporário do Groq. Vamos tentar novamente mais tarde. ❤️");
    } else if (status === 401 || status === 403) {
      await ctx.reply("Não consegui acessar o Groq. Confira a chave GROQ_API_KEY nos Secrets.");
    } else if (status === 400 || status === 404) {
      await ctx.reply("O Groq recusou a solicitação. Pode haver um problema com o modelo ou os parâmetros.");
    } else {
      await ctx.reply("Estou com uma falha de conexão agora. Tente novamente em instantes.");
    }
  } finally {
    inFlightChats.delete(chatId);
  }
});

bot.catch((error) => {
  console.error("Erro no Telegram:", error.error?.name ?? "erro desconhecido");
});

bot.start({
  onStart: (info) => {
    console.log(`Suzie @${info.username} está conectada ao Telegram usando Groq.`);
  },
});
