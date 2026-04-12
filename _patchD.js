const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

// ── 1. Add CSS for optgroup/option styling + custom input ──
html = html.replace(
  `.spec-add-btn{display:flex;align-items:center;gap:6px;background:var(--surface);border:2px dashed var(--border);border-radius:10px;padding:9px 14px;font-size:13px;color:var(--muted);cursor:pointer;width:100%;transition:all .2s}
.spec-add-btn:hover{border-color:var(--accent);color:var(--text)}`,
  `.spec-add-btn{display:flex;align-items:center;gap:6px;background:var(--surface);border:2px dashed var(--border);border-radius:10px;padding:9px 14px;font-size:13px;color:var(--muted);cursor:pointer;width:100%;transition:all .2s}
.spec-add-btn:hover{border-color:var(--accent);color:var(--text)}
#specSelect optgroup{color:#F97E00;font-weight:bold;background:#1a1d29}
#specSelect option{color:#ffffff;background:#1a1d29}
.spec-custom-input{display:flex;gap:6px;margin-top:6px}
.spec-custom-input input{flex:1;background:#1a1d29;color:#fff;border:1px solid #F97E00;border-radius:8px;padding:6px 10px;font-size:13px;outline:none}
.spec-custom-input button{background:#F97E00;color:#000;border:none;border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer}`
);

// ── 2. Fix optgroup label: 📊 → 💼 for Biznes, add ✏️ Własna at end, add custom input, fix onchange ──
html = html.replace(
  `        <select id="specSelect" size="8" style="display:none;background:#1a1d29;color:#fff;border:1px solid #F97E00;width:100%;border-radius:8px;margin-top:6px;padding:4px 0" onchange="addSpec(this.value);this.selectedIndex=-1;">
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
        </select>`,
  `        <select id="specSelect" size="8" style="display:none;background:#1a1d29;color:#fff;border:1px solid #F97E00;width:100%;border-radius:8px;margin-top:6px;padding:4px 0" onchange="handleSpecChange(this)">
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
          <optgroup label="💼 Biznes">
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
          <optgroup label="✏️ Własna">
            <option value="__custom__">✏️ Wpisz własną specjalizację...</option>
          </optgroup>
        </select>
        <div class="spec-custom-input" id="specCustomInput" style="display:none">
          <input type="text" id="specCustomText" placeholder="Np. DJ, Sommelier, Fotograf ślubny..." onkeydown="if(event.key==='Enter'){event.preventDefault();addCustomSpec()}">
          <button type="button" onclick="addCustomSpec()">+ Dodaj</button>
        </div>`
);

// ── 3. Replace JS functions ──
html = html.replace(
  `function toggleSpecList() {
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
}`,
  `function toggleSpecList() {
  const sel = document.getElementById('specSelect');
  if (!sel) return;
  const isHidden = sel.style.display === 'none';
  sel.style.display = isHidden ? 'block' : 'none';
  if (!isHidden) {
    document.getElementById('specCustomInput').style.display = 'none';
  }
}

function handleSpecChange(sel) {
  const val = sel.value;
  sel.selectedIndex = -1;
  if (val === '__custom__') {
    const ci = document.getElementById('specCustomInput');
    ci.style.display = 'flex';
    document.getElementById('specCustomText').focus();
  } else {
    addSpec(val);
  }
}

function addCustomSpec() {
  const inp = document.getElementById('specCustomText');
  const val = inp.value.trim();
  if (val) {
    addSpec(val);
    inp.value = '';
    document.getElementById('specCustomInput').style.display = 'none';
    document.getElementById('specSelect').style.display = 'none';
  }
}

function addSpec(item) {
  if (item && !localSpecializations.includes(item)) {
    localSpecializations.push(item);
    renderSpecTags();
    markDirty();
  }
}`
);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
