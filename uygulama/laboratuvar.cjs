'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SAMPLE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const MAX_PREVIEW = 24 * 1024;
const MAX_RESULT = 8 * 1024;
const MAX_RECORD = 512 * 1024;
const MAX_SAVED = 128;
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_RUNS = 32;
const MAX_SESSIONS = 32;
const MAX_PENDING_OPEN = 4;
const MAX_PENDING_RUN = 2;
const SESSION_TTL = 6 * 60 * 60 * 1000;
const QUERY_ERROR = 'Aramak için 1 ile 120 karakter arasında bir kelime veya .pdf gibi bir ifade yaz.';

const ACTIONS = {
  preview: [['action', 'sampleId'], []],
  confirm: [['action', 'id', 'revision'], []],
  run: [['action', 'id', 'revision', 'payload'], []],
  rerun: [['action', 'id', 'revision', 'payload'], []],
  reset: [['action', 'id', 'revision'], []],
  save: [['action', 'id', 'revision'], ['payload']],
  open: [['action', 'id'], []],
};

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function requireCondition(condition, status, message) {
  if (!condition) throw error(status, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, required, optional = []) {
  if (!isObject(value)) return false;
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function isUuid(value) {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

function isSampleId(value) {
  return typeof value === 'string' && value === value.trim() && SAMPLE_ID.test(value);
}

function boundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function savedName(value) {
  return boundedText(value, 120) && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) && instant.toISOString() === value;
}

function validateInput(value, defaultInput) {
  if (Object.hasOwn(defaultInput, 'codexDetected')) {
    return exact(value, ['codexDetected']) && typeof value.codexDetected === 'boolean';
  }
  return exact(value, ['query']) && typeof value.query === 'string' && value.query.length <= 120 &&
    value.query.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value.query);
}

function validDefaultInput(value) {
  return isObject(value) && validateInput(value, value);
}

function validPreview(value) {
  return isObject(value) && boundedText(value.title, 250) && boundedText(value.overview, 5000) &&
    boundedText(value.scope, 3000) && isObject(value.module) && boundedText(value.module.title, 250) &&
    boundedText(value.module.description, 3000) && boundedText(value.mode, 200) &&
    Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.length <= 20 &&
    value.evidence.every(item => isObject(item) && boundedText(item.title, 250) &&
      boundedText(item.ref, 1000) && boundedText(item.description, 3000)) &&
    Array.isArray(value.flow) && value.flow.length > 0 && value.flow.length <= 20 &&
    value.flow.every(item => isObject(item) && boundedText(item.title, 250) && boundedText(item.detail, 3000)) &&
    validDefaultInput(value.defaultInput);
}

function validResult(value) {
  return isObject(value) && boundedText(value.summary, 1500) && boundedText(value.mode, 200) &&
    Array.isArray(value.details) && value.details.length <= 40 &&
    value.details.every(item => boundedText(item, 1500)) && Buffer.byteLength(JSON.stringify(value)) <= MAX_RESULT;
}

function sameInput(a, b) {
  return a.query === b.query && a.codexDetected === b.codexDetected;
}

function validRecord(value, id, sampleIds) {
  if (!exact(value, ['version', 'id', 'name', 'sampleId', 'savedAt', 'previewHash', 'work']) ||
      value.version !== 1 || value.id !== id || !savedName(value.name) || !sampleIds.has(value.sampleId) ||
      !isTimestamp(value.savedAt) || typeof value.previewHash !== 'string' || value.previewHash.length !== 64 ||
      !/^[a-f0-9]{64}$/u.test(value.previewHash)) return false;
  const work = value.work;
  if (!exact(work, ['defaultInput', 'input', 'runs', 'selectedRunId', 'resetCount']) ||
      !validDefaultInput(work.defaultInput) || !validateInput(work.input, work.defaultInput) ||
      !Array.isArray(work.runs) || work.runs.length > MAX_RUNS ||
      !Number.isSafeInteger(work.resetCount) || work.resetCount < 0) return false;
  const previousRuns = new Map();
  let lastInput = work.defaultInput;
  for (const run of work.runs) {
    if (!exact(run, ['id', 'input', 'result', 'retryOf']) || !isUuid(run.id) ||
        previousRuns.has(run.id) || !validateInput(run.input, work.defaultInput) || !validResult(run.result)) return false;
    if (run.retryOf === null) {
      lastInput = run.input;
    } else {
      const original = previousRuns.get(run.retryOf);
      if (!original || !sameInput(run.input, original.input)) return false;
    }
    previousRuns.set(run.id, run);
  }
  return sameInput(work.input, lastInput) &&
    work.selectedRunId === (work.runs.at(-1)?.id ?? null);
}

function previewHash(preview) {
  return crypto.createHash('sha256').update(JSON.stringify(preview)).digest('hex');
}

function listedRecord({ id, name, sampleId, savedAt }) {
  return { id, name, sampleId, savedAt };
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function storage(dataDir, sampleIds) {
  const root = path.resolve(dataDir);
  const storageError = () => error(503, 'Kayıt klasörüne erişilemedi. Çalışma ekranda duruyor, daha sonra tekrar kaydedebilirsin.');

  async function checkRoot(create) {
    try {
      if (create) {
        const parent = path.dirname(root);
        const realParent = await fs.realpath(parent);
        if (!samePath(parent, realParent)) throw storageError();
        await fs.mkdir(root, { recursive: true });
      }
      const entry = await fs.lstat(root);
      if (!entry.isDirectory() || !samePath(root, await fs.realpath(root))) throw storageError();
      return true;
    } catch (err) {
      if (err.code === 'ENOENT' && !create) return false;
      throw storageError();
    }
  }

  async function read(id) {
    const file = path.join(root, id + '.json');
    let handle;
    try {
      const entry = await fs.lstat(file, { bigint: true });
      if (!entry.isFile() || entry.nlink > 2n || entry.size > BigInt(MAX_RECORD)) return null;
      if (entry.nlink === 2n) {
        // A stop after publishing can leave the in-directory staging link behind.
        const staging = await fs.lstat(path.join(root, '.' + id + '.tmp'), { bigint: true });
        if (!staging.isFile() || staging.dev !== entry.dev || staging.ino !== entry.ino) return null;
      }
      handle = await fs.open(file, 'r');
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== entry.nlink || opened.dev !== entry.dev || opened.ino !== entry.ino ||
          opened.size !== entry.size) return null;
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const final = await handle.stat({ bigint: true });
      if (length !== Number(opened.size) || final.mtimeNs !== opened.mtimeNs || final.ctimeNs !== opened.ctimeNs) return null;
      const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      return validRecord(record, id, sampleIds) ? record : null;
    } catch {
      return null;
    } finally {
      if (handle) await handle.close();
    }
  }

  async function inspect() {
    const records = [];
    let fileCount = 0;
    let visited = 0;
    if (!await checkRoot(false)) return { records, fileCount };
    try {
      const files = await fs.opendir(root);
      for await (const entry of files) {
        if (++visited > MAX_DIRECTORY_ENTRIES) throw storageError();
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (!isUuid(id)) continue;
        fileCount++;
        if (fileCount > MAX_SAVED) break;
        if (!entry.isFile()) continue;
        const record = await read(id);
        if (record) records.push(listedRecord(record));
      }
    } catch {
      throw storageError();
    }
    records.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
    return { records, fileCount };
  }

  async function write(record) {
    await checkRoot(true);
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    requireCondition(bytes.length <= MAX_RECORD, 413, 'Bu çalışma kayıt için fazla büyük.');
    requireCondition((await inspect()).fileCount < MAX_SAVED, 409, 'Kayıt sınırı doldu.');
    const temporary = path.join(root, '.' + record.id + '.tmp');
    const destination = path.join(root, record.id + '.json');
    let handle;
    let ownsTemporary = false;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      ownsTemporary = true;
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.link(temporary, destination);
    } catch {
      throw storageError();
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (ownsTemporary) await fs.unlink(temporary).catch(() => {});
    }
  }

  return {
    inspect,
    write,
    async read(id) {
      return (await checkRoot(false)) ? read(id) : null;
    },
  };
}

