const express = require("express");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // щоб HTML-форми працювали

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

function randomPin6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ===== SIMPLE COOKIE PARSER =====
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const [k, ...v] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(v.join("=") || "");
  });
  return out;
}

// ===== PIN SECURITY (hash + encrypt) =====
// key for encryption derived from WEBHOOK_SECRET (so you don't need new ENV)
function encKey() {
  return crypto.createHash("sha256").update(String(WEBHOOK_SECRET)).digest(); // 32 bytes
}

function encryptText(plain) {
  // AES-256-GCM
  const key = encKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    enc: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptText(enc, iv, tag) {
  const key = encKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(enc, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

function hashPin(pin, salt) {
  // PBKDF2 hash
  const h = crypto.pbkdf2Sync(pin, salt, 120000, 32, "sha256");
  return h.toString("hex");
}

// ===== PANEL SESSION TOKEN (cookie) =====
// token = venueId|ts|hmac
function signPanelToken(venueId) {
  const ts = Date.now();
  const payload = `${venueId}|${ts}`;
  const hmac = crypto
    .createHmac("sha256", String(WEBHOOK_SECRET))
    .update(payload)
    .digest("hex");
  return `${payload}|${hmac}`;
}

function verifyPanelToken(token) {
  if (!token) return null;
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [venueIdStr, tsStr, sig] = parts;
  const payload = `${venueIdStr}|${tsStr}`;
  const expected = crypto
    .createHmac("sha256", String(WEBHOOK_SECRET))
    .update(payload)
    .digest("hex");
  if (expected !== sig) return null;

  const venueId = Number(venueIdStr);
  if (!Number.isInteger(venueId) || venueId <= 0) return null;

  // token valid 30 days
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return null;
  const age = Date.now() - ts;
  if (age > 30 * 24 * 60 * 60 * 1000) return null;

  return { venueId };
}

// ===== DB INIT =====
async function initDb() {
  // Foxes (users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS foxes (
      user_id BIGINT PRIMARY KEY,
      invites INT NOT NULL DEFAULT 3,
      rating INT NOT NULL DEFAULT 1,
      visits INT NOT NULL DEFAULT 0, -- total counted visits (Phase 1 progress)
      earned_invites INT NOT NULL DEFAULT 0, -- для OWNER: скільки “заробив” по правилах
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE foxes
    ADD COLUMN IF NOT EXISTS earned_invites INT NOT NULL DEFAULT 0;
  `);

  // Venues (partners)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT 'Warsaw',
      pin_salt TEXT,
      pin_hash TEXT,
      pin_enc TEXT,
      pin_iv TEXT,
      pin_tag TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Pending/Confirmed checkins
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

  // Ensure every venue has PIN (generated once)
  await ensureVenuePins();

  console.log("✅ DB ready");
}

async function ensureVenuePins() {
  const { rows } = await pool.query(
    "SELECT id, name, pin_hash FROM venues ORDER BY id ASC"
  );
  for (const v of rows) {
    if (v.pin_hash) continue;

    const pin = randomPin6();
    const salt = crypto.randomBytes(16).toString("hex");
    const pinHash = hashPin(pin, salt);
    const e = encryptText(pin);

    await pool.query(
      `
      UPDATE venues
      SET pin_salt=$2, pin_hash=$3, pin_enc=$4, pin_iv=$5, pin_tag=$6
      WHERE id=$1
      `,
      [v.id, salt, pinHash, e.enc, e.iv, e.tag]
    );

    // PIN показуємо в логах 1 раз (для тестів)
    console.log(`🔐 Venue PIN created: ID ${v.id} "${v.name}" PIN=${pin}`);
  }
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
  const { rows } = await pool.query(
    "SELECT id, name, city, pin_salt, pin_hash, pin_enc, pin_iv, pin_tag FROM venues WHERE id = $1",
    [venueId]
  );
  return rows[0] || null;
}

async function listVenues() {
  const { rows } = await pool.query("SELECT id, name, city FROM venues ORDER BY id ASC LIMIT 50");
  return rows;
}

// ===== OWNER RULES =====
const OWNER_INVITES = 999999999;
const OWNER_RATING_GAP = 1000;

function isAdminId(userId) {
  return String(userId) === String(ADMIN_USER_ID);
}
function isAdmin(ctx) {
  return isAdminId(ctx.from.id);
}

async function getMaxRatingExcludingAdmin() {
  const r = await pool.query(
    "SELECT COALESCE(MAX(rating), 0) AS max FROM foxes WHERE user_id <> $1",
    [ADMIN_USER_ID]
  );
  return Number(r.rows[0].max || 0);
}

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
  await pool.query(`
    UPDATE checkins
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < NOW()
  `);
}

async function getPendingForVenue(venueId) {
  const { rows } = await pool.query(
    `
    SELECT id, user_id, otp, created_at, expires_at
    FROM checkins
    WHERE venue_id=$1 AND status='pending' AND expires_at > NOW()
    ORDER BY id DESC
    LIMIT 20
    `,
    [venueId]
  );
  return rows;
}

// ===== CORE CONFIRM LOGIC (used by OWNER confirm + panel confirm) =====
async function confirmByOtpForVenue(venueId, otp) {
  await expireOldCheckins();

  const venue = await getVenueById(venueId);
  if (!venue) return { ok: false, msg: "❌ Немає такого закладу." };

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
    return { ok: false, msg: "❌ Не знайдено pending check-in. Може OTP вже прострочений (10 хв)." };
  }

  // mark checkin confirmed
  await pool.query("UPDATE checkins SET status='confirmed' WHERE id = $1", [row.id]);

  const dayISO = warsawDateISO();
  const userId = Number(row.user_id);

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
  await createFoxIfMissing(userId);

  let info = {
    ok: true,
    venueName: venue.name,
    dayISO,
    countedAdded,
    userId,
    X: 0,
    Y: 0,
    inviteText: "",
  };

  if (countedAdded) {
    await pool.query(
      "UPDATE foxes SET visits = visits + 1, rating = rating + 1, updated_at = NOW() WHERE user_id = $1",
      [userId]
    );

    const fox = await getFox(userId);
    const progress = fox.visits % 5;

    if (progress === 0) {
      if (isAdminId(userId)) {
        await pool.query(
          "UPDATE foxes SET earned_invites = earned_invites + 1, updated_at = NOW() WHERE user_id = $1",
          [userId]
        );
        const updated = await getFox(userId);
        info.inviteText =
          `🎟 +1 earned invite (за 5 counted visits)\n` +
          `🏁 Earned Invites: ${updated.earned_invites}\n` +
          `👑 OWNER: основні інвайти завжди безлімітні.`;
      } else {
        await pool.query(
          "UPDATE foxes SET invites = invites + 1, updated_at = NOW() WHERE user_id = $1",
          [userId]
        );
        info.inviteText = "🎟 +1 інвайт за 5 counted visits!";
      }
    } else {
      const remaining = 5 - progress;
      info.inviteText = `📈 До наступного інвайта: ще ${remaining} counted visit(и).`;
    }
  }

  const xy = await getXYForVenue(venueId, userId);
  info.X = xy.X;
  info.Y = xy.Y;

  return info;
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// ===== ADMIN COMMANDS =====
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Ти не адмін.");
  await ownerEnsure(ctx.from.id);
  return ctx.reply("👑 Ти АДМІН (owner mode).");
});

// Show venue PIN (OWNER only): /venuepin 1
bot.command("venuepin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Тільки OWNER.");
  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  if (!Number.isInteger(venueId) || venueId <= 0) return ctx.reply("❌ Напиши так: /venuepin 1");

  const v = await getVenueById(venueId);
  if (!v) return ctx.reply("❌ Немає такого закладу.");
  if (!v.pin_enc) return ctx.reply("❌ У цього закладу ще немає PIN (дивись логи Railway).");

  const pin = decryptText(v.pin_enc, v.pin_iv, v.pin_tag);
  return ctx.reply(`🔐 PIN для "${v.name}" (ID ${v.id}): ${pin}\n\nPanel: /panel (в браузері)`);
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
      "Confirm (для тесту OWNER): /confirm 1 123456\n" +
      "PIN закладу (OWNER): /venuepin 1\n" +
      "Panel (в браузері): відкрий /panel\n" +
      "Статус: /me\n" +
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
      `Confirm (для тесту OWNER): /confirm ${venueId} 123456\n` +
      `Panel: відкрий /panel у браузері (PIN має заклад)`
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
      `Далі персонал має підтвердити в Panel (через PIN).\n` +
      `Для тесту OWNER може підтвердити так:\n` +
      `/confirm ${venueId} ${otp}`
  );
});

// OWNER confirm (for tests)
bot.command("confirm", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Confirm команда зараз тільки для OWNER (тест). Реально підтверджує заклад через /panel.");
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  const otp = (parts[2] || "").trim();

  if (!Number.isInteger(venueId) || venueId <= 0 || otp.length !== 6) {
    return ctx.reply("❌ Напиши так: /confirm 1 123456");
  }

  const r = await confirmByOtpForVenue(venueId, otp);
  if (!r.ok) return ctx.reply(r.msg);

  let msg = `✅ Confirm OK\n🏪 ${r.venueName}\n📅 Day (Warsaw): ${r.dayISO}\n\n`;
  if (!r.countedAdded) {
    msg +=
      "ℹ️ Counted Visit вже був сьогодні для цього Fox у цьому закладі.\n" +
      "Правило: max 1 counted/day/venue/Fox.\n\n";
  } else {
    msg += `${r.inviteText}\n\n✅ Counted Visit додано і зараховано в статистику.\n\n`;
  }
  msg += `📊 X/Y: ${r.X}/${r.Y}`;
  return ctx.reply(msg);
});

// quick test
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

// ===== PANEL (browser) =====
app.get("/panel", async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.panel_token;
  const data = verifyPanelToken(token);

  if (!data) {
    // login page
    return res.status(200).send(`
      <html><head><meta charset="utf-8"><title>FoxPot Panel</title></head>
      <body style="font-family: Arial; max-width: 520px; margin: 30px auto;">
        <h2>THE FOX POT CLUB — Panel Lokalu</h2>
        <p><b>Що це:</b> сторінка для персоналу закладу.</p>
        <p><b>PIN</b> = 6 цифр “пароль” закладу.</p>
        <form method="POST" action="/panel/login">
          <label>PIN (6 цифр):</label><br/>
          <input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" style="font-size:20px; padding:8px; width: 220px;" required />
          <br/><br/>
          <button type="submit" style="font-size:18px; padding:10px 16px;">Увійти</button>
        </form>
      </body></html>
    `);
  }

  const venue = await getVenueById(data.venueId);
  if (!venue) {
    res.setHeader("Set-Cookie", "panel_token=; Max-Age=0; Path=/");
    return res.redirect("/panel");
  }

  const pending = await getPendingForVenue(venue.id);
  const pendingHtml = pending.length
    ? pending
        .map(
          (p) =>
            `<li>OTP: <b>${p.otp}</b> (expires: ${new Date(p.expires_at).toLocaleString()})</li>`
        )
        .join("")
    : "<li>Немає pending чек-інів (або вони протухли).</li>";

  return res.status(200).send(`
    <html><head><meta charset="utf-8"><title>FoxPot Panel</title></head>
    <body style="font-family: Arial; max-width: 720px; margin: 30px auto;">
      <h2>Panel Lokalu</h2>
      <p><b>Заклад:</b> ${venue.name} (${venue.city})</p>

      <h3>Підтвердити візит (15 секунд)</h3>
      <p><b>OTP</b> = 6 цифр, які показує Fox після /checkin</p>
      <form method="POST" action="/panel/confirm">
        <label>OTP (6 цифр):</label><br/>
        <input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" style="font-size:20px; padding:8px; width: 220px;" required />
        <br/><br/>
        <button type="submit" style="font-size:18px; padding:10px 16px;">CONFIRM</button>
      </form>

      <h3>Pending (останні 10 хв)</h3>
      <ul>${pendingHtml}</ul>

      <p><a href="/panel/logout">Вийти</a></p>
    </body></html>
  `);
});

app.post("/panel/login", async (req, res) => {
  const pin = String(req.body.pin || "").trim();
  if (!/^[0-9]{6}$/.test(pin)) {
    return res.status(400).send("❌ PIN має бути 6 цифр. <a href='/panel'>Назад</a>");
  }

  // find venue where pin matches (hash check)
  const { rows } = await pool.query(
    "SELECT id, pin_salt, pin_hash FROM venues WHERE pin_hash IS NOT NULL"
  );

  let matchedVenueId = null;
  for (const v of rows) {
    const calc = hashPin(pin, v.pin_salt);
    if (calc === v.pin_hash) {
      matchedVenueId = v.id;
      break;
    }
  }

  if (!matchedVenueId) {
    return res.status(401).send("❌ Невірний PIN. <a href='/panel'>Спробувати ще раз</a>");
  }

  const token = signPanelToken(matchedVenueId);
  // httpOnly cookie
  res.setHeader(
    "Set-Cookie",
    `panel_token=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}`
  );
  return res.redirect("/panel");
});

app.post("/panel/confirm", async (req, res) => {
  const cookies = parseCookies(req);
  const data = verifyPanelToken(cookies.panel_token);
  if (!data) return res.redirect("/panel");

  const otp = String(req.body.otp || "").trim();
  if (!/^[0-9]{6}$/.test(otp)) {
    return res.status(400).send("❌ OTP має бути 6 цифр. <a href='/panel'>Назад</a>");
  }

  const r = await confirmByOtpForVenue(data.venueId, otp);
  if (!r.ok) {
    return res.status(400).send(`${r.msg} <br/><br/><a href="/panel">Назад</a>`);
  }

  let msg = `<h2>✅ Confirm OK</h2>
  <p><b>Заклад:</b> ${r.venueName}</p>
  <p><b>Day (Warsaw):</b> ${r.dayISO}</p>`;

  if (!r.countedAdded) {
    msg += `<p>ℹ️ Counted Visit вже був сьогодні для цього Fox у цьому закладі.<br/>Правило: max 1 counted/day/venue/Fox.</p>`;
  } else {
    msg += `<p>${r.inviteText}</p><p>✅ Counted Visit додано і зараховано в статистику.</p>`;
  }

  msg += `<p><b>X/Y:</b> ${r.X}/${r.Y}</p>
  <p><a href="/panel">Назад у Panel</a></p>`;

  return res.status(200).send(`<html><head><meta charset="utf-8"><title>Confirm</title></head><body style="font-family: Arial; max-width:720px; margin:30px auto;">${msg}</body></html>`);
});

app.get("/panel/logout", (req, res) => {
  res.setHeader("Set-Cookie", "panel_token=; HttpOnly; Path=/; Max-Age=0");
  return res.redirect("/panel");
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
      console.log(`✅ Panel: /panel`);
    });
  } catch (e) {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  }
})();
