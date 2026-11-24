'use strict';

/**
 * Sade Türkçe Rehber, Yapay Zekâ Devir-Teslim ve Canlı Görsel Pano Üreticisi (`sunum-uretici.cjs`)
 *
 * Ürettiği Çıktılar (`.proje-hafizasi/` altında veya isteğe bağlı proje kökünde):
 * 1. `CANLI-PANO.html`       : Kullanıcının yan ekranda açıp canlı takip edeceği, arama/filtreleme
 *                              yapılabilen, otomatik yenilenebilen sade Türkçe görsel takip ekranı!
 * 2. `PROJE-REHBERI.md`      : İnsanın 2 dakikada "Hangi madde nerede, neyi neden yaptık?" sorusunu
 *                              okuyabileceği numaralı kılavuz.
 * 3. `AI-DEVIR-TESLIM.md`    : Claude, Codex, Gemini, OpenCode, Cursor veya başka bir yapay zekâ
 *                              projeyi devraldığında 30 saniyede konuyu kavrayıp aynı disiplinle
 *                              çalışmasını sağlayan zorunlu protokol!
 * 4. İsteğe bağlı güvenli kanca enjeksiyonu (`AGENTS.md` / `CLAUDE.md` yönetilen bloklarına DOKUNMAZ!).
 */

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteText, escapeHtml } = require('./guvenlik.cjs');

const STATUS_LABELS = {
  tamamlandi: { badge: '🟢 TAMAMLANDI & KANITLANDI', css: 'st-done', short: 'Tamamlandı' },
  devam_ediyor: { badge: '🟡 ŞU AN YAPILIYOR', css: 'st-active', short: 'Yapılıyor' },
  bekliyor: { badge: '🔵 SIRADA BEKLİYOR', css: 'st-pending', short: 'Sırada' },
  engelli: { badge: '🟠 KARAR / ENGEL BEKLİYOR', css: 'st-blocked', short: 'Engelli' },
  kanit_bozuldu: { badge: '🔴 DİKKAT: KANIT DOSYASI EKSİK/BOZUK!', css: 'st-broken', short: 'Kanıt Bozuk!' },
};

const IDEA_LABELS = {
  park_edildi: '💡 Park Edildi (Sırasını Bekliyor)',
  planlandi: '📌 Maddeye Bağlandı',
  uygulandi: '✅ Uygulandı',
  vazgecildi: '🗄️ Vazgeçildi',
};

