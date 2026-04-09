const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

// ── 1. CSS: hero-vis-btn ──
html = html.replace(
  `.section-vis-btn{display:none;`,
  `.hero-vis-btn{display:none;border:none;border-radius:16px;padding:2px 8px;font-size:10px;font-weight:600;cursor:pointer;transition:all .2s;white-space:nowrap;margin-top:3px}
.hero-vis-btn.sec-on{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:#22c55e}
.hero-vis-btn.sec-off{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#f87171}
.is-owner .hero-vis-btn{display:inline-flex;align-items:center}
.fox-email{font-size:13px;color:var(--muted);margin-top:3px}
.fox-email a{color:var(--muted);text-decoration:none}
.fox-email a:hover{color:var(--accent)}
.section-vis-btn{display:none;`
);

// ── 2. HTML: hero — add foxEmail + all toggle buttons ──
html = html.replace(
  `      <div class="fox-nick" id="foxNick"></div>
      <div class="fox-spec" id="foxSpec" style="display:none"></div>
      <div class="fox-city" id="foxCity"></div>
      <div class="rating-pill"><span id="foxRating">0</span> pkt Fox Rating</div>
      <div class="pioneer-badge" id="pioneerBadge" style="display:none"></div>
      <div class="avail-badge" id="availBadge" style="display:none">🟢 Dostępny dziś</div>
      <div class="invoice-badge" id="invoiceBadge" style="display:none">🧾 Wystawia faktury</div>
      <div class="fox-bio" id="foxBio" style="display:none"></div>
      <div class="pub-spec-wrap" id="pubSpecWrap" style="display:none"></div>
      <div class="social-row" id="socialRow"></div>`,
  `      <div class="fox-nick" id="foxNick"></div>
      <div class="fox-spec" id="foxSpec" style="display:none"></div>
      <div id="heroAddressWrap">
        <div class="fox-city" id="foxCity"></div>
        <div class="fox-email" id="foxEmail" style="display:none"></div>
        <button class="hero-vis-btn" id="visHeroAddress" onclick="toggleSectionVis('address')"></button>
      </div>
      <div id="heroEmailWrap">
        <button class="hero-vis-btn" id="visHeroEmail" onclick="toggleSectionVis('email')"></button>
      </div>
      <div id="heroRatingWrap">
        <div class="rating-pill"><span id="foxRating">0</span> pkt Fox Rating</div>
        <div class="pioneer-badge" id="pioneerBadge" style="display:none"></div>
        <button class="hero-vis-btn" id="visHeroRating" onclick="toggleSectionVis('rating')"></button>
      </div>
      <div id="heroAvailWrap">
        <div class="avail-badge" id="availBadge" style="display:none">🟢 Dostępny dziś</div>
        <button class="hero-vis-btn" id="visHeroAvail" onclick="toggleSectionVis('availability')"></button>
      </div>
      <div id="heroInvoiceWrap">
        <div class="invoice-badge" id="invoiceBadge" style="display:none">🧾 Wystawia faktury</div>
        <button class="hero-vis-btn" id="visHeroInvoice" onclick="toggleSectionVis('invoicing_badge')"></button>
      </div>
      <div id="heroBioWrap">
        <div class="fox-bio" id="foxBio" style="display:none"></div>
        <button class="hero-vis-btn" id="visHeroBio" onclick="toggleSectionVis('bio')"></button>
      </div>
      <div id="heroSpecsWrap">
        <div class="pub-spec-wrap" id="pubSpecWrap" style="display:none"></div>
        <button class="hero-vis-btn" id="visHeroSpecs" onclick="toggleSectionVis('specializations')"></button>
      </div>
      <div id="heroSocialWrap">
        <div class="social-row" id="socialRow"></div>
        <button class="hero-vis-btn" id="visHeroSocial" onclick="toggleSectionVis('social_links')"></button>
      </div>`
);

// ── 3. Render: populate foxEmail ──
html = html.replace(
  `  let city = [d.district, d.contact_address, d.city].filter(Boolean).join(' · ');
  document.getElementById('foxCity').textContent = city || '';`,
  `  let city = [d.district, d.contact_address, d.city].filter(Boolean).join(' · ');
  document.getElementById('foxCity').textContent = city || '';
  const emailEl = document.getElementById('foxEmail');
  if (emailEl) {
    if (d.contact_email) {
      emailEl.innerHTML = '<a href="mailto:'+d.contact_email+'">📧 '+escHtml(d.contact_email)+'</a>';
      emailEl.style.display = '';
    } else {
      emailEl.style.display = 'none';
    }
  }`
);

