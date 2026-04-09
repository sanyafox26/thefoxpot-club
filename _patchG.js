const fs = require('fs');

// ── fox-profile.html ──
let html = fs.readFileSync('fox-profile.html', 'utf8');

// 1. HTML: add email + address fields after editDistrict field
html = html.replace(
  `      <div class="ep-field">
        <label>Dzielnica</label>
        <input id="editDistrict" maxlength="60" placeholder="np. Śródmieście"/>
      </div>`,
  `      <div class="ep-field">
        <label>Dzielnica</label>
        <input id="editDistrict" maxlength="60" placeholder="np. Śródmieście"/>
      </div>
      <div class="ep-field">
        <label>Email kontaktowy</label>
        <input id="editEmail" type="email" maxlength="200" placeholder="twoj@email.com"/>
      </div>
      <div class="ep-field">
        <label>Adres / Miasto</label>
        <input id="editAddress" type="text" maxlength="200" placeholder="np. Praga-Północ, Warszawa"/>
      </div>`
);

// 2. JS: local vars — add after localDistrict
html = html.replace(
  `let localDistrict = '';`,
  `let localDistrict = '';
let localEmail = '';
let localAddress = '';`
);

// 3. initLocals — add after localDistrict
html = html.replace(
  `  localDistrict = d.district || '';`,
  `  localDistrict = d.district || '';
  localEmail = d.contact_email || '';
  localAddress = d.contact_address || '';`
);

// 4. populateEditForm — add after editDistrict
html = html.replace(
  `  document.getElementById('editDistrict').value = localDistrict;`,
  `  document.getElementById('editDistrict').value = localDistrict;
  document.getElementById('editEmail').value = localEmail;
  document.getElementById('editAddress').value = localAddress;`
);

// 5. saveAll — read fields, after localDistrict read
html = html.replace(
  `  localDistrict = document.getElementById('editDistrict')?.value?.trim() || '';`,
  `  localDistrict = document.getElementById('editDistrict')?.value?.trim() || '';
  localEmail = document.getElementById('editEmail')?.value?.trim() || '';
  localAddress = document.getElementById('editAddress')?.value?.trim() || '';`
);

// 6. saveAll payload — add after education
html = html.replace(
  `        experience_items: localExperience,
        education: localEducation,
        skills: localSkills,`,
  `        experience_items: localExperience,
        education: localEducation,
        skills: localSkills,
        contact_email: localEmail,
        contact_address: localAddress,`
);

