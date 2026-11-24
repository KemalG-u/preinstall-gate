'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { createLaboratuvar } = require('./laboratuvar.cjs');
const { createServer } = require('./sunucu.cjs');

function fixture() {
  const firstStart = Promise.withResolvers();
  const firstFinish = Promise.withResolvers();
  const calls = [];
  const adapter = {
    samples: [{ id: 'ornek', title: 'Dosya bulucu' }, { id: 'arama', title: 'Sözcük araması' }],
    preview(id) {
      return {
        title: id === 'ornek' ? 'Dosya bulucu' : 'Sözcük araması',
        overview: 'Verilen örnekte bir iz arar.',
        scope: 'Yalnız deneme verisi.',
        module: { title: 'İzi bul', description: 'İzi arayıp listeye ekler.' },
        evidence: [{ title: 'Kaynak', ref: 'ornek.js:10', description: 'Listeye veri verir.' }],
        flow: [{ title: 'Listeyi aç', detail: 'Arama sonucu listede gösterilir.' }],
        defaultInput: id === 'ornek' ? { codexDetected: false } : { query: 'örnek' },
        mode: 'örnek',
        binding: { source: id + ':sabit' },
      };
    },
    async execute(id, input, { preview, workId, revision }) {
      assert.deepEqual(preview.binding, { source: id + ':sabit' });
      assert.equal(typeof workId, 'string');
      calls.push({ id, input, revision });
      if (calls.length === 1) {
        firstStart.resolve();
        await firstFinish.promise;
      }
      if (input.query === 'hata') throw new Error('internal fixture failure');
      return {
        summary: id === 'ornek' ? (input.codexDetected ? 'İz bulundu.' : 'İz yok.') : input.query,
        details: ['Bulgu listeye gitti.'],
        mode: 'örnek',
      };
    },
  };
  return { adapter, firstStart, firstFinish, calls };
}

