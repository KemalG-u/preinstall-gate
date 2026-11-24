'use strict';

// Synthetic test constants are joined at run time so no key-shaped literal sits in the source.
const J = (...parts) => parts.join('');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createProjeHafizasi } = require('../src/index.cjs');

test('1. Tak-çıkar sıfırdan kurulum: başka bir projede sıfırdan başlar, sade Türkçe rehber + AI devir + canlı HTML pano üretir', async () => {
  const fakeProject = await fsp.mkdtemp(path.join(os.tmpdir(), 'ph-yeni-proje-'));
  try {
    await fsp.mkdir(path.join(fakeProject, 'src'), { recursive: true });
    await fsp.writeFile(path.join(fakeProject, 'src', 'motor.js'), 'module.exports = { ok: true };\n', 'utf8');

    const hafiza = createProjeHafizasi({
      projectRoot: fakeProject,
      writeRootHandoverFile: true,
    });

    hafiza.init({
      projectName: 'Örnek E-Ticaret Asistanı',
      projectVision: 'Müşteri sorularını ve iadeleri sade bir panelden yönetmek.',
      ownerName: 'Kemal',
    });

    hafiza.upsertItem({
      id: 'M1',
      title: 'Sipariş Sorgulama Çekirdeği',
      status: 'tamamlandi',
      moduleTag: 'siparis-motoru',
      whatItDoes: 'Müşterinin sipariş numarasından kargo durumunu bulur.',
      whyWeDidIt: 'Müşteri hizmetlerinin tek tek ekran bakma yükünü kaldırmak için.',
      rejectedAlternatives: ['E-posta kazıma yöntemi (yavaş ve kırılgan olduğu için vazgeçildi)'],
      files: ['src/motor.js'],
      verifyCommand: 'node -e "require(\'./src/motor.js\')"',
      evidenceSummary: 'Birim testi geçti (0 hata)',
    });

    hafiza.addIdea({
      title: 'WhatsApp sesli mesajdan iade talebi okuma',
      detailPlainLanguage: 'Müşteri ses atınca metne çevirip ilgili siparişi bulsun.',
      whyValuable: 'Yazmak istemeyen müşterileri kaybetmemek için.',
      relatedItemId: 'M1',
    });

    hafiza.addDecision({
      title: 'Kargo API sorgusunda önbellek kuralı',
      chosenApproach: '5 dakikalık yerel önbellek kullan.',
      whyPlainLanguage: 'Aynı müşteri üst üste yenile yaptığında kargo firması bizi engellemesin diye.',
      rejectedApproaches: ['Her tıklamada canlı sorgu atmak'],
      consequenceIfViolated: 'Kargo API hız sınırına (429) takılır ve sistem kilitlenir.',
      relatedItemId: 'M1',
    });

    const audit = hafiza.audit();
    assert.equal(audit.allHealthy, true);
    assert.equal(audit.completedHealthyCount, 1);

    assert.ok(fs.existsSync(path.join(fakeProject, '.proje-hafizasi', 'CANLI-PANO.html')));
    assert.ok(fs.existsSync(path.join(fakeProject, '.proje-hafizasi', 'PROJE-REHBERI.md')));
    assert.ok(fs.existsSync(path.join(fakeProject, 'AI-DEVIR-TESLIM.md')));
  } finally {
    await fsp.rm(fakeProject, { recursive: true, force: true });
  }
});

test('2. Kırıcı dürüstlük bekçisi: Dosyası olmayan işe TAMAMLANDI dedirtmez; sonradan dosya silinirse otomatik KANIT BOZULDU alarmı yakar!', async () => {
  const fakeProject = await fsp.mkdtemp(path.join(os.tmpdir(), 'ph-durustluk-'));
  try {
    const hafiza = createProjeHafizasi({ projectRoot: fakeProject });
    hafiza.init({ projectName: 'Denetim Testi', projectVision: 'Yalan tamamlandı raporlarını yakalamak.' });

    // A) Olmayan dosyayla "tamamlandi" demeye çalışan yapay zekâ ANINDA engellenmeli!
    assert.throws(() => {
      hafiza.upsertItem({
        id: 'M1.1',
        title: 'Hayali Özellik',
        status: 'tamamlandi',
        whatItDoes: 'Sözde çalışıyor.',
        whyWeDidIt: 'Test için.',
        files: ['olmayan-dosya.js'],
        evidenceSummary: 'Sözde test edildi',
      });
    }, /kanıtsız TAMAMLANDI denemez/);

    // B) Proje dışına kaçan yol (`../../Windows/win.ini`) kanıt olarak verilemez!
    assert.throws(() => {
      hafiza.upsertItem({
        id: 'M1.2',
        title: 'Korsan Yol',
        status: 'tamamlandi',
        whatItDoes: 'Dış dosya.',
        whyWeDidIt: 'Test.',
        files: ['../../outside.txt'],
        evidenceSummary: 'Test',
      });
    }, /Proje kökü dışı|kanıtsız/);

    // C) Gerçek dosya varken kabul edilmeli; ama dosya sonradan silinirse `kanit_bozuldu` olmalı!
    const realFile = path.join(fakeProject, 'gercek.cjs');
    await fsp.writeFile(realFile, 'module.exports = 1;\n', 'utf8');

    hafiza.upsertItem({
      id: 'M1.3',
      title: 'Gerçek Modül',
      status: 'tamamlandi',
      whatItDoes: 'Gerçek iş yapar.',
      whyWeDidIt: 'Gerekli olduğu için.',
      files: ['gercek.cjs'],
      evidenceSummary: 'Doğrulandı.',
    });
    assert.equal(hafiza.audit().allHealthy, true);

    // Şimdi dosyayı silelim (sanki birisi yanlışlıkla bozdu!)
    await fsp.unlink(realFile);
    const brokenAudit = hafiza.audit();
    assert.equal(brokenAudit.allHealthy, false, 'Silinen kanıt dosyası yakalanmalı!');
    assert.deepEqual(brokenAudit.brokenIds, ['M1.3']);
    assert.equal(brokenAudit.byItemId['M1.3'].effectiveStatus, 'kanit_bozuldu');
  } finally {
    await fsp.rm(fakeProject, { recursive: true, force: true });
  }
});