// 7. Replace generatePdf with CV-style version
const oldGenPdf = html.indexOf('function generatePdf() {');
const oldGenPdfEnd = html.indexOf('\n// ── Init ──');
html = html.slice(0, oldGenPdf) + `function generatePdf() {
  const logoSrc = document.querySelector('.topbar-logo img')?.src || '';
  const name = escHtml(localDisplayName || NICKNAME);
  const bio = escHtml(profileData?.bio || '');
  const specs = localSpecializations || [];
  const profileUrl = location.href;
  const city = escHtml(localAddress || localDistrict || '');
  const email = escHtml(localEmail || '');
  const vis = localSectionsVis;
  const show = s => vis[s] !== false;

  // Header contact line
  const contactParts = [];
  if (city) contactParts.push(city);
  if (email) contactParts.push(email);
  contactParts.push('<a href="'+profileUrl+'" style="color:#F97E00">'+profileUrl+'</a>');
  const contactLine = contactParts.join(' &nbsp;·&nbsp; ');

  let sectionsHtml = '';

  if (show('experience') && localExperience.length) {
    sectionsHtml += '<div class="cv-section"><div class="cv-sec-title">Doświadczenie zawodowe</div>'
      + localExperience.map(e =>
          '<div class="cv-item">'
          + '<div class="cv-item-head"><span class="cv-item-title">'+escHtml(e.title||'')+'</span>'
          + (e.period?'<span class="cv-item-period">'+escHtml(e.period)+'</span>':'')+'</div>'
          + (e.company?'<div class="cv-item-company">'+escHtml(e.company)+'</div>':'')
          + (e.desc?'<div class="cv-item-desc">'+escHtml(e.desc)+'</div>':'')
          +'</div>').join('')
      + '</div>';
  }

  if (show('education') && localEducation.length) {
    sectionsHtml += '<div class="cv-section"><div class="cv-sec-title">Wykształcenie</div>'
      + localEducation.map(e =>
          '<div class="cv-item">'
          + '<div class="cv-item-head"><span class="cv-item-title">'+escHtml(e.school||'')+'</span>'
          + (e.years?'<span class="cv-item-period">'+escHtml(e.years)+'</span>':'')+'</div>'
          + (e.field?'<div class="cv-item-company">'+escHtml(e.field)+'</div>':'')
          + (e.degree?'<div class="cv-item-desc">'+escHtml(e.degree)+'</div>':'')
          +'</div>').join('')
      + '</div>';
  }

  if (show('skills') && localSkills.length) {
    sectionsHtml += '<div class="cv-section"><div class="cv-sec-title">Umiejętności</div>'
      + '<div class="cv-tags">'+localSkills.map(s=>'<span class="cv-tag">'+escHtml(s)+'</span>').join('')+'</div>'
      + '</div>';
  }

  if (show('services') && localServices.length) {
    sectionsHtml += '<div class="cv-section"><div class="cv-sec-title">Usługi / Oferta</div>'
      + localServices.map(s =>
          '<div class="cv-item">'
          + '<div class="cv-item-head"><span class="cv-item-title orange">'+escHtml(s.name||'')+'</span>'
          + (s.price?'<span class="cv-item-period">'+escHtml(s.price)+'</span>':'')+'</div>'
          + (s.desc?'<div class="cv-item-desc">'+escHtml(s.desc)+'</div>':'')
          +'</div>').join('')
      + '</div>';
  }

  if (show('portfolio') && localPortfolio.length) {
    sectionsHtml += '<div class="cv-section"><div class="cv-sec-title">Portfolio</div>'
      + localPortfolio.map(p =>
          '<div class="cv-item">'
          + '<div class="cv-item-title">'+escHtml(p.title||'')+'</div>'
          + (p.result?'<div class="cv-item-desc">'+escHtml(p.result)+'</div>':'')
          + ((p.tags||[]).length?'<div class="cv-tags" style="margin-top:4px">'+p.tags.map(t=>'<span class="cv-tag">'+escHtml(t)+'</span>').join('')+'</div>':'')
          + (p.url?'<div class="cv-item-desc"><a href="'+escHtml(p.url)+'" style="color:#F97E00">'+escHtml(p.url)+'</a></div>':'')
          +'</div>').join('')
      + '</div>';
  }

  const reviews = profileData?.reviews || [];
  if (show('reviews') && reviews.length) {
    sectionsHtml += '<div class="cv-section"><div class="cv-sec-title">Recenzje</div>'
      + reviews.map(r =>
          '<div class="cv-item">'
          + '<div class="cv-item-head"><span class="cv-item-company">'+escHtml(r.venue_name||'')+'</span>'
          + '<span style="color:#F97E00">'+'\u2605'.repeat(r.stars||0)+'\u2606'.repeat(5-(r.stars||0))+'</span></div>'
          + (r.text?'<div class="cv-item-desc">'+escHtml(r.text)+'</div>':'')
          + (r.date?'<div class="cv-item-period" style="font-size:10px">'+new Date(r.date).toLocaleDateString('pl-PL')+'</div>':'')
          +'</div>').join('')
      + '</div>';
  }

  const pdfHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"/><style>'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111;font-size:12px;padding:15mm}'
    + '.cv-header{margin-bottom:18px}'
    + '.cv-name{font-size:26px;font-weight:700;color:#111;letter-spacing:.5px;margin-bottom:4px}'
    + '.cv-contact{font-size:11px;color:#555;margin-bottom:8px}'
    + '.cv-specs{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}'
    + '.cv-spec-tag{border:1px solid #F97E00;border-radius:10px;padding:2px 9px;font-size:10px;color:#F97E00}'
    + '.cv-bio{font-size:12px;color:#333;line-height:1.5;padding-top:8px;border-top:1px solid #e0e0e0}'
    + '.cv-section{margin-top:16px}'
    + '.cv-sec-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#111;padding-bottom:4px;border-bottom:2px solid #F97E00;margin-bottom:10px}'
    + '.cv-item{margin-bottom:10px}'
    + '.cv-item-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}'
    + '.cv-item-title{font-size:13px;font-weight:600;color:#111}'
    + '.cv-item-title.orange,.orange{color:#F97E00}'
    + '.cv-item-company{font-size:12px;color:#F97E00;margin-top:1px}'
    + '.cv-item-period{font-size:10px;color:#888;white-space:nowrap}'
    + '.cv-item-desc{font-size:11px;color:#555;margin-top:3px;line-height:1.5}'
    + '.cv-tags{display:flex;flex-wrap:wrap;gap:5px}'
    + '.cv-tag{border:1px solid #F97E00;border-radius:8px;padding:1px 7px;font-size:10px;color:#F97E00}'
    + '.cv-logo{height:32px;width:auto;margin-bottom:10px;display:block}'
    + '.cv-footer{position:fixed;bottom:10mm;left:15mm;right:15mm;text-align:center;font-size:9px;color:#bbb;border-top:1px solid #e0e0e0;padding-top:4px}'
    + '</style></head><body>'
    + (logoSrc ? '<img class="cv-logo" src="'+logoSrc+'" alt="FoxPot Club"/>' : '')
    + '<div class="cv-header">'
    + '<div class="cv-name">'+name+'</div>'
    + '<div class="cv-contact">'+contactLine+'</div>'
    + (specs.length ? '<div class="cv-specs">'+specs.map(s=>'<span class="cv-spec-tag">'+escHtml(s)+'</span>').join('')+'</div>' : '')
    + (bio ? '<div class="cv-bio">'+bio+'</div>' : '')
    + '</div>'
    + sectionsHtml
    + '<div class="cv-footer">Wygenerowano przez The FoxPot Club &middot; thefoxpot.club</div>'
    + '</body></html>';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;left:-9999px;top:0;width:794px';
  wrapper.innerHTML = pdfHtml;
  document.body.appendChild(wrapper);

  html2pdf().set({
    margin: 0,
    filename: 'foxpot-cv-' + NICKNAME + '.pdf',
    image: { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true, allowTaint: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(wrapper).save().then(() => document.body.removeChild(wrapper));
}

` + html.slice(oldGenPdfEnd);

