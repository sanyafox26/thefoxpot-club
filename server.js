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

// ===== TIME (Warsaw) =====
function warsawDateISO() {
  // YYYY-MM-DD in Europe/Warsaw
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function randomOtp6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ===== DB INIT =====
async function initDb() {
  // Foxes (users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS foxes (
      user_id BIGINT PRIMARY KEY,
      invites INT NOT NULL DEFAULT 3,
      rating INT NOT NULL DEFAULT 1,
      visits INT NOT NULL DEFAULT 0, -- тут: total counted visits (Phase 1 progress)
      earned_invites INT NOT NULL DEFAULT 0, -- для OWNER: скільки “заробив” по правилах
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // якщо таблиця була створена раніше без earned_invites — додаємо колонку
  await pool.query(`
    ALTER TABLE foxes
    ADD COLUMN IF NOT EXISTS earned_invites INT NOT NULL DEFAULT 0;
  `);

  // Venues (partners) — поки тестові
  await pool.query(`
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT 'Warsaw',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Pending/Confirmed checkins (імітація чек-іну з OTP)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      otp TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | expired
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // Counted visits: 1/day/venue/user (LOCKED)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS counted_visits (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      day_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, venue_id, day_date)
    );
  `);

  // Seed venues (якщо пусто — додаємо 2 тестові)
  const c = await pool.query("SELECT COUNT(*)::int AS n FROM venues");
  if ((c.rows[0]?.n || 0) === 0) {
    await pool.query(
      "INSERT INTO venues (name, city) VALUES ($1,$2), ($3,$4)",
      ["Test Kebab #1", "Warsaw", "Test Pizza #2", "Warsaw"]
    );
    console.log("✅ DB: seeded test venues (2)");
  }

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

async function getVenueById(venueId) {
  const { rows } = await pool.query("SELECT id, name, city FROM venues WHERE id = $1", [venueId]);
  return rows[0] || null;
}

async function listVenues() {
  const { rows } = await pool.query("SELECT id, name, city FROM venues ORDER BY id ASC LIMIT 50");
  return rows;
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

// ===== X/Y helpers =====
async function getXYForVenue(venueId, userId) {
  // X = твій counted visits у цьому venue
  const xq = await pool.query(
    "SELECT COUNT(*)::int AS x FROM counted_visits WHERE venue_id = $1 AND user_id = $2",
    [venueId, userId]
  );
  const yq = await pool.query(
    "SELECT COUNT(*)::int AS y FROM counted_visits WHERE venue_id = $1",
    [venueId]
  );
  return { X: xq.rows[0].x || 0, Y: yq.rows[0].y || 0 };
}

async function expireOldCheckins() {
  // м’яко: ставимо expired для прострочених pending (не критично, але чисто)
  await pool.query(`
    UPDATE checkins
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < NOW()
  `);
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// ===== ADMIN COMMANDS =====
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Ти не адмін.");
  await ownerEnsure(ctx.from.id);
  return ctx.reply("👑 Ти АДМІН (owner mode).");
});

// ===== BASIC COMMANDS =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await createFoxIfMissing(userId);
  await ownerEnsure(userId);

  return ctx.reply(
    "🦊 Ласкаво просимо до FoxPot Club\n\n" +
      "Список закладів: /venues\n" +
      "Сторінка закладу: /venue 1\n" +
      "Check-in: /checkin 1\n" +
      "Confirm (панель, зараз тільки адмін): /confirm 1 123456\n" +
      "Статус: /me\n" +
      "Інвайти: /invite"
  );
});

