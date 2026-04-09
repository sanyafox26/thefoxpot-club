const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

// 1. Add html2pdf CDN before </body>
html = html.replace(
  `</body>`,
  `<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
</body>`
);

// 2. Change btnPrint onclick
html = html.replace(
  `onclick="window.print()"`,
  `onclick="generatePdf()"`
);

// 3. Add generatePdf() before // ── Init ──
html = html.replace(
  `// ── Init ──`,
  `function generatePdf() {
  const logoSrc = document.querySelector('.topbar-logo img')?.src || '';
  const avatarSrc = document.getElementById('foxAvatar')?.src || '';
  const name = escHtml(localDisplayName || NICKNAME);
  const bio = escHtml(profileData?.bio || '');
  const specs = localSpecializations || [];
  const profileUrl = location.href;
  const vis = localSectionsVis;
  const show = s => vis[s] !== false;

  let sectionsHtml = '';

  if (show('experience') && localExperience.length) {
    sectionsHtml += \`<div class="pdf-section">
      <div class="pdf-sec-title">Doświadczenie</div>
      \${localExperience.map(e => \`
        <div class="pdf-card">
          <div class="pdf-card-title">\${escHtml(e.title||'')}</div>
          \${e.company?'<div class="pdf-card-sub orange">'+escHtml(e.company)+'</div>':''}
          \${e.period?'<div class="pdf-card-meta">'+escHtml(e.period)+'</div>':''}
          \${e.desc?'<div class="pdf-card-desc">'+escHtml(e.desc)+'</div>':''}
        </div>\`).join('')}
    </div>\`;
  }

  if (show('education') && localEducation.length) {
    sectionsHtml += \`<div class="pdf-section">
      <div class="pdf-sec-title">Wykształcenie</div>
      \${localEducation.map(e => \`
        <div class="pdf-card">
          <div class="pdf-card-title orange">\${escHtml(e.school||'')}</div>
          \${e.field?'<div class="pdf-card-sub">'+escHtml(e.field)+'</div>':''}
          \${e.degree?'<div class="pdf-card-meta">'+escHtml(e.degree)+'</div>':''}
          \${e.years?'<div class="pdf-card-meta">'+escHtml(e.years)+'</div>':''}
        </div>\`).join('')}
    </div>\`;
  }

  if (show('skills') && localSkills.length) {
    sectionsHtml += \`<div class="pdf-section">
      <div class="pdf-sec-title">Umiejętności</div>
      <div class="pdf-tags">\${localSkills.map(s=>'<span class="pdf-tag">'+escHtml(s)+'</span>').join('')}</div>
    </div>\`;
  }

  if (show('services') && localServices.length) {
    sectionsHtml += \`<div class="pdf-section">
      <div class="pdf-sec-title">Usługi</div>
      \${localServices.map(s => \`
        <div class="pdf-card pdf-card-row">
          <div>
            <div class="pdf-card-title orange">\${escHtml(s.name||'')}</div>
            \${s.desc?'<div class="pdf-card-desc">'+escHtml(s.desc)+'</div>':''}
          </div>
          \${s.price?'<div class="pdf-price">'+escHtml(s.price)+'</div>':''}
        </div>\`).join('')}
    </div>\`;
  }

  if (show('portfolio') && localPortfolio.length) {
    sectionsHtml += \`<div class="pdf-section">
      <div class="pdf-sec-title">Portfolio</div>
      \${localPortfolio.map(p => \`
        <div class="pdf-card">
          <div class="pdf-card-title">\${escHtml(p.title||'')}</div>
          \${p.result?'<div class="pdf-card-desc">'+escHtml(p.result)+'</div>':''}
          \${(p.tags||[]).length?'<div class="pdf-tags" style="margin-top:4px">'+(p.tags.map(t=>'<span class="pdf-tag">'+escHtml(t)+'</span>').join(''))+'</div>':''}
          \${p.url?'<div class="pdf-card-meta"><a href="'+escHtml(p.url)+'" style="color:#F97E00">'+escHtml(p.url)+'</a></div>':''}
        </div>\`).join('')}
    </div>\`;
  }

  const reviews = profileData?.reviews || [];
  if (show('reviews') && reviews.length) {
    sectionsHtml += \`<div class="pdf-section">
      <div class="pdf-sec-title">Recenzje</div>
      \${reviews.map(r => \`
        <div class="pdf-card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="pdf-card-sub orange">\${escHtml(r.venue_name||'')}</div>
            <div style="color:#F97E00">\${'★'.repeat(r.stars||0)}\${'☆'.repeat(5-(r.stars||0))}</div>
          </div>
          \${r.text?'<div class="pdf-card-desc">'+escHtml(r.text)+'</div>':''}
          <div class="pdf-card-meta">\${r.date?new Date(r.date).toLocaleDateString('pl-PL'):''}</div>
        </div>\`).join('')}
    </div>\`;
  }

  const pdfHtml = \`<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;background:#fff;color:#111;font-size:13px;padding:24px 28px}
    .pdf-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #F97E00}
    .pdf-logo{height:44px;width:auto;display:block;margin-bottom:10px}
    .pdf-avatar{width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #F97E00;flex-shrink:0}
    .pdf-name{font-size:22px;font-weight:700;color:#111}
    .pdf-bio{font-size:12px;color:#444;margin-top:4px;line-height:1.5}
    .pdf-specs{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
    .pdf-spec-tag{border:1px solid #F97E00;border-radius:12px;padding:2px 9px;font-size:11px;color:#F97E00}
    .pdf-section{margin-top:16px;padding-top:12px;border-top:1px solid #e0e0e0}
    .pdf-sec-title{font-size:12px;font-weight:700;color:#111;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px}
    .pdf-card{background:#f9f9f9;border-radius:6px;padding:10px 12px;margin-bottom:8px}
    .pdf-card-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
    .pdf-card-title{font-size:13px;font-weight:600;color:#111}
    .orange{color:#F97E00}
    .pdf-card-sub{font-size:12px;font-weight:500;color:#555;margin-top:2px}
    .pdf-card-meta{font-size:11px;color:#888;margin-top:2px}
    .pdf-card-desc{font-size:12px;color:#555;margin-top:4px;line-height:1.5}
    .pdf-tags{display:flex;flex-wrap:wrap;gap:5px}
    .pdf-tag{border:1px solid #F97E00;border-radius:10px;padding:2px 8px;font-size:11px;color:#F97E00}
    .pdf-price{font-size:13px;font-weight:700;color:#F97E00;white-space:nowrap;padding-top:2px}
    .pdf-footer{margin-top:24px;padding-top:12px;border-top:1px solid #e0e0e0;font-size:10px;color:#999;text-align:center}
  </style></head><body>
  <div class="pdf-header">
    <div style="flex:1">
      \${logoSrc?'<img class="pdf-logo" src="'+logoSrc+'" alt="FoxPot Club"/>'
               :'<span style="font-size:20px;font-weight:800;color:#F97E00">FoxPot Club</span><br/>'}
      <div class="pdf-name">\${name}</div>
      \${bio?'<div class="pdf-bio">'+bio+'</div>':''}
      \${specs.length?'<div class="pdf-specs">'+specs.map(s=>'<span class="pdf-spec-tag">'+escHtml(s)+'</span>').join('')+'</div>':''}
    </div>
    \${avatarSrc?'<img class="pdf-avatar" src="'+avatarSrc+'" alt=""/>':''}
  </div>
  \${sectionsHtml}
  <div class="pdf-footer">\${profileUrl}</div>
  </body></html>\`;

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;left:-9999px;top:0;width:794px';
  wrapper.innerHTML = pdfHtml;
  document.body.appendChild(wrapper);

  html2pdf().set({
    margin: 0,
    filename: 'foxpot-' + NICKNAME + '.pdf',
    image: { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true, allowTaint: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(wrapper).save().then(() => document.body.removeChild(wrapper));
}

// ── Init ──`
);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
