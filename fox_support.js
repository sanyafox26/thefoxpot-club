"use strict";

/**
 * FOX SUPPORT SYSTEM — Phase 1 v2
 *
 * Self-service support for Fox users inside the Telegram bot.
 * Uber/Revolut-style: buttons first, no free text until structured escalation.
 *
 * v2 CHANGES:
 *  ✅ Problem fingerprint (problem_key in admin ticket + analytics)
 *  ✅ Block user spam button (🚫 Ogranicz zgłoszenia → 24h block)
 *  ✅ Auto-close sends message to Fox
 *  ✅ Priority with colored squares: 🟥 High 🟧 Medium 🟩 Low
 *  ✅ Member since in ticket context
 *  ✅ 🔍 Sprawdź status — live system check before escalation
 *  ✅ Updated confirmation: "Odpowiemy w ciągu 24 godzin, jeśli będzie potrzebna dodatkowa informacja."
 *
 * Integration: require this module and call setupSupport(bot, pool, { ADMIN_TG_ID })
 */

/* ═══════════════════════════════════════════════════════════════
   SUPPORT FAQ TREE
   Each category → list of problems → answer + action + second step
   + statusCheck function for live system diagnostics
═══════════════════════════════════════════════════════════════ */

const SUPPORT_CATEGORIES = {
  checkin: {
    emoji: "📍",
    label: "Check-in",
    intro: "Najczęstsze problemy z check-in:",
    problems: {
      cant_checkin: {
        label: "Nie mogę zrobić check-in",
        answer: "🔹 Upewnij się, że jesteś w lokalu\n🔹 Sprawdź połączenie z internetem\n🔹 Spróbuj ponownie za chwilę",
        action: { text: "🔄 Spróbuj ponownie", key: "retry_checkin" },
        step2_answer: "🔹 Zamknij aplikację i otwórz ponownie\n🔹 Sprawdź, czy lokal jest aktywny w /venues\n🔹 Upewnij się, że Twoje konto nie jest zablokowane",
        step2_action: { text: "🏪 Lista lokali", key: "show_venues" },
        priority: "high",
        hasStatusCheck: true,
      },
      venue_not_confirmed: {
        label: "Lokal nie potwierdził wizyty",
        answer: "🔹 Lokal powinien potwierdzić wizytę po wpisaniu kodu wizyty\n🔹 Jeśli status się nie zmienia — poczekaj kilka minut\n🔹 Pokaż kod wizyty personelowi ponownie",
        action: { text: "📋 Sprawdź status wizyty", key: "check_visit_status" },
        step2_answer: "🔹 Poprosź personel o sprawdzenie panelu\n🔹 Upewnij się, że kod wizyty nie wygasł (ważny 10 min)\n🔹 Jeśli problem nie ustąpi — zgłoś poniżej",
        step2_action: { text: "🔑 Nowy check-in", key: "new_checkin" },
        priority: "high",
        hasStatusCheck: true,
      },
      no_checkin_button: {
        label: "Nie widzę przycisku check-in",
        answer: "🔹 Przycisk check-in jest widoczny na stronie lokalu\n🔹 Otwórz kartę lokalu i spróbuj ponownie\n🔹 Upewnij się, że masz aktualną wersję aplikacji",
        action: { text: "🗺️ Otwórz mapę lokali", key: "open_map" },
        step2_answer: "🔹 Spróbuj zamknąć i ponownie otworzyć aplikację\n🔹 Wyczyść cache przeglądarki\n🔹 Otwórz aplikację przez link w bocie: /start",
        step2_action: { text: "🏠 Menu główne", key: "main_menu" },
        priority: "medium",
        hasStatusCheck: false,
      },
      checkin_not_saved: {
        label: "Check-in nie został zapisany",
        answer: "🔹 Check-in może pojawić się z opóźnieniem\n🔹 Sprawdź po chwili ponownie w profilu\n🔹 Upewnij się, że kod wizyty został potwierdzony przez lokal",
        action: { text: "🔄 Sprawdź ponownie", key: "retry_checkin" },
        step2_answer: "🔹 Otwórz /achievements i sprawdź liczbę wizyt\n🔹 Wizyta jest naliczana tylko raz dziennie w danym lokalu\n🔹 Jeśli nadal brak — zgłoś problem poniżej",
        step2_action: { text: "📜 Historia wizyt", key: "visit_history" },
        priority: "high",
        hasStatusCheck: true,
      },
    },
  },

  otp: {
    emoji: "🔑",
    label: "Kod wizyty",
    intro: "Najczęstsze problemy z kodem wizyty:",
    problems: {
      otp_not_working: {
        label: "Kod wizyty nie działa",
        answer: "🔹 Upewnij się, że wpisujesz prawidłowy 6-cyfrowy kod\n🔹 Kod jest ważny 10 minut od wygenerowania\n🔹 Sprawdź, czy nie ma literówki",
        action: { text: "🔁 Wyślij kod ponownie", key: "resend_otp" },
        step2_answer: "🔹 Wygeneruj nowy check-in przez /checkin <venue_id>\n🔹 Pokaż nowy kod personelowi\n🔹 Jeśli nadal nie działa — zgłoś problem",
        step2_action: { text: "🆕 Nowy check-in", key: "new_checkin" },
        priority: "high",
        hasStatusCheck: true,
      },
      no_otp_received: {
        label: "Nie dostałem kodu",
        answer: "🔹 Kod wizyty wyświetla się w bocie po /checkin <venue_id>\n🔹 Sprawdź historię wiadomości w bocie\n🔹 Upewnij się, że wpisałeś poprawne venue_id",
        action: { text: "🆕 Pokaż nowy kod", key: "new_checkin" },
        step2_answer: "🔹 Sprawdź listę lokali: /venues\n🔹 Użyj poprawnego ID lokalu\n🔹 Spróbuj ponownie lub zgłoś problem",
        step2_action: { text: "🏪 Lista lokali", key: "show_venues" },
        priority: "medium",
        hasStatusCheck: true,
      },
      otp_expired: {
        label: "Kod wygasł",
        answer: "🔹 Kod wizyty jest ważny 10 minut\n🔹 Wygeneruj nowy check-in: /checkin <venue_id>\n🔹 Pokaż nowy kod personelowi od razu",
        action: { text: "🆕 Pokaż nowy kod", key: "new_checkin" },
        step2_answer: "🔹 Jeśli kod wygasa zbyt szybko — zrób check-in tuż przed pokazaniem personelowi\n🔹 Możesz też poprosić personel o szybszą weryfikację",
        step2_action: { text: "📋 Sprawdź status kodu", key: "check_otp_status" },
        priority: "low",
        hasStatusCheck: true,
      },
      otp_entered_nothing: {
        label: "Wpisałem kod, ale nic się nie stało",
        answer: "🔹 Kod wpisuje personel w panelu lokalu, nie Ty\n🔹 Pokaż kod wizyty na ekranie telefonu pracownikowi\n🔹 Poczekaj na potwierdzenie",
        action: { text: "📋 Sprawdź status kodu", key: "check_otp_status" },
        step2_answer: "🔹 Poprosź personel o otwarcie panelu lokalu\n🔹 Panel dostępny pod: /panel\n🔹 Jeśli lokal nie może potwierdzić — zgłoś problem",
        step2_action: { text: "🔄 Sprawdź ponownie", key: "retry_checkin" },
        priority: "medium",
        hasStatusCheck: true,
      },
    },
  },

  discount: {
    emoji: "🎟️",
    label: "Zniżka / rezerwacja",
    intro: "Problemy ze zniżką lub rezerwacją:",
    problems: {
      reservation_not_working: {
        label: "Nie działa rezerwacja",
        answer: "🔹 Rezerwacja jest dostępna tylko w wybranych lokalach\n🔹 Sprawdź, czy lokal obsługuje rezerwacje\n🔹 Rezerwacja wygasa po określonym czasie",
        action: { text: "📋 Sprawdź rezerwację", key: "check_reservation" },
        step2_answer: "🔹 Sprawdź w aplikacji status swojej rezerwacji\n🔹 Upewnij się, że rezerwacja nie wygasła\n🔹 Spróbuj zarezerwować ponownie",
        step2_action: { text: "🔄 Spróbuj ponownie", key: "retry_reservation" },
        priority: "high",
        hasStatusCheck: true,
      },
      discount_not_activated: {
        label: "Zniżka się nie aktywowała",
        answer: "🔹 Zniżka aktywuje się po poprawnym check-in\n🔹 Upewnij się, że wizyta została potwierdzona przez lokal\n🔹 Sprawdź w profilu status wizyty",
        action: { text: "👤 Otwórz profil", key: "open_profile" },
        step2_answer: "🔹 Zniżka obowiązuje w dniu wizyty\n🔹 Pokaż personelowi ekran z potwierdzeniem\n🔹 Jeśli lokal nie daje zniżki — zgłoś problem",
        step2_action: { text: "📋 Sprawdź status", key: "check_visit_status" },
        priority: "high",
        hasStatusCheck: true,
      },
      how_to_use_discount: {
        label: "Nie wiem jak użyć zniżki",
        answer: "🔹 Zrób check-in w lokalu: /checkin <venue_id>\n🔹 Pokaż personelowi kod wizyty\n🔹 Po potwierdzeniu — zniżka aktywna na ten dzień\n🔹 Poinformuj kelnera przed zamówieniem",
        action: { text: "🏪 Lista lokali", key: "show_venues" },
        step2_answer: "🔹 Zniżka wynosi domyślnie 10%\n🔹 Obowiązuje na cały rachunek w dniu wizyty\n🔹 Niektóre lokale mogą mieć indywidualną zniżkę",
        step2_action: { text: "🗺️ Otwórz mapę lokali", key: "open_map" },
        priority: "low",
        hasStatusCheck: false,
      },
      reservation_disappeared: {
        label: "Rezerwacja zniknęła",
        answer: "🔹 Rezerwacja może wygasać po określonym czasie\n🔹 Sprawdź, czy nie minął termin ważności\n🔹 Rezerwacja jest widoczna tylko do momentu wykorzystania lub wygaśnięcia",
        action: { text: "📋 Sprawdź rezerwację", key: "check_reservation" },
        step2_answer: "🔹 Jeśli rezerwacja wygasła — utwórz nową\n🔹 Pamiętaj o limicie czasu na realizację\n🔹 Jeśli uważasz, że to błąd — zgłoś poniżej",
        step2_action: { text: "🔄 Spróbuj ponownie", key: "retry_reservation" },
        priority: "medium",
        hasStatusCheck: true,
      },
    },
  },

  account: {
    emoji: "🦊",
    label: "Konto Fox",
    intro: "Problemy z kontem Fox:",
    problems: {
      rating_not_added: {
        label: "Nie naliczyło rating",
        answer: "🔹 Rating nalicza się po poprawnym check-in potwierdzonym przez lokal\n🔹 Bonus przyznawany jest po złożeniu rachunku\n🔹 Sprawdź w profilu aktualną liczbę punktów",
        action: { text: "🔄 Sprawdź ponownie", key: "check_profile" },
        step2_answer: "🔹 Rating +1 za każdą potwierdzoną wizytę\n🔹 Dodatkowe punkty za osiągnięcia i spin\n🔹 Sprawdź /achievements i /top",
        step2_action: { text: "🏆 Osiągnięcia", key: "show_achievements" },
        priority: "medium",
        hasStatusCheck: true,
      },
      invites_missing: {
        label: "Gdzie są moje invites",
        answer: "🔹 Zaproszenia pojawiają się po odpowiednich akcjach\n🔹 +1 invite za każde 5 potwierdzonych wizyt\n🔹 Sprawdź: /refer",
        action: { text: "👤 Otwórz profil", key: "open_profile" },
        step2_answer: "🔹 Zaproszenia możesz też wygrać w daily spin\n🔹 Sprawdź /spin\n🔹 Bonus zaproszeń za rejestrację nowego Fox",
        step2_action: { text: "🎰 Daily Spin", key: "daily_spin" },
        priority: "low",
        hasStatusCheck: false,
      },
      stamps_not_visible: {
        label: "Nie widzę stempli",
        answer: "🔹 Stemple są widoczne w profilu po zapisaniu przez lokal\n🔹 Sprawdź: /stamps <venue_id>\n🔹 Stemple przyznaje personel lokalu",
        action: { text: "📜 Historia wizyt", key: "visit_history" },
        step2_answer: "🔹 Poprosź personel lokalu o dodanie stempla\n🔹 Stemple są powiązane z konkretnym lokalem\n🔹 Jeśli brak — zgłoś problem",
        step2_action: { text: "🔄 Sprawdź ponownie", key: "check_profile" },
        priority: "low",
        hasStatusCheck: false,
      },
      visit_history_missing: {
        label: "Nie widzę historii wizyt",
        answer: "🔹 Historia wizyt może wymagać odświeżenia\n🔹 Sprawdź: /achievements — tam widać liczbę wizyt\n🔹 Otwórz aplikację ponownie",
        action: { text: "📜 Historia wizyt", key: "visit_history" },
        step2_answer: "🔹 Historia wizyt jest widoczna w aplikacji\n🔹 Odśwież stronę lub zamknij i otwórz ponownie\n🔹 Jeśli nadal brak — zgłoś poniżej",
        step2_action: { text: "🔄 Odśwież", key: "refresh_app" },
        priority: "low",
        hasStatusCheck: false,
      },
    },
  },

  technical: {
    emoji: "⚙️",
    label: "Problem techniczny",
    intro: "Najczęstsze problemy techniczne:",
    problems: {
      app_not_opening: {
        label: "Aplikacja się nie otwiera",
        answer: "🔹 Zamknij i otwórz Telegram ponownie\n🔹 Kliknij przycisk \"Otwórz FoxPot App\" w bocie\n🔹 Sprawdź połączenie z internetem",
        action: { text: "🏠 Wróć do głównego menu", key: "main_menu" },
        step2_answer: "🔹 Zaktualizuj Telegram do najnowszej wersji\n🔹 Spróbuj na innym urządzeniu\n🔹 Wyczyść cache Telegrama",
        step2_action: { text: "🔄 Odśwież", key: "refresh_app" },
        priority: "medium",
        hasStatusCheck: false,
      },
      map_not_working: {
        label: "Mapa nie działa",
        answer: "🔹 Sprawdź, czy masz włączoną lokalizację\n🔹 Odśwież stronę z mapą\n🔹 Poczekaj chwilę — mapa może się ładować",
        action: { text: "🗺️ Otwórz mapę", key: "open_map" },
        step2_answer: "🔹 Spróbuj otworzyć mapę z poziomu profilu\n🔹 Upewnij się, że przeglądarka ma dostęp do GPS\n🔹 Jeśli nadal nie działa — zgłoś problem",
        step2_action: { text: "🔄 Odśwież", key: "refresh_app" },
        priority: "medium",
        hasStatusCheck: false,
      },
      nothing_loading: {
        label: "Nic się nie ładuje",
        answer: "🔹 Sprawdź połączenie z internetem\n🔹 Zamknij i otwórz aplikację ponownie\n🔹 Spróbuj w innej sieci (Wi-Fi / dane mobilne)",
        action: { text: "🔄 Odśwież", key: "refresh_app" },
        step2_answer: "🔹 Wyczyść cache przeglądarki\n🔹 Zaktualizuj Telegram\n🔹 Spróbuj na innym urządzeniu",
        step2_action: { text: "🏠 Wróć do głównego menu", key: "main_menu" },
        priority: "medium",
        hasStatusCheck: false,
      },
      error_on_click: {
        label: "Wyskakuje błąd po kliknięciu",
        answer: "🔹 Odśwież aplikację i spróbuj ponownie\n🔹 Zamknij inne aplikacje w tle\n🔹 Zrestartuj Telegram",
        action: { text: "🔄 Odśwież", key: "refresh_app" },
        step2_answer: "🔹 Jeśli błąd się powtarza — zanotuj co dokładnie klikasz\n🔹 Spróbuj wyczyścić cache\n🔹 Zgłoś problem z opisem błędu poniżej",
        step2_action: { text: "🏠 Wróć do głównego menu", key: "main_menu" },
        priority: "medium",
        hasStatusCheck: false,
      },
    },
  },

  subscription: {
    emoji: "🎁",
    label: "Bonus za subskrypcję",
    intro: "Problemy z bonusem za subskrypcję:",
    problems: {
      bonus_not_working: {
        label: "Nie działa bonus",
        answer: "🔹 Kliknięcie \"Subskrybuj\" samo w sobie nie wystarczy\n🔹 Musisz wrócić i kliknąć \"Sprawdź\"\n🔹 Bonus przyznawany jest tylko raz za platformę",
        action: { text: "✅ Sprawdź subskrypcję", key: "check_subscription" },
        step2_answer: "🔹 Upewnij się, że faktycznie zasubskrybowałeś kanał\n🔹 Kliknij \"Sprawdź\" po powrocie do aplikacji\n🔹 Bonus: +1 rating za platformę",
        step2_action: { text: "✅ Sprawdź ponownie", key: "check_subscription" },
        priority: "low",
        hasStatusCheck: true,
      },
      subscribe_nothing_happened: {
        label: "Kliknąłem Subskrybuj, ale nic się nie stało",
        answer: "🔹 Kliknięcie \"Subskrybuj\" otwiera link do kanału\n🔹 Zasubskrybuj kanał, a następnie wróć do aplikacji\n🔹 Kliknij \"Sprawdź\" — dopiero wtedy bonus się naliczy",
        action: { text: "✅ Sprawdź subskrypcję", key: "check_subscription" },
        step2_answer: "🔹 Weryfikacja wymaga czasu — poczekaj chwilę\n🔹 Upewnij się, że jesteś zalogowany na tym samym koncie\n🔹 Spróbuj ponownie za minutę",
        step2_action: { text: "🔄 Sprawdź ponownie", key: "check_subscription" },
        priority: "low",
        hasStatusCheck: true,
      },
      no_rating_for_sub: {
        label: "Nie dostałem rating",
        answer: "🔹 Rating za subskrypcję wynosi +1 za platformę\n🔹 Bonus przyznawany tylko raz\n🔹 Sprawdź, czy kliknąłeś \"Sprawdź\" po subskrypcji",
        action: { text: "✅ Sprawdź subskrypcję", key: "check_subscription" },
        step2_answer: "🔹 Sprawdź w profilu aktualny rating\n🔹 Jeśli subskrypcja już była weryfikowana — bonus nie powtarza się\n🔹 Bonus za komplet (4 platformy): +1 invite",
        step2_action: { text: "👤 Otwórz profil", key: "open_profile" },
        priority: "low",
        hasStatusCheck: true,
      },
      no_invite_for_set: {
        label: "Nie dostałem invite za komplet",
        answer: "🔹 Invite za komplet przyznawany jest po weryfikacji WSZYSTKICH 4 platform\n🔹 Sprawdź, czy każda platforma ma status ✅\n🔹 Kliknij \"Sprawdź\" przy każdej platformie",
        action: { text: "✅ Sprawdź subskrypcję", key: "check_subscription" },
        step2_answer: "🔹 Invite za komplet przyznawany jest tylko raz\n🔹 Jeśli już otrzymałeś — nie powtarza się\n🔹 Sprawdź /refer — tam widać Twoje zaproszenia",
        step2_action: { text: "👤 Otwórz profil", key: "open_profile" },
        priority: "low",
        hasStatusCheck: true,
      },
    },
  },
};

