(() => {
  'use strict';

  const find = (key) => document.getElementById('gate-flow' + (key ? '-' + key : ''));
  const root = find();
  if (!root) return;

  const status = find('status');
  const runForm = find('run');
  const toolSelect = find('tool');
  const input = find('input');
  const updateTools = find('update-tools');
  const controls = root.querySelectorAll('button, input, select');
  const fileLimit = 64 * 1024;
  let first;
  let update;
  let initialRun;
  let updateRun;
  let attempts = [];
  let isExample = true;
  let busy = false;

  const list = (items) => Array.isArray(items) ? items : [];
  const commonNames = {
    read_file: 'Dosyayı oku', list_directory: 'Klasörü listele',
    search_files: 'Dosya ara', get_file_info: 'Dosya bilgilerini gör'
  };
  const commonInputs = { path: 'Dosya veya klasör yolu', pattern: 'Aranacak ad veya desen' };
  const toolLabel = (tool) => Object.hasOwn(commonNames, tool.name)
    ? commonNames[tool.name] : tool.label || tool.name;
  const testUnavailable = 'Kapı bu işin istediği girdi biçimini henüz desteklemiyor. Deneme tek bir metin alanı alabilir.';

  function element(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function setStatus(message, error = false) {
    status.textContent = message;
    status.dataset.tone = error ? 'error' : 'info';
  }

  function setBusy(value) {
    busy = value;
    root.toggleAttribute('data-busy', value);
    controls.forEach((control) => { control.disabled = value; });
    if (!value) renderToolInput();
    updateTools.querySelectorAll('button').forEach((control) => {
      control.disabled = value || control.dataset.cannotTest === 'true';
    });
  }

  async function request(body) {
    let response;
    try {
      response = await fetch('/api/gate-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error('Kapı’nın yerel hizmetine ulaşılamadı. Tekrar deneyebilirsin.');
    }
    const value = await response.json().catch(() => null);
    if (!response.ok || !value) {
      if (response.status === 405 || (response.status === 404 && !value?.error)) {
        throw new Error('Açık olan yerel hizmet bu denemeyi desteklemiyor. Kapı’nın güncel adresini aç.');
      }
      throw new Error(value?.error || 'İşlem tamamlanamadı.');
    }
    return value;
  }

  async function perform(message, work) {
    if (busy) return;
    setBusy(true);
    setStatus(message);
    let nextFocus;
    try {
      nextFocus = await work();
    } catch (error) {
      setStatus(error.message || 'İşlem tamamlanamadı.', true);
    } finally {
      setBusy(false);
    }
    nextFocus?.focus();
  }

  function renderList(target, items, empty) {
    if (!items.length) {
      target.replaceChildren(element('p', empty));
      return;
    }
    const ul = document.createElement('ul');
    ul.replaceChildren(...items.map((item) => element('li', item)));
    target.replaceChildren(ul);
  }

  function renderOutput(target, output) {
    let parsed;
    try { parsed = JSON.parse(output); } catch { /* Plain text is shown directly. */ }
    if (parsed && Array.isArray(parsed.matches)
        && parsed.matches.every((item) => item && typeof item.path === 'string')) {
      const heading = parsed.truncated === true
        ? `${parsed.matches.length} sonuç gösteriliyor. Araç, listenin sınırlandığını bildirdi.`
        : `${parsed.matches.length} sonuç gösteriliyor.`;
      target.append(element('p', heading));
      const matches = document.createElement('div');
      renderList(matches, parsed.matches.map((item) => item.path), 'Eşleşen sonuç gelmedi.');
      target.append(matches);
      const detail = document.createElement('details');
      detail.append(element('summary', 'Aracın verdiği ayrıntılı sonucu gör'), element('pre', output));
      target.append(detail);
      return;
    }
    target.append(element('pre', output));
  }

  function renderCoverage() {
    const names = {
      passed: 'Test edildi', pending: 'Henüz denenmedi', incomplete: 'Test eksik', blocked: 'Engellendi'
    };
    const checks = document.createElement('dl');
    for (const [inspection, run] of [[first, initialRun], [update, updateRun]]) {
      if (!inspection) continue;
      const entries = new Map();
      [...list(inspection.coverage), ...list(run?.coverage)].forEach((item) => entries.set(item.label, item));
      for (const item of entries.values()) {
        const suffix = update && inspection.version ? ` · ${inspection.version}` : '';
        const term = element('dt', item.label + suffix);
        const text = [names[item.state] || 'Durum bilinmiyor', item.detail].filter(Boolean).join(' · ');
        checks.append(term, element('dd', text));
      }
    }
    find('checks').replaceChildren(checks);
    find('coverage').hidden = !checks.childElementCount;
  }

  function renderReport() {
    find('report').hidden = !first;
    if (!first) return;

    const successful = attempts.filter(({ result }) => result.status === 'worked');
    const blocked = [...new Set(attempts.flatMap(({ result }) => list(result.blocked)))];
    const successfulNames = new Set(successful.filter((item) => !item.isUpdate).map((item) => item.name));
    const untested = list(first.tools).filter((tool) => !successfulNames.has(tool.name));
    const decision = find('decision');
    decision.replaceChildren(element('h4', 'Bu denemeye göre'));
    if (!attempts.length) {
      decision.append(element('p', 'İşler listelendi. Bir işi çalıştırdığında sonucunu ve henüz denenmeyen işleri burada göreceksin.'));
    } else {
      const text = successful.length
        ? `${successful.length} denemede sonuç alındı. Sonuç, yalnızca gösterilen girdi ve örnek dosyalar için geçerli.`
        : 'Henüz başarılı bir çalışma sonucu alınmadı.';
      decision.append(element('p', text));
      if (untested.length) {
        decision.append(element('p', `İlk sürümde sonucu henüz görülmeyen işler (${untested.length}): ${untested.map(toolLabel).join(', ')}.`));
      } else if (list(first.tools).length) {
        decision.append(element('p', 'İlk sürümde listelenen tüm işler en az bir kez denendi.'));
      }
      if (!isExample && successful.some((item) => !item.isUpdate)) {
        decision.append(element('p', 'Karar: Önce ayrı bir örnek klasörle dene.'));
        decision.append(element('p', 'Sonuç aldığın işleri kullanmak istersen önce dosyalarının kopyalarıyla dene ve yalnızca ihtiyaç duyduğu klasörü aç. İhtiyacın olan bir iş henüz denenmediyse kurulumdan önce onu da dene.'));
      } else {
        decision.append(element('p', 'Kurup kurmamaya karar verirken bu sonuçları, denemediğin işleri ve araca hangi klasörü açacağını birlikte değerlendir.'));
      }
    }
    const worked = find('worked');
    worked.replaceChildren();
    if (!attempts.length) worked.append(element('p', 'Örnek henüz çalıştırılmadı.'));
    for (const attempt of attempts) {
      const run = attempt.result;
      const section = document.createElement('section');
      const suffix = attempt.isUpdate ? ' · güncelleme' : '';
      section.append(element('h5', attempt.label + suffix));
      section.append(element('p', attempt.input === undefined ? 'Girdi verilmedi.' : `Verdiğin girdi: ${attempt.input || '(boş)'}`));
      if (run.status === 'worked') {
        section.append(element('p', 'Sonuç alındı.'));
        if (typeof run.output === 'string' && run.output) renderOutput(section, run.output);
        else if (run.summary) section.append(element('p', run.summary));
      } else if (run.status === 'blocked') {
        section.append(element('p', 'İstek engellendi.'));
      } else {
        section.append(element('p', run.summary || 'Deneme tamamlanamadı.'));
      }
      worked.append(section);
    }
    renderList(find('blocked'), blocked, initialRun ? 'Bu denemede raporlanan bir engel yok.' : 'Deneme sonucu bekleniyor.');

    const permissionLine = (tool) => {
      const label = toolLabel(tool);
      return tool.description ? `${label} · ${tool.description}` : label;
    };
    const permissions = list(update?.added).filter((tool) => tool.change !== 'updated-source').map(permissionLine);
    const reviewAgain = list(update?.reviewAgain).map(permissionLine);
    const noComparison = !update ? 'Güncelleme henüz karşılaştırılmadı.' : 'Güncellemede yeni izin bulunmadı.';
    const missingComparison = update && !update.id ? 'İzin karşılaştırması tamamlanamadı.' : noComparison;
    renderList(find('added'), permissions, missingComparison);
    if (permissions.length) find('added').append(element('p', 'Bu izinler kapalı.'));
    if (reviewAgain.length) {
      const heading = document.createElement('p');
      heading.append(element('strong', 'Yeniden onay gerekli'));
      const review = document.createElement('div');
      renderList(review, reviewAgain, '');
      find('added').append(heading, review, element('p', 'Bu işlerin kodu değişti. Önceki izinler kapalı.'));
    }
    const removed = list(update?.removed);
    if (removed.length) {
      find('added').append(element('p', 'Kaldırılan işler · ' + removed.map((tool) => typeof tool === 'string' ? tool : toolLabel(tool)).join(', ')));
    }
    renderCoverage();
  }

  function currentStep(id) {
    for (const step of ['first', 'second', 'third']) {
      if (step === id) find(step).setAttribute('aria-current', 'step');
      else find(step).removeAttribute('aria-current');
    }
  }

  function renderToolInput() {
    const tool = list(first?.tools).find((item) => item.name === toolSelect.value);
    input.parentElement.hidden = tool?.needsInput === false || tool?.canTest === false;
    const label = input.previousElementSibling;
    label.textContent = Object.hasOwn(commonInputs, tool?.inputLabel)
      ? commonInputs[tool.inputLabel] : tool?.inputLabel || 'Örnek girdi';
    if (!tool) return;
    find('run-button').disabled = busy || tool.canTest === false || tool.canApprove === false;
    find('run-note').textContent = tool.canTest === false ? testUnavailable
      : tool.canApprove === false ? 'Bu iş deneme için izin listesine alınamıyor.'
      : 'Seçtiğin işe bu deneme için izin verirsin. Deneme örnek dosyalarla yapılır.';
  }

  function renderInspection() {
    const tools = list(first?.tools);
    find('title').textContent = first?.title || 'Belge Bulucu';
    find('intro').textContent = first && !isExample
      ? (first.version ? `Seçtiğin dosya · ${first.version}` : 'Seçtiğin MCP dosyası')
      : 'Kapı için hazırlanmış örnek. Örnek klasörde PDF arar.';
    find('reset').hidden = !first;
    find('sources').hidden = Boolean(first?.id && tools.length);
    find('file-note').hidden = find('sources').hidden;
    find('inspect-note').textContent = first
      ? (tools.length ? `${tools.length} iş listelendi.` : (first.summary || 'Çalıştırılabilir bir iş listelenemedi.'))
      : 'Aracın hangi işleri sunduğunu gör.';
    find('run-note').textContent = first
      ? (tools.length ? 'Seçtiğin işe bu deneme için izin verirsin. Deneme örnek dosyalarla yapılır.' : 'İnceleme tamamlanmadan örnek çalıştırılamaz.')
      : 'İnceleme tamamlanınca deneyeceğin işi seç.';
    runForm.hidden = !first?.id || !tools.length;
    toolSelect.replaceChildren(...tools.map((tool) => {
      const option = element('option', toolLabel(tool));
      option.value = tool.name;
      return option;
    }));
    input.value = first && isExample ? 'pdf' : '';
    renderToolInput();
    find('update-actions').hidden = true;
    updateTools.hidden = true;
    find('update').textContent = isExample ? 'Güncellemeyi karşılaştır' : 'Güncelleme dosyasını seç';
    find('update-note').textContent = isExample
      ? 'Yeni sürümün hangi izinleri istediğini gör.'
      : 'İlk dosyayla aynı adı taşıyan yeni .py dosyasını seç. Dosya başka bir klasörde olabilir.';
    currentStep(runForm.hidden ? 'first' : 'second');
    renderReport();
  }

  function renderComparison() {
    const previousVersion = first.version ? `Sürüm ${first.version}` : 'İlk sürüm';
    const nextVersion = update.version ? `sürüm ${update.version}` : 'güncelleme';
    find('update-note').textContent = update.summary || (update.id
      ? `${previousVersion} ile ${nextVersion} karşılaştırıldı.`
      : 'Güncellemeyi incelemek mümkün olmadı.');
    updateTools.replaceChildren();
    for (const tool of list(update.tools)) {
      if (!tool.allowed && !tool.newPermission && tool.change !== 'updated-source') continue;
      const blocked = tool.newPermission || !tool.allowed;
      const label = toolLabel(tool);
      const button = element('button', blocked ? `${label} engelini dene` : `${label} işini yeniden dene`);
      button.type = 'button';
      button.className = 'button secondary';
      button.dataset.cannotTest = String(tool.canTest === false);
      button.disabled = busy || tool.canTest === false;
      button.addEventListener('click', () => runTool(update, tool, true));
      updateTools.append(button);
      if (tool.canTest === false) updateTools.append(element('p', testUnavailable));
    }
    updateTools.hidden = !updateTools.childElementCount;
    renderReport();
  }

  async function readFile(file) {
    if (!/\.py$/i.test(file.name)) throw new Error('Tek başına çalışan bir Python MCP dosyası (.py) seç.');
    if (!file.size || file.size > fileLimit) throw new Error('Boş olmayan, en fazla 64 KB boyutunda bir dosya seç.');
    return { source: await file.text(), name: file.name };
  }

  function inspect(preset, file) {
    perform('Kapı, aracın sunduğu işleri inceliyor…', async () => {
      const source = file ? await readFile(file) : { preset };
      const data = await request({ action: 'inspect', ...source });
      first = data;
      update = initialRun = updateRun = undefined;
      attempts = [];
      isExample = !file;
      renderInspection();
      if (runForm.hidden) {
        setStatus('İnceleme eksik kaldı. Ayrıntıları açabilir veya başka bir dosya seçebilirsin.', true);
        return;
      }
      setStatus('İnceleme tamamlandı. Deneyeceğin işi seç.');
      return toolSelect;
    });
  }

  function runTool(inspection, tool, isUpdate) {
    if (tool.canTest === false || (!isUpdate && tool.canApprove === false)) return;
    const denied = isUpdate && (!tool.allowed || tool.newPermission);
    const message = denied ? 'Kapı, bu isteğin önünde izin engeli olup olmadığını denetliyor…' : 'Araç, örnek dosyalarla deniyor…';
    perform(message, async () => {
      const body = { action: 'run', id: inspection.id, tool: tool.name };
      if (tool.needsInput !== false) body.input = input.value;
      if (!isUpdate) body.approve = true;
      const response = await request(body);
      attempts.push({ name: tool.name, label: toolLabel(tool), input: body.input, isUpdate, result: response });
      if (isUpdate) updateRun = response;
      else initialRun = response;
      find('update-actions').hidden = false;
      currentStep('third');
      renderReport();
      if (response.status === 'worked') setStatus('Deneme tamamlandı.');
      else if (response.status === 'blocked') setStatus('İstek engellendi.');
      else setStatus('Deneme tamamlanamadı. Ayrıntılar deneme sonucunda.', true);
      return find('report-title');
    });
  }

  function compare(file) {
    if (!first?.id) return;
    perform('Kapı, iki sürümün araç izinlerini karşılaştırıyor…', async () => {
      const source = file ? await readFile(file) : { preset: 'v2' };
      update = await request({ action: 'inspect', previousId: first.id, ...source });
      updateRun = undefined;
      attempts = attempts.filter((attempt) => !attempt.isUpdate);
      renderComparison();
      setStatus(update.id ? 'Güncelleme karşılaştırıldı.' : 'Karşılaştırma tamamlanamadı. Ayrıntılar deneme sonucunda.', !update.id);
      return find('added-title');
    });
  }

  find('inspect').addEventListener('click', () => inspect('v1'));
  find('pick').addEventListener('click', () => find('file').click());
  find('file').addEventListener('change', (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) inspect(null, file);
  });
  toolSelect.addEventListener('change', renderToolInput);
  runForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const tool = list(first?.tools).find((item) => item.name === toolSelect.value);
    if (tool) runTool(first, tool, false);
  });
  find('update').addEventListener('click', () => {
    if (isExample) compare();
    else find('update-file').click();
  });
  find('update-file').addEventListener('change', (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) compare(file);
  });
  find('reset').addEventListener('click', () => {
    first = update = initialRun = updateRun = undefined;
    attempts = [];
    isExample = true;
    find('coverage').open = false;
    renderInspection();
    setStatus('');
    find('inspect').focus();
  });
})();