function createLaboratuvar(options = {}) {
  const { adapter = require('./laboratuvar-ornekler.cjs') } = options;
  const defaultDataDir = path.join(__dirname, '..', '.laboratuvar-kayitlari');
  const dataDir = options.dataDir ?? (process.env.URUN_TANI_LAB_DATA || defaultDataDir);
  const samples = structuredClone(adapter.samples);
  const sampleIds = new Set(samples.map(sample => sample.id));
  const records = storage(dataDir, sampleIds);
  const sessions = new Map();
  let savesPending = Promise.resolve();
  let opening = 0;
  let executing = 0;

  function sweep() {
    const earliest = Date.now() - SESSION_TTL;
    for (const [id, session] of sessions) {
      if (!session.busy && session.touchedAt < earliest) sessions.delete(id);
    }
  }

  function makeSession(sampleId, preview, work = null) {
    if (sessions.size >= MAX_SESSIONS) {
      const available = [...sessions.values()].filter(session => !session.busy);
      available.sort((a, b) => {
        const phase = Number(a.state.phase === 'ready') - Number(b.state.phase === 'ready');
        return phase || a.touchedAt - b.touchedAt;
      });
      requireCondition(available.length > 0, 429, 'Açık çalışmalar işleniyor. Bir işlem tamamlanınca tekrar dene.');
      sessions.delete(available[0].state.id);
    }
    const id = crypto.randomUUID();
    const state = {
      id,
      revision: 0,
      phase: work ? 'ready' : 'preview',
      sampleId,
      preview,
      input: structuredClone(work?.input ?? preview.defaultInput),
      runs: work?.runs ?? [],
      selectedRunId: work?.selectedRunId ?? null,
      resetCount: work?.resetCount ?? 0,
    };
    sessions.set(id, { state, busy: false, touchedAt: Date.now() });
    return { state: structuredClone(state) };
  }

  async function startSession(task) {
    sweep();
    requireCondition(opening < MAX_PENDING_OPEN, 429, 'Önizlemeler hazırlanıyor. Bir işlem tamamlanınca tekrar dene.');
    opening++;
    try {
      return await task();
    } finally {
      opening--;
    }
  }

  async function loadPreview(sampleId) {
    requireCondition(isSampleId(sampleId) && sampleIds.has(sampleId), 404, 'Bu laboratuvar örneği bulunamadı.');
    try {
      const encoded = JSON.stringify(await adapter.preview(sampleId));
      if (!encoded || Buffer.byteLength(encoded) > MAX_PREVIEW) throw new Error('Invalid preview size');
      const preview = JSON.parse(encoded);
      if (!validPreview(preview)) throw new Error('Invalid preview');
      return preview;
    } catch {
      throw error(503, 'Örneğin kaynak önizlemesi hazırlanamadı. Lütfen tekrar dene.');
    }
  }

  async function execute(state, input, retryOf) {
    requireCondition(state.runs.length < MAX_RUNS, 409, 'Deneme geçmişi doldu. Yeniden denemek için çalışmayı sıfırla.');
    requireCondition(executing < MAX_PENDING_RUN, 429, 'Başka denemeler çalışıyor. Bir işlem tamamlanınca tekrar dene.');
    executing++;
    let result;
    try {
      const context = {
        preview: structuredClone(state.preview),
        workId: state.id,
        revision: state.revision,
        signal: AbortSignal.timeout(60_000),
      };
      const encoded = JSON.stringify(await adapter.execute(state.sampleId, structuredClone(input), context));
      if (!encoded || Buffer.byteLength(encoded) > MAX_RESULT) throw new Error('Invalid result size');
      result = JSON.parse(encoded);
      if (!validResult(result)) throw new Error('Invalid result');
    } catch (err) {
      if (err?.status === 409) throw error(409, 'Onaylanan kaynak doğrulanamadı. Örneği inceleyip yeniden onayla.');
      if (err?.status === 503) throw error(503, 'Yalıtılmış deneme şu anda çalıştırılamadı. Girdi ve deneme geçmişi ekranda duruyor.');
      throw error(502, 'Örnek çalıştırılamadı. Girdi ve deneme geçmişi ekranda duruyor.');
    } finally {
      executing--;
    }
    const run = { id: crypto.randomUUID(), input: structuredClone(input), result, retryOf };
    state.selectedRunId = run.id;
    state.runs.push(run);
    if (retryOf === null) state.input = structuredClone(input);
  }

  async function save(state, payload) {
    const name = payload?.name;
    const validPayload = payload === undefined ||
      (exact(payload, [], ['name']) && (name === undefined || (typeof name === 'string' && savedName(name.trim()))));
    requireCondition(validPayload, 400, 'Kayıt adı 1 ile 120 karakter arasında olmalı.');
    const record = {
      version: 1,
      id: crypto.randomUUID(),
      name: name?.trim() ?? state.preview.title.trim().slice(0, 120).trimEnd(),
      sampleId: state.sampleId,
      savedAt: new Date().toISOString(),
      previewHash: previewHash(state.preview),
      work: {
        defaultInput: state.preview.defaultInput,
        input: state.input,
        runs: state.runs,
        selectedRunId: state.selectedRunId,
        resetCount: state.resetCount,
      },
    };
    requireCondition(validRecord(record, record.id, sampleIds), 422, 'Bu çalışma geçerli bir kayda dönüştürülemedi.');
    const saving = savesPending.then(async () => {
      await records.write(record);
      // The commit succeeded. A transient failure to list it must not fail or replay the mutation.
      const listing = await records.inspect().catch(() => ({ records: [] }));
      if (!listing.records.some(item => item.id === record.id)) listing.records.unshift(listedRecord(record));
      return listing.records;
    });
    savesPending = saving.catch(() => {});
    return saving;
  }

  async function post(request) {
    const action = isObject(request) ? request.action : undefined;
    const schema = typeof action === 'string' && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    requireCondition(schema && exact(request, ...schema), 400, 'Laboratuvar isteğinde eksik veya tanınmayan alan var.');
    if (action === 'preview') {
      return startSession(async () => makeSession(request.sampleId, await loadPreview(request.sampleId)));
    }

    requireCondition(isUuid(request.id), 400, 'Çalışma veya kayıt kimliği geçersiz.');
    if (action === 'open') {
      return startSession(async () => {
        const record = await records.read(request.id);
        requireCondition(record, 404, 'Kayıt bulunamadı veya okunamadı.');
        const preview = await loadPreview(record.sampleId);
        requireCondition(record.previewHash === previewHash(preview) && sameInput(record.work.defaultInput, preview.defaultInput),
          409, 'Kayıttaki kaynak ile mevcut kaynak farklı. Örneği açıp yeniden incele.');
        return makeSession(record.sampleId, preview, record.work);
      });
    }

    requireCondition(Number.isSafeInteger(request.revision) && request.revision >= 0, 400, 'Çalışma sürümü geçersiz.');
    sweep();
    const session = sessions.get(request.id);
    requireCondition(session, 404, 'Açık çalışma bulunamadı. Örneği baştan inceleyebilir veya bir kaydı açabilirsin.');
    const { state } = session;
    requireCondition(!session.busy && state.revision === request.revision, 409,
      'Çalışma değişti ya da hâlâ işleniyor. Ekrandaki güncel işlem tamamlandığında tekrar dene.');
    requireCondition(state.phase === (action === 'confirm' ? 'preview' : 'ready'), 409,
      action === 'confirm' ? 'Kaynak zaten onaylandı.' : 'İşlemden önce kaynak önizlemesini onayla.');
    session.busy = true;
    try {
      let saved;
      switch (action) {
        case 'confirm':
          state.phase = 'ready';
          break;
        case 'run':
          requireCondition(validateInput(request.payload, state.preview.defaultInput), 400,
            Object.hasOwn(state.preview.defaultInput, 'query') ? QUERY_ERROR : 'Deneme girdisi bu örneğe uygun değil.');
          await execute(state, request.payload, null);
          break;
        case 'rerun': {
          requireCondition(exact(request.payload, ['runId']) && isUuid(request.payload.runId), 400, 'Geçmiş deneme kimliği geçersiz.');
          const original = state.runs.find(run => run.id === request.payload.runId);
          requireCondition(original, 404, 'Seçilen deneme bu çalışma geçmişinde bulunamadı.');
          await execute(state, original.input, original.id);
          break;
        }
        case 'reset':
          state.input = structuredClone(state.preview.defaultInput);
          state.runs = [];
          state.selectedRunId = null;
          state.resetCount++;
          break;
        case 'save':
          saved = await save(state, request.payload);
          break;
      }
      state.revision++;
      const response = { state: structuredClone(state) };
      if (saved) response.saved = saved;
      return response;
    } finally {
      session.touchedAt = Date.now();
      session.busy = false;
    }
  }

  return {
    async get() {
      const catalog = { samples: structuredClone(samples), saved: [] };
      try {
        const { records: saved } = await records.inspect();
        return { ...catalog, saved };
      } catch (err) {
        if (err?.status !== 503) throw err;
        return { ...catalog, savedWarning: 'Kayıtlara erişilemedi. Yeni denemeler yapabilirsin.' };
      }
    },
    post,
  };
}

module.exports = { createLaboratuvar };