function renderMarkdownGuide(ledger, auditReport, recentHistory = []) {
  const lines = [];
  lines.push(`# 🧭 ${ledger.project.name} — Sade Türkçe Proje Hafızası ve Haritası`);
  lines.push('');
  lines.push(`- **Son Güncelleme:** ${ledger.project.updatedAt}`);
  lines.push(`- **Kanıt Denetimi:** ${auditReport.allHealthy ? '✅ Tüm tamamlanan maddelerin dosya ve test kanıtları sağlam' : `🔴 DİKKAT: ${auditReport.brokenCount} maddede kanıt sorunu var (${auditReport.brokenIds.join(', ')})`}`);
  lines.push(`- **Şu Anki Odak Madde:** ${ledger.project.currentFocusItemId || 'Yeni adım onayı bekleniyor'}`);
  if (ledger.project.nextStepPlainLanguage) {
    lines.push(`- **Sıradaki Net Adım:** ${ledger.project.nextStepPlainLanguage}`);
  }
  lines.push('');
  lines.push('## 1. Büyük Resim: Biz Ne Yapıyoruz?');
  lines.push('');
  lines.push(ledger.project.visionPlainLanguage);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 2. Numaralı İş ve Özellik Haritası (`M1`, `M1.1`...)');
  lines.push('> Aklına yeni bir fikir geldiğinde sadece ilgili madde numarasını (ör. `M2.3`) söylemen yeterli.');
  lines.push('');

  for (const item of ledger.items) {
    const a = auditReport.byItemId[item.id];
    const st = STATUS_LABELS[a?.effectiveStatus || item.status] || STATUS_LABELS.bekliyor;
    const indent = (item.id.split('.').length - 1) > 0 ? '### ' : '## ';
    lines.push(`${indent}\`${item.id}\` — ${item.title} [${st.badge}]`);
    lines.push(`- **Modül / Alan:** \`${item.moduleTag}\``);
    lines.push(`- **Bu Ne İşe Yarar? (Sade Anlatım):** ${item.whatItDoes || '-'}`);
    lines.push(`- **Neden Yaptık / Hangi Sorunu Önler?:** ${item.whyWeDidIt || '-'}`);
    if (item.howItWorksSimple) {
      lines.push(`- **Nasıl Çalışır?:** ${item.howItWorksSimple}`);
    }
    if (item.rejectedAlternatives?.length) {
      lines.push(`- **Vazgeçilen / Girilmeyecek Yollar:** ${item.rejectedAlternatives.join(' | ')}`);
    }
    if (item.doNotTouchWarnings?.length) {
      lines.push(`- **Kırmızı Çizgi (Bozma Uyarısı):** ${item.doNotTouchWarnings.join(' | ')}`);
    }
    if (item.files?.length) {
      lines.push(`- **Nerede Duruyor (Dosyalar):** ${item.files.map(f => `\`${f}\``).join(', ')}`);
    }
    if (item.verifyCommand) {
      lines.push(`- **Doğrulama Komutu:** \`${item.verifyCommand}\``);
    }
    if (item.evidenceSummary) {
      lines.push(`- **Kanıt Özeti:** ${item.evidenceSummary}`);
    }
    if (a?.issues?.length) {
      lines.push(`- **⚠️ Denetçi Uyarısı:** ${a.issues.join(' / ')}`);
    }

    const linkedIdeas = (ledger.ideas || []).filter(i => i.relatedItemId === item.id);
    if (linkedIdeas.length) {
      lines.push(`- **💡 Bu Maddeye Bağlı Fikirler:** ${linkedIdeas.map(i => `\`${i.id}\` ${i.title} (${IDEA_LABELS[i.status] || i.status})`).join('; ')}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 3. Fikir Havuzu / Park Yeri (`F-01`...)');
  lines.push('> Elimizdeki işi bölmemek için park ettiğimiz ama asla unutulmayacak fikirler:');
  lines.push('');
  if (!ledger.ideas?.length) {
    lines.push('_Henüz park edilmiş fikir yok._');
  } else {
    for (const idea of ledger.ideas) {
      lines.push(`- **\`${idea.id}\` — ${idea.title}** (${IDEA_LABELS[idea.status] || idea.status})`);
      lines.push(`  - **İlgili Madde:** \`${idea.relatedItemId || 'Genel'}\` | **Ne Zaman Bakılacak?:** ${idea.whenToRevisit}`);
      if (idea.detailPlainLanguage) lines.push(`  - **Açıklama:** ${idea.detailPlainLanguage}`);
      if (idea.whyValuable) lines.push(`  - **Neden Önemli?:** ${idea.whyValuable}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 4. Kritik Mimari Kararlar ve "Aynı Çukura Düşmeme" Kayıtları (`K-01`...)');
  lines.push('');
  if (!ledger.decisions?.length) {
    lines.push('_Henüz kayıtlı karar yok._');
  } else {
    for (const dec of ledger.decisions) {
      lines.push(`### \`${dec.id}\` — ${dec.title}${dec.relatedItemId ? ` (İlgili: \`${dec.relatedItemId}\`)` : ''}`);
      lines.push(`- **Seçilen Doğru Yol:** ${dec.chosenApproach}`);
      lines.push(`- **Neden Böyle Seçtik?:** ${dec.whyPlainLanguage}`);
      if (dec.rejectedApproaches?.length) {
        lines.push(`- **Denenip Reddedilen Yanlış Yollar:** ${dec.rejectedApproaches.join(' | ')}`);
      }
      if (dec.consequenceIfViolated) {
        lines.push(`- **Bu Karar Çiğnenirse Ne Bozulur?:** ${dec.consequenceIfViolated}`);
      }
      lines.push('');
    }
  }

  if (recentHistory.length) {
    lines.push('---');
    lines.push('');
    lines.push('## 5. Son Değişiklik Tarihçesi (Kim, Ne Zaman, Ne Yaptı?)');
    lines.push('');
    for (const h of recentHistory.slice(0, 15)) {
      lines.push(`- \`${h.at}\` **[${h.actor}]** (${h.eventType}): ${h.summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderAiHandoverMarkdown(ledger, auditReport, dataDirRel) {
  const completed = ledger.items.filter(i => auditReport.byItemId[i.id]?.effectiveStatus === 'tamamlandi');
  const active = ledger.items.filter(i => auditReport.byItemId[i.id]?.effectiveStatus === 'devam_ediyor');
  const pending = ledger.items.filter(i => auditReport.byItemId[i.id]?.effectiveStatus === 'bekliyor');
  const broken = ledger.items.filter(i => auditReport.byItemId[i.id]?.evidenceBroken);

  const lines = [];
  lines.push(`# 🤖 AI DEVİR-TESLİM VE ZORUNLU ÇALIŞMA DİSİPLİNİ (${ledger.project.name})`);
  lines.push('');
  lines.push('> **BU PROJEYİ OKUYAN HERHANGİ BİR YAPAY ZEKÂ AJANINA (Claude, Codex, Gemini, Antigravity, OpenCode, Cursor vb.) ZORUNLU TALİMAT:**');
  lines.push('> Koda dokunmadan ÖNCE bu dosyayı baştan sona oku ve aşağıdaki çalışma disiplinine **istisnasız** uy!');
  lines.push('');
  lines.push('## 1. Tek Gerçek Kaynak ve Komutlar');
  lines.push(`- **Kanonik Hafıza Verisi:** \`${dataDirRel}/hafiza-defteri.json\` (Elle bozma; modül CLI veya API üzerinden güncelle!)`);
  lines.push(`- **Görsel Kullanıcı Panosu:** \`${dataDirRel}/CANLI-PANO.html\``);
  lines.push('- **Durumu ve Kanıtları Kontrol Et:** `node moduller/proje-hafizasi/src/cli.cjs durum`');
  lines.push('- **Değişiklik Sonrası Belgeleri ve Panoyu Yenile:** `node moduller/proje-hafizasi/src/cli.cjs yenile`');
  lines.push('- **Canlı Panoyu Tarayıcıda Aç:** `node moduller/proje-hafizasi/src/cli.cjs pano`');
  lines.push('');
  lines.push('## 2. Değiştirilemez Çalışma Kuralları (Kırmızı Çizgiler)');
  for (const [idx, rule] of (ledger.disciplineRules || []).entries()) {
    lines.push(`${idx + 1}. ${rule}`);
  }
  lines.push('');
  lines.push('## 3. Şu Anki Anlık Durum Özeti (30 Saniyelik Bağlam)');
  lines.push(`- **Projenin Gerçek Hedefi:** ${ledger.project.visionPlainLanguage}`);
  lines.push(`- **Şu Anki Odak Madde:** \`${ledger.project.currentFocusItemId || 'Yok'}\``);
  lines.push(`- **Sıradaki Beklenen Adım:** ${ledger.project.nextStepPlainLanguage || 'Kullanıcı ile sıradaki maddeyi onayla.'}`);
  if (broken.length) {
    lines.push(`- **🔴 ACİL KANIT UYARISI (Önce Bunu Onar!):** ${broken.map(b => `\`${b.id}\` (${b.title})`).join(', ')}`);
  }
  lines.push('');
  lines.push('### 🟡 Şu An Üzerinde Çalışılan Maddeler');
  if (!active.length) lines.push('- Şu an açık `devam_ediyor` madde yok.');
  for (const it of active) {
    lines.push(`- **\`${it.id}\` ${it.title}** (${it.moduleTag}) -> Dosyalar: ${(it.files || []).join(', ') || 'henüz yok'}`);
  }
  lines.push('');
  lines.push('### 🟢 Tamamlanmış ve Kanıtlanmış Maddeler (Dokunurken Geriye Dönük Kırma!)');
  for (const it of completed) {
    lines.push(`- **\`${it.id}\` ${it.title}** -> Kanıt: \`${it.verifyCommand || it.evidenceSummary}\` | Dosyalar: ${(it.files || []).map(f => `\`${f}\``).join(', ')}`);
  }
  lines.push('');
  lines.push('### 🔵 Sırada Bekleyen Maddeler (Kullanıcı Onayı Olmadan Faz Atlama!)');
  for (const it of pending) {
    lines.push(`- **\`${it.id}\` ${it.title}** — ${it.whatItDoes}`);
  }
  lines.push('');
  lines.push('## 4. Tekrarlanmaması Gereken Hatalar ve Mimari Kararlar');
  for (const dec of ledger.decisions || []) {
    lines.push(`- **\`${dec.id}\` ${dec.title}:** Seçilen: *${dec.chosenApproach}* | **ASLA YAPMA:** ${(dec.rejectedApproaches || []).join('; ') || '-'}`);
  }
  lines.push('');
  lines.push('## 5. Park Edilmiş Kullanıcı Fikirleri (Sırası Geldiğinde Uygulamak İçin)');
  for (const idea of ledger.ideas || []) {
    lines.push(`- **\`${idea.id}\` (${idea.relatedItemId || 'Genel'}):** ${idea.title} — *${idea.whenToRevisit}*`);
  }

  return `${lines.join('\n')}\n`;
}

