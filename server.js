const express = require("express");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.json());

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not set");
  process.exit(1);
}
if (!WEBHOOK_SECRET || WEBHOOK_SECRET.trim().length < 8) {
  console.error("❌ WEBHOOK_SECRET missing/too short");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ===== SIMPLE STATE (TEMP, RAM) =====
const foxes = new Map(); // userId -> { invites, rating, visits }

// ===== BOT COMMANDS =====
bot.start((ctx) => {
  const userId = ctx.from.id;

  if (!foxes.has(userId)) {
    foxes.set(userId, { invites: 3, rating: 1, visits: 0 });
  }

  return ctx.reply(
    "🦊 Ласкаво просимо до FoxPot Club\n\n" +
      "Ти зареєстрований як Fox.\n" +
      "Статус: /me\n" +
      "Правила: /rules\n" +
      "Інвайти: /invite"
  );
});

bot.command("me", (ctx) => {
  const userId = ctx.from.id;
  const fox = foxes.get(userId);

  if (!fox) return ctx.reply("❌ Ти ще не Fox. Натисни /start");

  return ctx.reply(
    "🦊 Твій статус Fox\n\n" +
      `Інвайти: ${fox.invites}\n` +
      `Рейтинг: ${fox.rating}\n` +
      `Відвідування: ${fox.visits}`
  );
});

bot.command("rules", (ctx) => {
  return ctx.reply(
    "📜 FoxPot Phase 1 — коротко:\n\n" +
      "• Fox = учасник клубу\n" +
      "• Знижки мін. −10% у закладах\n" +
      "• Рейтинг = не гроші\n" +
      "• Інвайти не продаються\n" +
      "• Fox не представляє FoxPot"
  );
});

bot.command("invite", (ctx) => {
  const userId = ctx.from.id;
  const fox = foxes.get(userId);

  if (!fox) return ctx.reply("❌ Спочатку /start");

  return ctx.reply(`🎟 Твої інвайти: ${fox.invites}\n\nГенерація кодів — скоро.`);
});

// залишимо test, щоб ти швидко перевіряв
bot.hears(/test/i, (ctx) => ctx.reply("Test OK ✅"));

// ===== ROUTES =====
app.get("/", (req, res) => res.status(200).send("The FoxPot Club backend OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ДОДАЛИ: щоб браузер показував, що шлях існує (GET)
app.get(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
  res.status(200).send("OK (webhook endpoint exists)");
});

// ===== WEBHOOK =====
const webhookPath = `/telegram/${WEBHOOK_SECRET}`;

// ДОДАЛИ: лог, щоб бачити що Telegram реально прислав апдейт
app.post(webhookPath, (req, res) => {
  console.log("📩 Telegram update received");

  // ВАЖЛИВО: Telegraf webhookCallback сам віддає відповідь Telegram'у
  // але ми також страхуємось try/catch, щоб не було 404
  try {
    return bot.webhookCallback(webhookPath)(req, res);
  } catch (e) {
    console.error("❌ Webhook handler error:", e);
    return res.sendStatus(200); // Telegramу головне 200
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`✅ Webhook path: ${webhookPath}`);
});
