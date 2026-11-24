'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const PRESETS = require('./kapi-ornek.cjs');

const MAX_SOURCE = 64 * 1024;
const TTL = 30 * 60 * 1000;
const ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const sessions = new Map();
let currentWorker = false;
const supervisor = fs.readFileSync(path.join(__dirname, 'kapi-yalitim.py'), 'utf8');
const WSL = 'C:\\Windows\\System32\\wsl.exe';
const FALLBACK_TITLE = 'Seçilen araç';
const LIMITS = {
  sandbox: 'Dosya ve ağ yalıtımı doğrulanamadı. Kaynak çalıştırılmadı.',
  protocol: 'Araç, desteklenen Python MCP bağlantısında geçerli bir araç listesi vermedi.',
  limit: 'Araç süre, çıktı veya yetenek sınırını aştı. Deneme tamamlanamadı.',
  changed: 'Araç listesi veya tanımı değişti. İstek gönderilmedi. Yeniden incele.',
  call: 'Araç denendi ancak başarılı bir sonuç vermedi.',
  input: 'Bu işin istediği girdi şu anda desteklenmiyor veya örnek değer uygun değil.',
};

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function only(body, fields) { return Object.keys(body).every(key => fields.includes(key)); }
function fingerprint(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function plain(value, limit) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, limit)
    : '';
}
function check(label, state, detail) { return { label, state, detail }; }
function coverage(boundary, stage, call = 'pending') {
  return [
    check('Dosya yalıtımı ve kapalı ağ', boundary ? 'passed' : 'incomplete', boundary
      ? 'Yalıtım doğrulandı: gerçek dosyalar çalışma alanına açılmadı. İnternet, yerel ağ ve Windows bağlantı soketleri kapalı.'
      : LIMITS.sandbox),
    check('Araç listesi', stage === 'ok' ? 'passed' : 'incomplete', stage === 'ok'
      ? (call === 'blocked' ? 'Araç listesi önceki incelemede alındı; engellenen işlem için program yeniden başlatılmadı.'
          : 'Araç listesi yalıtılmış ortamda alındı.')
      : (LIMITS[stage] || LIMITS.protocol)),
    check('Seçilen araç', call,
      call === 'passed' ? 'Yalnız izin verilen araca örnek girdi gönderildi.'
        : call === 'blocked' ? 'İzin olmadığı için araca istek gönderilmedi.'
          : call === 'incomplete' ? 'Seçilen araç için başarılı bir sonuç alınmadı.'
            : 'İnceleme sırasında hiçbir araç çağrılmadı. Güven ortamı yalnızca bu denemeyi kapsar.'),
  ];
}

async function worker(payload, signal) {
  if (signal?.aborted) return { code: 'limit', boundary: false };
  if (currentWorker) fail(429, 'Başka bir Kapı denemesi çalışıyor. Tamamlandığında yeniden dene.');
  if (process.platform !== 'win32' && process.platform !== 'linux') return { code: 'sandbox', boundary: false };
  currentWorker = true;
  try {
    return await new Promise(resolve => {
      const onWindows = process.platform === 'win32';
      const local = ['/usr/bin/python3', '-I', '-B', '-S', '-c', supervisor];
      const command = onWindows ? WSL : '/usr/bin/env';
      const args = onWindows
        ? ['-d', 'Ubuntu', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin', 'LANG=C.UTF-8', ...local]
        : ['-i', 'PATH=/usr/bin', 'LANG=C.UTF-8', ...local];
      const child = spawn(command, args, {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        cwd: onWindows ? 'C:\\Windows\\System32' : '/',
        env: onWindows ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' } : {},
      });
      const chunks = [];
      let length = 0;
      let stopped;
      const stop = code => {
        if (stopped) return;
        stopped = code;
        child.kill();
      };
      const cancel = () => stop('limit');
      const timer = setTimeout(cancel, 14000);
      signal?.addEventListener('abort', cancel, { once: true });
      child.stderr.resume(); // Candidate text must never be interpreted as supervisor evidence.
      child.stdout.on('data', part => {
        length += part.length;
        if (length > 144 * 1024) return stop('limit');
        chunks.push(part);
      });
      child.stdin.on('error', () => {});
      child.on('error', () => { stopped ||= 'sandbox'; });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (stopped || code !== 0) return resolve({ code: stopped || 'sandbox', boundary: false });
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve({ code: 'sandbox', boundary: false });
        }
      });
      child.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8'));
    });
  } finally {
    currentWorker = false;
  }
}

