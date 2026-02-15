const express = require("express");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

// Потрібно, щоб бот міг давати лінк на панель
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

// Секрет для кукі панелі (можна не задавати — тоді використає WEBHOOK_SECRET)
const PANEL_TOKEN_SECRET = (process.env.PANEL_TOKEN_SECRET || WEBHOOK_SECRET || "").trim();

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

function random6Digits() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ===== SIMPLE PIN HASH (без додаткових бібліотек) =====
// Зберігаємо у БД не PIN, а "salt$hash"
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(pin, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}$${hash}`;
}
function verifyPin(pin, stored) {
  try {
    const [salt, hash] = String(stored || "").split("$");
    if (!salt || !hash) return false;
    const test = crypto.pbkdf2Sync(pin, salt, 120000, 32, "sha256").toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
  } catch {
    return false;
  }
}

// ===== COOKIES + SIGNED TOKEN (панель) =====
function base64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function base64urlDecode(str) {
  return JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
}
function sign(data) {
  return crypto.createHmac("sha256", PANEL_TOKEN_SECRET).update(data).digest("base64url");
}
function makeToken(payload) {
  const body = base64urlEncode(payload);
  const sig = sign(body);
  return `${body}.${sig}`;
}
function readToken(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  // захист від підбору
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = base64urlDecode(body);
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
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
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite || "Lax"}`);
  parts.push(`Path=${opts.path || "/"}`);
  res.setHeader("Set-Cookie", parts.join("; "));
}

// ===== I18N (PL / EN / UA) =====
const I18N = {
  pl: {
    langName: "PL",
    titleLogin: "Panel lokalu",
    selectVenue: "Wybierz lokal",
    pin: "PIN (6 cyfr)",
    login: "Zaloguj",
    logout: "Wyloguj",
    otp: "OTP (6 cyfr)",
    confirm: "Confirm",
    pending: "Pending (ostatnie 10 min)",
    noPending: "Brak pending.",
    wrongPin: "Błędny PIN.",
    wrongOtp: "Nie znaleziono pending z tym OTP (może minęło 10 min).",
    resultTitle: "✅ Confirm OK",
    day: "Dzień (Warszawa)",
    already: "DZIŚ JUŻ BYŁO ✅",
    tryTomorrow: "Spróbuj jutro po 00:00 (Warszawa).",
    countedAdded: "✅ Counted Visit dodano.",
    back: "Wróć do Panelu",
    xy: "X/Y",
  },
  en: {
    langName: "EN",
    titleLogin: "Venue Panel",
    selectVenue: "Select venue",
    pin: "PIN (6 digits)",
    login: "Login",
    logout: "Logout",
    otp: "OTP (6 digits)",
    confirm: "Confirm",
    pending: "Pending (last 10 min)",
    noPending: "No pending.",
    wrongPin: "Wrong PIN.",
    wrongOtp: "No pending found for this OTP (maybe expired after 10 min).",
    resultTitle: "✅ Confirm OK",
    day: "Day (Warsaw)",
    already: "ALREADY TODAY ✅",
    tryTomorrow: "Try tomorrow after 00:00 (Warsaw).",
    countedAdded: "✅ Counted Visit added.",
    back: "Back to Panel",
    xy: "X/Y",
  },
  ua: {
    langName: "UA",
    titleLogin: "Панель закладу",
    selectVenue: "Вибери заклад",
    pin: "PIN (6 цифр)",
    login: "Увійти",
    logout: "Вийти",
    otp: "OTP (6 цифр)",
    confirm: "Підтвердити",
    pending: "Очікують (останні 10 хв)",
    noPending: "Немає очікуючих.",
    wrongPin: "Неправильний PIN.",
    wrongOtp: "Не знайдено pending з таким OTP (можливо пройшло 10 хв).",
    resultTitle: "✅ Confirm OK",
    day: "День (Варшава)",
    already: "СЬОГОДНІ ВЖЕ БУЛО ✅",
    tryTomorrow: "Спробуй завтра після 00:00 (Варшава).",
    countedAdded: "✅ Counted Visit додано.",
    back: "Назад в Panel",
    xy: "X/Y",
  },
};