/* ═══════════════════════════════════════════════════════════════
   PRIORITY LOGIC — v2: colored squares
═══════════════════════════════════════════════════════════════ */
const PRIORITY_LABELS = { high: "🟥 Wysoki", medium: "🟧 Średni", low: "🟩 Niski" };

function detectPriority(category, problemKey) {
  const cat = SUPPORT_CATEGORIES[category];
  if (!cat) return "medium";
  const prob = cat.problems[problemKey];
  return prob?.priority || "medium";
}

/* ═══════════════════════════════════════════════════════════════
   MIGRATION — support tables (v2: support_block_until)
═══════════════════════════════════════════════════════════════ */
async function migrateSupport(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_support_tickets (
      id              BIGSERIAL PRIMARY KEY,
      fox_id          BIGINT,
      telegram_user_id BIGINT NOT NULL,
      username        TEXT,
      category        TEXT NOT NULL,
      problem_key     TEXT NOT NULL,
      venue_id        BIGINT,
      venue_name      TEXT,
      short_message   TEXT,
      attachment_url  TEXT,
      status          TEXT NOT NULL DEFAULT 'open',
      priority        TEXT NOT NULL DEFAULT 'medium',
      admin_message_id BIGINT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_support_events (
      id          BIGSERIAL PRIMARY KEY,
      ticket_id   BIGINT NOT NULL REFERENCES fp1_support_tickets(id) ON DELETE CASCADE,
      event_type  TEXT NOT NULL,
      payload     JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_support_faq_hits (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL,
      category    TEXT NOT NULL,
      problem_key TEXT NOT NULL,
      resolved    BOOLEAN NOT NULL DEFAULT FALSE,
      step        INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // v2: support_block_until column on foxes for spam block
  try {
    await pool.query(
      `ALTER TABLE fp1_foxes ADD COLUMN IF NOT EXISTS support_block_until TIMESTAMPTZ`
    );
  } catch {}

  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_fp1_support_tickets_user ON fp1_support_tickets(telegram_user_id)`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_fp1_support_tickets_status ON fp1_support_tickets(status)`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_fp1_support_faq_hits_cat ON fp1_support_faq_hits(category, problem_key)`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_fp1_support_tickets_problem ON fp1_support_tickets(problem_key)`); } catch {}

  console.log("✅ Support tables migrated (v2)");
}

/* ═══════════════════════════════════════════════════════════════
   IN-MEMORY STATE
═══════════════════════════════════════════════════════════════ */
const supportState = new Map();

function getState(userId) { return supportState.get(String(userId)); }
function setState(userId, data) { supportState.set(String(userId), { ...data, ts: Date.now() }); }
function clearState(userId) { supportState.delete(String(userId)); }

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of supportState) {
    if (v.ts < cutoff) supportState.delete(k);
  }
}, 30 * 60 * 1000);

