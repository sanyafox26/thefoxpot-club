const fs = require('fs');

// ── fox-profile.html ──
let html = fs.readFileSync('fox-profile.html', 'utf8');

// 1. CSS — add after .exp-desc
html = html.replace(
  `/* ── skills ── */`,
  `/* ── education ── */
.edu-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:10px;position:relative}
.edu-school{font-size:15px;font-weight:600}
.edu-field{font-size:13px;color:var(--accent);font-weight:500;margin-top:2px}
.edu-degree{font-size:12px;color:var(--muted);margin-top:2px}
.edu-years{font-size:12px;color:var(--muted);margin-top:2px}

/* ── skills ── */`
);

// 2. HTML section — insert between expList section and Skills section
html = html.replace(
  `      <!-- Skills -->
      <div class="section" id="secSkills" data-sec="skills">`,
  `      <!-- Education -->
      <div class="section" id="secEducation" data-sec="education">
        <div class="section-head">
          <div class="section-title">Wykształcenie</div>
          <button class="section-vis-btn" title="Widoczność sekcji" onclick="toggleSectionVis('education')" id="visEducation">👁</button>
        </div>
        <div id="eduList"></div>
        <button class="add-btn" onclick="openEduModal(null)">+ Dodaj wykształcenie</button>
      </div>

      <!-- Skills -->
      <div class="section" id="secSkills" data-sec="skills">`
);

// 3. Modal — insert after modalExp
html = html.replace(
  `<!-- Modal: Service -->`,
  `<!-- Modal: Education -->
<div class="modal-overlay" id="modalEdu">
  <div class="modal-sheet">
    <div class="modal-title">Wykształcenie</div>
    <div class="field-group"><label>Uczelnia *</label><input id="eduSchool" placeholder="np. Uniwersytet Warszawski"/></div>
    <div class="field-group"><label>Kierunek / Specjalizacja</label><input id="eduField" placeholder="np. Informatyka"/></div>
    <div class="field-group"><label>Stopień</label>
      <select id="eduDegree" style="background:#1a1d29;color:#fff;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:14px;width:100%">
        <option value="">— wybierz —</option>
        <option value="lic">licencjat (lic.)</option>
        <option value="inż">inżynier (inż.)</option>
        <option value="mgr">magister (mgr)</option>
        <option value="dr">doktor (dr)</option>
        <option value="inne">inne</option>
      </select>
    </div>
    <div class="field-group"><label>Lata (od–do)</label><input id="eduYears" placeholder="np. 2018–2022"/></div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal('modalEdu')">Anuluj</button>
      <button class="btn-delete" id="eduDeleteBtn" onclick="deleteEduItem()" style="display:none">Usuń</button>
      <button class="btn-save" onclick="saveEduItem()">Zapisz</button>
    </div>
  </div>
</div>

<!-- Modal: Service -->`
);

// 4. localEducation variable — after localExperience
html = html.replace(
  `let localSkills = [];`,
  `let localEducation = [];
let localSkills = [];`
);

// 5. editingEduIdx — after editingExpIdx
html = html.replace(
  `let editingSvcIdx = null;`,
  `let editingEduIdx = null;
let editingSvcIdx = null;`
);

// 6. initLocals — add education
html = html.replace(
  `  localExperience = JSON.parse(JSON.stringify(d.experience_items || []));
  localSkills = JSON.parse(JSON.stringify(d.skills || []));`,
  `  localExperience = JSON.parse(JSON.stringify(d.experience_items || []));
  localEducation = JSON.parse(JSON.stringify(d.education || []));
  localSkills = JSON.parse(JSON.stringify(d.skills || []));`
);

// 7. render() — call renderEducation
html = html.replace(
  `  renderExperience();
  renderSkills();`,
  `  renderExperience();
  renderEducation();
  renderSkills();`
);

// 8. applySectionsVisibility — add education
html = html.replace(
  `  const secs = ['stats','experience','skills','services','portfolio','reviews'];`,
  `  const secs = ['stats','experience','education','skills','services','portfolio','reviews'];`
);

// 9. save payload — add education
html = html.replace(
  `        experience_items: localExperience,
        skills: localSkills,`,
  `        experience_items: localExperience,
        education: localEducation,
        skills: localSkills,`
);