function getLang(req) {
  const q = (req.query.lang || "").toString().toLowerCase();
  const cookies = parseCookies(req);
  const c = (cookies.panel_lang || "").toLowerCase();
  const lang = (q || c || "pl");
  return I18N[lang] ? lang : "pl";
}
function langSwitcherHtml(lang) {
  const mk = (code) => {
    const active = code === lang ? "font-weight:bold;text-decoration:underline;" : "";
    return `<a href="/panel/lang/${code}" style="margin-right:10px;${active}">${I18N[code].langName}</a>`;
  };
  return `<div style="margin-bottom:10px;">${mk("pl")}${mk("en")}${mk("ua")}</div>`;
}

// ===== DB INIT =====
async function initDb() {
  // Foxes
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

  await pool.query(`
    ALTER TABLE foxes
    ADD COLUMN IF NOT EXISTS earned_invites INT NOT NULL DEFAULT 0;
  `);

  // Venues
  await pool.query(`
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT 'Warsaw',
      pin_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // МІГРАЦІЯ (важливо): якщо venues вже існувала — додай колонку
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pin_hash TEXT;`);

  // Checkins (pending OTP)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      otp TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // Counted visits (1/day/venue/user)
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

  // Seed venues
  const c = await pool.query("SELECT COUNT(*)::int AS n FROM venues");
  if ((c.rows[0]?.n || 0) === 0) {
    await pool.query(
      "INSERT INTO venues (name, city) VALUES ($1,$2), ($3,$4)",
      ["Test Kebab #1", "Warsaw", "Test Pizza #2", "Warsaw"]
    );
    console.log("✅ DB: seeded test venues (2)");
  }

  // Ensure PINs exist
  await ensureVenuePins();

  console.log("✅ DB ready");
}

async function ensureVenuePins() {
  const { rows } = await pool.query("SELECT id, name, pin_hash FROM venues ORDER BY id ASC");
  const createdPins = [];

  for (const v of rows) {
    if (!v.pin_hash) {
      const pin = random6Digits();
      const pin_hash = hashPin(pin);
      await pool.query("UPDATE venues SET pin_hash = $1 WHERE id = $2", [pin_hash, v.id]);
      createdPins.push({ id: v.id, name: v.name, pin });
    }
  }

  // Показуємо тільки коли генеруємо вперше (або після reset)
  for (const p of createdPins) {
    console.log(`🔐 PIN for "${p.name}" (ID ${p.id}): ${p.pin}`);
  }
}

// ===== DB HELPERS =====
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
  const { rows } = await pool.query("SELECT id, name, city, pin_hash FROM venues WHERE id = $1", [venueId]);
  return rows[0] || null;
}

async function listVenues() {
  const { rows } = await pool.query("SELECT id, name, city FROM venues ORDER BY id ASC LIMIT 50");
  return rows;
}

