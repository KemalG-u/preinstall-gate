'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { discoverTrials } = require('./otomatik-dene.cjs');
const { discoverDesktopJobs } = require('./masaustu-akisi.cjs');

const run = promisify(execFile);
const version = '6.4.0';
const bundle = path.join(__dirname, '../ornekler/agentic-os-3.0.0/calisma/rea/yerel-input', `rea-${version}-linux-runtime.tar.gz`);
const bundleHash = '6430b5b7c4766f10a3d7ad36405de7d785aa15f2235c12e302ccbf91c54ee1e2';
const bundleSize = 62470079;
const runtime = 'lib/node_modules/rea-agents';
const babelParser = 'node_modules/@babel/parser/lib/index.js';
const javascriptName = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const reserved = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;
const sourceBudget = 896 * 1024;

function safePath(name) {
  return typeof name === 'string' && name.length <= 200 && !/[\\:<>"|?*\x00-\x1f\x7f]/u.test(name) &&
    name.split('/').every(part => part && part[0] !== '.' && !/[. ]$/.test(part) &&
      !reserved.test(part) && part.toLowerCase() !== 'node_modules');
}

function selectSources(files) {
  const names = new Set();
  const sources = [];
  let remaining = sourceBudget;
  for (const file of files.slice(0, 49)) {
    if (!safePath(file?.name) || typeof file.text !== 'string') continue;
    const { name, text } = file;
    const size = Buffer.byteLength(text);
    if (!size || size > 128 * 1024 || size > remaining || text.includes('\0')) continue;
    const isPackage = name === 'package.json';
    const extensionless = !path.posix.extname(name) && /^#![^\r\n]*\bnode\b/.test(text);
    if (!isPackage && !javascriptName.test(name) && !extensionless) continue;
    const staged = extensionless ? `${name}.__urun_tani__.js` : name;
    const normalized = staged.toLowerCase();
    if ([...names].some(other => other === normalized || other.startsWith(normalized + '/') || normalized.startsWith(other + '/'))) continue;
    names.add(normalized);
    sources.push({ name, staged, text, lines: text.split(/\r?\n/), isPackage });
    remaining -= size;
  }
  return sources;
}

function manifestEntrypoints(files) {
  const root = files.find(file => file.isPackage);
  if (!root) return [];
  try {
    const pkg = JSON.parse(root.text);
    const bins = typeof pkg?.bin === 'string' ? [[String(pkg.name || '').split('/').at(-1), pkg.bin]] :
      pkg?.bin && typeof pkg.bin === 'object' ? Object.entries(pkg.bin).slice(0, 24) : [];
    const names = new Set(files.map(file => file.name));
    return bins.flatMap(([command, target]) => {
      const file = typeof target === 'string' ? target.replace(/^\.\//, '') : '';
      if (!/^[\w.-]{1,80}$/.test(command) || !names.has(file) || file === root.name) return [];
      const line = root.lines.findIndex(source => source.includes(JSON.stringify(target))) + 1;
      return [{ command, path: file, ...(line ? { manifest: root.name, line } : {}) }];
    });
  } catch {
    return [];
  }
}

function childEnvironment(stage) {
  const env = { TMP: stage, TEMP: stage, TMPDIR: stage, HOME: stage, USERPROFILE: stage,
    APPDATA: stage, LOCALAPPDATA: stage, XDG_CONFIG_HOME: stage, XDG_CACHE_HOME: stage, LC_ALL: 'C' };
  for (const name of ['SystemRoot', 'WINDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

async function openStage() {
  const cache = path.join(await realpath(__dirname), '.cache');
  await mkdir(cache, { recursive: true });
  const stat = await lstat(cache);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('REA cache is not a local directory.');
  return mkdtemp(path.join(cache, 'rea-analiz-'));
}

function status(status, detail) {
  return { status, detail, evidence: [], context: null, analyzedPaths: [] };
}

function location(value, sources) {
  const file = sources.get(value?.source || value?.path);
  const line = value?.start?.line;
  if (!file || !Number.isInteger(line) || line < 1 || line > file.lines.length) return null;
  return { path: file.name, line };
}

function sourceFragment(value, sources) {
  const file = sources.get(value?.source);
  const start = value?.start;
  const end = value?.end;
  if (!file || !start || !end || !file.lines[start.line - 1]) return '';
  const firstLine = file.lines[start.line - 1];
  return firstLine.slice(start.column, start.line === end.line ? end.column : undefined).trim().slice(0, 140);
}

function compactGraph(result, files) {
  const sources = new Map(files.map(file => [file.staged, file]));
  const entrypoints = manifestEntrypoints(files);
  const modules = new Map();
  for (const node of result.graph.nodes) {
    for (const observation of node.observations ?? []) {
      const props = observation.properties;
      const file = sources.get(props?.path);
      if (props?.semantic_role !== 'source-module' || !file) continue;
      const exports = (props.export_names ?? []).filter(name => typeof name === 'string' && name.length <= 100).slice(0, 24);
      modules.set(file.name, { path: file.name, exports, format: props.module_format });
    }
  }

  const importsByTarget = new Map();
  const exportSites = [];
  for (const edge of result.graph.edges) {
    const origin = location(edge.evidence?.location?.value, sources);
    const props = edge.properties;
    if (!origin || !props) continue;
    if (edge.relation === 'exposes' && props.module_link_kind === 'export' && typeof props.exported_name === 'string') {
      exportSites.push({ ...origin, name: props.exported_name.slice(0, 120) });
    }
    const target = sources.get(props.resolved_path)?.name;
    if (edge.relation !== 'imports' || !target || typeof props.specifier !== 'string') continue;
    const key = `${origin.path}\0${target}\0${props.specifier}`;
    const item = importsByTarget.get(key) ?? { ...origin, target, specifier: props.specifier.slice(0, 180), bindings: [] };
    item.line = Math.min(item.line, origin.line);
    if (typeof props.local_name === 'string' && !item.bindings.includes(props.local_name) && item.bindings.length < 16) {
      item.bindings.push(props.local_name.slice(0, 80));
    }
    importsByTarget.set(key, item);
  }
  const imports = [...importsByTarget.values()];
  const priority = new Set(entrypoints.map(entry => entry.path));
  for (const module of modules.values()) {
    if (module.exports.length && priority.size < 10 && /^(?:src\/)?(?:index|main|app)\.[^.]+$/i.test(module.path)) priority.add(module.path);
  }
  for (let pass = 0; pass < 2; pass++) {
    const frontier = new Set(priority);
    for (const item of imports) if (frontier.has(item.path) && priority.size < 16) priority.add(item.target);
  }
  const cliPaths = new Set(entrypoints.map(entry => entry.path));
  const direct = new Set(imports.filter(item => cliPaths.has(item.path)).map(item => item.target));
  const rank = name => cliPaths.has(name) ? 0 : direct.has(name) ? 1 : priority.has(name) ? 2 : 3;
  const compare = (a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0);
  imports.sort(compare);
  exportSites.sort(compare);

  const semantic = result.semantic_graph;
  const nodes = new Map();
  const calls = [];
  const functions = [];
  for (const node of semantic?.nodes ?? []) {
    const value = node.evidence?.location?.value;
    const where = location(value, sources);
    if (!where) continue;
    const name = typeof node.label === 'string' ? node.label.slice(0, 100) : '';
    const point = { ...where, name };
    if (node.kind === 'call-site') {
      const expression = sourceFragment(value, sources);
      if (expression) calls.push({ ...point, expression });
    }
    if (node.kind === 'function' && name) functions.push(point);
    nodes.set(node.node_id, point);
  }
  const relationKinds = new Set(['calls', 'returns-to-call', 'argument-to-parameter', 'registers-listener', 'sends', 'writes-to']);
  const relations = [];
  for (const item of semantic?.relations ?? []) {
    if (item.resolution !== 'resolved' || !relationKinds.has(item.relation)) continue;
    const from = nodes.get(item.source_node_id);
    const to = nodes.get(item.target_node_id);
    if (from && to) relations.push({ type: item.relation, from, to });
  }
  calls.sort(compare);
  const exposed = point => Boolean(modules.get(point.path)?.exports.includes(point.name));
  functions.sort((a, b) => Number(exposed(b)) - Number(exposed(a)) || compare(a, b));
  relations.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));

  const evidence = [];
  const seen = new Set();
  const addEvidence = (site, label) => {
    const key = `${site.path}:${site.line}`;
    if (seen.has(key) || evidence.length >= 12) return;
    const { path, line } = site;
    evidence.push({ path, line, label });
    seen.add(key);
  };
  for (const item of entrypoints.slice(0, 3)) {
    if (item.line) addEvidence({ path: item.manifest, line: item.line }, `Komut girişi: ${item.command}`);
  }
  for (const item of imports.slice(0, 4)) addEvidence(item, `REA: ${item.target} içe aktarılıyor`);
  for (const item of functions.filter(exposed).slice(0, 4)) addEvidence(item, `REA: ${item.name} işlevi`);
  const dynamicCalls = calls.filter(item => rank(item.path) < 2 && /^[\w$.]+\[[^\]]{1,80}\]\s*\(/u.test(item.expression));
  for (const item of dynamicCalls.slice(0, 3)) addEvidence(item, 'REA: Çalışırken seçilen işlevin çağrı noktası');
  for (const item of relations.filter(item => item.type === 'calls').slice(0, 4)) addEvidence(item.from, `REA: ${item.to.name} çağrısı`);
  for (const item of exportSites.slice(0, 4)) addEvidence(item, `REA: ${item.name} dışa aktarılıyor`);
  for (const item of functions.slice(0, 4)) addEvidence(item, `REA: ${item.name} işlevi`);

  const statistics = result.statistics;
  const coverage = {
    graph: result.graph.coverage?.status ?? 'unknown',
    semantic: semantic?.coverage?.status ?? 'unknown',
    truncated: Boolean(result.graph.coverage?.truncated || semantic?.coverage?.truncated),
  };
  const analyzedPaths = [...modules.keys()].sort();
  const context = {
    engine: `REA ${version}`,
    statistics: {
      parsedFiles: statistics.parsed_javascript_files,
      parseFailures: statistics.parse_failures,
      relations: semantic?.relations?.length ?? 0,
    },
    coverage,
    entrypoints,
    modules: [...modules.values()].sort(compare).slice(0, 24),
    imports: imports.slice(0, 24),
    exports: exportSites.slice(0, 24),
    functions: functions.slice(0, 30),
    calls: [...new Set([...dynamicCalls, ...calls])].slice(0, 48),
    relations: relations.slice(0, 30),
  };
  return { context, analyzedPaths, evidence };
}

let parseSource;

async function analyzeWithRea(files, signal, consumers = []) {
  const selected = Array.isArray(files) ? selectSources(files) : [];
  const selectedConsumers = Array.isArray(consumers) ? selectSources(consumers) : [];
  if (!selected.some(file => !file.isPackage)) return status('unsupported', 'REA için seçilmiş JavaScript kaynak dosyası bulunamadı.');

  let stage;
  let phase = 'runtime';
  try {
    signal?.throwIfAborted();
    const artifact = await lstat(bundle);
    if (!artifact.isFile() || artifact.size !== bundleSize) return status('unavailable', 'Yerel REA paketinin boyutu doğrulanamadı.');
    const bytes = await readFile(bundle, { signal });
    if (createHash('sha256').update(bytes).digest('hex') !== bundleHash) {
      return status('unavailable', 'Yerel REA paketinin SHA-256 doğrulaması başarısız oldu.');
    }
    stage = await openStage();
    const source = path.join(stage, 'source');
    const archive = path.join(stage, 'runtime.tar.gz');
    await writeFile(archive, bytes, { flag: 'wx', signal });
    for (const file of selected) {
      const target = path.join(source, ...file.staged.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, { flag: 'wx', signal });
    }
    const opts = { cwd: stage, env: childEnvironment(stage), windowsHide: true, signal };
    const windows = process.platform === 'win32';
    const tar = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    await run(tar, ['--exclude', '*/node_modules/.bin', '--exclude', '*/node_modules/.bin/*', '-xzf', archive, '-C', stage, runtime],
      { ...opts, timeout: 12000, maxBuffer: 128 * 1024 });

    phase = 'analysis';
    const cli = path.join(stage, runtime, 'scripts/rea.mjs');
    const { stdout } = await run(process.execPath, [cli, 'analyze-javascript-application', source,
      '--artifact-format', 'directory', '--max-heap-mb', '384', '--analysis-timeout-ms', '12000', '--format', 'json', '--full-output'],
    { ...opts, timeout: 22000, maxBuffer: 24 * 1024 * 1024 });
    const envelope = JSON.parse(stdout);
    const result = envelope?.data?.normalized_result;
    if (!envelope.ok || !Array.isArray(result?.graph?.nodes) || !Array.isArray(result.graph.edges)) {
      return status('error', 'REA kullanılabilir bir kaynak grafiği döndürmedi.');
    }
    if (!result.statistics?.parsed_javascript_files) return status('unsupported', 'REA seçilen kaynak dosyalarında JavaScript sözdizimi çıkaramadı.');
    const { context, evidence, analyzedPaths } = compactGraph(result, selected);
    if (!analyzedPaths.length) return status('error', 'REA grafiği seçilen dosyalarla eşleştirilemedi.');
    signal?.throwIfAborted();
    // This file is a self-contained parser from the SHA-256 checked REA runtime.
    parseSource ||= (await import(pathToFileURL(path.join(stage, runtime, babelParser)).href)).parse;
    const trials = discoverTrials(selected, selectedConsumers, parseSource);
    const jobs = discoverDesktopJobs(selected, parseSource);
    const count = result.statistics.parsed_javascript_files;
    const failures = result.statistics.parse_failures;
    const limited = failures || count < selected.filter(file => !file.isPackage).length || context.coverage.truncated;
    return {
      status: 'ok',
      detail: `REA ${version}, ${count} JavaScript dosyasını statik olarak analiz etti.${limited ? ' Kaynak kapsamı kısmi.' : ''}`,
      context, evidence, analyzedPaths, trials, jobs,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (phase === 'runtime') return status('unavailable', 'Doğrulanmış yerel REA çalışma ortamı hazırlanamadı.');
    return status('error', error.killed ? 'REA kaynak analizi süre sınırına ulaştı.' : 'REA kaynak analizi tamamlanamadı.');
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { analyzeWithRea };