async function serve(dataDir, adapter) {
  const server = createServer({ lab: createLaboratuvar({ dataDir, adapter }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;

  async function request(method = 'GET', input, headers = {}, url = '/api/laboratuvar') {
    const options = { method, headers };
    if (input !== undefined) {
      options.body = JSON.stringify(input);
      options.headers = { 'Content-Type': 'application/json', ...headers };
    }
    const response = await fetch(base + url, options);
    return { status: response.status, body: await response.json() };
  }

  return {
    request,
    post: (input, headers) => request('POST', input, headers),
    close: () => {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      return closed;
    },
  };
}

function change(state, action, payload) {
  const request = { action, id: state.id, revision: state.revision };
  if (payload !== undefined) request.payload = payload;
  return request;
}

function resultState(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.state;
}

async function expectStatus(promise, status) {
  const response = await promise;
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.match(response.body.error, /./u);
}

async function removeFixture(root, paths) {
  assert.equal(path.dirname(root), path.dirname(__dirname));
  assert.match(path.basename(root), /^\.laboratuvar-kontrol-/u);
  for (const file of paths.reverse()) await fs.unlink(file);
  await fs.rmdir(path.join(root, 'records'));
  await fs.rmdir(root);
}

test('Önizleme, onay, çakışan çalıştırma, tekrar, sıfırla, iki ayrı kalıcı sürüm ve yeniden aç', { timeout: 15000 }, async (t) => {
  const { adapter, firstStart, firstFinish, calls } = fixture();
  const root = await fs.mkdtemp(path.join(path.dirname(__dirname), '.laboratuvar-kontrol-'));
  const dataDir = path.join(root, 'records');
  let http = await serve(dataDir, adapter);
  const files = [];
  try {
    const initial = await http.request();
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { samples: adapter.samples, saved: [] });
    await expectStatus(http.request('PUT'), 405);
    await expectStatus(http.post({ action: 'preview', sampleId: 'ornek' }, { Origin: 'https://example.test' }), 403);
    await expectStatus(http.post({ action: 'preview', sampleId: 'ornek' }, { 'Sec-Fetch-Site': 'cross-site' }), 403);
    await expectStatus(http.post({ action: 'preview', sampleId: 'ornek' }, { 'Content-Type': 'text/plain' }), 415);
    await expectStatus(http.post({ action: 'preview', sampleId: 'x'.repeat(9000) }), 413);
    await expectStatus(http.post({ action: 'preview', sampleId: 'olmayan' }), 404);
    await expectStatus(http.post({ action: 'preview', sampleId: 'ornek', source: 'farklı' }), 400);
    assert.equal(calls.length, 0);

    let state = resultState(await http.post({ action: 'preview', sampleId: 'ornek' }));
    assert.equal(state.phase, 'preview');
    assert.deepEqual(state.preview.binding, { source: 'ornek:sabit' });
    await expectStatus(http.post(change(state, 'run', { codexDetected: true })), 409);
    await expectStatus(http.post(change(state, 'save')), 409);
    const oldConfirm = change(state, 'confirm');
    state = resultState(await http.post(oldConfirm));
    assert.equal(state.phase, 'ready');
    assert.equal(state.revision, 1);
    await expectStatus(http.post(oldConfirm), 409);
    await expectStatus(http.post(change(state, 'run', { codexDetected: 'yes' })), 400);
    await expectStatus(http.post(change(state, 'run', { codexDetected: true, query: 'fazla' })), 400);
    assert.equal(calls.length, 0);

    const firstPost = change(state, 'run', { codexDetected: true });
    const first = http.post(firstPost);
    await firstStart.promise;
    try {
      await expectStatus(http.post(firstPost), 409);
      await expectStatus(http.post(change(state, 'reset')), 409);
      assert.equal(calls.length, 1);
    } finally {
      firstFinish.resolve();
    }
    state = resultState(await first);
    await expectStatus(http.post(firstPost), 409);
    const firstId = state.runs[0].id;
    assert.equal(state.selectedRunId, firstId);
    assert.equal(state.runs[0].result.summary, 'İz bulundu.');
    assert.deepEqual(state.input, { codexDetected: true });

    state = resultState(await http.post(change(state, 'run', { codexDetected: false })));
    assert.equal(state.runs[1].result.summary, 'İz yok.');
    await expectStatus(http.post(change(state, 'rerun', { runId: crypto.randomUUID() })), 404);
    state = resultState(await http.post(change(state, 'rerun', { runId: firstId })));
    assert.equal(state.runs[2].retryOf, firstId);
    assert.deepEqual(state.runs[2].input, { codexDetected: true });
    assert.equal(state.runs[2].result.summary, 'İz bulundu.');
    assert.deepEqual(state.input, { codexDetected: false });
    assert.equal(state.revision, 4);
    assert.equal(calls.length, 3);

    const saveRequest = change(state, 'save', { name: '  Önceki çalışma  ' });
    const savedFirst = await http.post(saveRequest);
    state = resultState(savedFirst);
    const firstSaved = savedFirst.body.saved[0];
    const firstFile = path.join(dataDir, firstSaved.id + '.json');
    files.push(firstFile);
    const firstBytes = await fs.readFile(firstFile);
    assert.equal(firstSaved.name, 'Önceki çalışma');
    await expectStatus(http.post(saveRequest), 409);

    const preview = state.preview;
    state = resultState(await http.post(change(state, 'reset')));
    assert.equal(state.phase, 'ready');
    assert.equal(state.resetCount, 1);
    assert.equal(state.selectedRunId, null);
    assert.deepEqual(state.runs, []);
    assert.deepEqual(state.input, preview.defaultInput);
    assert.deepEqual(state.preview, preview);
    const savedReset = await http.post(change(state, 'save', {}));
    state = resultState(savedReset);
    assert.equal(savedReset.body.saved.length, 2);
    const resetSaved = savedReset.body.saved.find(record => record.id !== firstSaved.id);
    files.push(path.join(dataDir, resetSaved.id + '.json'));
    assert.equal(resetSaved.name, 'Dosya bulucu');
    assert.deepEqual(await fs.readFile(firstFile), firstBytes);
    const resetWorkId = state.id;

    const links = await fs.readdir(dataDir);
    assert.deepEqual(links.sort(), files.map(file => path.basename(file)).sort());
    const damagedId = crypto.randomUUID();
    const damagedFile = path.join(dataDir, damagedId + '.json');
    await fs.writeFile(damagedFile, '{"version":1');
    files.push(damagedFile);
    const forgedId = crypto.randomUUID();
    const forgedFile = path.join(dataDir, forgedId + '.json');
    await fs.writeFile(forgedFile, firstBytes);
    files.push(forgedFile);
    const linkedId = crypto.randomUUID();
    const linkedFile = path.join(dataDir, linkedId + '.json');
    const linkedRecord = JSON.parse(firstBytes);
    linkedRecord.id = linkedId;
    linkedRecord.work.runs.at(-1).input.codexDetected = false;
    await fs.writeFile(linkedFile, JSON.stringify(linkedRecord));
    files.push(linkedFile);
    const staged = path.join(dataDir, '.' + firstSaved.id + '.tmp');
    await fs.link(firstFile, staged);
    files.push(staged);
    const symlinkId = crypto.randomUUID();
    const symlinkFile = path.join(dataDir, symlinkId + '.json');
    const symlinkContent = path.join(root, 'outside.json');
    await fs.writeFile(symlinkContent, JSON.stringify({ ...JSON.parse(firstBytes), id: symlinkId }));
    files.push(symlinkContent);
    try {
      await fs.symlink(symlinkContent, symlinkFile, 'file');
      t.diagnostic('Kayıt adlı dosya bağlantısı sınandı.');
    } catch (err) {
      if (process.platform !== 'win32' || err.code !== 'EPERM') throw err;
      await fs.symlink(dataDir, symlinkFile, 'junction');
      t.diagnostic('Windows dosya bağlantısı için izin vermedi. Kayıt adlı dizin bağlantısı sınandı.');
    }
    files.push(symlinkFile);

    await http.close();
    http = await serve(dataDir, adapter);
    const restart = await http.request();
    assert.deepEqual(restart.body.saved.map(record => record.id).sort(), [firstSaved.id, resetSaved.id].sort());
    assert.equal(calls.length, 3);
    await expectStatus(http.post(change(state, 'reset')), 404);
    await expectStatus(http.post({ action: 'open', id: 'x/../../records' }), 400);
    for (const id of [crypto.randomUUID(), damagedId, forgedId, linkedId, symlinkId]) {
      await expectStatus(http.post({ action: 'open', id }), 404);
    }
    await expectStatus(http.request('GET', undefined, {}, '/.laboratuvar-kayitlari/' + firstSaved.id + '.json'), 404);
    await expectStatus(http.request('GET', undefined, {}, '/laboratuvar-kontrol.cjs'), 404);

    const reopened = resultState(await http.post({ action: 'open', id: firstSaved.id }));
    assert.notEqual(reopened.id, resetWorkId);
    assert.equal(reopened.revision, 0);
    assert.equal(reopened.runs.length, 3);
    assert.equal(reopened.runs[2].retryOf, firstId);
    assert.deepEqual(reopened.preview, preview);
    state = resultState(await http.post({ action: 'open', id: resetSaved.id }));
    assert.equal(state.resetCount, 1);
    assert.equal(state.runs.length, 0);
    state = resultState(await http.post(change(state, 'run', { codexDetected: true })));
    assert.equal(state.runs[0].result.summary, 'İz bulundu.');

    state = resultState(await http.post({ action: 'preview', sampleId: 'arama' }));
    state = resultState(await http.post(change(state, 'confirm')));
    await expectStatus(http.post(change(state, 'run', { query: 'hata' })), 502);
    for (const query of ['', '   ', 'x\nb', 'x'.repeat(121)]) {
      await expectStatus(http.post(change(state, 'run', { query })), 400);
    }
    const versionBeforeRetry = state.revision;
    state = resultState(await http.post(change(state, 'run', { query: 'kendi örneğim' })));
    assert.equal(state.revision, versionBeforeRetry + 1);
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].result.summary, 'kendi örneğim');

    let oldestId;
    for (let i = 0; i < 36; i++) {
      const fresh = resultState(await http.post({ action: 'preview', sampleId: 'ornek' }));
      oldestId ??= fresh.id;
    }
    const readyAfterEviction = resultState(await http.post(change(state, 'run', { query: 'yaşayan çalışma' })));
    assert.equal(readyAfterEviction.runs.length, 2);
    await expectStatus(http.post({ action: 'confirm', id: oldestId, revision: 0 }), 404);
  } finally {
    firstFinish.resolve();
    await http.close();
    try {
      await removeFixture(root, files);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await fs.rmdir(root);
    }
  }
});