test('3. Gizli anahtar kalkanı ve bozuk JSON yedekten kurtarma (crash recovery) çalışır', async () => {
  const fakeProject = await fsp.mkdtemp(path.join(os.tmpdir(), 'ph-kurtarma-'));
  const leakedKey = J('sk-', 'GIZLI_ANAHTAR_BURAYA_YAZILAMAZ_123456789');
  try {
    const hafiza = createProjeHafizasi({ projectRoot: fakeProject });
    hafiza.init({ projectName: 'Kurtarma Projesi', projectVision: 'Veri kaybını önlemek.' });

    hafiza.addIdea({
      title: `OpenAI entegrasyonu (${leakedKey})`,
      detailPlainLanguage: `Bearer ${leakedKey} ile bağlanma fikri`,
      whyValuable: 'Hız testi',
    });

    const rawOnDisk = await fsp.readFile(hafiza.store.ledgerPath, 'utf8');
    assert.ok(!rawOnDisk.includes(leakedKey), 'Gizli anahtar diske ASLA yazılmamalı, otomatik maskelenmeli!');
    assert.match(rawOnDisk, /GIZLI_DEGER_KORUNDU/);

    // Şimdi ana JSON dosyasını yarım kalmış bozuk metinle ezelim; `.yedek` dosyasından otomatik kurtarmalı!
    await fsp.writeFile(hafiza.store.ledgerPath, '{ "bozuk_yarim_json": ', 'utf8');
    const recovered = hafiza.load();
    assert.equal(recovered.project.name, 'Kurtarma Projesi');
    assert.equal(recovered.ideas.length, 1);
  } finally {
    await fsp.rm(fakeProject, { recursive: true, force: true });
  }
});

test('4. Canlı HTTP Pano Sunucusu + ESM uyumu + sıfır dış/üst bağımlılık kontrolü', async () => {
  const esmMod = await import('../src/index.mjs');
  assert.equal(typeof esmMod.createProjeHafizasi, 'function');

  const fakeProject = await fsp.mkdtemp(path.join(os.tmpdir(), 'ph-sunucu-'));
  let srv = null;
  try {
    const hafiza = esmMod.createProjeHafizasi({ projectRoot: fakeProject });
    hafiza.init({ projectName: 'Canlı Sunucu Testi', projectVision: 'Tarayıcıdan anlık izleme.' });

    srv = await hafiza.startDashboard({ port: 0 });
    const htmlRes = await fetch(srv.url);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.match(htmlText, /Canlı Sunucu Testi/);

    const apiRes = await fetch(`${srv.url}api/durum`);
    assert.equal(apiRes.status, 200);
    const apiJson = await apiRes.json();
    assert.equal(apiJson.ledger.project.name, 'Canlı Sunucu Testi');
  } finally {
    if (srv) await srv.close();
    await fsp.rm(fakeProject, { recursive: true, force: true });
  }

  // `src/` içindeki hiçbir dosyada üst klasöre (`../../` veya `Ürün tanı`) bağımlılık olmamalı!
  const srcDir = path.join(__dirname, '..', 'src');
  for (const fname of fs.readdirSync(srcDir)) {
    const content = fs.readFileSync(path.join(srcDir, fname), 'utf8');
    assert.doesNotMatch(content, /\.\.\/\.\.\//, `${fname} üst klasöre bağımlı olmamalı!`);
    assert.doesNotMatch(content, /Ürün tanı/i, `${fname} belirli tek bir projeye bağımlı olmamalı!`);
  }
});