/* ═══════════════════════════════════════════════════════════════
   RATE LIMIT + SPAM BLOCK (v2)
═══════════════════════════════════════════════════════════════ */
async function canEscalate(pool, userId) {
  // Check spam block first
  const block = await pool.query(
    `SELECT support_block_until FROM fp1_foxes WHERE user_id=$1 AND support_block_until > NOW() LIMIT 1`,
    [userId]
  );
  if (block.rowCount > 0) return { allowed: false, reason: "blocked" };

  // Check daily limit
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_support_tickets
     WHERE telegram_user_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId]
  );
  if (r.rows[0].c >= 2) return { allowed: false, reason: "limit" };

  return { allowed: true };
}

/* ═══════════════════════════════════════════════════════════════
   🔍 LIVE STATUS CHECK — Revolut-style diagnostics (v2)
═══════════════════════════════════════════════════════════════ */
async function runStatusCheck(pool, userId, category, problemKey) {
  const uid = String(userId);
  const lines = [];

  // ── CHECK-IN & OTP STATUS ──
  if (category === "checkin" || category === "otp") {
    const lastCheckin = await pool.query(
      `SELECT venue_id, otp, created_at, confirmed_at, expires_at
       FROM fp1_checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [uid]
    );
    if (lastCheckin.rowCount === 0) {
      lines.push("📋 Brak check-in w systemie.");
      lines.push("Użyj /checkin <venue_id> aby rozpocząć.");
    } else {
      const c = lastCheckin.rows[0];
      const venue = await pool.query(`SELECT name FROM fp1_venues WHERE id=$1`, [c.venue_id]);
      const vName = venue.rows[0]?.name || `ID ${c.venue_id}`;
      const created = new Date(c.created_at).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" });

      if (c.confirmed_at) {
        lines.push(`✅ Ostatni check-in: potwierdzony`);
        lines.push(`🏪 Lokal: ${vName}`);
        lines.push(`🕐 ${created}`);
      } else if (new Date(c.expires_at) < new Date()) {
        lines.push(`❌ Ostatni check-in: kod wygasł`);
        lines.push(`🏪 Lokal: ${vName}`);
        lines.push(`🔑 Kod wizyty: ${c.otp} (wygasł)`);
        lines.push(`💡 Wygeneruj nowy: /checkin ${c.venue_id}`);
      } else {
        lines.push(`⏳ Ostatni check-in: oczekuje na potwierdzenie lokalu`);
        lines.push(`🏪 Lokal: ${vName}`);
        lines.push(`🔑 Kod wizyty: ${c.otp}`);
        lines.push(`Może to potrwać kilka minut.`);
      }
    }

    // Today's visit
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
    const todayVisit = await pool.query(
      `SELECT venue_id FROM fp1_counted_visits WHERE user_id=$1 AND war_day=$2`, [uid, today]
    );
    if (todayVisit.rowCount > 0) {
      lines.push(`\n✅ Wizyta dziś: zaliczona (${todayVisit.rowCount} lokal/e)`);
    } else {
      lines.push(`\nℹ️ Wizyta dziś: jeszcze nie zaliczona`);
    }
  }

  // ── RATING CHECK ──
  if (category === "account" && problemKey === "rating_not_added") {
    const fox = await pool.query(`SELECT rating, streak_current FROM fp1_foxes WHERE user_id=$1`, [uid]);
    if (fox.rowCount > 0) {
      lines.push(`📊 Aktualny rating: ${fox.rows[0].rating} pkt`);
      lines.push(`🔥 Streak: ${fox.rows[0].streak_current || 0} dni`);
    }
    const lastCheckin = await pool.query(
      `SELECT confirmed_at FROM fp1_checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [uid]
    );
    if (lastCheckin.rowCount > 0) {
      if (lastCheckin.rows[0].confirmed_at) {
        lines.push(`✅ Ostatni check-in: potwierdzony`);
        lines.push(`Rating zostanie/został dodany po potwierdzeniu.`);
      } else {
        lines.push(`⏳ Ostatni check-in: oczekuje na potwierdzenie`);
        lines.push(`Rating zostanie dodany po potwierdzeniu wizyty.`);
      }
    }
  }

  // ── RESERVATION CHECK ──
  if (category === "discount" && (problemKey === "reservation_not_working" || problemKey === "reservation_disappeared")) {
    const lastRes = await pool.query(
      `SELECT venue_id, created_at, expires_at, used, expired
       FROM fp1_reservations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [uid]
    );
    if (lastRes.rowCount === 0) {
      lines.push("📋 Brak rezerwacji w systemie.");
    } else {
      const r = lastRes.rows[0];
      const venue = await pool.query(`SELECT name FROM fp1_venues WHERE id=$1`, [r.venue_id]);
      const vName = venue.rows[0]?.name || `ID ${r.venue_id}`;
      if (r.used) {
        lines.push(`✅ Rezerwacja: użyta`);
      } else if (r.expired || new Date(r.expires_at) < new Date()) {
        lines.push(`❌ Rezerwacja: wygasła`);
        lines.push(`💡 Utwórz nową rezerwację w aplikacji.`);
      } else {
        lines.push(`⏳ Rezerwacja: aktywna`);
        lines.push(`Wygasa: ${new Date(r.expires_at).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}`);
      }
      lines.push(`🏪 Lokal: ${vName}`);
    }
  }

  // ── DISCOUNT CHECK ──
  if (category === "discount" && problemKey === "discount_not_activated") {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
    const todayVisit = await pool.query(
      `SELECT venue_id FROM fp1_counted_visits WHERE user_id=$1 AND war_day=$2`, [uid, today]
    );
    if (todayVisit.rowCount > 0) {
      lines.push(`✅ Wizyta dziś: zaliczona`);
      lines.push(`Zniżka powinna być aktywna.`);
      lines.push(`Pokaż personelowi ekran z potwierdzeniem.`);
    } else {
      const lastCheckin = await pool.query(
        `SELECT confirmed_at FROM fp1_checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [uid]
      );
      if (lastCheckin.rowCount > 0 && !lastCheckin.rows[0].confirmed_at) {
        lines.push(`⏳ Check-in oczekuje na potwierdzenie lokalu.`);
        lines.push(`Zniżka aktywuje się po potwierdzeniu.`);
      } else {
        lines.push(`ℹ️ Brak wizyty dziś.`);
        lines.push(`Zrób check-in aby aktywować zniżkę.`);
      }
    }
  }

  // ── SUBSCRIPTION CHECK ──
  if (category === "subscription") {
    const fox = await pool.query(
      `SELECT sub_instagram, sub_tiktok, sub_youtube, sub_telegram, sub_bonus_claimed
       FROM fp1_foxes WHERE user_id=$1`, [uid]
    );
    if (fox.rowCount > 0) {
      const f = fox.rows[0];
      lines.push(`📱 Status subskrypcji:`);
      lines.push(`  Instagram: ${f.sub_instagram ? "✅" : "❌"}`);
      lines.push(`  TikTok: ${f.sub_tiktok ? "✅" : "❌"}`);
      lines.push(`  YouTube: ${f.sub_youtube ? "✅" : "❌"}`);
      lines.push(`  Telegram: ${f.sub_telegram ? "✅" : "❌"}`);

      const count = [f.sub_instagram, f.sub_tiktok, f.sub_youtube, f.sub_telegram].filter(Boolean).length;
      if (count === 4) {
        lines.push(`\n✅ Komplet! ${f.sub_bonus_claimed ? "Bonus już odebrany." : "Bonus do odebrania!"}`);
      } else {
        const missing = [];
        if (!f.sub_instagram) missing.push("Instagram");
        if (!f.sub_tiktok)    missing.push("TikTok");
        if (!f.sub_youtube)   missing.push("YouTube");
        if (!f.sub_telegram)  missing.push("Telegram");
        lines.push(`\nBrakuje: ${missing.join(", ")}`);
        lines.push(`Zasubskrybuj i kliknij "Sprawdź" w aplikacji.`);
      }
    }
  }

  if (lines.length === 0) {
    lines.push("ℹ️ Nie udało się automatycznie sprawdzić statusu.");
    lines.push("Jeśli problem nadal występuje — opisz go poniżej.");
  }

  return lines.join("\n");
}