// 10. discardChanges — add renderEducation
html = html.replace(
  `  renderExperience();
  renderSkills();`,
  `  renderExperience();
  renderEducation();
  renderSkills();`
);

// 11. JS functions — add after renderExperience, before renderSkills
html = html.replace(
  `function renderSkills() {`,
  `function renderEducation() {
  const list = document.getElementById('eduList');
  if (!list) return;
  if (!localEducation.length) { list.innerHTML = '<div style="color:var(--muted);font-size:13px">Brak wykształcenia.</div>'; return; }
  list.innerHTML = localEducation.map((e,i)=>\`
    <div class="edu-card">
      <button class="edit-card-btn" onclick="openEduModal(\${i})">✏️</button>
      <div class="edu-school">\${escHtml(e.school||'')}</div>
      \${e.field?\`<div class="edu-field">\${escHtml(e.field)}</div>\`:''}
      \${e.degree?\`<div class="edu-degree">\${escHtml(e.degree)}</div>\`:''}
      \${e.years?\`<div class="edu-years">\${escHtml(e.years)}</div>\`:''}
    </div>\`).join('');
}

function openEduModal(idx) {
  editingEduIdx = idx;
  const e = idx !== null ? localEducation[idx] : {};
  document.getElementById('eduSchool').value = e.school||'';
  document.getElementById('eduField').value = e.field||'';
  document.getElementById('eduDegree').value = e.degree||'';
  document.getElementById('eduYears').value = e.years||'';
  document.getElementById('eduDeleteBtn').style.display = idx !== null ? '' : 'none';
  document.getElementById('modalEdu').classList.add('open');
}

function saveEduItem() {
  const school = document.getElementById('eduSchool').value.trim();
  if (!school) return;
  const item = {
    school,
    field: document.getElementById('eduField').value.trim(),
    degree: document.getElementById('eduDegree').value,
    years: document.getElementById('eduYears').value.trim(),
  };
  if (editingEduIdx !== null) localEducation[editingEduIdx] = item;
  else localEducation.push(item);
  renderEducation(); markDirty(); closeModal('modalEdu');
}

function deleteEduItem() {
  if (editingEduIdx !== null) { localEducation.splice(editingEduIdx,1); renderEducation(); markDirty(); closeModal('modalEdu'); }
}

function renderSkills() {`
);

fs.writeFileSync('fox-profile.html', html);
console.log('fox-profile.html done, size:', html.length);

// ── server.js ──
let srv = fs.readFileSync('server.js', 'utf8');

// 1. Migration — ensureColumn education after experience_items
srv = srv.replace(
  `  await ensureColumn("fp1_foxes", "experience_items",    "JSONB NOT NULL DEFAULT '[]'");`,
  `  await ensureColumn("fp1_foxes", "experience_items",    "JSONB NOT NULL DEFAULT '[]'");
  await ensureColumn("fp1_foxes", "education",            "JSONB NOT NULL DEFAULT '[]'");`
);

// 2. GET /api/fox-public — add education to SELECT
srv = srv.replace(
  `              f.experience_items, f.skills, f.services, f.profile_public,`,
  `              f.experience_items, f.education, f.skills, f.services, f.profile_public,`
);

// 3. PUT /api/fox/profile — add education to destructuring
srv = srv.replace(
  `      display_name, bio, specialization, specializations, district,
      social_links, portfolio_items, experience_items,
      skills, services, featured_project_id, invoicing,
      profile_public, sections_visibility,
      available_today, available_from, available_to`,
  `      display_name, bio, specialization, specializations, district,
      social_links, portfolio_items, experience_items, education,
      skills, services, featured_project_id, invoicing,
      profile_public, sections_visibility,
      available_today, available_from, available_to`
);

// 4. PUT — add education to SET clause (append after specializations=$17)
srv = srv.replace(
  `        specializations=$17::jsonb
       WHERE user_id=$18`,
  `        specializations=$17::jsonb,
        education=$19::jsonb
       WHERE user_id=$18`
);

// 5. PUT — add education to values array (after the specializations value at end)
srv = srv.replace(
  `        JSON.stringify(Array.isArray(specializations) ? specializations : []),
        tgUserId`,
  `        JSON.stringify(Array.isArray(specializations) ? specializations : []),
        tgUserId,
        JSON.stringify(Array.isArray(education) ? education : [])`
);

fs.writeFileSync('server.js', srv);
console.log('server.js done, size:', srv.length);
