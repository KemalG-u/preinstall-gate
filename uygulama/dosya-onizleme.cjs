'use strict';

const path = require('node:path');

const MAX_SOURCE_BYTES = 96 * 1024;
const MAX_CANDIDATES = 12;
const MAX_JOBS = 6;
const DOC = /(?:^|\/)(?:readme(?:\.[^/]+)?|(?:getting[-_ ]?started|quick[-_ ]?start|usage|tutorial)\.md)$/i;
const YAML = /\.ya?ml$/i;
const RAW_PATH = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const SYSTEM_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', '.localized']);
const SYSTEM_FOLDERS = new Set(['.git', '.svn']);
const EXAMPLE_NAMES = { pdf: ['fatura', 'sözleşme'], png: ['ekran', 'çizim'], jpg: ['fotoğraf', 'manzara'], txt: ['not', 'liste'] };

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function displayFolder(folder) {
  return folder.replace(/^~\/Downloads(?=\/|$)/i, 'İndirilenler')
    .replace(/^~\/Documents(?=\/|$)/i, 'Belgeler')
    .replace(/^~\/Desktop(?=\/|$)/i, 'Masaüstü');
}

function readNames(input) {
  if (typeof input !== 'string' || input.length > 2000) throw invalid('Dosya listesi 2.000 karakteri aşmamalı.');
  const lines = input.split(/\r\n|\n|\r/).filter(line => line.trim());
  if (!lines.length || lines.length > 50) throw invalid('Her satıra bir dosya yazın. Bir denemede en fazla 50 dosya kullanılabilir.');
  const names = new Map();
  for (const line of lines) {
    const relative = line.replace(/\\/g, '/');
    const parts = relative.split('/');
    if (line.length > 240 || RAW_PATH.test(line) || parts.some(part => !part || part === '.' || part === '..' ||
      part.trimEnd() !== part || part.endsWith('.') || WINDOWS_DEVICE.test(part))) {
      throw invalid('Dosya adı veya kaynak klasöre göre alt yol yazın. Örnek: 2025/fatura.pdf.');
    }
    if (relative.startsWith('~/')) throw invalid('Ev klasörü yerine kaynak klasöre göre bir dosya adı yazın.');
    // Windows lookup is case-insensitive. Repeating the same input is one file.
    const key = relative.toLowerCase();
    if (!names.has(key)) names.set(key, relative);
  }
  return [...names.values()];
}

function ruleResult(rule, input) {
  const names = readNames(input);
  const target = rule.actions.at(-1)[1];
  let sourceFolder = displayFolder(rule.source);
  let targetFolder = displayFolder(target);
  if (sourceFolder.toLowerCase() === targetFolder.toLowerCase()) {
    sourceFolder = rule.source;
    targetFolder = target;
  }
  const allowed = rule.filters.extension[0];
  const nameFilter = rule.filters.name?.[0];
  const existing = new Set(names.map(relative => `${rule.source}/${relative}`.toLowerCase()));
  const rows = names.map(relative => {
    const { base, dir, ext, name } = path.posix.parse(relative);
    const row = { from: sourceFolder + '/' + relative, to: null, status: 'unchanged', reason: '' };
    if (!rule.recursive && dir) return { ...row, reason: 'Alt klasörler bu kurala dahil değil.' };
    if (base.startsWith('~$') || SYSTEM_FILES.has(base.toLowerCase()) || dir.split('/').some(part => SYSTEM_FOLDERS.has(part.toLowerCase()))) {
      return { ...row, reason: 'Kural sistem dosyalarını ve ayrılmış klasörleri atlar.' };
    }
    if (!allowed.includes(ext.slice(1).toLowerCase())) return { ...row, reason: 'Dosya uzantısı kuralla eşleşmiyor.' };
    if (nameFilter) {
      const stem = name.normalize('NFC');
      const matches = nameFilter.tokens.some(token => nameFilter.caseSensitive ? stem.includes(token) :
        stem.toLowerCase().includes(token.toLowerCase()));
      if (!matches) return { ...row, reason: 'Dosya adında aranan sözcüklerden biri bulunamadı.' };
    }
    const targetPath = `${target}/${base}`.toLowerCase();
    if (targetPath === `${rule.source}/${relative}`.toLowerCase()) return { ...row, reason: 'Dosya zaten hedef klasörde.' };
    if (existing.has(targetPath)) return { ...row, status: 'unresolved', reason: 'Hedefte aynı adlı bir dosya listeleniyor. Yeni ad bu listeden belirlenemiyor.' };
    return { ...row, to: `${targetFolder}/${base}`, status: 'planned', reason: 'Kural bu dosyayı seçti.' };
  });
  const targets = new Map();
  for (const row of rows) {
    if (!row.to) continue;
    const key = row.to.toLowerCase();
    targets.set(key, (targets.get(key) || 0) + 1);
  }
  for (const row of rows) {
    if (!row.to || targets.get(row.to.toLowerCase()) < 2) continue;
    row.to = null;
    row.status = 'unresolved';
    row.reason = 'Aynı adlı dosyalar aynı hedefe gidiyor. Son dosya adı bu listeden belirlenemiyor.';
  }
  return { sourceFolder, targetFolder, rows, movedCount: 0 };
}

