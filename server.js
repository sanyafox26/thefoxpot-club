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
}

// ===== POSTGRES =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  // базова таблиця
  await pool.query(`
    CREATE TABLE IF NOT EXISTS foxes (
      user_id BIGINT PRIMARY KEY,
      invites INT NOT NULL DEFAULT 3,
      rating INT NOT NULL DEFAULT 1,
      visits INT NOT NULL DEFAULT 0,
      earned_invites INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // якщо таблиця була створена раніше без earned_invites — додаємо колонку
  await pool.query(`
    ALTER TABLE foxes
    ADD COLUMN IF NOT EXISTS earned_invites INT NOT NULL DEFAULT 0;
  `);

  console.log("✅ DB ready");
}

async function getFox(userId) {
  const { rows } = await pool.query(
    "SELECT user_id, invites, rating, visits, earned_invites FROM foxes WHERE user_id = $1",
    [userId]
  );
  return rows[0] || null;
}

async function createFoxIfMissing(userId) {
  await pool.query(
    `
    INSERT INTO foxes (user_id, invites, rating, visits, earned_invites)
    VALUES ($1, 3, 1, 0, 0)
    ON CONFLICT (user_id) DO NOTHING
  `,
    [userId]
  );
  return getFox(userId);
}

// ===== OWNER RULES =====
const OWNER_INVITES = 999999999; // дуже велике число автоматично
const OWNER_RATING_GAP = 1000;   // OWNER = MAX_інших + 1000

function isAdminId(userId) {
  return String(userId) === String(ADMIN_USER_ID);
}
function isAdmin(ctx) {
  return isAdminId(ctx.from.id);
}

// MAX рейтинг серед ВСІХ, крім адміна
async function getMaxRatingExcludingAdmin() {
  const r = await pool.query(
    "SELECT COALESCE(MAX(rating), 0) AS max FROM foxes WHERE user_id <> $1",
    [ADMIN_USER_ID]
  );
  return Number(r.rows[0].max || 0);
}

// Гарантія: OWNER завжди top(інших)+1000, інвайти великі, і не 0
async function ownerEnsure(userId) {
  if (!isAdminId(userId)) return;

  await createFoxIfMissing(userId);

  const maxOther = await getMaxRatingExcludingAdmin();
  const wantedRating = maxOther + OWNER_RATING_GAP;

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
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// ===== ADMIN COMMANDS =====
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Ти не адмін.");
  await ownerEnsure(ctx.from.id);
  return ctx.reply("👑 Ти АДМІН (owner mode).");
});

bot.command("admin_open", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Доступ тільки для адміна.");

  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const fox = await getFox(userId);
  const maxOther = await getMaxRatingExcludingAdmin();
  const wantedRating = maxOther + OWNER_RATING_GAP;

  return ctx.reply(
    "✅ Owner Mode оновлено.\n\n" +
      `🎟 Інвайти: ${fox.invites}\n` +
      `⭐ Рейтинг: ${fox.rating}\n` +
      `🏁 Earned Invites: ${fox.earned_invites}\n\n` +
      `📌 Правило: OWNER = MAX_інших(${maxOther}) + ${OWNER_RATING_GAP} = ${wantedRating}`
  );
});

// ручні (для тестів)
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

  const progress = fox.visits % 5;
  const remaining = progress === 0 ? 0 : 5 - progress;

  if (isAdmin(ctx)) {
    const maxOther = await getMaxRatingExcludingAdmin();
    return ctx.reply(
      "👑 OWNER STATUS\n\n" +
        `🎟 Інвайти: ${fox.invites}\n` +
        `⭐ Рейтинг: ${fox.rating}\n` +
        `👣 Візити: ${fox.visits}\n` +
        `🏁 Earned Invites: ${fox.earned_invites}\n\n` +
        (remaining === 0
          ? "✅ Наступний інвайт вже нарахований на 5-му візиті.\n"
          : `📈 До наступного earned invite: ще ${remaining} візит(и).\n`) +
        `📌 Правило: OWNER = MAX_інших(${maxOther}) + ${OWNER_RATING_GAP}`
    );
  }

  return ctx.reply(
    "🦊 Твій статус\n\n" +
      `🎟 Інвайти: ${fox.invites}\n` +
      `⭐ Рейтинг: ${fox.rating}\n` +
      `👣 Візити: ${fox.visits}\n\n` +
      (remaining === 0
        ? "✅ Наступний інвайт вже нарахований на 5-му візиті."
        : `📈 До наступного інвайта: ще ${remaining} візит(и).`)
  );
});

bot.command("visit", async (ctx) => {
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  await createFoxIfMissing(userId);

  // +1 visit, +1 rating
  await pool.query(
    "UPDATE foxes SET visits = visits + 1, rating = rating + 1, updated_at = NOW() WHERE user_id = $1",
    [userId]
  );

  // ще раз гарантуємо OWNER правила після апдейту
  await ownerEnsure(userId);

  const fox = await getFox(userId);

  const progress = fox.visits % 5;
  const remaining = 5 - progress;

  let message =
    "🦊 Візит зараховано!\n\n" +
    `Візити: ${fox.visits}\n` +
    `Рейтинг: ${fox.rating}\n\n`;

  if (progress === 0) {
    // 5-й, 10-й, 15-й...
    if (isAdmin(ctx)) {
      await pool.query(
        "UPDATE foxes SET earned_invites = earned_invites + 1, updated_at = NOW() WHERE user_id = $1",
        [userId]
      );
      const updated = await getFox(userId);
      message +=
        "🎟 +1 earned invite (за 5 візитів)\n" +
        `🏁 Earned Invites: ${updated.earned_invites}\n\n` +
        "👑 OWNER: основні інвайти завжди безлімітні.";
    } else {
      await pool.query(
        "UPDATE foxes SET invites = invites + 1, updated_at = NOW() WHERE user_id = $1",
        [userId]
      );
      message += "🎟 +1 інвайт за 5 візитів!";
    }
  } else {
    if (isAdmin(ctx)) {
      message += `📈 До наступного earned invite: ще ${remaining} візит(и).`;
    } else {
      message += `📈 До наступного інвайта: ще ${remaining} візит(и).`;
    }
  }

  return ctx.reply(message);
});

bot.command("invite", async (ctx) => {
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const fox = await getFox(userId);
  if (!fox) return ctx.reply("❌ Натисни /start");

  if (isAdmin(ctx)) {
    return ctx.reply(
      `👑 OWNER\n\n🎟 Інвайти (безліміт): ${fox.invites}\n🏁 Earned Invites: ${fox.earned_invites}`
    );
  }

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
app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));

// ===== START =====
const PORT = process.env.PORT || 3000;

(async () => {
  await initDb();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Server running on ${PORT}`);
  });
})();