function session(id) {
  if (typeof id !== 'string' || !ID.test(id)) fail(400, 'Geçerli bir inceleme gerekli.');
  const value = sessions.get(id);
  if (!value || value.expires <= Date.now()) {
    sessions.delete(id);
    fail(404, 'İncelemenin süresi doldu. Aracı yeniden incele.');
  }
  return value;
}
function register(value) {
  const now = Date.now();
  for (const [id, entry] of sessions) if (entry.expires <= now) sessions.delete(id);
  if (sessions.size >= 24) sessions.delete(sessions.keys().next().value);
  const id = crypto.randomUUID();
  sessions.set(id, { ...value, expires: now + TTL });
  return id;
}

function optionalScalar(definition) {
  if (!object(definition) || !only(definition, ['type', 'title', 'description', 'default'])) return false;
  const value = definition.default;
  switch (definition.type) {
    case 'string': return value === undefined || (typeof value === 'string' && value.length <= 1500 && !value.includes('\0'));
    case 'boolean': return value === undefined || typeof value === 'boolean';
    case 'integer': return value === undefined || Number.isSafeInteger(value);
    case 'number': return value === undefined || Number.isFinite(value);
    default: return false;
  }
}

function inputShape(schema) {
  const metadata = ['type', 'title', 'description', '$schema', 'properties', 'required', 'additionalProperties'];
  if (!object(schema) || schema.type !== 'object' || !only(schema, metadata)) return null;
  if (schema.properties !== undefined && !object(schema.properties)) return null;
  if (schema.required !== undefined && !Array.isArray(schema.required)) return null;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') return null;
  const required = schema.required || [];
  const entries = Object.entries(schema.properties || {});
  if (!entries.length && !required.length) return {};
  if (!entries.length || required.length > 1 || (entries.length > 1 && required.length !== 1)) return null;
  const key = required.length ? required[0] : entries[0][0];
  if (typeof key !== 'string' || !Object.hasOwn(schema.properties, key)) return null;
  const definition = schema.properties[key];
  if (!object(definition) || definition.type !== 'string'
      || !only(definition, ['type', 'title', 'description', 'default', 'minLength', 'maxLength', 'enum'])) return null;
  // Only the selected field is sent. Optional fields retain the server's own behavior when omitted.
  for (const [name, property] of entries) {
    if (!/^[\w.-]{1,70}$/.test(name) || (name !== key && !optionalScalar(property))) return null;
  }
  const label = plain(definition.title, 100) || key;
  return { key, label, required: required.length === 1,
    min: definition.minLength ?? 0, max: definition.maxLength ?? 1500, values: definition.enum };
}

function toolRow(tool, entry) {
  const change = entry.changes.get(tool.name);
  const shape = inputShape(tool.inputSchema);
  return {
    name: tool.name, label: plain(tool.title, 100) || plain(tool.name, 100) || 'İsimsiz araç',
    description: plain(tool.description, 360), allowed: entry.approved.has(tool.name),
    newPermission: change === 'added' || change === 'changed', change: change || null,
    needsInput: Boolean(shape?.key), inputLabel: shape?.label || '',
    canTest: Boolean(shape), canApprove: entry.approvable.has(tool.name),
  };
}
function availableTool(tool) { return /^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name); }