function fileTrial(rule, file) {
  const [extensions, filterLine] = rule.filters.extension;
  const first = extensions[0];
  const other = ['jpg', 'txt', 'mp3', 'gif', 'zip', 'csv', 'log', 'bin', 'xyz'].find(ext => !extensions.includes(ext));
  const nameFilter = rule.filters.name?.[0];
  const [firstName, secondName] = Object.hasOwn(EXAMPLE_NAMES, first) ? EXAMPLE_NAMES[first] : ['ilk-dosya', 'ikinci-dosya'];
  const examples = [nameFilter ? `örnek-${nameFilter.tokens[0]}.${first}` : `${firstName}.${first}`,
    nameFilter ? `örnek-${nameFilter.tokens[0]}-02.${first}` : `${secondName}.${first}`, `${EXAMPLE_NAMES[other]?.[0] || 'diğer-dosya'}.${other}`];
  if (rule.recursive) examples[1] = '2025/' + examples[1];
  const sampleInput = examples.join('\n');
  const preview = ruleResult(rule, sampleInput);
  const extensionText = extensions.map(ext => '.' + ext).join(', ');
  const types = extensions.map(ext => ext.toUpperCase()).join(' ve ');
  const targetLine = rule.actions.at(-1)[2];
  const isDocumentation = !YAML.test(file.name);
  const lines = file.text.split(/\r\n|\n|\r/);
  const at = (line, role, label) => ({ path: file.name, line, role, label, quote: (lines[line - 1] || '').trim().slice(0, 220) });
  const producer = at(targetLine, 'producer', 'Kuralın seçilen dosyayı göndereceği klasör.');
  const explanation = {
    scenario: `${preview.sourceFolder} klasöründe ${types} dosyalarını diğerlerinden ayırmak istiyorsun. Bu kural, tek tek seçme işini yapar.`,
    steps: [
      { label: 'Nereye bakar?', text: `${preview.sourceFolder} klasöründeki dosya adlarına bakar${rule.recursive ? ', alt klasörleri de dahil eder.' : '.'}` },
      { label: 'Neye göre seçer?', text: `${extensionText} uzantısını arar${nameFilter ? ` ve dosya adında ${nameFilter.tokens.join(', ')} sözcüklerinden birini ister.` : '.'}` },
      { label: 'Nereye gider?', text: `Seçtiklerini ${preview.targetFolder} klasöründe toplar. Hedefte ad çakışmazsa dosya adı korunur.` },
    ],
    example: { rows: preview.rows, sourceFolder: preview.sourceFolder, targetFolder: preview.targetFolder },
  };
  const job = {
    id: `file-rule:${file.name}:${filterLine}`, origin: isDocumentation ? 'document' : 'source',
    title: nameFilter ? `${types} dosyalarını ada göre ayır` : `${types} dosyalarını ayır`,
    summary: nameFilter ? `Adında ${nameFilter.tokens.join(', ')} sözcüklerinden biri bulunan ${types} dosyalarını ${preview.targetFolder} klasöründe toplar.` :
      `${preview.sourceFolder} içindeki eşleşen dosyaları ${preview.targetFolder} klasöründe toplamak için seçer.`,
    trigger: isDocumentation ? 'Belgedeki örnek dosya düzenleme kuralı çalıştırıldığında başlar.' : 'Bu dosya düzenleme kuralı çalıştırıldığında başlar.',
    output: 'Eşleşen dosyalar ve her dosyanın hedef yolu.',
    consumer: `Taşıma adımı, seçilen dosya ve ${preview.targetFolder} içindeki hedef yolunu alır.`,
    explanation,
    evidence: [at(rule.locationLine, 'trigger', 'Dosya aramasının başlayacağı klasör.'),
      at(filterLine, 'producer', 'Dosya uzantısını seçen kural.'),
      ...(rule.filters.name ? [at(rule.filters.name[1], 'producer', 'Dosya adına bakan ek filtre.')] : []),
      ...(rule.continuationLine ? [at(rule.continuationLine, 'producer', 'Belge, taşıma adımını önceki kurala ekler.')] : []),
      { ...producer, role: 'consumer' }],
  };
  const fields = {
    mode: 'preview', inputLabel: 'Dosya adları (her satıra bir dosya)', sampleInput,
    verifiedUses: [{ ...producer, kind: 'application', recipient: 'Taşıma adımı' }],
    description: 'Kuralı örnek dosya adlarına uygular ve olası yolları hesaplar. Hedef klasörde önceden bulunan dosyalar denetlenmez.',
  };
  const runner = (input, signal) => {
    signal?.throwIfAborted();
    const result = ruleResult(rule, input);
    const output = result.rows.map(row => row.to ? `${row.from} → ${row.to}` : `${row.from} — ${row.reason}`).join('\n');
    return { output, preview: result, detail: 'Önizleme dosya adları üzerinden hesaplandı. Taşınan dosya sayısı 0.' };
  };
  return { job, fields, runner };
}

async function prepareFileTrials(files, parse, signal) {
  const candidates = files.filter(file => !/^\.github\/workflows\//i.test(file.name) &&
    (DOC.test(file.name) || YAML.test(file.name)) && Buffer.byteLength(file.text) <= MAX_SOURCE_BYTES &&
    /(?:^|[\r\n])[ \t]*rules[ \t]*:/.test(file.text)).slice(0, MAX_CANDIDATES);
  if (!candidates.length) return { trials: [] };
  let rules;
  try { rules = await parse(candidates); }
  catch {
    signal?.throwIfAborted();
    return { trials: [], unavailable: true };
  }
  const result = [];
  const seen = new Set();
  for (const rule of rules) {
    const key = JSON.stringify([rule.source, rule.recursive, rule.filters.extension[0], rule.filters.name?.[0], rule.actions.at(-1)[1]]);
    if (seen.has(key)) continue;
    seen.add(key);
    const file = candidates.find(item => item.name === rule.path);
    if (file) result.push(fileTrial(rule, file));
    if (result.length === MAX_JOBS) break;
  }
  return { trials: result };
}

module.exports = { prepareFileTrials };
