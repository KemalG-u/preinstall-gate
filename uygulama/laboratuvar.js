(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'sample', 'inspect', 'sample-description', 'status', 'preview', 'source-title',
    'overview', 'scope', 'confirm', 'ready', 'module-title', 'module-description',
    'flow', 'evidence', 'run-form', 'input', 'run', 'result', 'result-title',
    'given', 'summary', 'details', 'usage', 'result-mode', 'history', 'reset',
    'save-name', 'save', 'saved',
  ].map((id) => [id, $('lab-' + id)]));

  const rui = {
    form: $('repo-inspect-form'),
    url: $('repo-url'),
    intent: $('repo-intent'),
    inspectBtn: $('repo-inspect-btn'),
    status: $('repo-status'),
    step2: $('repo-step2'),
    step2Title: $('repo-step2-title'),
    snapshotBar: $('repo-snapshot-bar'),
    intentFit: $('repo-intent-fit'),
    supportAlert: $('repo-support-alert'),
    whoWhat: $('repo-who-what'),
    intentNote: $('repo-intent-note'),
    modelNote: $('repo-model-note'),
    limitationsBox: $('repo-limitations-box'),
    limitationsSummary: $('repo-limitations-summary'),
    limitationsList: $('repo-limitations-list'),
    exampleBox: $('repo-example-box'),
    exampleBadge: $('repo-example-badge'),
    exampleIn: $('repo-example-in'),
    exampleOut: $('repo-example-out'),
    exampleNote: $('repo-example-note'),
    jobsWrap: $('repo-jobs-wrap'),
    jobsList: $('repo-jobs-list'),
    jobDetail: $('repo-job-detail'),
    jobOrigin: $('repo-job-origin'),
    jobConsumerKind: $('repo-job-consumer-kind'),
    jobTitle: $('repo-job-title'),
    jobSummary: $('repo-job-summary'),
    jobTrigger: $('repo-job-trigger'),
    jobInput: $('repo-job-input'),
    jobOutput: $('repo-job-output'),
    jobConsumer: $('repo-job-consumer'),
    flowBoxes: $('repo-flow-boxes'),
    evidenceList: $('repo-evidence-list'),
    step34: $('repo-step34'),
    step34Title: $('repo-step34-title'),
    approvalBox: $('repo-approval-box'),
    depStatus: $('repo-dep-status'),
    approveBtn: $('repo-approve-btn'),
    trialTuning: $('repo-trial-tuning'),
    extraFlags: $('repo-extra-flags'),
    discoveredFlags: $('repo-discovered-flags'),
    prediction: $('repo-prediction'),
    abControls: $('repo-ab-controls'),
    inputA: $('repo-input-a'),
    inputB: $('repo-input-b'),
    runA: $('repo-run-a'),
    runB: $('repo-run-b'),
    resultA: $('repo-result-a'),
    resultB: $('repo-result-b'),
    consumerProof: $('repo-consumer-proof'),
    consumerProofBody: $('repo-consumer-proof-body'),
    abDiff: $('repo-ab-diff'),
    abDiffBody: $('repo-ab-diff-body'),
    techProof: $('repo-tech-proof'),
    techProofBody: $('repo-tech-proof-body'),
    step5: $('repo-step5'),
    resetBtn: $('repo-reset-btn'),
    cleanRerunBtn: $('repo-clean-rerun-btn'),
    exportBtn: $('repo-export-btn'),
    resetNote: $('repo-reset-note'),
    cleanRerunBox: $('repo-clean-rerun-box'),
    archivedRuns: $('repo-archived-runs'),
    archivedRunsBody: $('repo-archived-runs-body'),
    saveName: $('repo-save-name'),
    saveBtn: $('repo-save-btn'),
  };

  let samples = [];
  let presetSaved = [];
  let repoSaved = [];
  let savedWarning = '';
  let state = null;
  let repoState = null;
  let busy = false;

  const say = (message) => { if (ui.status) ui.status.textContent = message; };
  const repoSay = (message, tone = '') => {
    if (!rui.status) return;
    rui.status.textContent = message;
    if (tone) rui.status.dataset.tone = tone;
    else delete rui.status.dataset.tone;
  };
  const element = (tag, content, className) => {
    const node = document.createElement(tag);
    if (content != null) node.textContent = String(content);
    if (className) node.className = className;
    return node;
  };
  const shown = (value, fallback = 'Bilgi verilmedi.') =>
    typeof value === 'string' && value.trim() ? value : fallback;

  function syncSecondaryDrawerHash() {
    const drawer = $('secondary-entry-drawer');
    if (!drawer) return;
    if (location.hash === '#kendi-aracini-incele') {
      drawer.open = true;
    }
  }
  window.addEventListener('hashchange', syncSecondaryDrawerHash);
  syncSecondaryDrawerHash();

  // Quick-pick repository chips for users who want an instant real-world example
  for (const chip of document.querySelectorAll('.repo-quick-chip')) {
    chip.addEventListener('click', () => {
      if (busy) return;
      if (rui.url && chip.dataset.repoUrl) rui.url.value = chip.dataset.repoUrl;
      if (rui.intent && chip.dataset.repoIntent) rui.intent.value = chip.dataset.repoIntent;
      rui.inspectBtn?.focus();
    });
  }

  function allRunsChronological(st) {
    if (!st) return [];
    const archived = (st.archivedRuns || []).flatMap((g) =>
      (g.preservedRuns || []).map((r) => ({ ...r, _archivedInReset: g.resetNumber }))
    );
    const active = (st.runs || []).map((r) => ({ ...r, _archivedInReset: 0 }));
    return [...archived, ...active];
  }

  function setBusy(value) {
    busy = value;
    if (ui.sample) ui.sample.disabled = value || !samples.length;
    if (ui.inspect) ui.inspect.disabled = value || !samples.length;
    for (const node of document.querySelectorAll('#laboratuvar button:not(#lab-inspect), #laboratuvar input, #laboratuvar textarea, #laboratuvar form select')) {
      node.disabled = value;
    }
    if (!value && rui.cleanRerunBtn) {
      const hasAnyRun = Boolean(repoState?.permission?.granted && allRunsChronological(repoState).length > 0);
      rui.cleanRerunBtn.disabled = !hasAnyRun;
    }
    $('laboratuvar')?.setAttribute('aria-busy', String(value));
  }

  async function request(method, data) {
    const options = method === 'GET' ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
    const response = await fetch('/api/laboratuvar', options);
    if (method === 'GET' && response.status === 404) {
      const error = new Error('Laboratuvar bu sunucuda bulunmuyor.');
      error.status = 404;
      throw error;
    }
    let body;
    try { body = await response.json(); } catch { throw new Error('Sunucudan anlaşılır bir yanıt alınamadı.'); }
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'İşlem tamamlanamadı. Tekrar dene.');
    return body;
  }

  async function repoRequest(method, data) {
    const options = method === 'GET' ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
    const response = await fetch('/api/depo-laboratuvar', options);
    let body;
    try { body = await response.json(); } catch { throw new Error('Sunucudan geçerli JSON yanıtı alınamadı.'); }
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Depo işlemi tamamlanamadı.');
    return body;
  }

  function downloadJsonFile(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderSaved() {
    ui.saved.replaceChildren();
    if (savedWarning) {
      const warning = element('p', savedWarning);
      warning.setAttribute('role', 'status');
      ui.saved.append(warning);
    }
    const merged = [
      ...repoSaved.map((r) => ({ ...r, _kind: 'repo' })),
      ...presetSaved.map((p) => ({ ...p, _kind: 'preset' })),
    ].sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));

    if (!merged.length) {
      if (!savedWarning) ui.saved.append(element('p', 'Henüz kayıt yok.'));
      return;
    }
    const list = element('ul', null, 'lab-saved-list');
    for (const item of merged) {
      const row = element('li');
      const titleSpan = element('span', shown(item.name, 'İsimsiz kayıt'));
      let metaParts;
      if (item._kind === 'repo') {
        metaParts = [
          'GitHub Deposu: ' + shown(item.repository, ''),
          item.commitSha ? 'sürüm ' + item.commitSha.slice(0, 8) : '',
          typeof item.runCount === 'number' ? item.runCount + ' deneme' : '',
          item.savedAt ? new Date(item.savedAt).toLocaleString('tr-TR') : '',
        ];
      } else {
        const sample = samples.find((entry) => entry.id === item.sampleId);
        metaParts = [
          'Hazır Örnek: ' + shown(sample?.title, item.sampleId),
          item.savedAt ? new Date(item.savedAt).toLocaleString('tr-TR') : '',
        ];
      }
      const meta = element('small', metaParts.filter(Boolean).join(' · '));
      const label = element('div');
      label.append(titleSpan, meta);

      const actionWrap = element('div', null, 'lab-saved-actions');
      const openBtn = element('button', 'Aç', 'lab-secondary');
      openBtn.type = 'button';
      openBtn.disabled = busy;
      openBtn.setAttribute('aria-label', shown(item.name, 'İsimsiz kayıt') + ' kaydını aç');
      if (item._kind === 'repo') {
        openBtn.addEventListener('click', () =>
          repoAct('open', { recordId: item.id }, 'Kayıtlı GitHub depo incelemesi açıldı.', 'repo-step2-title')
        );
        const exportBtn = element('button', 'Rapor (JSON)', 'lab-secondary lab-btn-quiet');
        exportBtn.type = 'button';
        exportBtn.disabled = busy;
        exportBtn.addEventListener('click', () => exportSavedOrActiveReport({ recordId: item.id }));

        const delBtn = element('button', 'Sil', 'lab-secondary lab-btn-danger-quiet');
        delBtn.type = 'button';
        delBtn.disabled = busy;
        delBtn.setAttribute('aria-label', shown(item.name, 'İsimsiz kayıt') + ' kaydını sil');
        delBtn.addEventListener('click', () => deleteRepoSavedRecord(item.id));

        actionWrap.append(openBtn, exportBtn, delBtn);
      } else {
        openBtn.addEventListener('click', () => {
          const drawer = $('preset-lab-drawer');
          if (drawer) drawer.open = true;
          act('open', { id: item.id }, 'Kayıt açıldı. Çalışmana devam edebilirsin.', 'lab-source-title');
        });
        actionWrap.append(openBtn);
      }
      row.append(label, actionWrap);
      list.append(row);
    }
    ui.saved.append(list);
  }

  async function exportSavedOrActiveReport(target) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await repoRequest('POST', { action: 'exportReport', ...target });
      if (res.report) {
        const slug = String(res.report.repository || 'depo').replace(/[^A-Za-z0-9._-]+/g, '-');
        downloadJsonFile(`urun-tani-kanit-${slug}-${(res.report.commitSha || '').slice(0, 8)}.json`, res.report);
        repoSay('Gizli bilgilerden arındırılmış kanıt özeti (JSON) indirildi.');
      }
    } catch (err) {
      repoSay('Rapor dışa aktarılamadı: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteRepoSavedRecord(recordId) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await repoRequest('POST', { action: 'deleteRecord', recordId });
      if (Array.isArray(res.saved)) repoSaved = res.saved;
      renderSaved();
      repoSay('Kayıt silindi.');
    } catch (err) {
      repoSay('Kayıt silinemedi: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /* ======================== GitHub Repository Lab Rendering ======================== */

  function selectedRepoJob() {
    if (!repoState || !Array.isArray(repoState.jobs)) return null;
    return repoState.jobs.find((j) => j.id === repoState.selectedJobId) || repoState.jobs[0] || null;
  }

  function renderSlotRunBox(container, run, workspaceClean) {
    container.replaceChildren();
    container.hidden = !run;
    if (!run) return;
    const exp = run.explanation || {};
    const badgeRow = element('div', null, 'repo-badge-row');
    const statusBadge = element(
      'span',
      run.exitCode === 0
        ? `Gerçek süreç çıktısı (çıkış kodu: 0, ${run.durationMs} ms)`
        : `Süreç uyarı/çıkış koduyla tamamlandı (kod: ${run.exitCode}, ${run.durationMs} ms)`,
      'repo-badge ' + (run.exitCode === 0 ? 'badge-verified' : 'badge-example')
    );
    badgeRow.append(statusBadge);
    if (run._archivedInReset) {
      badgeRow.append(element('span', `${run._archivedInReset}. sıfırlama öncesi korunan kanıt`, 'repo-badge'));
    } else if (run.retryOf) {
      badgeRow.append(element('span', 'Temiz ortam tekrarı', 'repo-badge badge-verified'));
    }
    container.append(badgeRow);

    const givenP = element('p');
    const flagPart = Array.isArray(run.extraFlags) && run.extraFlags.length ? ` · seçenekler: ${run.extraFlags.join(' ')}` : '';
    givenP.append(element('strong', 'Ne verdim? '), element('span', `${run.inputFileName} (${run.inputText.length} karakter${flagPart})`));
    container.append(givenP);

    if (run.prediction) {
      const predP = element('p', `Önceki tahminin: "${run.prediction}"`, 'repo-prediction-echo');
      container.append(predP);
    }

    const outLabel = element('p');
    outLabel.append(element('strong', 'Ne çıktı?'));
    const pre = element('pre', shown(exp.output, '(Boş çıktı)'));
    container.append(outLabel, pre);

    if (Array.isArray(exp.fileChanges) && exp.fileChanges.length > 0) {
      const fsBox = element('div', null, 'repo-fs-diff-note');
      const fsSummary = exp.fileChanges.map((f) => `${f.path} (${f.kind}, ${f.bytes} bayt)`).join(', ');
      fsBox.append(element('strong', 'Deney klasörü dosya etkisi: '), element('span', fsSummary));
      container.append(fsBox);
    }

    const useP = element('p', 'Nerede kullanılır? ' + shown(exp.whereUsed), 'lab-muted');
    container.append(useP);
    if (workspaceClean && run._archivedInReset) {
      container.append(element('p', 'Not: Çalışma alanı sıfırlandı; bu kartta sıfırlama öncesi saklanan gerçek koşu kanıtı gösteriliyor.', 'lab-muted'));
    }
  }

  function renderConsumerProof(job, latestRuns) {
    const relevant = latestRuns.filter((r) => r.jobId === job?.id);
    if (!job || !relevant.length) {
      rui.consumerProof.hidden = true;
      return;
    }
    const latest = relevant.at(-1);
    const trace = latest.trace || {};
    const exp = latest.explanation || {};
    const isMismatch = trace.status === 'mismatch_or_stale';
    const isVerified = trace.status === 'verified_natural_consumer';

    rui.consumerProof.hidden = false;
    rui.consumerProof.dataset.mismatch = String(isMismatch);
    rui.consumerProofBody.replaceChildren();

    const badge = element(
      'span',
      shown(exp.consumerBadge, trace.status),
      'repo-badge ' + (isVerified ? 'badge-verified' : (isMismatch ? 'badge-warn' : 'badge-example'))
    );
    const verdict = element('p', shown(exp.consumerVerdict));
    rui.consumerProofBody.append(badge, verdict);

    if (trace.producerReturn || trace.consumerReceived) {
      const grid = element('div', null, 'repo-proof-grid');
      const prodBox = element('div', null, 'repo-proof-box');
      prodBox.append(
        element('strong', `Üretici dönüşü (${job.flowSpec?.producer?.module}.${job.flowSpec?.producer?.qualname})`),
        element('code', `Koşu (runId): ${latest.runId}`),
        element('code', `Nesne kimliği (objectId): ${trace.producerReturn?.objectId ?? 'yok'} · Tür: ${trace.producerReturn?.type ?? '-'}`),
        element('code', `Değer SHA-256: ${trace.producerReturn?.sha256 ?? 'yok'}`),
        element('code', `Önizleme: ${trace.producerReturn?.preview ?? ''}`)
      );
      const consBox = element('div', null, 'repo-proof-box');
      consBox.append(
        element('strong', job.isNaturalRepoConsumer
          ? `Doğal tüketici girişi (${job.flowSpec?.consumer?.module}.${job.flowSpec?.consumer?.qualname})`
          : `Çıktı akışı (${job.flowSpec?.consumer?.qualname})`),
        element('code', `Koşu (runId): ${latest.runId}`),
        element('code', trace.consumerReceived
          ? `Alınan parametre (${trace.matchedArgName}): objectId=${trace.consumerReceived.objectId} · Tür=${trace.consumerReceived.type}`
          : 'Ayrı iç tüketici çağrısı yok (doğrudan standart çıktı)'),
        element('code', trace.consumerReceived
          ? `Alınan SHA-256: ${trace.consumerReceived.sha256}`
          : `Standart çıktı eşleşmesi: ${trace.sinkMatchesStdout ? 'EVET' : 'HAYIR'}`),
        element('code', trace.consumerReceived
          ? `Kimlik eşleşmesi: ${trace.identityMatch ? 'DOĞRULANDI' : 'EŞLEŞMEDİ'} · Değer eşleşmesi: ${trace.valueMatch ? 'DOĞRULANDI' : 'EŞLEŞMEDİ'}`
          : '')
      );
      grid.append(prodBox, consBox);
      rui.consumerProofBody.append(grid);
    }
  }

  function renderAbDiff(ab) {
    rui.abDiff.hidden = !ab;
    rui.abDiffBody.replaceChildren();
    if (!ab) return;
    rui.abDiffBody.append(
      element('p', ab.changedSummary),
      element('p', 'Bu ne işe yarar ve nerede kullanılır? ' + shown(ab.purposeAndUsage), 'lab-muted')
    );
    const grid = element('div', null, 'repo-example-grid');
    const colA = element('div');
    colA.append(element('strong', `A çıktısı (çıkış kodu: ${ab.exitCodeA ?? 0})`), element('pre', shown(ab.outputA, '(Boş çıktı)')));
    const colB = element('div');
    colB.append(element('strong', `B çıktısı (çıkış kodu: ${ab.exitCodeB ?? 0})`), element('pre', shown(ab.outputB, '(Boş çıktı)')));
    grid.append(colA, colB);
    rui.abDiffBody.append(grid);
  }

  function renderTechProof(runs) {
    rui.techProof.hidden = !runs.length;
    rui.techProofBody.replaceChildren();
    if (!runs.length) return;
    const latest = runs.at(-1);
    const lines = [
      `Depo ve sabit sürüm (commit SHA): ${repoState.repository} @ ${repoState.commitSha}`,
      `İncelenen arşiv SHA-256: ${repoState.archiveSha256 || 'yerel/test'}`,
      `Çalıştırılan kaynak kanıtı SHA-256: ${latest.sourceEvidenceSha256}`,
      `Yalıtım motoru: ${latest.sandboxSpec?.engine || 'WSL2 + Bubblewrap'} (Python ${latest.boundary?.pythonVersion || '3.14'})`,
      `Ağ ve soket engeli: ${latest.sandboxSpec?.network || ''} · Engellenen aileler: ${(latest.boundary?.blockedSockets || []).join(', ')}`,
      `Komut (güvenli argv gösterimi): ${JSON.stringify(latest.argv)}`,
      `Çıkış durumu: ${latest.exitCode} · Süre: ${latest.durationMs} ms · Çıktı SHA-256: ${latest.stdoutSha256}`,
      `Doğrulanan bağımlılık tekerlekleri (.whl): ${(latest.verifiedWheels || []).length ? latest.verifiedWheels.map((w) => `${w.filename} (${w.sha256.slice(0, 12)}…)`).join(', ') : 'Yok (yalnız standart kütüphane)'}`,
      `Geçici deney alanı (/work/deney) dosya farkı: oluşturulan=${latest.fsDiff?.created?.length || 0}, değişen=${latest.fsDiff?.modified?.length || 0}, silinen=${latest.fsDiff?.deleted?.length || 0}`,
    ];
    rui.techProofBody.append(element('pre', lines.join('\n')));
  }

  function renderDiscoveredFlagChips(job) {
    if (!rui.discoveredFlags) return;
    rui.discoveredFlags.replaceChildren();
    const options = job?.trialDefaults?.availableOptions || job?.flowSpec?.invocation?.options || [];
    if (!options.length) {
      rui.discoveredFlags.append(element('span', 'Ek komut bayrağı bildirilmedi.', 'lab-muted'));
      return;
    }
    rui.discoveredFlags.append(element('small', 'Kaynakta keşfedilen seçenekler (tıklayıp ekleyebilirsin): ', 'lab-muted'));
    for (const opt of options.slice(0, 8)) {
      const flag = opt.flags?.[0];
      if (!flag) continue;
      const chip = element('button', opt.takesValue ? `${flag} <değer>` : flag, 'repo-flag-chip');
      chip.type = 'button';
      if (opt.help) chip.title = opt.help;
      chip.addEventListener('click', () => {
        if (busy || !rui.extraFlags) return;
        const token = opt.choices?.length ? `${flag} ${opt.choices[0]}` : (opt.takesValue ? `${flag} ` : flag);
        const cur = rui.extraFlags.value.trim();
        if (!cur.includes(flag)) {
          rui.extraFlags.value = (cur ? cur + ' ' : '') + token;
        }
        rui.extraFlags.focus();
      });
      rui.discoveredFlags.append(chip);
    }
  }

  function renderRepoState(preserveTextareas = false) {
    if (!repoState) {
      rui.step2.hidden = true;
      rui.step34.hidden = true;
      rui.step5.hidden = true;
      return;
    }

    rui.url.value = repoState.url || rui.url.value;
    rui.intent.value = repoState.intent || rui.intent.value;

    // Step 2: Snapshot + Intent Alignment + Overview + Limitations + Jobs
    rui.step2.hidden = false;
    rui.snapshotBar.replaceChildren(
      element('span', `Depo: ${repoState.repository}`, 'repo-snapshot-chip'),
      element('span', `Dal: ${repoState.branch}`, 'repo-snapshot-chip'),
      element('span', `Sabit sürüm: ${repoState.commitSha.slice(0, 12)}`, 'repo-snapshot-chip'),
      element('span', `Okunan dosya: ${repoState.readFileCount} / ${repoState.totalEntryCount}`, 'repo-snapshot-chip')
    );

    const ov = repoState.overview || {};
    if (rui.intentFit) {
      if (ov.intentFit) {
        rui.intentFit.hidden = false;
        rui.intentFit.dataset.level = ov.intentFit.verdict || ov.intentFit.level || 'genel_inceleme';
        const cleanExp = String(ov.intentFit.explanation || '').replace(/\*\*/g, '');
        rui.intentFit.replaceChildren(
          element('strong', `Amacınla uyum: ${ov.intentFit.badge} — `),
          element('span', cleanExp)
        );
      } else {
        rui.intentFit.hidden = true;
      }
    }

    const sup = repoState.supportInfo || {};
    rui.supportAlert.hidden = false;
    rui.supportAlert.dataset.supported = String(Boolean(repoState.supported));
    rui.supportAlert.replaceChildren(
      element('strong', repoState.supported ? 'Canlı yalıtılmış denemeye uygun: ' : 'Canlı deneme sınırı / engel nedeni: '),
      element('span', shown(sup.reason, '') + (sup.nextStep ? ' Sonraki adım: ' + sup.nextStep : ''))
    );

    rui.whoWhat.textContent = shown(ov.whoAndWhat);
    rui.intentNote.textContent = shown(String(ov.intentConnection || '').replace(/\*\*/g, ''), '');
    rui.modelNote.textContent = shown(ov.modelStatus, '');

    // Honest coverage & static limitations box
    if (rui.limitationsBox && rui.limitationsList) {
      const lims = [...(repoState.limitations || [])];
      const unreadCount = Math.max(0, (repoState.totalEntryCount || 0) - (repoState.readFileCount || 0));
      if (unreadCount > 0) {
        lims.unshift(`Arşivdeki ${repoState.totalEntryCount} girdiden ${repoState.readFileCount} metin/kod dosyası okundu; ikili veya sınır dışı ${unreadCount} girdi kapsam dışı bırakıldı.`);
      }
      rui.limitationsBox.hidden = !lims.length;
      if (rui.limitationsSummary) {
        rui.limitationsSummary.textContent = `İnceleme sınırı ve kapsam notları (${lims.length} madde — okunan ${repoState.readFileCount}/${repoState.totalEntryCount})`;
      }
      rui.limitationsList.replaceChildren(...lims.map((item) => element('li', item)));
    }

    if (ov.examplePreview) {
      rui.exampleBox.hidden = false;
      rui.exampleBadge.textContent = ov.examplePreview.badge;
      rui.exampleIn.textContent = ov.examplePreview.given;
      rui.exampleOut.textContent = ov.examplePreview.expectedKind;
      rui.exampleNote.textContent = ov.examplePreview.note;
    } else {
      rui.exampleBox.hidden = true;
    }

    const jobs = repoState.jobs || [];
    const currentJob = selectedRepoJob();
    const combinedRuns = allRunsChronological(repoState);

    rui.jobsWrap.hidden = !jobs.length;
    rui.jobsList.replaceChildren();
    for (const j of jobs) {
      const btn = element('button', null, 'repo-job-btn');
      btn.type = 'button';
      const active = currentJob && j.id === currentJob.id;
      btn.setAttribute('aria-pressed', String(Boolean(active)));
      btn.append(
        element('span', j.title),
        element('small', j.isNaturalRepoConsumer ? 'Doğal iç tüketici adımı var' : 'Standart çıktı / statik bulgu')
      );
      btn.addEventListener('click', () => {
        if (!active) repoAct('selectJob', { jobId: j.id }, 'Seçilen iş güncellendi.', 'repo-job-title');
      });
      rui.jobsList.append(btn);
    }

    if (currentJob) {
      rui.jobDetail.hidden = false;
      rui.jobOrigin.textContent = shown(currentJob.originLabel, 'Kaynakta görülen');
      const hasVerifiedRun = combinedRuns.some(
        (r) => r.jobId === currentJob.id && r.trace?.status === 'verified_natural_consumer'
      );
      rui.jobConsumerKind.textContent = hasVerifiedRun
        ? 'Bu denemede doğrulandı (aynı koşuda kimlik ve değer eşleşti)'
        : (currentJob.isNaturalRepoConsumer ? 'Doğal depo içi tüketici (denemede doğrulanmaya hazır)' : 'Yalnız çıktı yazıcı');
      rui.jobConsumerKind.className = 'repo-badge ' + (hasVerifiedRun ? 'badge-verified' : '');

      rui.jobTitle.textContent = currentJob.title;
      rui.jobSummary.textContent = currentJob.summary;
      rui.jobTrigger.textContent = currentJob.trigger;
      rui.jobInput.textContent = currentJob.input;
      rui.jobOutput.textContent = currentJob.output;
      rui.jobConsumer.textContent = currentJob.consumer;

      rui.flowBoxes.replaceChildren();
      for (const box of currentJob.boxes || []) {
        const li = element('li');
        const badgeText = box.role === 'consumer' && hasVerifiedRun ? 'Bu denemede doğrulandı' : box.originBadge;
        li.append(
          element('span', badgeText, 'repo-badge ' + (box.role === 'consumer' && hasVerifiedRun ? 'badge-verified' : '')),
          element('strong', `${box.step}. ${box.title}`),
          element('p', box.detail)
        );
        rui.flowBoxes.append(li);
      }

      rui.evidenceList.replaceChildren();
      for (const ev of currentJob.evidence || []) {
        const li = element('li');
        li.append(
          element('strong', `${ev.label} `),
          element('code', `${ev.path}:${ev.line}`),
          ev.quote ? element('div', `Kod satırı: ${ev.quote}`, 'lab-muted') : ''
        );
        rui.evidenceList.append(li);
      }
    } else {
      rui.jobDetail.hidden = true;
    }

    // Steps 3 & 4: Verification & A/B Trial
    const hasPastEvidence = combinedRuns.length > 0 || (repoState.cleanReruns?.length > 0);
    rui.step34.hidden = !repoState.supported && !hasPastEvidence;
    rui.step5.hidden = !repoState.supported && !hasPastEvidence;

    if (!rui.step34.hidden) {
      const approved = Boolean(repoState.permission?.granted && repoState.permission?.approvedJobId === currentJob?.id);
      rui.approveBtn.hidden = approved || !repoState.supported;
      if (repoState.dependencyPrep) {
        rui.depStatus.textContent = `Bağımlılık durumu: ${repoState.dependencyPrep.summary}`;
      } else {
        const deps = repoState.pythonMeta?.dependencies || [];
        rui.depStatus.textContent = deps.length
          ? `Bildirilen paket bağımlılıkları (${deps.length}): ${deps.slice(0, 5).join(', ')} (onaylandığında yalnız ikili .whl özetleri doğrulanır).`
          : 'Ek dış paket bağımlılığı yok; yalnızca standart Python kütüphanesi kullanılır.';
      }

      const showTrialControls = approved || combinedRuns.length > 0;
      rui.abControls.hidden = !showTrialControls;
      if (rui.trialTuning) {
        rui.trialTuning.hidden = !approved;
        renderDiscoveredFlagChips(currentJob);
      }
      if (!preserveTextareas) {
        rui.inputA.value = repoState.draftInputs?.A ?? '';
        rui.inputB.value = repoState.draftInputs?.B ?? '';
        if (rui.extraFlags) {
          rui.extraFlags.value = (repoState.draftFlags || []).join(' ');
        }
      }

      // Resolve latest A and latest B across active runs first, falling back to archived runs when reset/reopened!
      const activeRuns = (repoState.runs || []).map((r) => ({ ...r, _archivedInReset: 0 }));
      const latestA =
        [...activeRuns].reverse().find((r) => r.slot === 'A' && r.jobId === currentJob?.id) ||
        [...combinedRuns].reverse().find((r) => r.slot === 'A' && r.jobId === currentJob?.id);
      const latestB =
        [...activeRuns].reverse().find((r) => r.slot === 'B' && r.jobId === currentJob?.id) ||
        [...combinedRuns].reverse().find((r) => r.slot === 'B' && r.jobId === currentJob?.id);

      renderSlotRunBox(rui.resultA, latestA, repoState.workspaceClean);
      renderSlotRunBox(rui.resultB, latestB, repoState.workspaceClean);

      renderConsumerProof(currentJob, combinedRuns);
      const abToRender =
        repoState.abComparison ||
        [...(repoState.archivedRuns || [])].reverse().find((g) => g.preservedAbComparison)?.preservedAbComparison ||
        null;
      renderAbDiff(abToRender);
      renderTechProof(combinedRuns);
    }

    // Step 5: Reset, Clean Rerun, Archived Evidence & Save
    if (!rui.step5.hidden) {
      rui.resetNote.textContent = `Sıfırlama sayısı: ${repoState.resetCount || 0} · Toplam koşu: ${combinedRuns.length} · Durum: ${repoState.workspaceClean ? 'Temiz çalışma alanı' : 'Deneme yapıldı (sıfırlanabilir)'}. Kaynak kod, gerçek dosyaların ve önceki deney kanıtları korunur.`;

      const cleanList = repoState.cleanReruns || [];
      rui.cleanRerunBox.hidden = !cleanList.length;
      rui.cleanRerunBox.replaceChildren();
      if (cleanList.length) {
        const lastCr = cleanList.at(-1);
        rui.cleanRerunBox.append(
          element('span', lastCr.consistent ? 'Tutarlılık doğrulandı' : 'Fark saptandı', 'repo-badge ' + (lastCr.consistent ? 'badge-verified' : 'badge-warn')),
          element('p', lastCr.summary)
        );
      }

      const arch = repoState.archivedRuns || [];
      rui.archivedRuns.hidden = !arch.length;
      rui.archivedRunsBody.replaceChildren();
      for (const group of arch) {
        const p = element('p', `${group.resetNumber}. sıfırlama öncesi korunan koşular (${group.preservedRuns?.length || 0} adet, ${new Date(group.resetAt).toLocaleTimeString('tr-TR')}): ` +
          (group.preservedRuns || []).map((r) => `${r.slot} koşusu (${r.runId.slice(0, 8)}, çıkış=${r.exitCode}, çıktı özeti=${r.stdoutSha256.slice(0, 10)}…)`).join(' · '));
        rui.archivedRunsBody.append(p);
      }
    }
  }

  async function repoAct(action, extra = {}, successMsg = '', focusId = '') {
    if (busy) return;
    const preserveInputs = ['run', 'save', 'cleanRerun'].includes(action);
    const savedDraftA = rui.inputA?.value;
    const savedDraftB = rui.inputB?.value;
    const savedFlags = rui.extraFlags?.value;
    const savedPred = rui.prediction?.value;

    setBusy(true);
    repoSay('İşlem yürütülüyor…');
    try {
      const payload = { action, ...extra };
      if (repoState && !['inspect', 'open'].includes(action)) {
        payload.id = repoState.id;
        payload.revision = repoState.revision;
      }
      const res = await repoRequest('POST', payload);
      if (res.state) repoState = res.state;
      if (Array.isArray(res.saved)) repoSaved = res.saved;
      renderRepoState(preserveInputs);
      if (preserveInputs && repoState && action !== 'reset') {
        if (savedDraftA !== undefined) rui.inputA.value = savedDraftA;
        if (savedDraftB !== undefined) rui.inputB.value = savedDraftB;
        if (savedFlags !== undefined && rui.extraFlags) rui.extraFlags.value = savedFlags;
        if (savedPred !== undefined && rui.prediction) rui.prediction.value = savedPred;
      }
      renderSaved();
      repoSay(successMsg);
      if (focusId) $(focusId)?.focus();
    } catch (err) {
      repoSay('İşlem tamamlanamadı: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  rui.form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    repoAct(
      'inspect',
      { url: rui.url.value.trim(), intent: rui.intent.value.trim() },
      'Depo incelendi. Amacına uygunluğu, iş akışını ve kapsam sınırlarını aşağıda görebilirsin.',
      'repo-step2-title'
    );
  });

  rui.approveBtn?.addEventListener('click', () => {
    const job = selectedRepoJob();
    if (!repoState || !job) return;
    repoAct(
      'prepareAndApprove',
      { expectedCommitSha: repoState.commitSha, expectedJobId: job.id },
      'Yalıtım ve bağımlılık doğrulaması tamamlandı. Şimdi A ve B girdilerini çalıştırabilirsin.',
      'repo-input-a'
    );
  });

  rui.runA?.addEventListener('click', () => {
    const job = selectedRepoJob();
    if (!job) return;
    repoAct(
      'run',
      {
        slot: 'A',
        inputText: rui.inputA.value,
        expectedJobId: job.id,
        extraFlags: rui.extraFlags?.value || '',
        prediction: rui.prediction?.value || '',
      },
      'A girdisi kapalı ağ WSL2 + Bubblewrap yalıtımında çalıştırıldı.',
      'repo-consumer-proof-title'
    );
  });

  rui.runB?.addEventListener('click', () => {
    const job = selectedRepoJob();
    if (!job) return;
    repoAct(
      'run',
      {
        slot: 'B',
        inputText: rui.inputB.value,
        expectedJobId: job.id,
        extraFlags: rui.extraFlags?.value || '',
        prediction: rui.prediction?.value || '',
      },
      'B girdisi çalıştırıldı; A/B fark özeti ve doğal tüketici doğrulaması güncellendi.',
      'repo-ab-diff-title'
    );
  });

  rui.resetBtn?.addEventListener('click', () => {
    repoAct(
      'reset',
      {},
      'Deney çalışma alanı sıfırlandı; önceki deney kanıtları ve kaynak korundu.',
      'repo-step5-title'
    );
  });

  rui.cleanRerunBtn?.addEventListener('click', () => {
    if (!repoState) return;
    const candidateRuns = allRunsChronological(repoState);
    const target = candidateRuns.at(-1);
    if (!target) {
      repoSay('Tekrar çalıştırılacak bir önceki deneme bulunamadı.', 'error');
      return;
    }
    repoAct(
      'cleanRerun',
      { runId: target.runId },
      'Seçilen girdi temiz ortamda tekrar çalıştırıldı ve önceki sonuçla karşılaştırıldı.'
    );
  });

  rui.exportBtn?.addEventListener('click', () => {
    if (!repoState) return;
    exportSavedOrActiveReport({ id: repoState.id });
  });

  rui.saveBtn?.addEventListener('click', () => {
    repoAct(
      'save',
      { name: rui.saveName.value.trim() },
      'Depo incelemesi ve deneme kanıtları diske kaydedildi. Normal yeniden açılışta Kayıtlar bölümünden açılabilir.'
    );
  });

  /* ======================== Existing Preset Sample Lab ======================== */

  function sampleDescription() {
    const selected = samples.find((item) => String(item.id) === ui.sample.value);
    ui['sample-description'].textContent = selected ? shown(selected.description, '') : '';
  }

  function renderSamples() {
    const chosen = ui.sample.value;
    ui.sample.replaceChildren();
    if (!samples.length) ui.sample.append(element('option', 'Henüz örnek yok'));
    for (const item of samples) {
      const option = element('option', item.title);
      option.value = item.id;
      ui.sample.append(option);
    }
    if (samples.some((item) => String(item.id) === chosen)) ui.sample.value = chosen;
    sampleDescription();
  }

  function renderInput() {
    ui.input.replaceChildren();
    const initial = state.input && typeof state.input === 'object' ? state.input : state.preview.defaultInput || {};
    if (Object.prototype.hasOwnProperty.call(state.preview.defaultInput || {}, 'codexDetected')) {
      const label = element('label', 'Örnek ortamda Codex var mı?');
      label.htmlFor = 'lab-codex';
      const select = element('select');
      select.id = 'lab-codex';
      select.name = 'codexDetected';
      for (const [value, title] of [['false', 'Hayır, bulunamadı'], ['true', 'Evet, bulundu']]) {
        const option = element('option', title);
        option.value = value;
        select.append(option);
      }
      select.value = String(Boolean(initial.codexDetected));
      ui.input.append(label, select, element('p', 'Bu bir örnek ortamdır; bilgisayarın taranmaz.'));
    } else if (Object.prototype.hasOwnProperty.call(state.preview.defaultInput || {}, 'query')) {
      const label = element('label', 'Aramak istediğin metin');
      label.htmlFor = 'lab-query';
      const input = element('input');
      input.id = 'lab-query';
      input.name = 'query';
      input.type = 'text';
      input.maxLength = 120;
      input.value = typeof initial.query === 'string' ? initial.query : '';
      input.required = true;
      ui.input.append(label, input);
    } else {
      ui.input.append(element('p', 'Bu örnek için kullanılabilir bir deneme girdisi bulunamadı.'));
      ui.run.disabled = true;
    }
  }

  function describeInput(input) {
    if (!input || typeof input !== 'object') return 'Girdi bilgisi yok.';
    if (typeof input.codexDetected === 'boolean') return 'Verdiğin örnek: Codex ' + (input.codexDetected ? 'bulundu.' : 'bulunamadı.');
    if (typeof input.query === 'string') return 'Aradığın metin: ' + input.query;
    return 'Girdi bilgisi görüntülenemedi.';
  }

  function renderResult() {
    const run = (state.runs || []).find((item) => item.id === state.selectedRunId);
    ui.result.hidden = !run;
    if (!run) return;
    const result = run.result || {};
    ui.given.textContent = describeInput(run.input);
    ui.summary.textContent = shown(result.summary, 'Sonuç açıklaması yok.');
    ui.details.replaceChildren(...(Array.isArray(result.details) ? result.details.map((detail) => element('li', detail)) : []));
    ui.usage.textContent = result.usage ? 'Bu sonuç nerede kullanılır? ' + result.usage : 'Sonucun nerede kullanıldığı belirtilmedi.';
    ui['result-mode'].textContent = result.mode === 'synthetic' ? 'Bu sonuç örnek verilerle üretilmiştir.' : (result.mode ? 'Deneme türü: ' + result.mode : '');
  }

  function renderHistory() {
    ui.history.replaceChildren();
    const runs = state.runs || [];
    if (!runs.length) {
      ui.history.append(element('p', 'Henüz deneme yapılmadı.'));
      return;
    }
    const list = element('ol');
    for (const [index, run] of runs.entries()) {
      const item = element('li');
      const description = element('span', (index + 1) + '. deneme — ' + describeInput(run.input));
      const button = element('button', 'Yeniden dene', 'lab-secondary');
      button.type = 'button';
      button.disabled = busy;
      button.setAttribute('aria-label', (index + 1) + '. denemeyi aynı girdiyle yeniden dene');
      button.addEventListener('click', () => act('rerun', { payload: { runId: run.id } }, 'Aynı girdiyle yeniden denendi.', 'lab-result-title'));
      item.append(description, button);
      list.append(item);
    }
    ui.history.append(list);
  }

  function renderState() {
    const preview = state?.preview;
    ui.preview.hidden = !preview;
    ui.ready.hidden = state?.phase !== 'ready' || !preview;
    if (!preview) return;
    ui['source-title'].textContent = shown(preview.title);
    ui.overview.textContent = shown(preview.overview);
    ui.scope.textContent = shown(preview.scope, 'Kapsam bilgisi sunulmadı.');
    ui.confirm.hidden = state.phase === 'ready';
    if (state.phase !== 'ready') return;
    ui['module-title'].textContent = shown(preview.module?.title, 'İş bilgisi yok');
    ui['module-description'].textContent = shown(preview.module?.description);
    ui.flow.replaceChildren(...(Array.isArray(preview.flow) ? preview.flow.map((step) => {
      const li = element('li');
      li.append(element('strong', shown(step.title)), element('p', shown(step.detail, '')));
      return li;
    }) : []));
    ui.evidence.replaceChildren(...(Array.isArray(preview.evidence) ? preview.evidence.map((entry) => {
      const li = element('li');
      li.append(element('strong', shown(entry.title)), element('p', shown(entry.description, '')), element('small', shown(entry.ref, '')));
      return li;
    }) : []));
    renderInput();
    renderResult();
    renderHistory();
  }

  async function act(action, extra = {}, success = '', focusId) {
    if (busy) return;
    if (!['preview', 'open'].includes(action) && (!state || String(state.sampleId) !== ui.sample.value)) {
      say('Seçtiğin kaynağı incele.');
      return;
    }
    const keepDraft = ['rerun', 'save'].includes(action);
    const oldStateId = state?.id;
    const draftInput = keepDraft ? ($('lab-codex') || $('lab-query')) : null;
    const draft = draftInput ? { id: draftInput.id, value: draftInput.value } : null;
    setBusy(true);
    say('İşlem sürüyor…');
    try {
      const data = { action, ...extra };
      if (state && !['preview', 'open'].includes(action)) {
        data.id = state.id;
        data.revision = state.revision;
      }
      const response = await request('POST', data);
      if (!response.state) throw new Error('İşlem yanıtında çalışma bilgisi bulunamadı.');
      state = response.state;
      if (Array.isArray(response.saved)) {
        presetSaved = response.saved;
        savedWarning = typeof response.savedWarning === 'string' ? response.savedWarning : '';
      }
      if (action === 'save' && !Array.isArray(response.saved)) {
        const refreshed = await request('GET');
        presetSaved = refreshed.saved || [];
        savedWarning = typeof refreshed.savedWarning === 'string' ? refreshed.savedWarning : '';
      }
      if (state.sampleId && samples.some((item) => item.id === state.sampleId)) {
        ui.sample.value = state.sampleId;
        sampleDescription();
      }
      renderState();
      if (draft && state.id === oldStateId && $(draft.id)) $(draft.id).value = draft.value;
      renderSaved();
      say(success);
      if (focusId) $(focusId)?.focus();
    } catch (error) {
      say('İşlem yapılamadı: ' + error.message + ' Tekrar deneyebilirsin.');
    } finally {
      setBusy(false);
    }
  }

  ui.sample.addEventListener('change', () => {
    sampleDescription();
    if (!state) {
      say('Seçtiğin kaynağı incele.');
      return;
    }
    if (String(state.sampleId) !== ui.sample.value) {
      if (state.phase === 'preview') state = null;
      ui.preview.hidden = true;
      ui.ready.hidden = true;
      say('Seçtiğin kaynağı incele.');
    } else {
      ui.preview.hidden = false;
      ui.ready.hidden = state.phase !== 'ready';
      say('Hazır çalışmana devam edebilirsin.');
    }
  });
  ui.inspect.addEventListener('click', () => act('preview', { sampleId: ui.sample.value }, 'Kaynak incelendi. Devam etmek için kapsamı okuyup onayla.', 'lab-source-title'));
  ui.confirm.addEventListener('click', () => act('confirm', {}, 'Kaynak onaylandı. Şimdi işi deneyebilirsin.', 'lab-module-title'));
  ui['run-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    const codex = $('lab-codex');
    const query = $('lab-query');
    if (!codex && !query) return;
    const payload = codex ? { codexDetected: codex.value === 'true' } : { query: query.value };
    act('run', { payload }, 'Deneme tamamlandı.', 'lab-result-title');
  });
  ui.reset.addEventListener('click', () => act('reset', {}, 'Çalışma başa döndü. Kaydettiğin kayıtlar korunuyor.', 'lab-source-title'));
  ui.save.addEventListener('click', () => act('save', { payload: ui['save-name'].value.trim() ? { name: ui['save-name'].value.trim() } : {} }, 'Çalışma kaydedildi. Kayıtlar bölümünden tekrar açabilirsin.'));

  async function load() {
    setBusy(true);
    try {
      const [presetData, repoData] = await Promise.all([
        request('GET'),
        repoRequest('GET').catch(() => ({ saved: [] })),
      ]);
      samples = Array.isArray(presetData.samples) ? presetData.samples : [];
      presetSaved = Array.isArray(presetData.saved) ? presetData.saved : [];
      repoSaved = Array.isArray(repoData.saved) ? repoData.saved : [];
      savedWarning = typeof presetData.savedWarning === 'string' ? presetData.savedWarning : '';
      renderSamples();
      renderSaved();
      say(samples.length ? '' : 'Henüz incelenecek örnek yok.');
    } catch (error) {
      if (error.status === 404) {
        document.body.dataset.laboratuvar = 'unavailable';
      } else {
        ui.sample.replaceChildren(element('option', 'Örnekler yüklenemedi'));
        ui.saved.textContent = 'Kayıtlar yüklenemedi.';
        say('Laboratuvara ulaşılamadı: ' + error.message + ' Sayfayı yenileyerek tekrar deneyebilirsin.');
      }
    } finally {
      setBusy(false);
    }
  }
  load();
})();