// ── 4. applySectionsVisibility: extend with hero items ──
html = html.replace(
  `function applySectionsVisibility() {
  const secs = ['stats','experience','education','skills','services','portfolio','reviews'];
  secs.forEach(s=>{
    const el = document.getElementById(\`sec\${s.charAt(0).toUpperCase()+s.slice(1)}\`);
    const btn = document.getElementById(\`vis\${s.charAt(0).toUpperCase()+s.slice(1)}\`);
    const hidden = localSectionsVis[s] === false;
    if (el) {
      if (isOwner) {
        el.style.display = '';
        el.classList.toggle('section-hidden-owner', hidden);
      } else {
        el.style.display = hidden ? 'none' : '';
        el.classList.remove('section-hidden-owner');
      }
    }
    if (btn) {
      btn.textContent = hidden ? '🔴 Ukryta' : '🟢 Widoczna';
      btn.className = 'section-vis-btn ' + (hidden ? 'sec-off' : 'sec-on');
    }
  });
}`,
  `function applySectionsVisibility() {
  const secs = ['stats','experience','education','skills','services','portfolio','reviews'];
  secs.forEach(s=>{
    const el = document.getElementById(\`sec\${s.charAt(0).toUpperCase()+s.slice(1)}\`);
    const btn = document.getElementById(\`vis\${s.charAt(0).toUpperCase()+s.slice(1)}\`);
    const hidden = localSectionsVis[s] === false;
    if (el) {
      if (isOwner) {
        el.style.display = '';
        el.classList.toggle('section-hidden-owner', hidden);
      } else {
        el.style.display = hidden ? 'none' : '';
        el.classList.remove('section-hidden-owner');
      }
    }
    if (btn) {
      btn.textContent = hidden ? '🔴 Ukryta' : '🟢 Widoczna';
      btn.className = 'section-vis-btn ' + (hidden ? 'sec-off' : 'sec-on');
    }
  });

  // Hero element toggles
  const heroItems = [
    { key: 'address',         wrapId: 'heroAddressWrap', btnId: 'visHeroAddress' },
    { key: 'email',           wrapId: 'heroEmailWrap',   btnId: 'visHeroEmail' },
    { key: 'rating',          wrapId: 'heroRatingWrap',  btnId: 'visHeroRating' },
    { key: 'availability',    wrapId: 'heroAvailWrap',   btnId: 'visHeroAvail' },
    { key: 'invoicing_badge', wrapId: 'heroInvoiceWrap', btnId: 'visHeroInvoice' },
    { key: 'bio',             wrapId: 'heroBioWrap',     btnId: 'visHeroBio' },
    { key: 'specializations', wrapId: 'heroSpecsWrap',   btnId: 'visHeroSpecs' },
    { key: 'social_links',    wrapId: 'heroSocialWrap',  btnId: 'visHeroSocial' },
  ];
  const heroLabels = {
    address: 'Adres', email: 'Email', rating: 'Rating', availability: 'Dostępność',
    invoicing_badge: 'Faktury', bio: 'Bio', specializations: 'Specjalizacje', social_links: 'Linki'
  };
  heroItems.forEach(({key, wrapId, btnId}) => {
    const wrap = document.getElementById(wrapId);
    const btn  = document.getElementById(btnId);
    const hidden = localSectionsVis[key] === false;
    if (wrap) {
      if (isOwner) {
        wrap.style.opacity = hidden ? '0.35' : '';
      } else {
        wrap.style.display = hidden ? 'none' : '';
      }
    }
    if (btn) {
      btn.textContent = (hidden ? '🔴 ' : '🟢 ') + heroLabels[key];
      btn.className = 'hero-vis-btn ' + (hidden ? 'sec-off' : 'sec-on');
    }
  });
}`
);

// ── 5. PDF: respect hero visibility toggles ──
// Replace the contactParts block and add checks for bio, specs, social in pdfHtml
html = html.replace(
  `  // Header contact line
  const contactParts = [];
  if (localDistrict) contactParts.push(escHtml(localDistrict));
  if (localAddress) contactParts.push(escHtml(localAddress));
  if (localEmail) contactParts.push(escHtml(localEmail));
  contactParts.push('<a href="'+profileUrl+'" style="color:#F97E00">'+profileUrl+'</a>');
  const contactLine = contactParts.join(' &nbsp;|&nbsp; ');`,
  `  // Header contact line (respects hero visibility toggles)
  const contactParts = [];
  if (show('address') && (localDistrict || localAddress)) {
    [localDistrict, localAddress].filter(Boolean).forEach(v => contactParts.push(escHtml(v)));
  }
  if (show('email') && localEmail) contactParts.push(escHtml(localEmail));
  contactParts.push('<a href="'+profileUrl+'" style="color:#F97E00">'+profileUrl+'</a>');
  const contactLine = contactParts.join(' &nbsp;|&nbsp; ');
  const pdfBio = show('bio') ? bio : '';
  const pdfSpecs = show('specializations') ? specs : [];`
);

// Fix pdfHtml to use pdfBio and pdfSpecs
html = html.replace(
  `      + (bio ? '<div class="cv-bio">'+bio+'</div>' : '')`,
  `      + (pdfBio ? '<div class="cv-bio">'+pdfBio+'</div>' : '')`
);
html = html.replace(
  `    + (specs.length ? '<div class="cv-specs">'+specs.map(s=>'<span class="cv-spec-tag">'+escHtml(s)+'</span>').join('')+'</div>' : '')`,
  `    + (pdfSpecs.length ? '<div class="cv-specs">'+pdfSpecs.map(s=>'<span class="cv-spec-tag">'+escHtml(s)+'</span>').join('')+'</div>' : '')`
);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