test('Kayıt dizini açılamadığında örnek kataloğu ve yeni deneme çalışır', { timeout: 15000 }, async () => {
  const { adapter, firstFinish } = fixture();
  firstFinish.resolve();
  const root = await fs.mkdtemp(path.join(path.dirname(__dirname), '.laboratuvar-kontrol-'));
  const dataDir = path.join(root, 'records');
  await fs.writeFile(dataDir, 'Bu dosya bir dizin değil.', { flag: 'wx' });
  const http = await serve(dataDir, adapter);
  try {
    const catalog = await http.request();
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body, {
      samples: adapter.samples,
      saved: [],
      savedWarning: 'Kayıtlara erişilemedi. Yeni denemeler yapabilirsin.',
    });
    await expectStatus(http.post({ action: 'open', id: crypto.randomUUID() }), 503);
    let state = resultState(await http.post({ action: 'preview', sampleId: 'ornek' }));
    state = resultState(await http.post(change(state, 'confirm')));
    await expectStatus(http.post(change(state, 'save', {})), 503);
    state = resultState(await http.post(change(state, 'run', { codexDetected: true })));
    assert.equal(state.runs[0].result.summary, 'İz bulundu.');
    const catalogAfterRun = await http.request();
    assert.deepEqual(catalogAfterRun, catalog);
    assert.equal(await fs.readFile(dataDir, 'utf8'), 'Bu dosya bir dizin değil.');
  } finally {
    await http.close();
    await fs.unlink(dataDir);
    await fs.rmdir(root);
  }
});