async function expireOldCheckins() {
  await pool.query(`
    UPDATE checkins
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < NOW()
  `);
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

// ===== X/Y =====
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

// ===== CONFIRM CORE (shared: admin + panel) =====
async function confirmOtpForVenue(venueId, otp) {
  await expireOldCheckins();

  const venue = await getVenueById(venueId);
  if (!venue) return { ok: false, reason: "no_venue" };

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
  if (!row) return { ok: false, reason: "no_pending" };

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
      } else {
        await pool.query(
          "UPDATE foxes SET invites = invites + 1, updated_at = NOW() WHERE user_id = $1",
          [userId]
        );
      }
    }
  }

  const { X, Y } = await getXYForVenue(venueId, userId);

  return { ok: true, venue, dayISO, userId, countedAdded, X, Y };
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// /panel як команда (тепер бот реагує)
bot.command("panel", async (ctx) => {
  const base = PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (!base) {
    return ctx.reply(
      "❌ Brak PUBLIC_BASE_URL.\n" +
      "W Railway → Variables dodaj:\n" +
      "PUBLIC_BASE_URL = https://twoj-domen.up.railway.app"
    );
  }
  return ctx.reply(`🔗 Panel lokalu: ${base}/panel`);
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Ти не адмін.");
  await ownerEnsure(ctx.from.id);
  return ctx.reply("👑 Ти АДМІН (owner mode).");
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await createFoxIfMissing(userId);
  await ownerEnsure(userId);

  return ctx.reply(
    "🦊 FoxPot Club\n\n" +
    "Zakłady: /venues\n" +
    "Strona lokalu: /venue 1\n" +
    "Check-in: /checkin 1\n" +
    "Panel (link): /panel\n" +
    "Status: /me\n"
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
      `🎟 Invites: ${fox.invites}\n` +
      `⭐ Rating: ${fox.rating}\n` +
      `👣 Counted Visits: ${fox.visits}\n` +
      `🏁 Earned Invites: ${fox.earned_invites}\n\n` +
      (remaining === 0
        ? "✅ Next earned invite on multiple of 5.\n"
        : `📈 Do następnego: jeszcze ${remaining} counted.\n`) +
      `📌 OWNER = MAX(other=${maxOther}) + ${OWNER_RATING_GAP}`
    );
  }

  return ctx.reply(
    "🦊 Twój status\n\n" +
    `🎟 Invites: ${fox.invites}\n` +
    `⭐ Rating: ${fox.rating}\n` +
    `👣 Counted Visits: ${fox.visits}\n\n` +
    (remaining === 0
      ? "✅ Next invite on multiple of 5."
      : `📈 Do następnego invite: jeszcze ${remaining} counted.`)
  );
});

bot.command("id", (ctx) => ctx.reply(`Twój Telegram ID: ${ctx.from.id}`));

bot.command("venues", async (ctx) => {
  await expireOldCheckins();
  const rows = await listVenues();
  if (!rows.length) return ctx.reply("Póki co brak lokali.");

  let text = "🗺 Lokale (test)\n\n";
  for (const v of rows) text += `• ID ${v.id}: ${v.name} (${v.city})\n`;
  text += "\nStrona: /venue 1";
  return ctx.reply(text);
});

bot.command("venue", async (ctx) => {
  await expireOldCheckins();
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);

  if (!Number.isInteger(venueId) || venueId <= 0) return ctx.reply("❌ Napisz: /venue 1");

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Nie ma takiego lokalu. /venues");

  const { X, Y } = await getXYForVenue(venueId, userId);

  return ctx.reply(
    `🏪 ${venue.name} (${venue.city})\n\n` +
    `📊 X/Y: ${X}/${Y}\n\n` +
    `Check-in: /checkin ${venueId}\n` +
    `Panel (link): /panel`
  );
});

bot.command("checkin", async (ctx) => {
  await expireOldCheckins();
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);

  if (!Number.isInteger(venueId) || venueId <= 0) return ctx.reply("❌ Napisz: /checkin 1");

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Nie ma takiego lokalu. /venues");

  const otp = random6Digits();
  await pool.query(
    `
    INSERT INTO checkins (user_id, venue_id, otp, status, expires_at)
    VALUES ($1, $2, $3, 'pending', NOW() + INTERVAL '10 minutes')
  `,
    [userId, venueId, otp]
  );

  return ctx.reply(
    `✅ Check-in (10 min)\n\n` +
    `🏪 ${venue.name}\n` +
    `🔐 OTP: ${otp}\n\n` +
    `Personel potwierdza w Panelu: /panel`
  );
});

// (залишаємо admin confirm для тестів)
bot.command("confirm", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Confirm tylko OWNER (test).");

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  const otp = (parts[2] || "").trim();

  if (!Number.isInteger(venueId) || venueId <= 0 || otp.length !== 6) {
    return ctx.reply("❌ Napisz: /confirm 1 123456");
  }

  const r = await confirmOtpForVenue(venueId, otp);
  if (!r.ok) {
    if (r.reason === "no_pending") return ctx.reply("❌ Brak pending (OTP wygasł po 10 min).");
    return ctx.reply("❌ Błąd.");
  }

  const msg =
    `✅ Confirm OK\nLokal: ${r.venue.name}\n\n` +
    `Dzień (Warszawa): ${r.dayISO}\n\n` +
    (r.countedAdded
      ? `✅ Counted dodano.\n`
      : `DZIŚ JUŻ BYŁO ✅\nSpróbuj jutro po 00:00 (Warszawa).\n`) +
    `\nX/Y: ${r.X}/${r.Y}`;

  return ctx.reply(msg);
});

