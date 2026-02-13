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
if (!ADMIN_USER_ID) {
  console.error("❌ ADMIN_USER_ID not set (add it in Railway Variables)");
  // не виходимо, але адмін-функції не працюватимуть
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
  console.log("✅ DB ready");
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

// ===== OWNER RULES =====
const OWNER_INVITES = 999999999; // дуже велике число автоматично
const OWNER_RATING_GAP = 1000; // адмін завжди +1000 над будь-ким

function isAdmin(ctx) {
  return String(ctx.from.id) === String(ADMIN_USER_ID);
}

async function getMaxRating() {
  const r = await pool.query("SELECT COALESCE(MAX(rating), 0) AS max FROM foxes");
  return Number(r.rows[0].max || 0);
}

// Головна гарантія: адмін завжди топ+1000 + багато інвайтів, і ніколи не 0
async function ownerEnsure(userId) {
  if (String(userId) !== String(ADMIN_USER_ID)) return;

  await createFoxIfMissing(userId);

  const maxRating = await getMaxRating();
  const wantedRating = maxRating + OWNER_RATING_GAP;

  await pool.query(
    `
    UPDATE foxes
    SET
      invites = $2,
      rating  = CASE
                  WHEN rating <= 0 THEN 1
                  WHEN rating < $3 THEN $3
                  ELSE rating
                END,
      updated_at = NOW()
    WHERE user_id = $1
  `,
    [userId, OWNER_INVITES, wantedRating]
  );

  // Якщо раптом maxRating = це сам адмін, wantedRating стане rating+1000,
  // це нормально: адмін завжди буде вище.
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// ===== ADMIN COMMANDS =====
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Ти не адмін.");
  await ownerEnsure(ctx.from.id);
  return ctx.reply("👑 Ти АДМІН (owner mode).");
});

// Разова команда (не обовʼязкова, але корисна)
bot.command("admin_open", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Доступ тільки для адміна.");
  const userId = ctx.from.id;

  await ownerEnsure(userId);
  const fox = await getFox(userId);

  const maxRating = await getMaxRating();
  const wantedRating = maxRating + OWNER_RATING_GAP;

  return ctx.reply(
    "✅ Owner Mode оновлено.\n\n" +
      `🎟 Інвайти: ${fox.invites}\n` +
      `⭐ Рейтинг: ${fox.rating}\n` +
      `📌 Правило: OWNER = MAX(${maxRating}) + ${OWNER_RATING_GAP} = ${wantedRating}`
  );
});

// Ручні команди лишаємо (на випадок тестів)
bot.command("admin_invites", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Доступ тільки для адміна.");

  const parts = ctx.message.text.trim().split(/\s+/);
  const n = Number(parts[1]);

  if (!Number.isInteger(n) || n < 0 || n > 1000000000) {
    return ctx.reply("❌ Напиши так: /admin_invites 999");
  }

  const userId = ctx.from.id;
  await createFoxIfMissing(userId);
  await pool.query("UPDATE foxes SET invites = $2 WHERE user_id = $1", [userId, n]);

  return ctx.reply(`✅ Інвайти встановлено: ${n}`);
});

bot.command("admin_rating", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Доступ тільки для адміна.");

  const parts = ctx.message.text.trim().split(/\s+/);
  const n = Number(parts[1]);

  if (!Number.isInteger(n) || n < 1 || n > 2000000000) {
    return ctx.reply("❌ Напиши так: /admin_rating 999");
  }

  const userId = ctx.from.id;
  await createFoxIfMissing(userId);
  await pool.query("UPDATE foxes SET rating = $2 WHERE user_id = $1", [userId, n]);

  return ctx.reply(`✅ Рейтинг встановлено: ${n}`);
});

bot.command("admin_unban", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Доступ тільки для адміна.");

  const userId = ctx.from.id;
  await createFoxIfMissing(userId);
  await pool.query("UPDATE foxes SET rating = 1 WHERE user_id = $1", [userId]);

  await ownerEnsure(userId);
  return ctx.reply("✅ Готово. Owner відновлено.");
});

// ===== BASIC COMMANDS =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await createFoxIfMissing(userId);
  await ownerEnsure(userId);

  return ctx.reply(
    "🦊 Ласкаво просимо до FoxPot Club\n\n" +
      "Статус: /me\n" +
      "Візит: /visit\n" +
      "Інвайти: /invite"
  );
});

bot.command("me", async (ctx) => {
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const fox = await getFox(userId);
  if (!fox) return ctx.reply("❌ Натисни /start");

  if (isAdmin(ctx)) {
    const maxRating = await getMaxRating();
    return ctx.reply(
      "👑 OWNER STATUS\n\n" +
        `🎟 Інвайти: ${fox.invites}\n` +
        `⭐ Рейтинг: ${fox.rating}\n` +
        `👣 Візити: ${fox.visits}\n\n` +
        `📌 Правило: OWNER = MAX(${maxRating}) + ${OWNER_RATING_GAP}`
    );
  }

  return ctx.reply(
    "🦊 Твій статус\n\n" +
      `🎟 Інвайти: ${fox.invites}\n` +
      `⭐ Рейтинг: ${fox.rating}\n` +
      `👣 Візити: ${fox.visits}`
  );
});

bot.command("visit", async (ctx) => {
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  await createFoxIfMissing(userId);

  await pool.query(
    "UPDATE foxes SET visits = visits + 1, rating = rating + 1 WHERE user_id = $1",
    [userId]
  );

  // після змін ще раз гарантуємо owner-правило
  await ownerEnsure(userId);

  const fox = await getFox(userId);

  let message =
    "🦊 Візит зараховано!\n\n" +
    `Візити: ${fox.visits}\n` +
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
});

bot.command("invite", async (ctx) => {
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const fox = await getFox(userId);
  if (!fox) return ctx.reply("❌ Натисни /start");

  return ctx.reply(`🎟 Твої інвайти: ${fox.invites}`);
});

bot.command("id", (ctx) => {
  return ctx.reply(`Твій Telegram ID: ${ctx.from.id}`);
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

// ===== WEBHOOK =====
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