function renderDashboardHtml(ledger, auditReport, recentHistory = [], { liveServerMode = false } = {}) {
  const payload = {
    ledger,
    auditReport,
    recentHistory: recentHistory.slice(0, 25),
    generatedAt: new Date().toISOString(),
  };
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(ledger.project.name)} — Canlı Proje Hafızası ve Takip Panosu</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --panel-hover: #26354d;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --green: #10b981;
      --green-bg: rgba(16, 185, 129, 0.14);
      --yellow: #f59e0b;
      --yellow-bg: rgba(245, 158, 11, 0.16);
      --blue: #38bdf8;
      --blue-bg: rgba(56, 189, 248, 0.14);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.18);
      --purple: #a78bfa;
      --purple-bg: rgba(167, 139, 250, 0.15);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
    }
    .wrap { max-width: 1320px; margin: 0 auto; padding: 24px 20px 64px; }
    .hero {
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px 24px;
      margin-bottom: 20px;
    }
    .hero-top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: center; }
    .hero h1 { margin: 0; font-size: 1.45rem; letter-spacing: -0.01em; }
    .live-pill {
      font-size: 0.82rem;
      padding: 6px 12px;
      border-radius: 999px;
      background: var(--green-bg);
      color: var(--green);
      border: 1px solid rgba(16,185,129,0.35);
      font-weight: 600;
    }
    .vision-box {
      margin-top: 14px;
      padding: 14px 16px;
      background: rgba(15, 23, 42, 0.65);
      border-left: 4px solid var(--blue);
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 0.96rem;
    }
    .next-step-banner {
      margin-top: 12px;
      padding: 12px 16px;
      background: var(--yellow-bg);
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      font-size: 0.94rem;
    }
    .alert-banner {
      margin-top: 12px;
      padding: 12px 16px;
      background: var(--red-bg);
      border: 1px solid var(--red);
      border-radius: 10px;
      color: #fecaca;
      font-weight: 600;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
    }
    .stat-num { font-size: 1.65rem; font-weight: 700; }
    .stat-lbl { font-size: 0.84rem; color: var(--muted); }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 18px;
      align-items: center;
    }
    .search-input {
      flex: 1;
      min-width: 240px;
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      font-size: 0.95rem;
    }
    .tab-btn {
      padding: 9px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
      font-weight: 600;
      font-size: 0.88rem;
    }
    .tab-btn.active {
      background: var(--blue);
      color: #082f49;
      border-color: var(--blue);
    }
    .item-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px 20px;
      margin-bottom: 14px;
      transition: border-color 0.15s;
    }
    .item-card.child-item { margin-left: 26px; border-left: 4px solid #475569; }
    .item-card.st-done { border-left: 4px solid var(--green); }
    .item-card.st-active { border-left: 4px solid var(--yellow); box-shadow: 0 0 0 1px rgba(245,158,11,0.3); }
    .item-card.st-broken { border: 2px solid var(--red); }
    .item-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; align-items: center; }
    .item-id {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      background: #0f172a;
      color: var(--blue);
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 0.95rem;
      border: 1px solid var(--border);
    }
    .item-title { font-size: 1.08rem; font-weight: 700; margin-left: 8px; }
    .badge {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 700;
    }
    .badge.st-done { background: var(--green-bg); color: var(--green); }
    .badge.st-active { background: var(--yellow-bg); color: var(--yellow); }
    .badge.st-pending { background: var(--blue-bg); color: var(--blue); }
    .badge.st-broken { background: var(--red-bg); color: #fca5a5; }
    .badge.mod-tag { background: var(--purple-bg); color: var(--purple); margin-right: 6px; }
    .qa-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .qa-box {
      background: rgba(15, 23, 42, 0.55);
      border: 1px solid rgba(51, 65, 85, 0.8);
      border-radius: 10px;
      padding: 11px 14px;
      font-size: 0.91rem;
    }
    .qa-box strong { display: block; color: var(--blue); font-size: 0.8rem; text-transform: uppercase; margin-bottom: 4px; }
    .meta-line { margin-top: 10px; font-size: 0.84rem; color: var(--muted); }
    .code-pill {
      display: inline-block;
      font-family: ui-monospace, Consolas, monospace;
      background: #0f172a;
      padding: 2px 7px;
      border-radius: 5px;
      margin: 2px 4px 2px 0;
      color: #cbd5e1;
      font-size: 0.8rem;
    }
    .idea-tag {
      margin-top: 10px;
      padding: 8px 12px;
      background: var(--purple-bg);
      border-radius: 8px;
      font-size: 0.87rem;
      color: #ddd6fe;
    }
    .warn-box {
      margin-top: 10px;
      padding: 8px 12px;
      background: rgba(239, 68, 68, 0.14);
      border-radius: 8px;
      font-size: 0.85rem;
      color: #fecaca;
    }
    .section-title { font-size: 1.2rem; margin: 26px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="hero-top">
        <h1 id="projTitle">🧭 Proje Hafızası</h1>
        <span class="live-pill" id="syncInfo">Canlı Kayıt</span>
      </div>
      <div class="vision-box" id="projVision"></div>
      <div class="next-step-banner" id="nextStepBox"></div>
      <div class="alert-banner hidden" id="brokenAlertBox"></div>
    </div>

    <div class="stats" id="statsGrid"></div>

    <div class="controls">
      <input type="search" id="searchBox" class="search-input" placeholder="Madde numarası (M1.2), özellik, karar veya fikir ara..." />
      <button class="tab-btn active" data-filter="all">Tümü</button>
      <button class="tab-btn" data-filter="devam_ediyor">🟡 Şu An Yapılanlar</button>
      <button class="tab-btn" data-filter="tamamlandi">🟢 Tamamlananlar</button>
      <button class="tab-btn" data-filter="bekliyor">🔵 Sıradakiler</button>
      <button class="tab-btn" data-filter="ideas">💡 Fikir Havuzu</button>
      <button class="tab-btn" data-filter="decisions">⚖️ Kritik Kararlar</button>
    </div>

    <div id="itemsContainer"></div>
    <div id="ideasSection">
      <h2 class="section-title">💡 Fikir Havuzu / Park Yeri (Sırayı Bozmadan Saklanan Fikirler)</h2>
      <div id="ideasContainer"></div>
    </div>
    <div id="decisionsSection">
      <h2 class="section-title">⚖️ Unutulmaması Gereken Kararlar ve Girilmeyecek Çıkmaz Sokaklar</h2>
      <div id="decisionsContainer"></div>
    </div>
    <div id="historySection">
      <h2 class="section-title">🕒 Son İşlem Tarihçesi</h2>
      <div id="historyContainer"></div>
    </div>
  </div>

  <script>
    window.__INITIAL_MEMORY__ = ${safeJson};
    const LIVE_MODE = ${liveServerMode ? 'true' : 'false'};
    let currentData = window.__INITIAL_MEMORY__;
    let activeFilter = 'all';
    let searchTerm = '';

    const ST_META = {
      tamamlandi: { label: '🟢 TAMAMLANDI & KANITLANDI', cls: 'st-done' },
      devam_ediyor: { label: '🟡 ŞU AN YAPILIYOR', cls: 'st-active' },
      bekliyor: { label: '🔵 SIRADA BEKLİYOR', cls: 'st-pending' },
      engelli: { label: '🟠 KARAR BEKLİYOR', cls: 'st-broken' },
      kanit_bozuldu: { label: '🔴 KANIT EKSİK / BOZUK!', cls: 'st-broken' }
    };

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    function render() {
      const { ledger, auditReport, recentHistory } = currentData;
      document.getElementById('projTitle').textContent = '🧭 ' + ledger.project.name + ' — Canlı Takip ve Hafıza Panosu';
      document.getElementById('syncInfo').textContent = (LIVE_MODE ? '🟢 Canlı Otomatik Yenileme Açık • ' : '📄 Son Güncelleme: ') + new Date(ledger.project.updatedAt).toLocaleString('tr-TR');
      document.getElementById('projVision').innerHTML = '<strong>BÜYÜK RESİM (HEDEFİMİZ):</strong> ' + esc(ledger.project.visionPlainLanguage);

      const focusTxt = ledger.project.currentFocusItemId ? ('Odak Madde: ' + ledger.project.currentFocusItemId + ' • ') : '';
      document.getElementById('nextStepBox').innerHTML = '<strong>👉 SIRADAKİ ADIM:</strong> <span>' + esc(focusTxt + (ledger.project.nextStepPlainLanguage || 'Kullanıcı onayıyla sıradaki maddeye geçilecek.')) + '</span>';

      const alertEl = document.getElementById('brokenAlertBox');
      if (auditReport.warningAlerts && auditReport.warningAlerts.length) {
        alertEl.classList.remove('hidden');
        alertEl.textContent = auditReport.warningAlerts.join(' | ');
      } else {
        alertEl.classList.add('hidden');
      }

      const pendingCount = ledger.items.filter(i => (auditReport.byItemId[i.id]?.effectiveStatus || i.status) === 'bekliyor').length;
      const activeCount = auditReport.activeIds.length;
      document.getElementById('statsGrid').innerHTML = [
        { num: auditReport.completedHealthyCount + ' / ' + auditReport.totalItems, lbl: '🟢 Kanıtlanmış Biten Madde', color: 'var(--green)' },
        { num: activeCount, lbl: '🟡 Şu An Üzerinde Çalışılan', color: 'var(--yellow)' },
        { num: pendingCount, lbl: '🔵 Sırada Bekleyen Adım', color: 'var(--blue)' },
        { num: (ledger.ideas || []).length, lbl: '💡 Park Edilmiş Fikir', color: 'var(--purple)' },
        { num: (ledger.decisions || []).length, lbl: '⚖️ Kayıtlı Mimari Karar', color: '#e2e8f0' }
      ].map(s => '<div class="stat-card"><div class="stat-num" style="color:' + s.color + '">' + esc(s.num) + '</div><div class="stat-lbl">' + esc(s.lbl) + '</div></div>').join('');

      const q = searchTerm.trim().toLowerCase();
      const matchesQ = (obj) => !q || JSON.stringify(obj).toLowerCase().includes(q);

      // Maddeler
      const showItems = !['ideas', 'decisions'].includes(activeFilter);
      const itemsEl = document.getElementById('itemsContainer');
      itemsEl.classList.toggle('hidden', !showItems);
      if (showItems) {
        const filteredItems = ledger.items.filter(it => {
          const eff = auditReport.byItemId[it.id]?.effectiveStatus || it.status;
          if (activeFilter !== 'all' && eff !== activeFilter) return false;
          return matchesQ(it);
        });
        itemsEl.innerHTML = filteredItems.map(it => {
          const audit = auditReport.byItemId[it.id] || {};
          const eff = audit.effectiveStatus || it.status;
          const st = ST_META[eff] || ST_META.bekliyor;
          const isChild = it.id.includes('.');
          const linkedIdeas = (ledger.ideas || []).filter(f => f.relatedItemId === it.id);

          return '<div class="item-card ' + st.cls + (isChild ? ' child-item' : '') + '">' +
            '<div class="item-head">' +
              '<div><span class="item-id">' + esc(it.id) + '</span><span class="item-title">' + esc(it.title) + '</span></div>' +
              '<div><span class="badge mod-tag">' + esc(it.moduleTag) + '</span><span class="badge ' + st.cls + '">' + esc(st.label) + '</span></div>' +
            '</div>' +
            '<div class="qa-grid">' +
              '<div class="qa-box"><strong>Bu Parça Ne İşe Yarar?</strong>' + esc(it.whatItDoes) + '</div>' +
              '<div class="qa-box"><strong>Neden Bunu Yaptık / Yapıyoruz?</strong>' + esc(it.whyWeDidIt) + '</div>' +
              (it.howItWorksSimple ? '<div class="qa-box"><strong>Nasıl Çalışır? (Sade Özeti)</strong>' + esc(it.howItWorksSimple) + '</div>' : '') +
            '</div>' +
            (it.rejectedAlternatives && it.rejectedAlternatives.length
              ? '<div class="meta-line">🚫 <strong>Vazgeçilen / Girilmeyecek Yollar:</strong> ' + esc(it.rejectedAlternatives.join(' • ')) + '</div>'
              : '') +
            (it.doNotTouchWarnings && it.doNotTouchWarnings.length
              ? '<div class="warn-box">🛡️ <strong>Kırmızı Çizgi (Bozma Uyarısı):</strong> ' + esc(it.doNotTouchWarnings.join(' • ')) + '</div>'
              : '') +
            (it.files && it.files.length
              ? '<div class="meta-line">📂 <strong>Dosyalar:</strong> ' + it.files.map(f => '<span class="code-pill">' + esc(f) + '</span>').join('') + '</div>'
              : '') +
            (it.evidenceSummary
              ? '<div class="meta-line">✅ <strong>Doğrulama Kanıtı:</strong> ' + esc(it.evidenceSummary) + (it.verifyCommand ? ' <span class="code-pill">' + esc(it.verifyCommand) + '</span>' : '') + '</div>'
              : '') +
            (audit.issues && audit.issues.length
              ? '<div class="warn-box">⚠️ <strong>Denetçi Uyarısı:</strong> ' + esc(audit.issues.join(' | ')) + '</div>'
              : '') +
            (linkedIdeas.length
              ? '<div class="idea-tag">💡 <strong>Bu Maddeye Park Edilmiş Fikirler:</strong> ' + linkedIdeas.map(f => '[' + esc(f.id) + '] ' + esc(f.title)).join(' • ') + '</div>'
              : '') +
          '</div>';
        }).join('') || '<div class="item-card">Bu filtreye uygun madde bulunamadı.</div>';
      }

      // Fikirler
      const showIdeas = activeFilter === 'all' || activeFilter === 'ideas';
      document.getElementById('ideasSection').classList.toggle('hidden', !showIdeas);
      if (showIdeas) {
        const ideas = (ledger.ideas || []).filter(matchesQ);
        document.getElementById('ideasContainer').innerHTML = ideas.map(f =>
          '<div class="item-card"><div class="item-head">' +
            '<div><span class="item-id">' + esc(f.id) + '</span><span class="item-title">' + esc(f.title) + '</span></div>' +
            '<span class="badge mod-tag">İlgili Madde: ' + esc(f.relatedItemId || 'Genel') + '</span>' +
          '</div>' +
          '<div class="qa-grid">' +
            '<div class="qa-box"><strong>Fikir Detayı</strong>' + esc(f.detailPlainLanguage) + '</div>' +
            '<div class="qa-box"><strong>Neden Değerli & Ne Zaman Bakılacak?</strong>' + esc(f.whyValuable) + ' — <em>(' + esc(f.whenToRevisit) + ')</em></div>' +
          '</div></div>'
        ).join('') || '<div class="item-card">Kayıtlı fikir bulunamadı.</div>';
      }

      // Kararlar
      const showDec = activeFilter === 'all' || activeFilter === 'decisions';
      document.getElementById('decisionsSection').classList.toggle('hidden', !showDec);
      if (showDec) {
        const decs = (ledger.decisions || []).filter(matchesQ);
        document.getElementById('decisionsContainer').innerHTML = decs.map(d =>
          '<div class="item-card"><div class="item-head">' +
            '<div><span class="item-id">' + esc(d.id) + '</span><span class="item-title">' + esc(d.title) + '</span></div>' +
            (d.relatedItemId ? '<span class="badge mod-tag">İlgili: ' + esc(d.relatedItemId) + '</span>' : '') +
          '</div>' +
          '<div class="qa-grid">' +
            '<div class="qa-box"><strong>Seçtiğimiz Yol & Nedeni</strong>' + esc(d.chosenApproach) + ' — ' + esc(d.whyPlainLanguage) + '</div>' +
            '<div class="qa-box"><strong>Girilmeyecek Yollar & Çiğnenirse Ne Olur?</strong>' + esc((d.rejectedApproaches || []).join(' • ')) + (d.consequenceIfViolated ? ' | ⚠️ ' + esc(d.consequenceIfViolated) : '') + '</div>' +
          '</div></div>'
        ).join('') || '<div class="item-card">Kayıtlı karar bulunamadı.</div>';
      }

      // Tarihçe
      document.getElementById('historySection').classList.toggle('hidden', activeFilter !== 'all');
      document.getElementById('historyContainer').innerHTML = (recentHistory || []).slice(0, 12).map(h =>
        '<div class="meta-line">• <span class="code-pill">' + esc(new Date(h.at).toLocaleString('tr-TR')) + '</span> <strong>[' + esc(h.actor) + ']</strong> ' + esc(h.summary) + '</div>'
      ).join('');
    }

    document.getElementById('searchBox').addEventListener('input', (e) => {
      searchTerm = e.target.value || '';
      render();
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        render();
      });
    });

    render();

    if (LIVE_MODE) {
      setInterval(async () => {
        try {
          const r = await fetch('/api/durum', { cache: 'no-store' });
          if (r.ok) {
            currentData = await r.json();
            render();
          }
        } catch (_) {}
      }, 3000);
    }
  </script>