async function inspect(body, signal) {
  const byPreset = Object.hasOwn(body, 'preset');
  let source, title, family, version;
  if (byPreset) {
    if (!only(body, ['action', 'preset', 'previousId']) || typeof body.preset !== 'string' || !Object.hasOwn(PRESETS, body.preset)) {
      fail(400, 'Bu örnek sürümü bulunamadı.');
    }
    ({ source, version } = PRESETS[body.preset]);
    title = 'Belge Bulucu';
    family = 'preset:belge-bulucu';
  } else {
    if (!only(body, ['action', 'source', 'name', 'previousId']) || typeof body.source !== 'string'
        || !body.source.trim() || body.source.includes('\0') || Buffer.byteLength(body.source, 'utf8') > MAX_SOURCE
        || typeof body.name !== 'string' || !/^[^\\/\u0000-\u001F]{1,96}\.py$/i.test(body.name)) {
      fail(400, 'En fazla 64 KB, tek bir Python MCP sunucu dosyası (.py) seç.');
    }
    source = body.source;
    title = plain(body.name, 100) || FALLBACK_TITLE;
    family = 'upload:' + body.name.normalize('NFC').toLowerCase();
  }
  const sourceHash = fingerprint(source);
  version ||= 'SHA-256 ' + sourceHash.slice(0, 12);
  const previous = body.previousId === undefined ? null : session(body.previousId);
  if (previous && previous.family !== family) fail(409, 'Güncellemeyi aynı örnek veya aynı adlı dosyayla karşılaştır.');
  const result = await worker({ source }, signal);
  if (result.code !== 'ok' || !result.boundary || !Array.isArray(result.tools)) {
    return {
      id: null, title, version, status: 'incomplete', summary: LIMITS[result.code] || LIMITS.protocol,
      coverage: coverage(Boolean(result.boundary), result.code, 'incomplete'), tools: [], added: [], reviewAgain: [], removed: [],
    };
  }
  const tools = result.tools;
  const entry = {
    family, source, title, version, sourceHash, tools, preset: byPreset ? body.preset : null,
    approved: new Set(), approvable: new Set(), changes: new Map(),
  };
  const dropped = [];
  const oldTools = new Map(previous?.tools.map(tool => [tool.name, tool.signature]) || []);
  const isChanged = Boolean(previous && previous.sourceHash !== sourceHash);
  // Trusting a same-name tool does not trust changed uploaded code. The built-in
  // demo proves its two versions share the exact search handler and definition.
  const demoShared = previous?.preset === 'v1' && entry.preset === 'v2';
  for (const tool of tools) {
    if (previous && !oldTools.has(tool.name)) {
      entry.changes.set(tool.name, 'added');
    } else if (previous && oldTools.get(tool.name) !== tool.signature) {
      entry.changes.set(tool.name, 'changed');
    } else if (isChanged && !(demoShared && tool.name === 'belge_ara')) {
      entry.changes.set(tool.name, 'updated-source');
    }
    if (previous?.approved.has(tool.name) && !entry.changes.has(tool.name)
        && (!isChanged || (demoShared && tool.name === 'belge_ara'))) {
      entry.approved.add(tool.name);
    }
    // Update permissions stay closed in this comparison. Starting a fresh
    // uploaded investigation can deliberate again; the demo never opens delete.
    if (availableTool(tool) && (!previous || !entry.changes.has(tool.name))
        && !(entry.preset && tool.name !== 'belge_ara')) entry.approvable.add(tool.name);
  }
  if (previous) {
    const newNames = new Set(tools.map(tool => tool.name));
    dropped.push(...previous.tools.filter(tool => !newNames.has(tool.name)).map(tool => toolRow(tool, previous)));
  }
  const rows = tools.map(tool => toolRow(tool, entry));
  const id = register(entry);
  return {
    id, title, version, status: 'pending', coverage: coverage(true, 'ok'), tools: rows,
    added: rows.filter(tool => tool.newPermission), reviewAgain: rows.filter(tool => tool.change === 'updated-source'), removed: dropped,
    updated: Boolean(previous), sourceChanged: isChanged,
    summary: previous
      ? (isChanged ? 'Yeni sürüm incelendi. Yeni veya yeniden incelenmesi gereken izinler kapalı.' : 'Sürümler karşılaştırıldı.')
      : (tools.length ? 'Araçlar listelendi. Henüz hiçbir iş çalıştırılmadı.' : 'Program geçerli bir liste verdi, ancak listede çalıştırılacak araç yok.'),
  };
}