/* ═══════════════════════════════════════════════════════════════
   CONTEXT BUILDER — v2: includes member_since
═══════════════════════════════════════════════════════════════ */
async function buildTicketContext(pool, userId) {
  const ctx = {};

  const fox = await pool.query(
    `SELECT id, user_id, username, rating, invites, city, district, streak_current,
            trial_active, trial_origin_venue_id, is_demo, banned_until, created_at
     FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [String(userId)]
  );
  if (fox.rowCount > 0) {
    const f = fox.rows[0];
    ctx.fox_id = f.id;
    ctx.username = f.username;
    ctx.rating = f.rating;
    ctx.district = f.district;
    ctx.trial_active = f.trial_active;
    ctx.is_demo = f.is_demo;
    ctx.banned_until = f.banned_until;
    ctx.member_since = f.created_at;
  }

  const lastCheckin = await pool.query(
    `SELECT venue_id, otp, created_at, confirmed_at, expires_at
     FROM fp1_checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [String(userId)]
  );
  if (lastCheckin.rowCount > 0) {
    const c = lastCheckin.rows[0];
    ctx.last_checkin = {
      venue_id: c.venue_id, otp: c.otp, created: c.created_at,
      confirmed: c.confirmed_at,
      expired: !c.confirmed_at && new Date(c.expires_at) < new Date(),
    };
  }

  const lastRes = await pool.query(
    `SELECT venue_id, created_at, expires_at, used, expired
     FROM fp1_reservations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [String(userId)]
  );
  if (lastRes.rowCount > 0) ctx.last_reservation = lastRes.rows[0];

  const visits = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [String(userId)]
  );
  ctx.total_visits = visits.rows[0].c;

  // v2: previous tickets count (for spam detection)
  const prevTickets = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_support_tickets WHERE telegram_user_id=$1`, [String(userId)]
  );
  ctx.total_tickets = prevTickets.rows[0].c;

  ctx.timestamp = new Date().toISOString();
  return ctx;
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN TICKET MESSAGE — v2: fingerprint, member_since, colors
═══════════════════════════════════════════════════════════════ */
function formatAdminTicket(ticket, context) {
  const cat = SUPPORT_CATEGORIES[ticket.category];
  const prob = cat?.problems?.[ticket.problem_key];

  let msg = `🦊 FOX SUPPORT TICKET #${ticket.id}\n\n`;
  msg += `👤 Fox: @${ticket.username || "unknown"}\n`;
  msg += `🆔 Fox ID: ${ticket.telegram_user_id}\n`;
  msg += `📂 Kategoria: ${cat?.emoji || ""} ${cat?.label || ticket.category}\n`;
  msg += `❓ Problem: ${prob?.label || ticket.problem_key}\n`;
  msg += `🔑 Problem key: ${ticket.problem_key}\n`;
  msg += `⚡ Priorytet: ${PRIORITY_LABELS[ticket.priority] || ticket.priority}\n`;

  if (ticket.venue_name) msg += `🏪 Lokal: ${ticket.venue_name} (id: ${ticket.venue_id})\n`;

  msg += `\n💬 Wiadomość:\n${ticket.short_message || "(brak)"}\n`;

  msg += `\n─── Kontekst ───\n`;
  msg += `📊 Rating: ${context.rating ?? "?"} | Wizyty: ${context.total_visits ?? "?"}\n`;
  msg += `📍 Dzielnica: ${context.district || "?"}\n`;

  // v2: member since
  if (context.member_since) {
    const memberDate = new Date(context.member_since).toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" });
    const daysAgo = Math.floor((Date.now() - new Date(context.member_since).getTime()) / 86400000);
    msg += `📅 Fox od: ${memberDate} (${daysAgo} dni)\n`;
  }

  // v2: previous tickets
  if (context.total_tickets > 0) {
    msg += `📨 Poprzednie zgłoszenia: ${context.total_tickets}\n`;
  }

  if (context.trial_active) msg += `⚠️ Współpraca testowa aktywna\n`;
  if (context.is_demo) msg += `⚠️ Konto demo\n`;
  if (context.banned_until) msg += `🚫 Zbanowany do: ${new Date(context.banned_until).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}\n`;

  if (context.last_checkin) {
    const lc = context.last_checkin;
    msg += `\n🔑 Ostatni check-in:\n`;
    msg += `  Lokal: ${lc.venue_id} | Kod wizyty: ${lc.otp}\n`;
    msg += `  Czas: ${new Date(lc.created).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}\n`;
    msg += `  Status: ${lc.confirmed ? "✅ Potwierdzony" : lc.expired ? "❌ Wygasły" : "⏳ Oczekuje"}\n`;
  }

  if (context.last_reservation) {
    const lr = context.last_reservation;
    msg += `\n📋 Ostatnia rezerwacja:\n`;
    msg += `  Lokal: ${lr.venue_id}\n`;
    msg += `  Status: ${lr.used ? "✅ Użyta" : lr.expired ? "❌ Wygasła" : "⏳ Aktywna"}\n`;
  }

  msg += `\n🕐 ${new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}`;
  msg += `\n📱 Status: ${ticket.status}`;

  return msg;
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN BUTTONS — v2: + block spam button
═══════════════════════════════════════════════════════════════ */
function buildAdminButtons(ticketId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Zamknięte", callback_data: `sup_admin_close_${ticketId}` },
        { text: "↩️ Odpowiedz", callback_data: `sup_admin_reply_${ticketId}` },
      ],
      [
        { text: "⚠️ Do sprawdzenia", callback_data: `sup_admin_check_${ticketId}` },
        { text: "🚫 Błąd lokalu", callback_data: `sup_admin_venue_error_${ticketId}` },
      ],
      [
        { text: "👤 Więcej danych", callback_data: `sup_admin_need_info_${ticketId}` },
        { text: "🚫 Ogranicz zgłoszenia", callback_data: `sup_admin_block_${ticketId}` },
      ],
    ],
  };
}