// ===== WEB ROUTES =====
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

// ===== PANEL: language switch =====
app.get("/panel/lang/:lang", (req, res) => {
  const lang = (req.params.lang || "pl").toLowerCase();
  const safe = I18N[lang] ? lang : "pl";
  setCookie(res, "panel_lang", safe, { maxAge: 60 * 60 * 24 * 365, httpOnly: false, secure: true, sameSite: "Lax" });
  res.redirect("/panel");
});

// ===== PANEL: GET =====
app.get("/panel", async (req, res) => {
  const lang = getLang(req);
  const t = I18N[lang];

  const cookies = parseCookies(req);
  const token = readToken(cookies.foxpot_panel || "");

  const venues = await listVenues();

  if (!token || !token.venue_id) {
    // LOGIN PAGE
    return res.status(200).send(`
      <html>
        <head><meta charset="utf-8"><title>${t.titleLogin}</title></head>
        <body style="font-family:Arial;max-width:520px;margin:30px auto;">
          ${langSwitcherHtml(lang)}
          <h2>${t.titleLogin}</h2>

          <form method="POST" action="/panel/login">
            <label>${t.selectVenue}</label><br/>
            <select name="venue_id" style="width:100%;padding:10px;margin:6px 0;">
              ${venues.map(v => `<option value="${v.id}">${v.id} — ${v.name}</option>`).join("")}
            </select>

            <label>${t.pin}</label><br/>
            <input name="pin" inputmode="numeric" maxlength="6" style="width:100%;padding:10px;margin:6px 0;" />

            <button type="submit" style="width:100%;padding:12px;">${t.login}</button>
          </form>

          <p style="margin-top:14px;color:#666;">
            TIP: to jest strona w przeglądarce: <b>/panel</b><br/>
            Telegram komenda: <b>/panel</b> (bot wyśle link)
          </p>
        </body>
      </html>
    `);
  }

  // AUTH OK -> PANEL
  const venue = await getVenueById(Number(token.venue_id));
  if (!venue) {
    setCookie(res, "foxpot_panel", "", { maxAge: 0, httpOnly: true, secure: true, sameSite: "Lax" });
    return res.redirect("/panel");
  }

  await expireOldCheckins();
  const pending = await pool.query(
    `
    SELECT otp, expires_at
    FROM checkins
    WHERE venue_id = $1 AND status='pending' AND expires_at > NOW()
    ORDER BY id DESC
    LIMIT 20
  `,
    [venue.id]
  );

  const pendingRows = pending.rows || [];

  res.status(200).send(`
    <html>
      <head><meta charset="utf-8"><title>${t.titleLogin}</title></head>
      <body style="font-family:Arial;max-width:720px;margin:30px auto;">
        ${langSwitcherHtml(lang)}
        <h2>${t.titleLogin}: ${venue.name}</h2>

        <form method="POST" action="/panel/confirm" style="margin:18px 0;padding:14px;border:1px solid #ddd;">
          <label><b>${t.otp}</b></label><br/>
          <input name="otp" inputmode="numeric" maxlength="6" style="width:260px;padding:10px;margin:8px 0;" />
          <button type="submit" style="padding:12px 18px;margin-left:8px;">${t.confirm}</button>
        </form>

        <div style="padding:14px;border:1px solid #ddd;">
          <h3 style="margin-top:0;">${t.pending}</h3>
          ${pendingRows.length === 0 ? `<p>${t.noPending}</p>` : `
            <table cellpadding="8" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              <tr style="background:#f6f6f6;">
                <th align="left">OTP</th>
                <th align="left">TTL</th>
                <th></th>
              </tr>
              ${pendingRows.map(r => `
                <tr style="border-top:1px solid #eee;">
                  <td><b>${r.otp}</b></td>
                  <td>${new Date(r.expires_at).toLocaleString("pl-PL")}</td>
                  <td>
                    <form method="POST" action="/panel/confirm" style="margin:0;">
                      <input type="hidden" name="otp" value="${r.otp}" />
                      <button type="submit">${t.confirm}</button>
                    </form>
                  </td>
                </tr>
              `).join("")}
            </table>
          `}
        </div>

        <form method="POST" action="/panel/logout" style="margin-top:18px;">
          <button type="submit" style="padding:10px 14px;">${t.logout}</button>
        </form>
      </body>
    </html>
  `);
});

