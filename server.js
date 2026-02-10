const express = require("express");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not set");
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error("❌ WEBHOOK_SECRET not set");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply("The FoxPot Club bot OK ✅"));
bot.hears(/test/i, (ctx) => ctx.reply("Test OK ✅"));

app.get("/", (req, res) => res.status(200).send("The FoxPot Club backend OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const webhookPath = `/telegram/${WEBHOOK_SECRET}`;
app.use(bot.webhookCallback(webhookPath));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`✅ Webhook path ready: ${webhookPath}`);
});