bot.command("me", async (ctx) => {
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const fox = await getFox(userId);
  if (!fox) return ctx.reply("❌ Натисни /start");

  // прогрес інвайтів по total counted visits (visits)
  const progress = fox.visits % 5;
  const remaining = progress === 0 ? 0 : 5 - progress;

  if (isAdmin(ctx)) {
    const maxOther = await getMaxRatingExcludingAdmin();
    return ctx.reply(
      "👑 OWNER STATUS\n\n" +
        `🎟 Інвайти: ${fox.invites}\n` +
        `⭐ Рейтинг: ${fox.rating}\n` +
        `👣 Counted Visits (total): ${fox.visits}\n` +
        `🏁 Earned Invites: ${fox.earned_invites}\n\n` +
        (remaining === 0
          ? "✅ Наступний earned invite буде нарахований на кратному 5.\n"
          : `📈 До наступного earned invite: ще ${remaining} counted visit(и).\n`) +
        `📌 Правило: OWNER = MAX_інших(${maxOther}) + ${OWNER_RATING_GAP}`
    );
  }

  return ctx.reply(
    "🦊 Твій статус\n\n" +
      `🎟 Інвайти: ${fox.invites}\n` +
      `⭐ Рейтинг: ${fox.rating}\n` +
      `👣 Counted Visits (total): ${fox.visits}\n\n` +
      (remaining === 0
        ? "✅ Наступний інвайт буде нарахований на кратному 5."
        : `📈 До наступного інвайта: ще ${remaining} counted visit(и).`)
  );
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

bot.command("id", (ctx) => ctx.reply(`Твій Telegram ID: ${ctx.from.id}`));

// ===== VENUES =====
bot.command("venues", async (ctx) => {
  await expireOldCheckins();
  const rows = await listVenues();

  if (!rows.length) return ctx.reply("Поки немає закладів.");

  let text = "🗺 Заклади (тестові)\n\n";
  for (const v of rows) {
    text += `• ID ${v.id}: ${v.name} (${v.city})\n`;
  }
  text += "\nСторінка: /venue 1";
  return ctx.reply(text);
});

bot.command("venue", async (ctx) => {
  await expireOldCheckins();
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);

  if (!Number.isInteger(venueId) || venueId <= 0) {
    return ctx.reply("❌ Напиши так: /venue 1");
  }

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Немає такого закладу. Подивись /venues");

  const { X, Y } = await getXYForVenue(venueId, userId);

  return ctx.reply(
    `🏪 ${venue.name} (${venue.city})\n\n` +
      `📊 X/Y: ${X}/${Y}\n\n` +
      `Check-in: /checkin ${venueId}\n` +
      `Confirm (панель, зараз тільки адмін): /confirm ${venueId} 123456`
  );
});

// ===== CHECK-IN / CONFIRM (OTP) =====
bot.command("checkin", async (ctx) => {
  await expireOldCheckins();
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);

  if (!Number.isInteger(venueId) || venueId <= 0) {
    return ctx.reply("❌ Напиши так: /checkin 1");
  }

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Немає такого закладу. Подивись /venues");

  const otp = randomOtp6();
  // TTL 10 хв
  await pool.query(
    `
    INSERT INTO checkins (user_id, venue_id, otp, status, expires_at)
    VALUES ($1, $2, $3, 'pending', NOW() + INTERVAL '10 minutes')
  `,
    [userId, venueId, otp]
  );

  return ctx.reply(
    `✅ Check-in створено (10 хв)\n\n` +
      `🏪 ${venue.name}\n` +
      `🔐 OTP: ${otp}\n\n` +
      `Далі персонал має підтвердити.\n` +
      `Зараз для тесту підтверджує тільки OWNER:\n` +
      `/confirm ${venueId} ${otp}`
  );
});