// ===== PANEL: LOGIN =====
app.post("/panel/login", async (req, res) => {
  const lang = getLang(req);
  const t = I18N[lang];

  const venueId = Number(req.body.venue_id);
  const pin = String(req.body.pin || "").trim();

  const venue = await getVenueById(venueId);
  if (!venue) return res.status(400).send("No venue");

  if (!pin || pin.length !== 6 || !verifyPin(pin, venue.pin_hash)) {
    return res.status(200).send(`
      <html><head><meta charset="utf-8"><title>${t.titleLogin}</title></head>
      <body style="font-family:Arial;max-width:520px;margin:30px auto;">
        ${langSwitcherHtml(lang)}
        <h2>${t.titleLogin}</h2>
        <p style="color:red;"><b>${t.wrongPin}</b></p>
        <a href="/panel">${t.back}</a>
      </body></html>
    `);
  }

  // OK: set cookie for 7 days
  const token = makeToken({ venue_id: venueId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  setCookie(res, "foxpot_panel", token, { maxAge: 7 * 24 * 60 * 60, httpOnly: true, secure: true, sameSite: "Lax" });
  res.redirect("/panel");
});

// ===== PANEL: LOGOUT =====
app.post("/panel/logout", (req, res) => {
  setCookie(res, "foxpot_panel", "", { maxAge: 0, httpOnly: true, secure: true, sameSite: "Lax" });
  res.redirect("/panel");
});

// ===== PANEL: CONFIRM =====
app.post("/panel/confirm", async (req, res) => {
  const lang = getLang(req);
  const t = I18N[lang];

  const cookies = parseCookies(req);
  const token = readToken(cookies.foxpot_panel || "");
  if (!token || !token.venue_id) return res.redirect("/panel");

  const venueId = Number(token.venue_id);
  const otp = String(req.body.otp || "").trim();

  if (!otp || otp.length !== 6) return res.redirect("/panel");

  const r = await confirmOtpForVenue(venueId, otp);
  if (!r.ok) {
    return res.status(200).send(`
      <html><head><meta charset="utf-8"><title>${t.titleLogin}</title></head>
      <body style="font-family:Arial;max-width:520px;margin:30px auto;">
        ${langSwitcherHtml(lang)}
        <h2>${t.titleLogin}</h2>
        <p style="color:red;"><b>${t.wrongOtp}</b></p>
        <a href="/panel">${t.back}</a>
      </body></html>
    `);
  }

  const big = r.countedAdded
    ? `<div style="padding:14px;background:#e9ffe9;border:1px solid #bde5bd;"><b>${t.countedAdded}</b></div>`
    : `<div style="padding:14px;background:#fff3cd;border:1px solid #ffeeba;"><b>${t.already}</b><br/>${t.tryTomorrow}</div>`;

  return res.status(200).send(`
    <html>
      <head><meta charset="utf-8"><title>${t.resultTitle}</title></head>
      <body style="font-family:Arial;max-width:720px;margin:30px auto;">
        ${langSwitcherHtml(lang)}
        <h2>${t.resultTitle}</h2>
        <p><b>Lokal:</b> ${r.venue.name}</p>
        <p><b>${t.day}:</b> ${r.dayISO}</p>

        ${big}

        <p style="margin-top:16px;"><b>${t.xy}:</b> ${r.X}/${r.Y}</p>

        <a href="/panel" style="display:inline-block;margin-top:14px;">${t.back}</a>
      </body>
    </html>
  `);
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
      if (PUBLIC_BASE_URL) console.log(`✅ Panel URL: ${PUBLIC_BASE_URL.replace(/\/+$/, "")}/panel`);
      else console.log(`ℹ️ Set PUBLIC_BASE_URL to show Panel link in Telegram /panel`);
    });
  } catch (e) {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  }
})();