/* ═══════════════════════════════════════════════════════════════
   SETUP — wire everything into the Telegraf bot
═══════════════════════════════════════════════════════════════ */
function setupSupport(bot, pool, { ADMIN_TG_ID, PUBLIC_URL }) {

  bot.command("pomoc", (ctx) => showSupportMenu(ctx));
  bot.command("help", (ctx) => showSupportMenu(ctx));

  bot.action("support_menu", async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    await showSupportMenu(ctx);
  });

  async function showSupportMenu(ctx) {
    const userId = String(ctx.from.id);
    clearState(userId);
    const buttons = Object.entries(SUPPORT_CATEGORIES).map(([key, cat]) => {
      return [{ text: `${cat.emoji} ${cat.label}`, callback_data: `sup_cat_${key}` }];
    });
    const text = `💬 Pomoc\n\nW czym możemy pomóc?`;
    try {
      await ctx.editMessageText(text, { reply_markup: { inline_keyboard: buttons } });
    } catch {
      await ctx.reply(text, { reply_markup: { inline_keyboard: buttons } });
    }
  }

  // ── CATEGORY SELECTED ──
  bot.action(/^sup_cat_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const category = ctx.match[1];
    const cat = SUPPORT_CATEGORIES[category];
    if (!cat) return;
    const userId = String(ctx.from.id);
    setState(userId, { category, step: 0 });
    const buttons = Object.entries(cat.problems).map(([key, prob]) => {
      return [{ text: prob.label, callback_data: `sup_prob_${category}:${key}` }];
    });
    buttons.push([{ text: "← Wróć", callback_data: "support_menu" }]);
    try {
      await ctx.editMessageText(`${cat.emoji} ${cat.label}\n\n${cat.intro}`, {
        reply_markup: { inline_keyboard: buttons },
      });
    } catch {}
  });

  // ── PROBLEM SELECTED → FAQ answer (step 1) + status check button ──
  bot.action(/^sup_prob_([^:]+):(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const category = ctx.match[1];
    const problemKey = ctx.match[2];
    const cat = SUPPORT_CATEGORIES[category];
    const prob = cat?.problems?.[problemKey];
    if (!prob) return;

    const userId = String(ctx.from.id);
    setState(userId, { category, problemKey, step: 1 });

    try {
      await pool.query(
        `INSERT INTO fp1_support_faq_hits(user_id, category, problem_key, step) VALUES($1,$2,$3,1)`,
        [userId, category, problemKey]
      );
    } catch {}

    const text = `${cat.emoji} ${prob.label}\n\n${prob.answer}`;
    const buttons = [];

    // v2: Status check button if available
    if (prob.hasStatusCheck) {
      buttons.push([{ text: "🔍 Sprawdź status", callback_data: `sup_status_${category}:${problemKey}` }]);
    }

    if (prob.action) {
      buttons.push([{ text: prob.action.text, callback_data: `sup_action_${prob.action.key}` }]);
    }
    buttons.push([
      { text: "✅ Tak", callback_data: `sup_resolved_yes` },
      { text: "❌ Nie", callback_data: `sup_resolved_no_1` },
    ]);

    try {
      await ctx.editMessageText(`${text}\n\nCzy to rozwiązało problem?`, {
        reply_markup: { inline_keyboard: buttons },
      });
    } catch {}
  });

  // ── 🔍 STATUS CHECK (v2) ──
  bot.action(/^sup_status_([^:]+):(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery("🔍 Sprawdzam..."); } catch {}
    const category = ctx.match[1];
    const problemKey = ctx.match[2];
    const userId = String(ctx.from.id);

    const result = await runStatusCheck(pool, userId, category, problemKey);

    const buttons = [
      [{ text: "✅ Problem rozwiązany", callback_data: `sup_resolved_yes` }],
      [{ text: "❌ Nadal nie działa", callback_data: `sup_resolved_no_1` }],
      [{ text: "💬 Powrót do Pomocy", callback_data: "support_menu" }],
    ];

    try {
      await ctx.editMessageText(`🔍 Diagnostyka systemu\n\n${result}\n\nCzy to rozwiązało problem?`, {
        reply_markup: { inline_keyboard: buttons },
      });
    } catch {}
  });

  // ── RESOLVED YES ──
  bot.action("sup_resolved_yes", async (ctx) => {
    try { await ctx.answerCbQuery("✅ Świetnie!"); } catch {}
    const userId = String(ctx.from.id);
    const state = getState(userId);
    if (state) {
      try {
        await pool.query(
          `UPDATE fp1_support_faq_hits SET resolved=TRUE
           WHERE user_id=$1 AND category=$2 AND problem_key=$3
           ORDER BY created_at DESC LIMIT 1`,
          [userId, state.category, state.problemKey]
        );
      } catch {}
    }
    clearState(userId);
    try {
      await ctx.editMessageText(
        `✅ Cieszę się, że mogłem pomóc!\n\n🦊 Miłego korzystania z The FoxPot Club!`,
        { reply_markup: { inline_keyboard: [
          [{ text: "💬 Powrót do Pomocy", callback_data: "support_menu" }]
        ]}}
      );
    } catch {}
  });

  // ── RESOLVED NO (step 1) → step 2 ──
  bot.action("sup_resolved_no_1", async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const userId = String(ctx.from.id);
    const state = getState(userId);
    if (!state || !state.category || !state.problemKey) return showSupportMenu(ctx);

    const cat = SUPPORT_CATEGORIES[state.category];
    const prob = cat?.problems?.[state.problemKey];
    if (!prob) return showSupportMenu(ctx);

    setState(userId, { ...state, step: 2 });

    try {
      await pool.query(
        `INSERT INTO fp1_support_faq_hits(user_id, category, problem_key, step) VALUES($1,$2,$3,2)`,
        [userId, state.category, state.problemKey]
      );
    } catch {}

    const text = `${cat.emoji} ${prob.label} — dodatkowe wskazówki\n\n${prob.step2_answer}`;
    const buttons = [];

    // v2: Status check also on step 2
    if (prob.hasStatusCheck) {
      buttons.push([{ text: "🔍 Sprawdź status", callback_data: `sup_status_${state.category}:${state.problemKey}` }]);
    }

    if (prob.step2_action) {
      buttons.push([{ text: prob.step2_action.text, callback_data: `sup_action_${prob.step2_action.key}` }]);
    }
    buttons.push([
      { text: "✅ Tak", callback_data: `sup_resolved_yes` },
      { text: "❌ Nie", callback_data: `sup_resolved_no_2` },
    ]);

    try {
      await ctx.editMessageText(`${text}\n\nCzy to rozwiązało problem?`, {
        reply_markup: { inline_keyboard: buttons },
      });
    } catch {}
  });

  // ── RESOLVED NO (step 2) → escalation ──
  bot.action("sup_resolved_no_2", async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const userId = String(ctx.from.id);
    const state = getState(userId);
    if (!state) return showSupportMenu(ctx);

    const check = await canEscalate(pool, userId);
    if (!check.allowed) {
      const msg = check.reason === "blocked"
        ? `⚠️ Twoje zgłoszenia zostały tymczasowo ograniczone.\n\nSpróbuj ponownie później lub skorzystaj z odpowiedzi w Pomocy.`
        : `⚠️ Twoje zgłoszenie zostało zapisane wcześniej.\n\nLimit: 2 zgłoszenia na 24h.\nSpróbuj ponownie później lub skorzystaj z odpowiedzi w Pomocy.`;
      try {
        await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: [
          [{ text: "💬 Powrót do Pomocy", callback_data: "support_menu" }]
        ]}});
      } catch {}
      return;
    }

    setState(userId, { ...state, step: "escalation", awaitingMessage: true });

    try {
      await ctx.editMessageText(
        `📝 Zgłoszenie do supportu\n\n` +
        `Kategoria: ${SUPPORT_CATEGORIES[state.category]?.emoji} ${SUPPORT_CATEGORIES[state.category]?.label}\n` +
        `Problem: ${SUPPORT_CATEGORIES[state.category]?.problems?.[state.problemKey]?.label}\n\n` +
        `Opisz krótko problem (1 wiadomość):`,
        { reply_markup: { inline_keyboard: [
          [{ text: "← Anuluj", callback_data: "support_menu" }]
        ]}}
      );
    } catch {}
  });

  // ── ACTION BUTTONS ──
  bot.action(/^sup_action_(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    try { await ctx.answerCbQuery(); } catch {}
    switch (action) {
      case "retry_checkin":
      case "new_checkin":
        await ctx.reply("Użyj komendy: /checkin <venue_id>\n\nLista lokali: /venues"); break;
      case "show_venues":
        await ctx.reply("Lista lokali: /venues"); break;
      case "open_map":
        if (PUBLIC_URL) {
          await ctx.reply("🗺️ Otwórz mapę:", { reply_markup: { inline_keyboard: [
            [{ text: "🦊 Otwórz FoxPot App", web_app: { url: `${PUBLIC_URL}/webapp` } }]
          ]}});
        } else { await ctx.reply("Otwórz aplikację przez /start"); }
        break;
      case "open_profile":
      case "check_profile":
        await ctx.reply("Twój profil: /start"); break;
      case "main_menu":
        await ctx.reply("/start — menu główne"); break;
      case "check_visit_status":
        await ctx.reply("Sprawdź wizyty: /achievements"); break;
      case "check_otp_status":
      case "resend_otp":
        await ctx.reply("Wygeneruj nowy check-in: /checkin <venue_id>\n\nLista lokali: /venues"); break;
      case "visit_history":
      case "show_achievements":
        await ctx.reply("Twoje osiągnięcia: /achievements\n\nTop Fox: /top"); break;
      case "daily_spin":
        await ctx.reply("Daily Spin: /spin"); break;
      case "check_reservation":
      case "retry_reservation":
        await ctx.reply("Sprawdź rezerwacje w aplikacji.\n\nOtwórz: /start"); break;
      case "check_subscription":
        if (PUBLIC_URL) {
          await ctx.reply("Sprawdź subskrypcję:", { reply_markup: { inline_keyboard: [
            [{ text: "🦊 Otwórz FoxPot App", web_app: { url: `${PUBLIC_URL}/webapp` } }]
          ]}});
        } else { await ctx.reply("Otwórz aplikację przez /start"); }
        break;
      case "refresh_app":
        await ctx.reply("Zamknij i otwórz aplikację ponownie: /start"); break;
      default:
        await ctx.reply("/start");
    }
  });

  // ── ADMIN ACTIONS — v2: close auto-notifies Fox, + block spam ──
  bot.action(/^sup_admin_(.+)_(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const ticketId = ctx.match[2];

    if (!ADMIN_TG_ID || String(ctx.from.id) !== String(ADMIN_TG_ID)) {
      return ctx.answerCbQuery("❌ Brak uprawnień");
    }
    try { await ctx.answerCbQuery(); } catch {}

    let newStatus = "open";
    let eventType = action;

    switch (action) {
      case "close":
        newStatus = "closed";
        // v2: AUTO-CLOSE — notify Fox
        try {
          const t = await pool.query(`SELECT telegram_user_id FROM fp1_support_tickets WHERE id=$1`, [ticketId]);
          if (t.rowCount > 0) {
            await bot.telegram.sendMessage(Number(t.rows[0].telegram_user_id),
              `✅ Twoje zgłoszenie #${ticketId} zostało rozwiązane.\n\n` +
              `Jeśli problem nadal występuje, możesz otworzyć nowe zgłoszenie:\n/pomoc`
            );
          }
        } catch (e) { console.error("AUTO_CLOSE_NOTIFY_ERR", e.message); }
        break;

      case "reply":
        newStatus = "waiting_user";
        await ctx.reply(`↩️ Odpowiedz na ticket #${ticketId}:\n\nFormat: /reply_ticket ${ticketId} <wiadomość>`);
        return;

      case "check":
        newStatus = "open";
        eventType = "marked_for_check";
        break;

      case "venue_error":
        newStatus = "open";
        eventType = "venue_error";
        break;

      case "need_info":
        newStatus = "waiting_user";
        // v2: auto-notify Fox about info request
        try {
          const t = await pool.query(`SELECT telegram_user_id FROM fp1_support_tickets WHERE id=$1`, [ticketId]);
          if (t.rowCount > 0) {
            await bot.telegram.sendMessage(Number(t.rows[0].telegram_user_id),
              `📋 Potrzebujemy dodatkowych informacji do zgłoszenia #${ticketId}.\n\n` +
              `Opisz problem szczegółowo lub dodaj screenshot.\n` +
              `Odpowiedz na tę wiadomość.`
            );
          }
        } catch (e) { console.error("NEED_INFO_NOTIFY_ERR", e.message); }
        break;

      case "block":
        // v2: BLOCK SPAM — 24h support block
        try {
          const t = await pool.query(`SELECT telegram_user_id, username FROM fp1_support_tickets WHERE id=$1`, [ticketId]);
          if (t.rowCount > 0) {
            await pool.query(
              `UPDATE fp1_foxes SET support_block_until = NOW() + INTERVAL '24 hours' WHERE user_id=$1`,
              [String(t.rows[0].telegram_user_id)]
            );
            eventType = "user_blocked";
            newStatus = "closed";

            const origText = ctx.callbackQuery?.message?.text || "";
            const blockLine = `\n\n🚫 ZABLOKOWANY na 24h (${new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })})`;
            await ctx.editMessageText(origText + blockLine, {
              reply_markup: buildAdminButtons(ticketId),
            });
            await pool.query(
              `UPDATE fp1_support_tickets SET status='closed', updated_at=NOW() WHERE id=$1`, [ticketId]
            );
            await pool.query(
              `INSERT INTO fp1_support_events(ticket_id, event_type, payload) VALUES($1,$2,$3)`,
              [ticketId, "user_blocked", JSON.stringify({ admin_id: String(ctx.from.id), duration: "24h" })]
            );
            return;
          }
        } catch (e) { console.error("BLOCK_SPAM_ERR", e.message); }
        return;
    }

    await pool.query(
      `UPDATE fp1_support_tickets SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, ticketId]
    );
    await pool.query(
      `INSERT INTO fp1_support_events(ticket_id, event_type, payload) VALUES($1,$2,$3)`,
      [ticketId, eventType, JSON.stringify({ admin_id: String(ctx.from.id) })]
    );

    const statusEmoji = { open: "📂", waiting_user: "⏳", resolved: "✅", closed: "🔒" };
    try {
      const origText = ctx.callbackQuery?.message?.text || "";
      const statusLine = `\n\n${statusEmoji[newStatus] || "📂"} Status: ${newStatus.toUpperCase()} (${new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })})`;
      await ctx.editMessageText(origText + statusLine, {
        reply_markup: buildAdminButtons(ticketId),
      });
    } catch {}
  });

  // ── ADMIN REPLY ──
  bot.command("reply_ticket", async (ctx) => {
    if (!ADMIN_TG_ID || String(ctx.from.id) !== String(ADMIN_TG_ID)) return;
    const parts = String(ctx.message?.text || "").trim().split(/\s+/);
    const ticketId = parts[1];
    const message = parts.slice(2).join(" ");
    if (!ticketId || !message) return ctx.reply("Format: /reply_ticket <ID> <wiadomość>");
    const ticket = await pool.query(
      `SELECT telegram_user_id FROM fp1_support_tickets WHERE id=$1 LIMIT 1`, [ticketId]
    );
    if (ticket.rowCount === 0) return ctx.reply("❌ Ticket nie znaleziony.");
    try {
      await bot.telegram.sendMessage(Number(ticket.rows[0].telegram_user_id),
        `💬 Odpowiedź na Twoje zgłoszenie #${ticketId}:\n\n${message}\n\n` +
        `Jeśli problem rozwiązany — nie musisz odpowiadać.`
      );
      await pool.query(`UPDATE fp1_support_tickets SET status='waiting_user', updated_at=NOW() WHERE id=$1`, [ticketId]);
      await pool.query(
        `INSERT INTO fp1_support_events(ticket_id, event_type, payload) VALUES($1,'admin_reply',$2)`,
        [ticketId, JSON.stringify({ message })]
      );
      await ctx.reply(`✅ Odpowiedź wysłana do Fox (ticket #${ticketId}).`);
    } catch (e) { await ctx.reply(`❌ Błąd wysyłania: ${e.message}`); }
  });

  // ── TEXT HANDLER — escalation messages ──
  function getSupportTextHandler() {
    return async function supportTextHandler(ctx, next) {
      const userId = String(ctx.from.id);
      const text = (ctx.message?.text || "").trim();
      if (text.startsWith("/")) return next();

      const state = getState(userId);
      if (!state || state.step !== "escalation" || !state.awaitingMessage) return next();

      const shortMessage = text.slice(0, 1000);
      const category = state.category;
      const problemKey = state.problemKey;
      const priority = detectPriority(category, problemKey);
      const username = ctx.from.username || ctx.from.first_name || String(ctx.from.id);

      const context = await buildTicketContext(pool, userId);

      const ticket = await pool.query(
        `INSERT INTO fp1_support_tickets(
          fox_id, telegram_user_id, username, category, problem_key,
          venue_id, venue_name, short_message, status, priority
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)
        RETURNING *`,
        [context.fox_id || null, userId, username, category, problemKey,
         context.last_checkin?.venue_id || null, null, shortMessage, priority]
      );
      const t = ticket.rows[0];

      if (t.venue_id) {
        const v = await pool.query(`SELECT name FROM fp1_venues WHERE id=$1 LIMIT 1`, [t.venue_id]);
        if (v.rowCount > 0) {
          await pool.query(`UPDATE fp1_support_tickets SET venue_name=$1 WHERE id=$2`, [v.rows[0].name, t.id]);
          t.venue_name = v.rows[0].name;
        }
      }

      await pool.query(
        `INSERT INTO fp1_support_events(ticket_id, event_type, payload) VALUES($1,'created',$2)`,
        [t.id, JSON.stringify({ context })]
      );

      if (ADMIN_TG_ID) {
        try {
          const adminMsg = formatAdminTicket(t, context);
          const sent = await bot.telegram.sendMessage(Number(ADMIN_TG_ID), adminMsg, {
            reply_markup: buildAdminButtons(t.id),
          });
          await pool.query(`UPDATE fp1_support_tickets SET admin_message_id=$1 WHERE id=$2`, [sent.message_id, t.id]);
        } catch (e) { console.error("SUPPORT_ADMIN_FORWARD_ERR", e.message); }
      }

      clearState(userId);

      // v2: Updated confirmation message
      await ctx.reply(
        `✅ Zgłoszenie #${t.id} zostało zapisane.\n\n` +
        `Odpowiemy w ciągu 24 godzin, jeśli będzie potrzebna dodatkowa informacja.\n\n` +
        `Dziękujemy za cierpliwość! 🦊`,
        { reply_markup: { inline_keyboard: [
          [{ text: "💬 Powrót do Pomocy", callback_data: "support_menu" }]
        ]}}
      );
    };
  }

  return { getSupportTextHandler, migrateSupport };
}

module.exports = { setupSupport, migrateSupport, SUPPORT_CATEGORIES, runStatusCheck };
