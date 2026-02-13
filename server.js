const express = require("express");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

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

const bot = new Telegraf(BOT_TOKEN);

// ===== ADMIN COMMAND =====
bot.command("admin", async (ctx) => {
  const userId = String(ctx.from.id);

  if (userId === ADMIN_USER_ID) {
    return ctx.reply("👑 Ти АДМІН (owner mode).");
  } else {
    return ctx.reply("⛔ Ти не адмін.");
  }
});

// ===== USER ID CHECK =====
bot.command("id", (ctx) => {
  return ctx.reply(`Твій Telegram ID: ${ctx.from.id}`);
});

// ===== VISIT COMMAND =====
bot.command("visit", async (ctx) => {
  const userId = ctx.from.id;

  try {
    await createFoxIfMissing(userId);

    await pool.query(
      "UPDATE foxes SET visits = visits + 1, rating = rating + 1 WHERE user_id = $1",
      [userId]
    );

    const fox = await getFox(userId);

    let message =
      "🦊 Візит зараховано!\n\n" +
      `Відвідування: ${fox.visits}\n` +
      `Рейтинг: ${fox.rating}\n\n`;

    const progress = fox.visits % 5;
    const remaining = 5 - progress;

    if (progress === 0) {
      await pool.query(
        "UPDATE foxes SET invites = invites + 1 WHERE user_id = $1",
        [userId]
      );
      message += "🎟 +1 інвайт за 5 візитів!";
    } else {
      message += `📈 До наступного інвайта: ще ${remaining} візит(и).`;
    }

    return ctx.reply(message);
  } catch (e) {
    console.error("❌ /visit error:", e);
    return ctx.reply("❌ Помилка сервера.");
  }
});

// ===== BASIC COMMANDS =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  try {
    await createFoxIfMissing(userId);

    return ctx.reply(
      "🦊 Ласкаво просимо до FoxPot Club\n\n" +
        "Статус: /me\n" +
        "Візит: /visit\n" +
        "Інвайти: /invite"
    );
  } catch (e) {
    console.error("❌ /start error:", e);
    return ctx.reply("❌ Помилка сервера.");
  }
});

bot.command("me", async (ctx) => {
  const fox = await getFox(ctx.from.id);
  if (!fox) return ctx.reply("❌ Натисни /start");

  return ctx.reply(
    "🦊 Твій статус\n\n" +
      `Інвайти: ${fox.invites}\n` +
      `Рейтинг: ${fox.rating}\n` +
      `Візити: ${fox.visits}`
  );
});

bot.command("invite", async (ctx) => {
  const fox = await getFox(ctx.from.id);
  if (!fox) return ctx.reply("❌ Натисни /start");

  return ctx.reply(`🎟 Твої інвайти: ${fox.invites}`);
});

// ===== ROUTES =====
app.get("/", (req, res) => res.status(200).send("The FoxPot Club backend OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));
app.get("/db", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows[0] });
  } catch {
    res.status(500).json({ ok: false });
  }
});

const webhookPath = `/telegram/${WEBHOOK_SECRET}`;

app.post(webhookPath, (req, res) => {
  return bot.webhookCallback(webhookPath)(req, res);
});

const PORT = process.env.PORT || 3000;

(async () => {
  await initDb();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Server running on ${PORT}`);
  });
})();
