const express = require("express");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.json()); // важливо для webhook

// --- ENV (з Railway Variables) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not set");
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error("❌ WEBHOOK_SECRET not set");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("❌ PUBLIC_URL not set");
  process.exit(1);
}

// --- Telegram bot ---
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply("The FoxPot Club bot OK ✅"));
bot.hears(/test/i, (ctx) => ctx.reply("Test OK ✅"));

// --- Basic routes ---
app.get("/", (req, res) => {
  res.status(200).send("The FoxPot Club backend OK");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// --- Webhook route (секретний шлях) ---
const webhookPath = `/telegram/${WEBHOOK_SECRET}`;
app.use(webhookPath, bot.webhookCallback(webhookPath));

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Server listening on ${PORT}`);

  try {
    await bot.telegram.setWebhook(`${PUBLIC_URL}${webhookPath}`);
    console.log("✅ Webhook set:", `${PUBLIC_URL}${webhookPath}`);
  } catch (e) {
    console.error("❌ Failed to set webhook:", e);
  }
});