bot.command("confirm", async (ctx) => {
  await expireOldCheckins();
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Confirm зараз доступний тільки OWNER (для тесту).");
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  const otp = (parts[2] || "").trim();

  if (!Number.isInteger(venueId) || venueId <= 0 || otp.length !== 6) {
    return ctx.reply("❌ Напиши так: /confirm 1 123456");
  }

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Немає такого закладу. Подивись /venues");

  // Беремо останній pending checkin для цього venue+otp, який ще не expired
  const q = await pool.query(
    `
    SELECT id, user_id
    FROM checkins
    WHERE venue_id = $1
      AND otp = $2
      AND status = 'pending'
      AND expires_at > NOW()
    ORDER BY id DESC
    LIMIT 1
  `,
    [venueId, otp]
  );

  const row = q.rows[0];
  if (!row) {
    return ctx.reply("❌ Не знайдено pending check-in. Може OTP вже прострочений (10 хв).");
  }

  // confirm (debounce тут не робимо складно — OTP одноразовий)
  await pool.query("UPDATE checkins SET status='confirmed' WHERE id = $1", [row.id]);

  // COUNTED VISIT правило: 1/доба/заклад/Fox (Warsaw date)
  const dayISO = warsawDateISO(); // YYYY-MM-DD
  const userId = Number(row.user_id);

  // вставляємо counted_visit (якщо вже є — нічого не робимо)
  const ins = await pool.query(
    `
    INSERT INTO counted_visits (user_id, venue_id, day_date)
    VALUES ($1, $2, $3::date)
    ON CONFLICT (user_id, venue_id, day_date) DO NOTHING
    RETURNING id
  `,
    [userId, venueId, dayISO]
  );

  const countedAdded = ins.rowCount === 1;

  // гарантуємо, що Fox існує
  await createFoxIfMissing(userId);

  let msg =
    `✅ Confirm OK\n🏪 ${venue.name}\n📅 Day (Warsaw): ${dayISO}\n\n`;

  if (!countedAdded) {
    msg += "ℹ️ Counted Visit вже був сьогодні для цього Fox у цьому закладі.\n" +
           "Правило: max 1 counted/day/venue/Fox.\n\n";
  } else {
    // Якщо counted додано — це реальна винагорода Phase 1:
    // foxes.visits += 1 (total counted), rating += 1
    await pool.query(
      "UPDATE foxes SET visits = visits + 1, rating = rating + 1, updated_at = NOW() WHERE user_id = $1",
      [userId]
    );

    // інвайт за кожні 5 counted visits:
    // - для OWNER: earned_invites
    // - для інших: invites
    const fox = await getFox(userId);
    const progress = fox.visits % 5;

    if (progress === 0) {
      if (isAdminId(userId)) {
        await pool.query(
          "UPDATE foxes SET earned_invites = earned_invites + 1, updated_at = NOW() WHERE user_id = $1",
          [userId]
        );
        const updated = await getFox(userId);
        msg +=
          "🎟 +1 earned invite (за 5 counted visits)\n" +
          `🏁 Earned Invites: ${updated.earned_invites}\n\n` +
          "👑 OWNER: основні інвайти завжди безлімітні.\n\n";
      } else {
        await pool.query(
          "UPDATE foxes SET invites = invites + 1, updated_at = NOW() WHERE user_id = $1",
          [userId]
        );
        msg += "🎟 +1 інвайт за 5 counted visits!\n\n";
      }
    } else {
      const remaining = 5 - progress;
      msg += `📈 До наступного інвайта: ще ${remaining} counted visit(и).\n\n`;
    }

    msg += "✅ Counted Visit додано і зараховано в статистику.\n\n";
  }

  // Показуємо X/Y для цього закладу для цього userId
  const { X, Y } = await getXYForVenue(venueId, userId);
  msg += `📊 X/Y (цього Fox у цьому закладі / всього закладу): ${X}/${Y}`;

  return ctx.reply(msg);
});

// швидкий тест
bot.hears(/test/i, (ctx) => ctx.reply("Test OK ✅"));

// ===== ROUTES =====
app.get("/", (req, res) => res.status(200).send("The FoxPot Club backend OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.get("/db", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows[0] });
  } catch (e) {
    console.error("❌ /db error:", e);
    res.status(500).json({ ok: false });
  }
});

// ===== WEBHOOK =====
const webhookPath = `/telegram/${WEBHOOK_SECRET}`;
app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));

// ===== START =====
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDb();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on ${PORT}`);
      console.log(`✅ Webhook path: ${webhookPath}`);
    });
  } catch (e) {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  }
})();
