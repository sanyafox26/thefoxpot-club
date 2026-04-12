const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

// ── 1. Replace HTML block ──
html = html.replace(
  `      <!-- Specialization dropdown-tag -->
      <div class="ep-field">
        <label>Specjalizacja</label>
        <div class="spec-tags-wrap" id="specTagsWrap"></div>
        <div class="spec-dropdown-wrap" id="specDropdownWrap">
          <button type="button" class="spec-add-btn" onclick="event.stopPropagation();toggleSpecDropdown()">+ Dodaj specjalizację</button>
          <div class="spec-dropdown" id="specDropdown" onclick="event.stopPropagation()"></div>
        </div>
      </div>`,
  `      <!-- Specialization select-tag -->
      <div class="ep-field">
        <label>Specjalizacja</label>
        <div class="spec-tags-wrap" id="specTagsWrap"></div>
        <button type="button" class="spec-add-btn" onclick="toggleSpecList()">+ Dodaj specjalizację</button>
        <select id="specSelect" size="8" style="display:none;background:#1a1d29;color:#fff;border:1px solid #F97E00;width:100%;border-radius:8px;margin-top:6px;padding:4px 0" onchange="addSpec(this.value);this.selectedIndex=-1;">
          <optgroup label="🍽️ Gastronomia & Hospitality">
            <option>Kelner</option><option>Barman</option><option>Kucharz</option><option>Szef kuchni</option>
            <option>Barista</option><option>Sommelier</option><option>Organizacja eventów</option>
            <option>Catering</option><option>Host / Hostessa</option>
          </optgroup>
          <optgroup label="💻 Technologia">
            <option>Programista</option><option>Web Developer</option><option>Mobile Developer</option>
            <option>UI Designer</option><option>UX Designer</option><option>Data Analyst</option>
            <option>DevOps</option><option>Cyberbezpieczeństwo</option><option>IT Support</option>
          </optgroup>
          <optgroup label="🎨 Kreatywne">
            <option>Fotograf</option><option>Videograf</option><option>Montażysta</option>
            <option>Grafik</option><option>Branding Designer</option><option>Muzyk</option>
            <option>Wokalista</option><option>Aktor</option><option>Copywriter</option><option>Content Creator</option>
          </optgroup>
          <optgroup label="📊 Biznes">
            <option>Marketing Manager</option><option>Social Media Manager</option><option>Sprzedawca</option>
            <option>Business Developer</option><option>Księgowy</option><option>Doradca prawny</option>
            <option>HR Specialist</option><option>Rekruter</option><option>Project Manager</option><option>Przedsiębiorca</option>
          </optgroup>
          <optgroup label="💪 Zdrowie & Sport">
            <option>Personal Trainer</option><option>Dietetyk</option><option>Fizjoterapeuta</option>
            <option>Pielęgniarka / Pielęgniarz</option><option>Lekarz</option><option>Coach wellness</option>
          </optgroup>
          <optgroup label="📚 Edukacja">
            <option>Nauczyciel</option><option>Korepetytor</option><option>Tłumacz</option>
            <option>Lektor języków</option><option>Coach</option><option>Mentor</option>
          </optgroup>
          <optgroup label="🔧 Rzemiosło & Usługi">
            <option>Budowlaniec</option><option>Elektryk</option><option>Hydraulik</option>
            <option>Mechanik</option><option>Fryzjer</option><option>Kosmetyczka</option>
            <option>Tatuażysta</option><option>Krawiec / Krawcowa</option><option>Kierowca</option><option>Inne</option>
          </optgroup>
        </select>
      </div>`
);

// ── 2. Replace JS: remove old dropdown JS, add simple new JS ──
// Find start and end of old spec JS block
const jsStart = html.indexOf('const SPEC_GROUPS = [');
const jsEnd = html.indexOf('function renderSpecChips() { renderSpecTags(); }') + 'function renderSpecChips() { renderSpecTags(); }'.length;

const newSpecJS = `function renderSpecTags() {
  const wrap = document.getElementById('specTagsWrap');
  if (!wrap) return;
  wrap.innerHTML = localSpecializations.map((s, i) =>
    \`<span class="spec-tag">\${escHtml(s)}<button type="button" class="spec-tag-x" onclick="removeSpec(\${i})">×</button></span>\`
  ).join('');
}

function toggleSpecList() {
  const sel = document.getElementById('specSelect');
  if (!sel) return;
  sel.style.display = sel.style.display === 'none' ? 'block' : 'none';
}

function addSpec(item) {
  if (item && !localSpecializations.includes(item)) {
    localSpecializations.push(item);
    renderSpecTags();
    markDirty();
  }
}

function removeSpec(idx) {
  localSpecializations.splice(idx, 1);
  renderSpecTags();
  markDirty();
}

function renderSpecChips() { renderSpecTags(); }`;

html = html.slice(0, jsStart) + newSpecJS + html.slice(jsEnd);

// ── 3. Remove old dropdown CSS, keep tag CSS ──
html = html.replace(
  `.spec-dropdown-wrap{position:relative;z-index:9999}
.spec-add-btn{display:flex;align-items:center;gap:6px;background:var(--surface);border:2px dashed var(--border);border-radius:10px;padding:9px 14px;font-size:13px;color:var(--muted);cursor:pointer;width:100%;transition:all .2s;margin-bottom:8px}
.spec-add-btn:hover{border-color:var(--accent);color:var(--text)}
.spec-dropdown{display:none;position:absolute;top:100%;left:0;right:0;background:#23263a;border:1px solid var(--border);border-radius:12px;z-index:9999;max-height:260px;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.4);pointer-events:auto}
.spec-dropdown.open{display:block}
.spec-dd-group{font-size:10px;color:#F97E00;font-weight:700;text-transform:uppercase;letter-spacing:.7px;padding:10px 14px 4px}
.spec-dd-item{padding:8px 14px;font-size:13px;color:var(--text);cursor:pointer;transition:background .15s}
.spec-dd-item:hover{background:rgba(249,126,0,.12);color:#F97E00}
.spec-dd-item.already{opacity:.35;cursor:default;pointer-events:none}`,
  `.spec-add-btn{display:flex;align-items:center;gap:6px;background:var(--surface);border:2px dashed var(--border);border-radius:10px;padding:9px 14px;font-size:13px;color:var(--muted);cursor:pointer;width:100%;transition:all .2s}
.spec-add-btn:hover{border-color:var(--accent);color:var(--text)}`
);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
