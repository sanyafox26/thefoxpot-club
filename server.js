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
  // 1) базова таблиця (як була)
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

  // 2) БЕЗПЕЧНА "міграція" — додаємо колонки, якщо їх ще нема
  await pool.query(`ALTER TABLE foxes ADD COLUMN IF NOT EXISTS personal_visits INT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE foxes ADD COLUMN IF NOT EXISTS counted_visits INT NOT NULL DEFAULT 0;`);
  // Зберігаємо дату останнього counted по Warsaw-даті (YYYY-MM-DD)
  await pool.query(`ALTER TABLE foxes ADD COLUMN IF NOT EXISTS last_counted_date DATE;`);

  console.log("✅ DB: table foxes ready + columns ready");
}

async function getFox(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, invites, rating, visits, personal_visits, counted_visits, last_counted_date
     FROM foxes WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function createFoxIfMissing(userId) {
  // Створює Fox якщо його нема (invites=3, rating=1, visits=0)
  await pool.query(
    `
    INSERT INTO foxes (user_id, invites, rating, visits, personal_visits, counted_visits, last_counted_date)
    VALUES ($1, 3, 1, 0, 0, 0, NULL)
    ON CONFLICT (user_id) DO NOTHING
  `,
    [userId]
  );
  return getFox(userId);
}

// Повертає сьогоднішню дату по Europe/Warsaw як DATE (через Postgres)
async function getWarsawTodayDate() {
  const r = await pool.query(`SELECT (NOW() AT TIME ZONE 'Europe/Warsaw')::date AS d;`);
  return r.rows[0].d; // тип DATE
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
        "Візит: /visit\n" +
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

    const today = await getWarsawTodayDate();
    const countedToday = fox.last_counted_date && String(fox.last_counted_date) === String(today);

    return ctx.reply(
      "🦊 Твій статус Fox\n\n" +
        `🎟 Інвайти: ${fox.invites}\n` +
        `⭐ Рейтинг: ${fox.rating}\n` +
        `👣 X (особисті візити): ${fox.personal_visits || 0}\n` +
        `✅ Counted (зараховані): ${fox.counted_visits || 0}\n` +
        `📅 Counted сьогодні: ${countedToday ? "ТАК ✅" : "НІ ❌"}`
    );
  } catch (e) {
    console.error("❌ /me error:", e);
    return ctx.reply("❌ Помилка сервера. Спробуй ще раз через 10 секунд.");
  }
});

// НОВЕ: /visit — Visits Engine v0
bot.command("visit", async (ctx) => {
  const userId = ctx.from.id;

  try {
    // 1) якщо не зареєстрований — просимо /start
    const fox = await getFox(userId);
    if (!fox) return ctx.reply("❌ Спочатку натисни /start");

    // 2) ЗАВЖДИ додаємо X (personal visit)
    await pool.query(
      `UPDATE foxes
       SET personal_visits = personal_visits + 1,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    // 3) Перевіряємо, чи можна counted сьогодні
    const today = await getWarsawTodayDate();
    const countedToday = fox.last_counted_date && String(fox.last_counted_date) === String(today);

    if (countedToday) {
      const updated = await getFox(userId);
      return ctx.reply(
        "👣 Візит записано!\n\n" +
          "✅ X (особисті візити) +1\n" +
          "⛔ Counted сьогодні вже був (1 раз/доба)\n\n" +
          `Тепер X: ${updated.personal_visits}\n` +
          `Counted: ${updated.counted_visits}\n` +
          `Рейтинг: ${updated.rating}\n` +
          `Інвайти: ${updated.invites}`
      );
    }

    // 4) Якщо counted ще не було — додаємо counted + rating + last_counted_date
    // Спочатку збільшуємо counted, rating, ставимо дату
    await pool.query(
      `UPDATE foxes
       SET counted_visits = counted_visits + 1,
           rating = rating + 1,
           last_counted_date = $2,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, today]
    );

    // 5) Після цього читаємо оновленого Fox і даємо invites за кожні 5 counted
    const updated = await getFox(userId);

    let inviteAdded = false;
    if ((updated.counted_visits || 0) > 0 && (updated.counted_visits % 5 === 0)) {
      await pool.query(
        `UPDATE foxes
         SET invites = invites + 1,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      inviteAdded = true;
    }

    const updated2 = await getFox(userId);

    return ctx.reply(
      "✅ Візит зараховано!\n\n" +
        "👣 X (особисті візити) +1\n" +
        "✅ Counted (1/доба) +1\n" +
        "⭐ Рейтинг +1\n" +
        (inviteAdded ? "🎟 Бонус: +1 інвайт (кожні 5 counted)\n" : "") +
        "\n" +
        `Тепер X: ${updated2.personal_visits}\n` +
        `Counted: ${updated2.counted_visits}\n` +
        `Рейтинг: ${updated2.rating}\n` +
        `Інвайти: ${updated2.invites}`
    );
  } catch (e) {
    console.error("❌ /visit error:", e);
    return ctx.reply("❌ Помилка сервера. Спробуй ще раз через 10 секунд.");
  }
});

bot.command("rules", (ctx) => {
  return ctx.reply(
    "📜 FoxPot Phase 1 — коротко:\n\n" +
      "• Fox = учасник клубу\n" +
      "• Знижки мін. −10% у закладах\n" +
      "• Рейтинг = не гроші\n" +
      "• Інвайти не продаються\n" +
      "• Візити: X (без ліміту), Counted (1 раз/доба)\n" +
      "• Fox не представляє FoxPot"
  );
});

bot.command("invite", async (ctx) => {
  const userId = ctx.from.id;

  try {
    const fox = await getFox(userId);
    if (!fox) return ctx.reply("❌ Спочатку /start");

    return ctx.reply(`🎟 Твої інвайти: ${fox.invites}\n\nГенерація кодів — скоро.`);
  } catch (e) {
    console.error("❌ /invite error:", e);
    return ctx.reply("❌ Помилка сервера. Спробуй ще раз через 10 секунд.");
  }
});

// швидкий тест
bot.hears(/test/i, (ctx) => ctx.reply("Test OK ✅"));

// ===== ROUTES =====
app.get("/", (req, res) => res.status(200).send("The FoxPot Club backend OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Щоб браузер показував, що шлях існує (GET)
app.get(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
  res.status(200).send("OK (webhook endpoint exists)");
});

// ДОДАТКОВО: тест БД в браузері
app.get("/db", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows[0] });
  } catch (e) {
    console.error("❌ /db error:", e);
    res.status(500).json({ ok: false, error: "db_failed" });
  }
});

// ===== WEBHOOK =====
const webhookPath = `/telegram/${WEBHOOK_SECRET}`;

app.post(webhookPath, (req, res) => {
  console.log("📩 Telegram update received");
  try {
    return bot.webhookCallback(webhookPath)(req, res);
  } catch (e) {
    console.error("❌ Webhook handler error:", e);
    return res.sendStatus(200);
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDb();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server listening on ${PORT}`);
      console.log(`✅ Webhook path: ${webhookPath}`);
    });
  } catch (e) {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  }
})();
