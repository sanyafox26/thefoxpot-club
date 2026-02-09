const express = require("express");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not set");
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("The FoxPot Club backend OK");
});

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply("The FoxPot Club bot OK ✅");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  bot.launch().then(() => console.log("Telegram bot launched"));
});
