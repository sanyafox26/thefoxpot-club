const express = require("express");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not set");
  process.exit(1);
}
if (!WEBHOOK_SECRET || WEBHOOK_SECRET.trim().length < 8) {
  console.error("❌ WEBHOOK_SECRET missing/too short");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set");
  process.exit(1);
}

// ===== POSTGRES =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Railway Postgres зазвичай потребує SSL
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS foxes (
      user_id BIGINT PRIMARY KEY,
      invites INT NOT NULL DEFAULT 3,
      rating INT NOT NULL DEFAULT 1,
      visits INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ DB: table foxes ready");
}

async function getFox(userId) {
  const { rows } = await pool.query(
    "SELECT user_id, invites, rating, visits FROM foxes WHERE user_id = $1",
    [userId]
  );
  return rows[0] || null;
}

async function createFoxIfMissing(userId) {
  // Створює Fox якщо його нема (invites=3, rating=1, visits=0)
  await pool.query(
    `
    INSERT INTO foxes (user_id, invites, rating, visits)
    VALUES ($1, 3, 1, 0)
    ON CONFLICT (user_id) DO NOTHING
  `,
    [userId]
  );
  return getFox(userId);
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// ===== BOT COMMANDS =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  try {
    await createFoxIfMissing(userId);

    return ctx.reply(
      "🦊 Ласкаво просимо до FoxPot Club\n\n" +
        "Ти зареєстрований як Fox.\n" +
        "Статус: /me\n" +
        "Правила: /rules\n" +
        "Інвайти: /invite"
    );
  } catch (e) {
    console.error("❌ /start error:", e);
    return ctx.reply("❌ Помилка сервера. Спробуй ще раз через 10 секунд.");
  }
});

bot.command("me", async (ctx) => {
  const userId = ctx.from.id;

  try {
    const fox = await getFox(userId);

    if (!fox) return ctx.reply("❌ Ти ще не Fox. Натисни /start");

    return ctx.reply(
      "🦊 Твій статус Fox\n\n" +
