#!/usr/bin/env node
'use strict';

/**
 * Komut satırından canlı "Maymuncuk" keşif raporu (`node src/cli-kesif.cjs [--ssh vps] [--json]`)
 */

const { createModelKapisi } = require('./index.cjs');

async function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const sshTargets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ssh' && args[i + 1]) {
      sshTargets.push(args[i + 1]);
      i++;
    }
  }

  const kapi = createModelKapisi();
  const report = await kapi.discover({ sshTargets });
  const roles = await kapi.roleMatrix();

  if (wantJson) {
    console.log(JSON.stringify({ report, roles }, null, 2));
    return;
  }

  console.log('====================================================================');
  console.log(' EVRENSEL MODEL VE AJAN KAPISI (v1.2.0 "MAYMUNCUK") — KEŞİF RAPORU');
  console.log('====================================================================');
  console.log(`Platform    : ${report.hostPlatform} (${report.nodeVersion})`);
  if (report.wslDistros?.length) {
    console.log(`WSL Dağıtım : ${report.wslDistros.join(', ')}`);
  }
  if (report.loadedDotEnvFiles?.length) {
    console.log(`.env Yüklendi: ${report.loadedDotEnvFiles.join(', ')}`);
  }
  console.log(`Kayıtlı     : ${report.summary.totalRegisteredProviders} sağlayıcı/ajan profili`);
  console.log(`Hazır       : ${report.summary.readyCount} kapı gerçekten kullanıma hazır (${report.summary.readyIds.join(', ') || 'yok'})`);
  if (report.summary.installedUnauthenticatedIds.length) {
    console.log(`Oturumsuz   : ${report.summary.installedUnauthenticatedIds.join(', ')} (komut kurulu ama geçerli/aktif yerel oturum yok!)`);
  }
  console.log(`Kum Havuzu  : ${report.summary.sandboxesReady.join(', ') || 'hazır kum havuzu yok'}`);
  if (report.remoteHosts.length) {
    for (const r of report.remoteHosts) {
      const reasonSuffix = !r.reachable && r.reason ? ` (${r.reason})` : '';
      console.log(`Uzak Hedef (${r.host}): ${r.reachable ? 'ERİŞİLDİ' : `ERİŞİLEMEDİ${reasonSuffix}`} ${r.reachable ? `(komutlar: ${Object.keys(r.binaries).join(', ')}, doğrulanmış model portları: ${Object.keys(r.activePorts).join(', ')})` : ''}`);
    }
  }

  console.log('\n--- 1. GERÇEKTEN KULLANIMA HAZIR KAPILAR ---');
  for (const p of report.providers.filter(x => x.ready)) {
    const credNote = p.credentialSource ? ` [kaynak: ${p.credentialSource}]` : '';
    const keyPoolNote = p.keyCount > 1 ? ` [havuz: ${p.keyCount} anahtar]` : '';
    console.log(` [HAZIR] ${p.title} (${p.id}) -> konum: ${p.location}${credNote}${keyPoolNote} | gizlilik: ${p.privacyTier} | ödeme: ${p.payerLabel}`);
  }

  console.log('\n--- 2. KURULU FAKAT OTURUMU / SÜRESİ DOLMUŞ VEYA BEKLEYENLER ---');
  for (const p of report.providers.filter(x => !x.ready)) {
    const tag = p.status === 'expired_auth'
      ? '[OTURUM SÜRESİ DOLMUŞ]'
      : p.status === 'installed_unauthenticated'
        ? '[KURULU AMA OTURUM YOK]'
        : (p.status === 'configured_but_service_stopped' ? '[AYARLI AMA SERVİS KAPALI]' : '[BEKLİYOR]');
    console.log(` ${tag} ${p.title} (${p.id}) -> ${p.missingSetupHint}`);
  }

  console.log('\n--- 3. TÜM YETENEK ROLLERİ OTOMATİK EŞLEŞTİRMESİ (7 EVRENSEL ROL) ---');
  for (const [roleId, res] of Object.entries(roles)) {
    if (res.resolved) {
      const caps = (res.primary.capabilities || []).join(',');
      const modeNote = res.primary.executionMode ? ` | kip:${res.primary.executionMode}` : '';
      console.log(` * ${roleId.padEnd(15)} => ${res.primary.providerTitle} [${res.primary.model}] (duyular: ${caps}${modeNote}) | Yedekler: ${res.fallbacks.map(f => `${f.providerId}:${f.model}`).join(', ') || 'yok'}`);
    } else {
      console.log(` * ${roleId.padEnd(15)} => ÇÖZÜLEMEDİ (${res.reason})`);
    }
  }
}

main().catch(err => {
  console.error('Keşif hatası:', err.message);
  process.exit(1);
});