async function run(body, signal) {
  if (!only(body, ['action', 'id', 'tool', 'input', 'approve'])
    || typeof body.tool !== 'string' || body.tool.length > 128
    || (body.input !== undefined && (typeof body.input !== 'string' || body.input.length > 1500 || body.input.includes('\0')))
    || (body.approve !== undefined && typeof body.approve !== 'boolean')) fail(400, 'Geçerli bir araç ve örnek girdi gerekli.');
  const entry = session(body.id);
  const tool = entry.tools.find(item => item.name === body.tool);
  const label = plain(tool?.title, 100) || plain(tool?.name, 100) || 'Bu araç';
  if (!tool || !(entry.approved.has(body.tool) || (body.approve === true && entry.approvable.has(body.tool)))) {
    const why = entry.changes.get(body.tool) === 'updated-source'
      ? label + ': Kaynak kodu değiştiği için eski izin kaldırıldı. Araç çağrılmadı.'
      : entry.changes.has(body.tool) || entry.preset && body.tool === 'belge_sil'
      ? label + ': Yeni izin verilmedi. Araç çağrılmadı.'
      : label + ': Bu işe izin verilmedi. Araç çağrılmadı.';
    return { ok: false, status: 'blocked', worked: [], blocked: [why], coverage: coverage(true, 'ok', 'blocked') };
  }
  const shape = inputShape(tool.inputSchema);
  const value = body.input ?? '';
  let args = {};
  if (!shape || (!shape.key && value) || (shape.key && ((shape.required && !value.trim())
      || ((value || shape.required) && ([...value].length < shape.min || [...value].length > shape.max
        || (shape.values !== undefined && (!Array.isArray(shape.values) || !shape.values.includes(value)))))))) {
    return { ok: false, status: 'incomplete', worked: [], blocked: [], summary: LIMITS.input, coverage: coverage(true, 'ok', 'incomplete') };
  }
  if (shape.key && (value || shape.required)) args = { [shape.key]: value };
  const expected = entry.tools.map(({ name, signature }) => ({ name, signature }));
  const result = await worker({ source: entry.source, tool: body.tool, arguments: args, expected }, signal);
  const passedNetworkProbe = Boolean(entry.preset && body.tool === 'belge_ara' && result.boundary && result.probe);
  if (!result.boundary || result.code !== 'ok' || (entry.preset && !passedNetworkProbe)) {
    if (result.code === 'changed') entry.approved.clear();
    return {
      ok: false, status: 'incomplete', worked: [], blocked: [],
      summary: (entry.preset && result.code === 'ok' ? 'Örneğin dış bağlantı engeli doğrulanamadı.' : LIMITS[result.code]) || LIMITS.call,
      coverage: coverage(Boolean(result.boundary), result.code === 'call' ? 'ok' : result.code, 'incomplete'),
    };
  }
  entry.approved.add(body.tool);
  return {
    ok: true, status: 'worked', worked: [label + ' çalıştı.'], output: plain(result.text, 4000),
    summary: result.hasText ? '' : 'Araç başarılı döndü ancak metin çıktısı üretmedi.',
    blocked: passedNetworkProbe ? ['Dış bağlantı girişimi engellendi. Örnek internete ulaşmadı.'] : [],
    coverage: coverage(true, 'ok', 'passed'),
  };
}

async function gateFlow(body, signal) {
  if (!object(body)) fail(400, 'Kapı isteği geçersiz.');
  if (body.action === 'inspect') return inspect(body, signal);
  if (body.action === 'run') return run(body, signal);
  fail(400, 'İncele veya çalıştır işlemi gerekli.');
}

module.exports = { gateFlow };