</body>
</html>`;
}

function generateAllViews(store, options = {}) {
  const ledger = store.load();
  if (!ledger) throw new Error('Önce proje hafızası başlatılmalıdır.');
  const auditReport = store.audit();
  const recentHistory = store.readRecentHistory(30);

  const relDataDir = path.relative(store.projectRoot, store.dataDir).split(path.sep).join('/') || '.proje-hafizasi';
  const guideMd = renderMarkdownGuide(ledger, auditReport, recentHistory);
  const aiMd = renderAiHandoverMarkdown(ledger, auditReport, relDataDir);
  const html = renderDashboardHtml(ledger, auditReport, recentHistory, { liveServerMode: false });

  const guidePath = path.join(store.dataDir, 'PROJE-REHBERI.md');
  const aiPath = path.join(store.dataDir, 'AI-DEVIR-TESLIM.md');
  const htmlPath = path.join(store.dataDir, 'CANLI-PANO.html');

  atomicWriteText(guidePath, guideMd);
  atomicWriteText(aiPath, aiMd);
  atomicWriteText(htmlPath, html);

  // Eğer proje kökünde de `AI-DEVIR-TESLIM.md` kopyası istenirse (mevcut `AGENTS.md` ve `CLAUDE.md`'ye DOKUNMADAN!)
  let rootAiPath = null;
  if (options.writeRootHandoverFile) {
    rootAiPath = path.join(store.projectRoot, 'AI-DEVIR-TESLIM.md');
    atomicWriteText(rootAiPath, aiMd);
  }

  return {
    auditReport,
    filesWritten: [guidePath, aiPath, htmlPath, rootAiPath].filter(Boolean),
    guidePath,
    aiPath,
    htmlPath,
    rootAiPath,
  };
}

module.exports = {
  renderMarkdownGuide,
  renderAiHandoverMarkdown,
  renderDashboardHtml,
  generateAllViews,
};
