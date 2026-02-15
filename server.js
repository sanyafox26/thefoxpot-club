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
function encKey() {
  return crypto.createHash("sha256").update(String(WEBHOOK_SECRET)).digest();
}

function encryptText(plain) {
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
  const plain = Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]);
  return plain.toString("utf8");
}

function hashPin(pin, salt) {
  const h = crypto.pbkdf2Sync(pin, salt, 120000, 32, "sha256");
  return h.toString("hex");
}

// ===== PANEL SESSION TOKEN (cookie) =====
function signPanelToken(venueId) {
  const ts = Date.now();
  const payload = `${venueId}|${ts}`;
  const hmac = crypto.createHmac("sha256", String(WEBHOOK_SECRET)).update(payload).digest("hex");
  return `${payload}|${hmac}`;
}

function verifyPanelToken(token) {
  if (!token) return null;
  const parts = token.split("|");
  if (parts.length !== 3) return null;

  const [venueIdStr, tsStr, sig] = parts;
  const payload = `${venueIdStr}|${tsStr}`;
  const expected = crypto.createHmac("sha256", String(WEBHOOK_SECRET)).update(payload).digest("hex");
  if (expected !== sig) return null;

  const venueId = Number(venueIdStr);
  if (!Number.isInteger(venueId) || venueId <= 0) return null;

  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return null;

  // session valid 30 days
  const age = Date.now() - ts;
  if (age > 30 * 24 * 60 * 60 * 1000) return null;

  return { venueId };
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

  // Venues + PIN fields
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

  // FIX: add missing columns if venues already existed
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pin_salt TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pin_hash TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pin_enc  TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pin_iv   TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pin_tag  TEXT;`);

  // Checkins
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

  // Counted visits
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

  // Seed test venues
  const c = await pool.query("SELECT COUNT(*)::int AS n FROM venues");
  if ((c.rows[0]?.n || 0) === 0) {
    await pool.query(
      "INSERT INTO venues (name, city) VALUES ($1,$2), ($3,$4)",
      ["Test Kebab #1", "Warsaw", "Test Pizza #2", "Warsaw"]
    );
    console.log("✅ DB: seeded test venues (2)");
  }

  // Ensure PINs
  await ensureVenuePins();

  console.log("✅ DB ready");
}

async function ensureVenuePins() {
  const { rows } = await pool.query("SELECT id, name, pin_hash FROM venues ORDER BY id ASC");
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

// ===== CORE CONFIRM LOGIC =====
async function confirmByOtpForVenue(venueId, otp) {
  await expireOldCheckins();

  const venue = await getVenueById(venueId);
  if (!venue) return { ok: false, msg: "❌ Brak takiego lokalu." };

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
    return { ok: false, msg: "❌ Nie znaleziono pending check-in. OTP mogło wygasnąć (10 min)." };
  }

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

  let inviteText = "";
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
        inviteText =
          `🎟 +1 earned invite (za 5 counted visits)\n` +
          `🏁 Earned Invites: ${updated.earned_invites}\n` +
          `👑 OWNER: invites są praktycznie bez limitu.`;
      } else {
        await pool.query(
          "UPDATE foxes SET invites = invites + 1, updated_at = NOW() WHERE user_id = $1",
          [userId]
        );
        inviteText = "🎟 +1 invite za 5 counted visits!";
      }
    } else {
      inviteText = `📈 Do następnego invite: jeszcze ${5 - progress} counted visit(ów).`;
    }
  }

  const { X, Y } = await getXYForVenue(venueId, userId);

  return {
    ok: true,
    venueName: venue.name,
    dayISO,
    countedAdded,
    X,
    Y,
    inviteText,
  };
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Nie jesteś adminem.");
  await ownerEnsure(ctx.from.id);
  return ctx.reply("👑 Jesteś ADMIN (owner mode).");
});

bot.command("venuepin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Tylko OWNER.");
  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  if (!Number.isInteger(venueId) || venueId <= 0) return ctx.reply("❌ Napisz tak: /venuepin 1");

  const v = await getVenueById(venueId);
  if (!v || !v.pin_enc) return ctx.reply("❌ PIN nie znaleziony (sprawdź logi Railway po starcie).");

  const pin = decryptText(v.pin_enc, v.pin_iv, v.pin_tag);
  return ctx.reply(`🔐 PIN dla "${v.name}" (ID ${v.id}): ${pin}\n\nPanel: otwórz /panel w przeglądarce`);
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await createFoxIfMissing(userId);
  await ownerEnsure(userId);

  return ctx.reply(
    "🦊 Witamy w FoxPot Club\n\n" +
      "Lista lokali: /venues\n" +
      "Strona lokalu: /venue 1\n" +
      "Check-in: /checkin 1\n" +
      "Confirm (test OWNER): /confirm 1 123456\n" +
      "PIN (OWNER): /venuepin 1\n" +
      "Panel (browser): /panel\n" +
      "Status: /me\n"
  );
});

bot.command("me", async (ctx) => {
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const fox = await getFox(userId);
  if (!fox) return ctx.reply("❌ Kliknij /start");

  const progress = fox.visits % 5;
  const remaining = progress === 0 ? 0 : 5 - progress;

  if (isAdmin(ctx)) {
    const maxOther = await getMaxRatingExcludingAdmin();
    return ctx.reply(
      "👑 OWNER STATUS\n\n" +
        `🎟 Invites: ${fox.invites}\n` +
        `⭐ Rating: ${fox.rating}\n` +
        `👣 Counted Visits (total): ${fox.visits}\n` +
        `🏁 Earned Invites: ${fox.earned_invites}\n\n` +
        (remaining === 0
          ? "✅ Następny earned invite naliczy się na wielokrotności 5.\n"
          : `📈 Do następnego earned invite: jeszcze ${remaining} counted visit(ów).\n`) +
        `📌 Zasada: OWNER = MAX_innych(${maxOther}) + ${OWNER_RATING_GAP}`
    );
  }

  return ctx.reply(
    "🦊 Twój status\n\n" +
      `🎟 Invites: ${fox.invites}\n` +
      `⭐ Rating: ${fox.rating}\n` +
      `👣 Counted Visits (total): ${fox.visits}\n\n` +
      (remaining === 0
        ? "✅ Następny invite naliczy się na wielokrotności 5."
        : `📈 Do następnego invite: jeszcze ${remaining} counted visit(ów).`)
  );
});

bot.command("venues", async (ctx) => {
  await expireOldCheckins();
  const rows = await listVenues();

  if (!rows.length) return ctx.reply("Brak lokali.");

  let text = "🗺 Lokale (testowe)\n\n";
  for (const v of rows) {
    text += `• ID ${v.id}: ${v.name} (${v.city})\n`;
  }
  text += "\nStrona: /venue 1";
  return ctx.reply(text);
});

bot.command("venue", async (ctx) => {
  await expireOldCheckins();
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);

  if (!Number.isInteger(venueId) || venueId <= 0) {
    return ctx.reply("❌ Napisz tak: /venue 1");
  }

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Brak takiego lokalu. Zobacz /venues");

  const { X, Y } = await getXYForVenue(venueId, userId);

  return ctx.reply(
    `🏪 ${venue.name} (${venue.city})\n\n` +
      `📊 X/Y: ${X}/${Y}\n\n` +
      `Check-in: /checkin ${venueId}\n`
  );
});

bot.command("checkin", async (ctx) => {
  await expireOldCheckins();
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);

  if (!Number.isInteger(venueId) || venueId <= 0) {
    return ctx.reply("❌ Napisz tak: /checkin 1");
  }

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Brak takiego lokalu. Zobacz /venues");

  const otp = randomOtp6();
  await pool.query(
    `
    INSERT INTO checkins (user_id, venue_id, otp, status, expires_at)
    VALUES ($1, $2, $3, 'pending', NOW() + INTERVAL '10 minutes')
  `,
    [userId, venueId, otp]
  );

  return ctx.reply(
    `✅ Check-in utworzony (10 min)\n\n` +
      `🏪 ${venue.name}\n` +
      `🔐 OTP: ${otp}\n\n` +
      `Personel potwierdza w Panelu (browser) /panel (PIN).\n` +
      `Do testu OWNER może: /confirm ${venueId} ${otp}`
  );
});

bot.command("confirm", async (ctx) => {
  await expireOldCheckins();
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Confirm tylko dla OWNER (test). Realnie potwierdza lokal przez /panel.");
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  const otp = (parts[2] || "").trim();

  if (!Number.isInteger(venueId) || venueId <= 0 || otp.length !== 6) {
    return ctx.reply("❌ Napisz tak: /confirm 1 123456");
  }

  const r = await confirmByOtpForVenue(venueId, otp);
  if (!r.ok) return ctx.reply(r.msg);

  let msg = `✅ Confirm OK\n🏪 ${r.venueName}\n📅 Day (Warsaw): ${r.dayISO}\n\n`;
  if (!r.countedAdded) {
    msg += "ℹ️ Counted już był dziś dla tego Foxa w tym lokalu.\nZasada: max 1 counted/dzień/lokal/Fox.\n\n";
  } else {
    msg += `${r.inviteText}\n\n✅ Counted dodano i zaliczono do statystyk.\n\n`;
  }
  msg += `📊 X/Y: ${r.X}/${r.Y}`;
  return ctx.reply(msg);
});

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

// ===== PANEL =====
app.get("/panel", async (req, res) => {
  const cookies = parseCookies(req);
  const data = verifyPanelToken(cookies.panel_token);

  if (!data) {
    return res.status(200).send(`
      <html><head><meta charset="utf-8"><title>Panel</title></head>
      <body style="font-family: Arial; max-width: 520px; margin: 30px auto;">
        <h2>THE FOX POT CLUB — Panel Lokalu</h2>
        <p><b>PIN</b> = 6 cyfr (hasło lokalu dla personelu)</p>
        <form method="POST" action="/panel/login">
          <input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
                 style="font-size:20px; padding:8px; width:220px;" required />
          <br/><br/>
          <button type="submit" style="font-size:18px; padding:10px 16px;">Zaloguj</button>
        </form>
      </body></html>
    `);
  }

  const venue = await getVenueById(data.venueId);
  const pending = await getPendingForVenue(venue.id);

  const list = pending.length
    ? pending
        .map(
          (p) =>
            `<li><b>${p.otp}</b> (wygasa: ${new Date(p.expires_at).toLocaleString()})</li>`
        )
        .join("")
    : "<li>Brak pending</li>";

  return res.status(200).send(`
    <html><head><meta charset="utf-8"><title>Panel</title></head>
    <body style="font-family: Arial; max-width: 720px; margin: 30px auto;">
      <h2>Panel Lokalu</h2>
      <p><b>Lokal:</b> ${venue.name}</p>

      <h3>Potwierdź OTP</h3>
      <form method="POST" action="/panel/confirm">
        <input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
               style="font-size:20px; padding:8px; width:220px;" required />
        <br/><br/>
        <button type="submit" style="font-size:18px; padding:10px 16px;">CONFIRM</button>
      </form>

      <h3>Pending (10 min)</h3>
      <ul>${list}</ul>

      <p><a href="/panel/logout">Wyloguj</a></p>
    </body></html>
  `);
});

app.post("/panel/login", async (req, res) => {
  const pin = String(req.body.pin || "").trim();
  if (!/^[0-9]{6}$/.test(pin)) {
    return res.status(400).send("❌ PIN musi mieć 6 cyfr. <a href='/panel'>Wróć</a>");
  }

  const { rows } = await pool.query("SELECT id, pin_salt, pin_hash FROM venues WHERE pin_hash IS NOT NULL");
  let matched = null;

  for (const v of rows) {
    if (hashPin(pin, v.pin_salt) === v.pin_hash) {
      matched = v.id;
      break;
    }
  }

  if (!matched) return res.status(401).send("❌ Błędny PIN. <a href='/panel'>Wróć</a>");

  const token = signPanelToken(matched);
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
    return res.status(400).send("❌ OTP musi mieć 6 cyfr. <a href='/panel'>Wróć</a>");
  }

  const r = await confirmByOtpForVenue(data.venueId, otp);
  if (!r.ok) return res.status(400).send(`${r.msg} <br/><a href='/panel'>Wróć</a>`);

  // ✅ WIELKI TEKST PO POLSKU
  const bigBox = r.countedAdded
    ? `
      <div style="padding:16px; border:2px solid #0a0; border-radius:12px; margin:16px 0;">
        <div style="font-size:26px; font-weight:800;">DODANO ✅</div>
        <div style="font-size:16px; margin-top:8px;">Wizyta została zaliczona do statystyk.</div>
      </div>
    `
    : `
      <div style="padding:16px; border:2px solid #d08b00; border-radius:12px; margin:16px 0;">
        <div style="font-size:26px; font-weight:800;">DZIŚ JUŻ BYŁO ✅</div>
        <div style="font-size:16px; margin-top:8px;">
          Ten Fox w tym lokalu ma już <b>1 counted visit</b> za <b>${r.dayISO}</b>.
          <br/><br/>
          <b>Spróbuj jutro po 00:00 (Warszawa).</b>
        </div>
      </div>
    `;

  return res.status(200).send(`
    <html><head><meta charset="utf-8"><title>OK</title></head>
    <body style="font-family: Arial; max-width: 720px; margin: 30px auto;">
      <h2>✅ Confirm OK</h2>
      <p><b>Lokal:</b> ${r.venueName}</p>
      <p><b>Dzień (Warszawa):</b> ${r.dayISO}</p>

      ${bigBox}

      <p><b>X/Y:</b> ${r.X}/${r.Y}</p>
      <p><a href="/panel">Wróć do Panelu</a></p>
    </body></html>
  `);
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on ${PORT}`);
  console.log(`✅ Webhook path: ${webhookPath}`);
});

(async () => {
  try {
    await initDb();
  } catch (e) {
    console.error("❌ DB init failed:", e);
  }
})();
