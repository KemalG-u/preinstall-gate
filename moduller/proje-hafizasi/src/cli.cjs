#!/usr/bin/env node
'use strict';

/**
 * `proje-hafizasi` Komut Satırı Aracı (`cli.cjs`)
 *
 * Kullanım Örnekleri:
 *   node cli.cjs baslat --proje "Yeni Projem" --hedef "Sade Türkçe hedef..."
 *   node cli.cjs durum [--kok "D:/baska-proje"] [--json]
 *   node cli.cjs yenile [--kok "D:/baska-proje"] [--kok-devir]
 *   node cli.cjs fikir --baslik "Telegram bildirimi" --madde M2.1 --detay "Limit %80 olunca..."
 *   node cli.cjs ara "soğuma"
 *   node cli.cjs pano [--port 4195]
 */

const path = require('node:path');
const { createProjeHafizasi } = require('./index.cjs');

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(token);
    }
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const cmd = flags._[0] || 'durum';
  const projectRoot = path.resolve(flags.kok || process.cwd());
  const dataDir = flags.veri ? path.resolve(flags.veri) : undefined;

  const hafiza = createProjeHafizasi({
    projectRoot,
    dataDir,
    writeRootHandoverFile: Boolean(flags['kok-devir']),
  });

  if (cmd === 'baslat') {
    const { ledger, views } = hafiza.init({
      projectName: flags.proje || path.basename(projectRoot),
      projectVision: flags.hedef || 'Proje hedefi tanımlanacak.',
      ownerName: flags.sahip || 'Proje sahibi',
      actor: flags.kim || 'kullanici',
    });
    console.log(`Proje hafızası hazırlandı: ${ledger.project.name}`);
    console.log(`Üretilen dosyalar:\n - ${views.filesWritten.join('\n - ')}`);
    return;
  }

  if (cmd === 'fikir') {
    if (!flags.baslik) {
      throw new Error('Fikir eklemek için --baslik "..." zorunludur.');
    }
    const { ledger } = hafiza.addIdea({
      title: flags.baslik,
      detailPlainLanguage: flags.detay || '',
      whyValuable: flags.neden || '',
      relatedItemId: flags.madde || null,
      whenToRevisit: flags.zaman || undefined,
    }, { actor: flags.kim || 'kullanici' });
    const added = ledger.ideas.at(-1);
    console.log(`Fikir park edildi: ${added.id} — ${added.title} (İlgili madde: ${added.relatedItemId || 'Genel'})`);
    return;
  }

  if (cmd === 'yenile') {
    const views = hafiza.syncViews({ writeRootHandoverFile: Boolean(flags['kok-devir']) });
    console.log('Tüm belgeler ve canlı görsel pano güncellendi:');
    for (const f of views.filesWritten) console.log(` - ${f}`);
    return;
  }

  if (cmd === 'ara') {
    const q = flags._[1] || flags.sorgu || '';
    const res = hafiza.search(q);
    console.log(`Arama: "${q}" -> ${res.items.length} madde, ${res.ideas.length} fikir, ${res.decisions.length} karar bulundu.`);
    for (const it of res.items) console.log(` [MADDE] ${it.id} (${it.status}): ${it.title}`);
    for (const f of res.ideas) console.log(` [FİKİR] ${f.id} (-> ${f.relatedItemId || 'Genel'}): ${f.title}`);
    for (const k of res.decisions) console.log(` [KARAR] ${k.id}: ${k.title}`);
    return;
  }

  if (cmd === 'pano') {
    const port = flags.port ? Number(flags.port) : 0;
    const srv = await hafiza.startDashboard({ port });
    console.log('====================================================================');
    console.log(` CANLI PROJE TAKİP PANOSU AÇILDI: ${srv.url}`);
    console.log(' Tarayıcıdan açtığında her 3 saniyede bir durumu otomatik yeniler.');
    console.log(' Kapatmak için Ctrl+C tuşlarına basabilirsin.');
    console.log('====================================================================');
    return;
  }

  // Varsayılan: `durum`
  const ledger = hafiza.load();
  if (!ledger) {
    console.log(`Bu projede (${projectRoot}) henüz hafıza defteri başlatılmamış. Başlatmak için: node cli.cjs baslat --proje "Ad"`);
    process.exit(1);
  }
  const auditReport = hafiza.audit();

  if (flags.json) {
    console.log(JSON.stringify({ ledger, auditReport }, null, 2));
    return;
  }

  console.log('====================================================================');
  console.log(` PROJE HAFIZASI VE KANIT DENETİM RAPORU — ${ledger.project.name}`);
  console.log('====================================================================');
  console.log(`Hedef (Özet) : ${ledger.project.visionPlainLanguage}`);
  console.log(`Odak Madde   : ${ledger.project.currentFocusItemId || 'Yeni madde onayı bekleniyor'}`);
  console.log(`Sıradaki İş  : ${ledger.project.nextStepPlainLanguage || '-'}`);
  console.log(`İlerleme     : ${auditReport.completedHealthyCount} / ${auditReport.totalItems} madde kanıtıyla tamamlandı`);
  console.log(`Kanıt Sağlığı: ${auditReport.allHealthy ? 'SAĞLAM (0 bozuk kanıt)' : `UYARI! Bozuk kanıtlar: ${auditReport.brokenIds.join(', ')}`}`);
  console.log(`Fikir Havuzu : ${(ledger.ideas || []).length} park edilmiş fikir | ${(ledger.decisions || []).length} kayıtlı karar`);
  console.log(`Görsel Pano  : ${path.join(hafiza.store.dataDir, 'CANLI-PANO.html')}`);

  console.log('\n--- NUMARALI MADDELER HARİTASI ---');
  for (const it of ledger.items) {
    const eff = auditReport.byItemId[it.id]?.effectiveStatus || it.status;
    const icon = eff === 'tamamlandi' ? '[BITTI]' : eff === 'devam_ediyor' ? '[AKTIF]' : eff === 'kanit_bozuldu' ? '[BOZUK!]' : '[SIRADA]';
    console.log(` ${icon.padEnd(9)} ${it.id.padEnd(7)} ${it.title} (${it.moduleTag})`);
  }

  if (ledger.ideas?.length) {
    console.log('\n--- FİKİR HAVUZU (PARK EDİLENLER) ---');
    for (const f of ledger.ideas) {
      console.log(` [${f.id}] (-> ${(f.relatedItemId || 'Genel').padEnd(5)}) ${f.title}`);
    }
  }

  if (!auditReport.allHealthy) {
    process.exitCode = 2;
  }
}

main().catch(err => {
  console.error('Proje Hafızası Hatası:', err.message);
  process.exit(1);
});