fs.writeFileSync('fox-profile.html', html);
console.log('fox-profile.html done, size:', html.length);

// ── server.js ──
let srv = fs.readFileSync('server.js', 'utf8');

// 1. Migration — add contact_email, contact_address columns
srv = srv.replace(
  `  await ensureColumn("fp1_foxes", "education",            "JSONB NOT NULL DEFAULT '[]'");`,
  `  await ensureColumn("fp1_foxes", "education",            "JSONB NOT NULL DEFAULT '[]'");
  await ensureColumn("fp1_foxes", "contact_email",         "VARCHAR(200)");
  await ensureColumn("fp1_foxes", "contact_address",       "VARCHAR(200)");`
);

// 2. GET /api/fox-public — add to SELECT
srv = srv.replace(
  `              f.experience_items, f.education, f.skills, f.services, f.profile_public,`,
  `              f.experience_items, f.education, f.skills, f.services, f.profile_public,
              f.contact_email, f.contact_address,`
);

// 3. PUT destructuring — add contact fields
srv = srv.replace(
  `      display_name, bio, specialization, specializations, district,
      social_links, portfolio_items, experience_items, education,
      skills, services, featured_project_id, invoicing,
      profile_public, sections_visibility,
      available_today, available_from, available_to`,
  `      display_name, bio, specialization, specializations, district,
      social_links, portfolio_items, experience_items, education,
      skills, services, featured_project_id, invoicing,
      profile_public, sections_visibility,
      available_today, available_from, available_to,
      contact_email, contact_address`
);

// 4. PUT SET clause — add contact fields as $20, $21
srv = srv.replace(
  `        specializations=$17::jsonb,
        education=$19::jsonb
       WHERE user_id=$18`,
  `        specializations=$17::jsonb,
        education=$19::jsonb,
        contact_email=$20,
        contact_address=$21
       WHERE user_id=$18`
);

// 5. PUT values — add contact fields after education
srv = srv.replace(
  `        JSON.stringify(Array.isArray(education) ? education : [])
      ]`,
  `        JSON.stringify(Array.isArray(education) ? education : []),
        contact_email || null,
        contact_address || null
      ]`
);

fs.writeFileSync('server.js', srv);
console.log('server.js done, size:', srv.length);
