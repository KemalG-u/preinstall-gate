(() => {
  'use strict';
  const MAX_BYTES = 131072;
  const MAX_SOURCE_REQUEST = 2 * 1024 * 1024;
  const MAX_SOURCE_FILES = 400;
  const ignoredDirectory = /^(?:\.git|\.svn|\.hg|node_modules|\.venv|__pycache__|coverage)$/i;
  const privateName = /^(?:\.env(?:[._-]|$)|\.ssh$|\.aws$|\.azure$|\.gnupg$|\.npmrc$|\.pypirc$|\.netrc$|\.git-credentials$|\.dockercfg$|\.DS_Store$|__MACOSX$|(?:secrets?|credentials?|private[_-]?keys?|service[_-]?accounts?|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$))|\.(?:pem|key|pfx|p12|kdbx|jks|keystore)$/i;
  const supported = /\.(?:md|markdown|mdx|txt|rst|adoc|textile|html?|css|[cm]?js|jsx|[cm]?ts|tsx|py|json|toml|ya?ml|xml|ini|cfg|csv|sh|ps1|bat|cmd|go|rs|rb|php|java|kt|kts|c|cc|cpp|h|hpp|cs|swift|sql|vue|svelte|ipynb|properties)$|(?:^|\/)(?:readme|license|copying|notice|makefile|dockerfile|gemfile|rakefile|procfile|justfile)$/i;
  const clean = s => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const clip = (s, n = 350) => clean(s).slice(0, n);
  const empty = (name, type, url = '') => ({ status: 'ok', name, type, summary: '', files: [], setup: [], signals: [], limitations: [], url, provenance: { read: [], version: null } });
  const failure = message => ({ status: 'error', message });
  function incomplete(record, message) {
    record.status = 'incomplete';
    record.limitations.push(message);
  }
  function markdownHeading(line) {
    const heading = line.match(/^\s{0,3}(#{1,6})[ \t]+(.*?)\s*#*\s*$/);
    if (!heading) return null;
    const text = heading[2].replace(/(?<!\\)<img(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'<>])*>/gi, '').trim();
    return { level: heading[1].length, text };
  }
  function skillMetadata(lines) {
    if (!/^---\s*$/.test(lines[0])) return {};
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end < 0) return {};
    const metadata = {};
    for (let index = 1; index < end; index++) {
      const property = lines[index].match(/^(name|description)\s*:\s*(.*)$/);
      if (!property) continue;
      const key = property[1];
      const value = property[2].trim();
      const block = value.match(/^([|>])([1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/);
      if (!block) {
        metadata[key] = value.replace(/^(["'])(.*)\1$/, '$2');
        continue;
      }
      const content = [];
      while (index + 1 < end && /^(?: +\S|\s*$)/.test(lines[index + 1])) content.push(lines[++index]);
      const explicitIndent = block[2]?.match(/[1-9]/);
      const indent = explicitIndent ? Number(explicitIndent[0]) : (content.find(line => line.trim())?.match(/^ +/)?.[0].length || 0);
      const unindented = content.map(line => line.trim() ? line.slice(indent).trimEnd() : '');
      if (block[1] === '|') metadata[key] = unindented.join('\n').trim();
      else {
        let folded = '';
        for (const [lineIndex, line] of unindented.entries()) {
          if (lineIndex > 0) {
            const previous = unindented[lineIndex - 1];
            if (previous && line && !/^\s/.test(previous) && !/^\s/.test(line)) folded += ' ';
            else if (!previous || /^\s/.test(previous) || /^\s/.test(line)) folded += '\n';
          }
          folded += line;
        }
        metadata[key] = folded.trim();
      }
    }
    return metadata;
  }
  function skillFields(text) {
    const result = { trigger: null, input: null, output: null, use: null, requirements: null };
    const labels = {
      trigger: ['trigger', 'triggers', 'when to use', 'tetik', 'tetikleyici', 'tetikleyiciler', 'ne zaman kullanılır', 'ne zaman devreye girer'],
      input: ['input', 'inputs', 'girdi', 'girdiler'],
      output: ['output', 'outputs', 'çıktı', 'çıktılar'],
      use: ['use', 'usage', 'output usage', 'where used', 'kullanım', 'kullanım yeri', 'çıktının kullanımı', 'nerede kullanılır'],
      requirements: ['requirements', 'prerequisites', 'dependencies', 'gereksinimler', 'gereklilikler', 'ön koşullar', 'önkoşullar', 'bağımlılıklar']
    };
    let active = null, activeLevel = 0, buffer = [], fence = null, frontmatter = false;
    const flush = () => {
      const value = buffer.join('\n').trim();
      if (active && value) result[active] = result[active] ? result[active] + '\n\n' + value : value;
      buffer = [];
    };
    for (const [index, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
      if (index === 0 && /^---\s*$/.test(line)) { frontmatter = true; continue; }
      if (frontmatter) { if (/^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false; continue; }
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (active) buffer.push(line);
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null;
        continue;
      }
      if (marker) { fence = marker[1]; if (active) buffer.push(line); continue; }
      const heading = markdownHeading(line);
      if (heading) {
        const { level } = heading;
        if (active && level > activeLevel) {
          if (heading.text) buffer.push('#'.repeat(level) + ' ' + heading.text);
          continue;
        }
        flush();
        const label = heading.text.replace(/:\s*$/, '').trim();
        const variants = [label.toLocaleLowerCase('tr-TR'), label.toLowerCase().replace(/\u0307/g, '')];
        active = Object.keys(labels).find(key => variants.some(value => labels[key].includes(value))) || null;
        activeLevel = level;
      } else if (active) buffer.push(line);
    }
    flush();
    return result;
  }
  function workflow(text, name, url, out) {
    if (typeof globalThis.urunTaniWorkflow !== 'function') {
      incomplete(out, name + ': iş akışı okuyucusu kullanılamadığından akış ayrıntıları çıkarılmadı.');
      return;
    }
    const result = globalThis.urunTaniWorkflow(text);
    if (result) out.workflow = { ...result, source: { name, url } };
  }
  // JSON.parse has already validated the document. Locate direct object properties
  // without confusing nested or repeated keys with the active scripts declaration.
  function scriptLocations(text) {
    const whitespace = index => { while (/\s/.test(text[index] || '') && index < text.length) index++; return index; };
    const stringEnd = start => {
      let index = start + 1;
      while (index < text.length) { if (text[index] === '\\') index += 2; else if (text[index++] === '"') break; }
      return index;
    };
    const valueEnd = start => {
      if (text[start] === '"') return stringEnd(start);
      let index = start, depth = 0;
      while (index < text.length) {
        const char = text[index];
        if (char === '"') { index = stringEnd(index); continue; }
        if (char === '{' || char === '[') depth++;
        if (char === '}' || char === ']') { if (!depth) break; depth--; if (!depth) return index + 1; }
        if (!depth && (char === ',' || /\s/.test(char))) break;
        index++;
      }
      return index;
    };
    const entries = start => {
      const found = []; let index = whitespace(start + 1);
      while (index < text.length && text[index] !== '}') {
        const keyStart = index, end = stringEnd(index), key = JSON.parse(text.slice(index, end));
        index = whitespace(whitespace(end) + 1);
        const startValue = index;
        index = whitespace(valueEnd(index));
        found.push({ key, keyStart, startValue });
        if (text[index] !== ',') break;
        index = whitespace(index + 1);
      }
      return found;
    };
    const declaration = entries(whitespace(0)).filter(item => item.key === 'scripts').pop();
    const locations = new Map();
    if (declaration && text[declaration.startValue] === '{') {
      for (const item of entries(declaration.startValue)) locations.set(item.key, text.slice(0, item.keyStart).split(/\r?\n/).length);
    }
    return locations;
  }
  function inspect(text, name, out) {
    text = text.replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    const proseFile = /\.(?:md|markdown|txt|rst)$/i.test(name) || /^(?:(?:docs|\.github)\/)?readme$/i.test(name) || /^LICENSE$/i.test(name);
    const metadata = /(?:^|\/)skill\.md$/i.test(name) ? skillMetadata(lines) : {};
    const prose = []; let frontmatter = false, fence = null;
    for (const [index, line] of lines.entries()) {
      if (proseFile && index === 0 && /^---\s*$/.test(line)) { frontmatter = true; continue; }
      if (frontmatter) {
        if (/^(?:---|\.\.\.)\s*$/.test(line)) { frontmatter = false; continue; }
        continue;
      }
      if (proseFile) {
        const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null; continue; }
        if (marker) { fence = marker[1]; continue; }
      }
      prose.push(line);
    }
    const headings = proseFile ? prose.map(markdownHeading).filter(heading => heading?.text && heading.level <= 4) : [];
    const titles = headings.slice(0, 8).map(heading => clip(heading.text, 160));
    const first = proseFile ? prose.find(l => { const t = l.trim(); return t.length > 25 && !/^(#|[-*+]\s|<|\{|\}|\/\/|\[!)/.test(t); }) : '';
    if (proseFile) {
      if (metadata.description) out.summary = 'Beceri açıklaması: ' + clip(metadata.description, 1500);
      else if (first) out.summary = 'Metindeki açıklama: ' + clip(first);
    } else if (/\.ya?ml$/i.test(name)) {
      const yamlName = lines.map(l => l.match(/^name\s*:\s*([^#\r\n]+)/)).find(Boolean);
      if (yamlName) out.summary = 'YAML içindeki ad: ' + clip(yamlName[1].replace(/^["']|["']$/g, ''));
    }
    if (titles.length) out.signals.push('Metindeki başlıklar: ' + titles.join(' · '));
    if (/^skill\.md$/i.test(name)) out.signals.push('Dosya adı SKILL.md: beceri yönergesi olabileceği çıkarımı; çalışması doğrulanmadı.');
    if (/\.ya?ml$/i.test(name)) {
      const jobs = []; let inJobs = false;
      for (const line of lines) {
        if (/^jobs\s*:\s*(?:#.*)?$/.test(line)) { inJobs = true; continue; }
        if (inJobs && /^\S/.test(line) && !/^\s*#/.test(line)) break;
        const match = inJobs && line.match(/^  ([A-Za-z0-9_-]+)\s*:\s*(?:#.*)?$/);
        if (match) jobs.push(match[1]);
      }
      if (jobs.length) out.signals.push('YAML jobs bölümünde görülen iş kimlikleri: ' + jobs.slice(0, 12).join(' · ') + '. Bunun GitHub Actions akışı olduğu dosya içeriğinden yapılan çıkarımdır.');
    }
    const commands = lines.map((line, index) => ({ line, number: index + 1 })).filter(item => /^\s*(?:[$>]\s*)?(?:npm|npx|pnpm|yarn|bun|pip|python|uv|cargo|go|docker|make|git clone)\s+[^\s]/i.test(item.line));
    out.setup.push(...commands.slice(0, 8).map(item => 'Metinde geçen, çalıştırılmamış komut — ' + name + ':' + item.number + ' — ' + item.line));
    if (commands.length > 8) out.limitations.push(name + ': ilk 8 komut gösteriliyor.');
    if (/\.json$/i.test(name)) {
      try {
        const data = JSON.parse(text);
        if (/^package\.json$/i.test(name)) {
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            incomplete(out, 'package.json beklenen nesne biçiminde değil; yalnız metin incelendi.');
          } else {
            if (typeof data.description === 'string' && data.description.trim()) out.summary = 'Manifest açıklaması: ' + clip(data.description);
            if (data.scripts && typeof data.scripts === 'object' && !Array.isArray(data.scripts)) {
              const locations = scriptLocations(text);
              Object.entries(data.scripts).slice(0, 12).forEach(([k, v]) => {
                if (typeof v !== 'string') return;
                const number = locations.get(k);
                const location = name + (number ? ':' + number : ' (satır belirlenemedi)');
                out.setup.push('Çalıştırılmamış manifest betiği ' + k + ' — ' + v + ' — ' + location + (number ? ' — ' + lines[number - 1] : ''));
              });
              if (Object.keys(data.scripts).length > 12) out.limitations.push(name + ': ilk 12 manifest betiği gösteriliyor.');
            }
          }
        }
      } catch { incomplete(out, 'JSON içeriği çözümlenemedi; yalnız metin incelendi.'); }
    }
    if (!out.summary) out.summary = 'Dosya metni incelendi; güvenilir kısa açıklama bulunamadı.';
    out.limitations.push('Başlıklar ve komutlar metinden çıkarılmıştır; işlev, güvenlik ve kurulum çalıştırılarak doğrulanmadı.');
    return { title: headings.find(heading => heading.level === 1)?.text || metadata.name, summary: metadata.description || first };
  }
  function eligibleLocalPath(path) {
    const parts = path.split('/');
    return supported.test(path) && parts.every((part, index) => part && !privateName.test(part) &&
      !ignoredDirectory.test(part) && (!part.startsWith('.') || (index === 0 && part === '.github')));
  }
  async function localFiles(kind, selected, signal) {
    const isFolder = kind === 'folder';
    const first = selected[0];
    if (!first || typeof first.arrayBuffer !== 'function') return failure(isFolder ? 'İçinde dosya bulunan bir klasör seçin.' : 'Geçerli bir dosya seçin.');
    const name = isFolder ? first.webkitRelativePath?.split('/')[0] : first.name;
    if (!name) return failure('Tarayıcı seçilen klasörün adını ve dosya yollarını vermedi. ZIP olarak seçebilirsin.');
    const useLocalService = localService();
    if (!useLocalService && isFolder) return { ...failure('Klasörü incelemek için Ürün Tanı’yı yerel adresinden açın.'), localService: true };
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const files = [];
    let bytes = encoder.encode(JSON.stringify({ kind, files })).length;
    for (const item of selected) {
      if (signal?.aborted) return failure('Kaynak incelemesi iptal edildi.');
      const prefix = name + '/';
      const path = isFolder && item.webkitRelativePath?.startsWith(prefix) ? item.webkitRelativePath.slice(prefix.length) : isFolder ? '' : item.name;
      if (!eligibleLocalPath(path)) {
        if (!isFolder) return failure('Bu dosya türü incelemeye alınmıyor. Bir metin veya kod dosyası seçin.');
        continue;
      }
      if (item.size > MAX_BYTES) {
        if (!isFolder) return failure('Dosya 128 KiB sınırını aşıyor. Daha küçük bir dosya seçin.');
        continue;
      }
      if (files.length >= MAX_SOURCE_FILES || bytes + item.size > MAX_SOURCE_REQUEST) continue;
      let text;
      try { text = decoder.decode(await item.arrayBuffer()); }
      catch {
        if (!isFolder) return failure('Dosya UTF-8 metin olarak okunamadı.');
        continue;
      }
      if (!text.trim() || text.includes('\u0000')) {
        if (!isFolder) return failure('Dosyada incelenebilecek metin bulunamadı.');
        continue;
      }
      const entry = { name: path, text };
      const entryBytes = encoder.encode(JSON.stringify(entry)).length + Number(files.length > 0);
      if (bytes + entryBytes > MAX_SOURCE_REQUEST) continue;
      files.push(entry);
      bytes += entryBytes;
    }
    if (!files.length) return failure('Seçilen klasörde incelemeye alınabilecek metin dosyası bulunamadı.');
    const data = useLocalService ? await archiveRequest('/api/source-files', 'application/json', JSON.stringify({ kind, files }), signal) : {
      files, paths: files.map(item => item.name), partial: true,
      limitations: ['Tarayıcı dosyayı metin olarak okudu. Kod incelemesi ve deneme hazırlama için Ürün Tanı’nın yerel adresini açabilirsin.']
    };
    if (data.status === 'error') return data;
    const record = archiveRecord(data, clip(name, 200), '', kind, files);
    const skipped = selected.length - files.length;
    if (skipped && record.status !== 'error') {
      record.limitations.push(`${skipped} dosya tür, gizlilik veya boyut sınırı nedeniyle inceleme isteğine alınmadı.`);
      record.status = 'incomplete';
    }
    return record;
  }
  const file = (input, signal) => localFiles('file', [input], signal);
  const folder = (input, signal) => localFiles('folder', input, signal);
  function parseUrl(raw) {
    let u; try { u = new URL(String(raw).trim()); } catch { return null; }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0]) || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) || parts[1] === '.' || parts[1] === '..') return null;
    parts[1] = parts[1].replace(/\.git$/i, '');
    if (!parts[1] || parts[1] === '.' || parts[1] === '..') return null;
    return parts;
  }
  function packageSkill(name) {
    return { id: 'package-' + name, name: 'skills/' + name + '/SKILL.md', fallback: name };
  }
  function skillRecord(text, candidate, source) {
    const { title, summary } = inspect(text, candidate.name, empty('', ''));
    return {
      id: candidate.id,
      title: clip(title, 160) || candidate.fallback || 'SKILL.md',
      summary: clip(summary, 1500),
      fields: skillFields(text),
      source
    };
  }
  function localService() {
    return /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(globalThis.location?.origin || '');
  }
  async function archiveRequest(path, contentType, body, signal) {
    const timeout = AbortSignal.timeout(150000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(path, {
        method: 'POST', body, headers: { 'Content-Type': contentType },
        credentials: 'omit', redirect: 'error', signal: requestSignal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) return failure(clip(data?.error, 350) || 'Kaynak okunamadı. Yeniden deneyin.');
      if (!Array.isArray(data?.files) || !Array.isArray(data?.paths) ||
          !data.files.every(file => typeof file?.name === 'string' && typeof file?.text === 'string') ||
          !data.paths.every(path => typeof path === 'string' && path.length)) {
        return failure('İnceleme için beklenen dosya bilgileri alınamadı.');
      }
      return data;
    } catch {
      return failure(timeout.aborted ? 'Kaynağı okuma süresi doldu. Yeniden deneyin.' :
        'Ürün Tanı’nın yerel hizmetine ulaşılamadı. Sayfayı yeniden yükleyin.');
    }
  }
  function archiveEvidence(evidence, paths, sourceFor) {
    return Array.isArray(evidence) ? evidence.filter(item => item && paths.has(item.path) &&
      Number.isSafeInteger(item.line) && item.line > 0).map(item => ({
        source: sourceFor(item.path), line: item.line, label: clip(item.label, 300), quote: clip(item.quote, 400), role: item.role,
        kind: ['test', 'example', 'application'].includes(item.kind) ? item.kind : null,
        effect: item.effect === 'comparison' ? 'comparison' : null,
        recipient: clip(item.recipient, 150), conditional: item.conditional === true
      })) : [];
  }
  function repoJobs(data, paths, sourceFor) {
    if (!Array.isArray(data.jobs)) return [];
    return data.jobs.filter(job => typeof job?.id === 'string' && job.id.trim() &&
      typeof job.title === 'string' && job.title.trim()).map(job => ({
      id: job.id,
      title: clip(job.title, 160),
      origin: ['source', 'model', 'document'].includes(job.origin) ? job.origin : job.id.startsWith('model:') ? 'model' : 'source',
      summary: clip(job.summary, 1500),
      output: clip(job.output, 1500),
      consumer: clip(job.consumer, 1500),
      trigger: clip(job.trigger, 1500),
      trialNote: clip(job.trialNote, 400),
      evidence: archiveEvidence(job.evidence, paths, sourceFor),
      explanation: job.explanation && typeof job.explanation === 'object' ? {
        scenario: clip(job.explanation.scenario, 650),
        steps: Array.isArray(job.explanation.steps) ? job.explanation.steps.slice(0, 6).map(step => ({
          label: clip(step?.label, 160), text: clip(step?.text, 650)
        })).filter(step => step.text) : [],
        example: job.explanation.example && typeof job.explanation.example === 'object' ? {
          sourceFolder: clip(job.explanation.example.sourceFolder, 350),
          targetFolder: clip(job.explanation.example.targetFolder, 350),
          rows: Array.isArray(job.explanation.example.rows) ? job.explanation.example.rows.slice(0, 20).map(row => ({
            from: clip(row?.from, 350), to: row?.to == null ? null : clip(row.to, 350),
            reason: clip(row?.reason, 350), status: ['planned', 'unchanged', 'unresolved'].includes(row?.status) ? row.status : null
          })).filter(row => row.from) : []
        } : null
      } : null,
      run: typeof job.run?.id === 'string' && job.run.id.trim() ? {
        id: job.run.id, description: clip(job.run.description, 1000),
        mode: ['bounded', 'pinned', 'simulation', 'preview'].includes(job.run.mode) ? job.run.mode : null,
        verifiedUses: archiveEvidence(job.run.verifiedUses, paths, sourceFor),
        command: clip(job.run.command, 120), inputLabel: clip(job.run.inputLabel, 120),
        sampleInput: typeof job.run.sampleInput === 'string' ? job.run.sampleInput.slice(0, 2000) : ''
      } : null
    }));
  }
  const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
  function readSnapshot(value, kind, paths) {
    if (!value || value.kind !== kind || !sha256(value.evidenceSha256)) return null;
    const files = Array.isArray(value.files) ? value.files.filter(item => paths.has(item?.path) && sha256(item.sha256) &&
      Number.isSafeInteger(item.bytes) && item.bytes >= 0) : [];
    return {
      kind, evidenceSha256: sha256(value.evidenceSha256), artifactSha256: sha256(value.artifactSha256), files,
      fileCount: Number.isSafeInteger(value.fileCount) ? value.fileCount : paths.size,
      readCount: Number.isSafeInteger(value.readCount) ? value.readCount : files.length,
      cloudAllowed: kind === 'github' && value.cloudAllowed === true
    };
  }
  function archiveRecord(data, name, url = '', kind = url ? 'github' : 'zip', supplied = []) {
    const sha = /^[a-f0-9]{40}$/i.test(data.sha || '') ? data.sha : null;
    if (url && !sha) return failure('GitHub sürümü doğrulanamadı. Arşiv incelemeye alınmadı.');
    const types = { github: 'GitHub deposu', zip: 'Yerel ZIP arşivi', file: 'Yerel dosya', folder: 'Yerel klasör' };
    const out = empty(name, types[kind], url);
    out.skills = [];
    out.workflows = [];
    if (kind === 'github' || kind === 'zip') out.archive = { count: data.paths.length, cached: url !== '' && data.cached === true };
    const paths = new Set(data.paths);
    out.provenance.snapshot = readSnapshot(data.snapshot, kind, paths);
    const documents = url ? new Map() : new Map([...data.files, ...supplied].map(item => [item.name, item.text]));
    const sourceFor = path => ({
      name: path,
      url: url ? url + '/blob/' + sha + '/' + path.split('/').map(encodeURIComponent).join('/') : '',
      excerpt: documents.has(path) ? line => {
        const value = documents.get(path).split(/\r\n|\n|\r/)[line - 1];
        return typeof value === 'string' ? value.trim().slice(0, 400) : '';
      } : null
    });
    const workflowPath = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
    const isWorkflow = path => workflowPath.test(path) || (kind === 'file' && /\.ya?ml$/i.test(path));
    out.jobs = repoJobs(data, paths, sourceFor);
    if (data.gate && typeof data.gate === 'object') {
      const g = data.gate;
      const decl = g.declaration || {};
      const declSrc = decl.declaredSource && paths.has(decl.declaredSource.path)
        ? { source: sourceFor(decl.declaredSource.path), line: decl.declaredSource.line, quote: clip(decl.declaredSource.quote, 300) }
        : null;
      out.gate = {
        verdict: ['BLOCK', 'REVIEW_REQUIRED', 'ALLOW_WITH_POLICY'].includes(g.verdict) ? g.verdict : 'REVIEW_REQUIRED',
        verdictTitle: clip(g.verdictTitle, 200),
        verdictSummary: clip(g.verdictSummary, 500),
        declaration: {
          title: clip(decl.title, 160),
          declaredPurpose: clip(decl.declaredPurpose, 400),
          declaredSource: declSrc
        },
        matrix: g.matrix && typeof g.matrix === 'object' ? {
          filesystemRead: Boolean(g.matrix.filesystemRead),
          filesystemWrite: Boolean(g.matrix.filesystemWrite),
          sensitivePathAccess: Boolean(g.matrix.sensitivePathAccess),
          networkEgress: Boolean(g.matrix.networkEgress),
          childProcess: Boolean(g.matrix.childProcess),
          envSecretRead: Boolean(g.matrix.envSecretRead),
          promptPoisoning: Boolean(g.matrix.promptPoisoning),
          desktopInput: Boolean(g.matrix.desktopInput)
        } : {},
        findings: Array.isArray(g.findings) ? g.findings.slice(0, 48).filter(f => f && paths.has(f.path)).map(f => ({
          ruleId: clip(f.ruleId, 80),
          category: clip(f.category, 120),
          severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(f.severity) ? f.severity : 'MEDIUM',
          title: clip(f.title, 200),
          description: clip(f.description, 400),
          source: sourceFor(f.path),
          line: Number.isSafeInteger(f.line) ? f.line : 1,
          quote: clip(f.quote, 300),
          undeclared: Boolean(f.undeclared)
        })) : [],
        canary: g.canary && typeof g.canary === 'object' ? {
          id: typeof g.canary.id === 'string' ? g.canary.id : null,
          executed: Boolean(g.canary.executed),
          reason: clip(g.canary.reason, 400),
          runtime: clip(g.canary.runtime, 40),
          entrypoint: clip(g.canary.entrypoint, 180),
          exitCode: Number.isInteger(g.canary.exitCode) ? g.canary.exitCode : null,
          timedOut: Boolean(g.canary.timedOut),
          stdout: clip(g.canary.stdout, 4000),
          stderr: clip(g.canary.stderr, 2000),
          sampleInput: typeof g.canary.sampleInput === 'string' ? g.canary.sampleInput.slice(0, 2000) : '',
          fsChanges: {
            created: Array.isArray(g.canary.fsChanges?.created) ? g.canary.fsChanges.created.slice(0, 24).map(c => ({
              path: clip(c.path, 180), size: Number(c.size) || 0, preview: clip(c.preview, 400)
            })) : [],
            modified: Array.isArray(g.canary.fsChanges?.modified) ? g.canary.fsChanges.modified.slice(0, 24).map(c => ({
              path: clip(c.path, 180), size: Number(c.size) || 0, preview: clip(c.preview, 400)
            })) : [],
            deleted: Array.isArray(g.canary.fsChanges?.deleted) ? g.canary.fsChanges.deleted.slice(0, 24).map(d => clip(d, 180)) : []
          },
          runtimeViolations: Array.isArray(g.canary.runtimeViolations) ? g.canary.runtimeViolations.slice(0, 12).map(v => ({
            type: clip(v.type, 80),
            severity: clip(v.severity, 40),
            permission: clip(v.permission, 120),
            resource: clip(v.resource, 240),
            summary: clip(v.summary, 400),
            evidence: clip(v.evidence, 600)
          })) : []
        } : null,
        policy: g.policy && typeof g.policy === 'object' ? {
          lockedCommand: clip(g.policy.lockedCommand, 500),
          mcpConfigJson: clip(g.policy.mcpConfigJson, 1500)
        } : null
      };
    }
    const overview = data.overview;
    if (overview && typeof overview === 'object') {
      const purpose = clip(overview.purpose, 650);
      const usage = clip(overview.usage, 650);
      const example = overview.example;
      const source = example?.evidence;
      const overviewEvidence = overview.evidence;
      const verifiedOverviewEvidence = overviewEvidence && paths.has(overviewEvidence.path) &&
        Number.isSafeInteger(overviewEvidence.line) && overviewEvidence.line > 0 ?
        { source: sourceFor(overviewEvidence.path), line: overviewEvidence.line, quote: clip(overviewEvidence.quote, 400) } : null;
      const hasEvidence = source && paths.has(source.path) && Number.isSafeInteger(source.line) && source.line > 0;
      const input = clip(example?.input, 350);
      const output = clip(example?.output, 350);
      const guide = overview.guide;
      const guideEvidence = item => item && paths.has(item.path) && Number.isSafeInteger(item.line) && item.line > 0 ?
        { source: sourceFor(item.path), line: item.line, quote: clip(item.quote, 400) } : null;
      const steps = Array.isArray(guide?.steps) ? guide.steps.slice(0, 4).map(step => ({
        title: clip(step?.title, 160), description: clip(step?.description, 650), evidence: guideEvidence(step?.evidence)
      })).filter(step => step.title && step.description && step.evidence) : [];
      const payoffEvidence = guideEvidence(guide?.payoffEvidence);
      out.overview = {
        purpose,
        usage, origin: ['source', 'model', 'document'].includes(overview.origin) ? overview.origin :
          data.inspection?.model?.status === 'ok' ? 'model' : null,
        evidence: verifiedOverviewEvidence,
        example: hasEvidence && input && output ? { input, output, source: sourceFor(source.path), line: source.line } : null,
        guide: steps.length >= 2 && payoffEvidence && clip(guide?.situation, 650) && clip(guide?.payoff, 650) ? {
          situation: clip(guide.situation, 650), steps, payoff: clip(guide.payoff, 650), payoffEvidence
        } : null
      };
    }
    if (data.inspection && typeof data.inspection === 'object') {
      out.inspection = ['rea', 'model'].map(name => {
        const stage = data.inspection[name];
        return { name, status: clip(stage?.status, 40), detail: clip(stage?.detail, 650),
          model: clip(stage?.model, 120), provider: clip(stage?.provider, 120),
          evidence: archiveEvidence(stage?.evidence, paths, sourceFor) };
      });
    }
    out.workflowSources = data.paths.filter(path => workflowPath.test(path)).map(sourceFor);
    if (url) {
      out.provenance.version = { branch: clip(data.branch, 160), sha, url: url + '/commit/' + sha };
    }
    const rootItems = new Set(data.paths.map(path => {
      const slash = path.indexOf('/');
      return slash < 0 ? path : path.slice(0, slash + 1);
    }));
    out.files = Array.from(rootItems).slice(0, 100);
    if (rootItems.size > 100) out.limitations.push('Kök dizindeki ilk 100 öğe gösteriliyor.');
    if (data.partial) out.status = 'incomplete';
    const reviewLimits = [...new Set([...(Array.isArray(data.limitations) ? data.limitations : []),
      ...(Array.isArray(data.workflowNotes) ? data.workflowNotes : [])].filter(note => typeof note === 'string' && note.trim()))];
    out.limitations.push(...reviewLimits);

    let readmeSummary = '', manifestSummary = '';
    for (const { name: path, text } of data.files) {
      const source = sourceFor(path);
      out.provenance.read.push(source);
      if (/(?:^|\/)skill\.md$/i.test(path)) {
        const packageName = path.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1];
        const candidate = packageName ? packageSkill(packageName) : {
          id: path.includes('/') ? 'path-' + path : 'root', name: path, fallback: path.split('/').at(-2)
        };
        out.skills.push(skillRecord(text, candidate, source));
        continue;
      }

      const details = empty('', '');
      inspect(text, path, details);
      out.setup.push(...details.setup);
      out.signals.push(...details.signals);
      out.limitations.push(...details.limitations.filter(note => !note.startsWith('Başlıklar ve komutlar')));
      if (details.status === 'incomplete') out.status = 'incomplete';
      if (/^(?:(?:docs|\.github)\/)?readme(?:\.[^/]+)?$/i.test(path) &&
          !readmeSummary && details.summary.startsWith('Metindeki açıklama')) readmeSummary = details.summary;
      if (path === 'package.json' && details.summary.startsWith('Manifest açıklaması')) manifestSummary = details.summary;
      if (isWorkflow(path)) {
        const parsed = empty('', '');
        const graphs = data.analysis?.workflowGraphs || data.workflowGraphs;
        if (graphs && Object.hasOwn(graphs, path)) {
          if (graphs[path] && typeof graphs[path] === 'object') parsed.workflow = { ...graphs[path], source };
        } else workflow(text, path, source.url, parsed);
        if (parsed.status === 'incomplete') out.status = 'incomplete';
        out.limitations.push(...parsed.limitations);
        if (!parsed.workflow) {
          if (parsed.status !== 'incomplete' && workflowPath.test(path)) out.limitations.push(path + ': GitHub Actions iş tanımları çıkarılamadı.');
        } else {
          out.workflows.push({ ...parsed.workflow, source });
        }
      }
    }
    if (Array.isArray(data.analyzedPaths)) {
      const read = new Set(out.provenance.read.map(source => source.name));
      for (const path of new Set(data.analyzedPaths)) {
        if (paths.has(path) && !read.has(path)) out.provenance.read.push(sourceFor(path));
      }
    }
    out.workflow = out.workflows.find(item => item.jobs?.length) || out.workflows[0] || null;
    out.summary = readmeSummary || manifestSummary || 'Okunan dosyalarda kısa bir ürün açıklaması bulunamadı.';
    out.limitations.push(kind === 'github' || kind === 'zip' ?
      'Arşivden seçilen dosyalar okundu. İnceleme sırasında kaynak komutları çalıştırılmadı.' :
      'Seçilen metinler bilgisayarında incelendi. İnceleme sırasında kaynak komutları çalıştırılmadı.');
    return out;
  }
  async function github(raw, signal) {
    const parts = parseUrl(raw);
    if (!parts) return failure('Herkese açık GitHub deposunun ana adresini girin. Örnek https://github.com/sahip/depo');
    const name = parts.join('/');
    const url = 'https://github.com/' + name;
    if (!localService()) return { ...failure('GitHub bağlantısını incelemek için Ürün Tanı’yı yerel adresinden açın.'), localService: true };
    const data = await archiveRequest('/api/github-source', 'application/json', JSON.stringify({ url }), signal);
    const canonical = typeof data.repository === 'string' ? parseUrl('https://github.com/' + data.repository)?.join('/') : null;
    const resolved = canonical && canonical === data.repository ? canonical : name;
    const record = data.status === 'error' ? data : archiveRecord(data, resolved, 'https://github.com/' + resolved);
    return record.status === 'error' ? { ...record, githubUrl: url } : record;
  }
  function kindFromLink(raw) {
    const address = String(raw || '').trim();
    // Keep non-repository GitHub pages out of the generic document path.
    if (/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}\/?$/i.test(address) && parseUrl(address)) return 'github';
    return 'web';
  }
  async function web(raw, signal) {
    if (!localService()) return { ...failure('Belge bağlantısını incelemek için Ürün Tanı’yı yerel adresinden açın.'), localService: true };
    const data = await archiveRequest('/api/web-source', 'application/json', JSON.stringify({ url: raw }), signal);
    if (data.status === 'error') return data;
    const document = data.document;
    if (!document || !['html', 'markdown', 'plain'].includes(document.format) || typeof document.url !== 'string' || data.files.length !== 1) {
      return failure('Belge bilgileri eksik döndü. Yeniden deneyin.');
    }
    const file = data.files[0];
    const name = clip(document.title, 160) || clip(file.name, 160);
    const type = { html: 'Herkese açık web sayfası', markdown: 'Herkese açık Markdown belgesi', plain: 'Herkese açık metin belgesi' }[document.format];
    const out = empty(name, type, document.url);
    out.files.push(file.name);
    out.provenance.read.push({ name: file.name, url: document.url, kind: 'web' });
    out.provenance.snapshot = readSnapshot(data.snapshot, 'web', new Set(data.paths));
    const cleanText = clean(file.text).replace(/[\u202a-\u202e\u2066-\u2069]/gu, '');
    out.document = {
      format: document.format, title: clip(document.title, 160),
      headings: Array.isArray(document.headings) ? document.headings.filter(heading => typeof heading === 'string').slice(0, 12).map(heading => clip(heading, 160)).filter(Boolean) : [],
      requestedUrl: document.requestedUrl, preview: cleanText.slice(0, 4800), previewClipped: cleanText.length > 4800
    };
    return out;
  }
  async function zip(input, signal) {
    if (!input?.size) return failure('ZIP dosyası boş veya okunamıyor. Geçerli bir ZIP seçin.');
    if (input.size > 32 * 1024 * 1024) return failure('ZIP dosyası 32 MiB sınırını aşıyor.');
    if (!localService()) return { ...failure('ZIP dosyasını incelemek için Ürün Tanı’yı yerel adresinden açın.'), localService: true };
    const data = await archiveRequest('/api/source-zip', 'application/zip', input, signal);
    return data.status === 'error' ? data : archiveRecord(data, clip(data.title, 200) || clip(input.name, 200) || "ZIP arşivi");
  }
  async function preset(presetId, signal) {
    if (!localService()) return { ...failure('Hazır senaryoyu çalıştırmak için Ürün Tanı’yı yerel adresinden açın.'), localService: true };
    const data = await archiveRequest('/api/gate-preset', 'application/json', JSON.stringify({ preset: presetId }), signal);
    return data.status === 'error' ? data : archiveRecord(data, clip(data.title, 200) || 'Hazır Deneme Senaryosu', '', 'folder', data.files);
  }
  globalThis.urunTanimaKaynak = { github, web, kindFromLink, file, folder, zip, preset, localService };
})();

