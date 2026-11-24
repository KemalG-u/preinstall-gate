(() => {
  'use strict';

  // Yalnız metni tarar; YAML, ifade, action veya komut çalıştırmaz.
  globalThis.urunTaniWorkflow = function (text) {
    if (typeof text !== 'string' || !text.trim() || text.includes('\0')) return null;
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const result = { triggers: [], jobs: [], limitations: [] };
    const note = message => { if (!result.limitations.includes(message)) result.limitations.push(message); };
    const add = (array, value) => { if (value && !array.includes(value)) array.push(value); };
    const collectReferences = (body, target) => {
      let start = 0;
      while ((start = body.indexOf('${{', start)) !== -1) {
        let expression = '', quoted = false, end = -1;
        for (let i = start + 3; i < body.length; i++) {
          const c = body[i];
          if (c === "'") {
            if (quoted && body[i + 1] === "'") { expression += '  '; i++; continue; }
            quoted = !quoted; expression += ' '; continue;
          }
          if (!quoted && c === '}' && body[i + 1] === '}') { end = i; break; }
          expression += quoted ? ' ' : c;
        }
        if (end < 0) { note('Tamamlanmamış veya çok satırlı ifadeler çözümlenmez.'); break; }
        const references = expression.matchAll(/(?<![\w.-])needs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)(?![\w-])/g);
        for (const ref of references) add(target, ref[1] + '.' + ref[2]);
        start = end + 2;
      }
    };
    const idPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/;
    let section = '', job = null, field = '', blockIndent = -1, sawOn = false, sawJobs = false;
    let onIndent = -1, jobIndent = -1, fieldIndent = -1, outputIndent = -1;
    let continuedQuote = '', stepIndent = -1, blockCapturesReferences = false;
    const quoteIsOpen = (text, quote, start) => {
      for (let i = start; i < text.length; i++) {
        if (quote === '"' && text[i] === '\\') { i++; continue; }
        if (text[i] === quote) {
          if (quote === "'" && text[i + 1] === "'") { i++; continue; }
          return false;
        }
      }
      return true;
    };
    const stripComment = line => {
      let quote = '', escaped = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote === '"' && c === '\\' && !escaped) { escaped = true; continue; }
        if ((c === '"' || c === "'") && !escaped) {
          if (!quote) quote = c;
          else if (quote === c) {
            if (c === "'" && line[i + 1] === "'") { i++; continue; }
            quote = '';
          }
        }
        if (c === '#' && !quote && (i === 0 || /\s/.test(line[i - 1]))) {
          note('Yorumlar çıkarıldı; yorum içeriği incelenmedi.');
          return line.slice(0, i);
        }
        escaped = false;
      }
      if (quote) note('Kapanmamış veya karmaşık tırnaklı değerler tam çözümlenmez.');
      return line;
    };
    const scalar = value => {
      value = value.trim();
      if (!value) return '';
      if (/^["']/.test(value)) {
        const q = value[0];
        if (value.length >= 2 && value.endsWith(q) && !/[\\]/.test(value) && !(q === "'" && value.slice(1, -1).includes("''"))) return value.slice(1, -1);
        note('Karmaşık tırnaklı değerler çözümlenmez.'); return '';
      }
      if (/[&*]|^!|[{}]/.test(value)) { note('Anchor, alias, etiket ve flow map yapıları çözümlenmez.'); return ''; }
      return value;
    };
    const list = (value, target) => {
      value = value.trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (!inner) return;
        for (const part of inner.split(',')) {
          const v = scalar(part);
          if (idPattern.test(v)) add(target, v);
          else note('Karmaşık liste öğeleri çözümlenmez.');
        }
      } else {
        const v = scalar(value);
        if (idPattern.test(v)) add(target, v);
        else if (value) note('Karmaşık liste veya ifade çözümlenmez.');
      }
    };
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index];
      if (continuedQuote) {
        if (!quoteIsOpen(raw, continuedQuote, 0)) continuedQuote = '';
        continue;
      }
      if (/^\s*$/.test(raw)) continue;
      const indentText = (raw.match(/^[ \t]*/) || [''])[0];
      if (indentText.includes('\t')) { note('Sekmeli girinti çözümlenmez.'); continue; }
      const indent = indentText.length;
      if (blockIndent >= 0) {
        if (indent > blockIndent) {
          if (blockCapturesReferences && job) collectReferences(raw.slice(indent), job.consumes);
          continue;
        }
        blockIndent = -1;
        blockCapturesReferences = false;
      }
      const line = stripComment(raw).trimEnd();
      if (!line.trim()) continue;
      const body = line.slice(indent);
      if (section === 'jobs' && job && field === 'steps' && indent > fieldIndent &&
          /^-\s+/.test(body) && (stepIndent < 0 || indent === stepIndent)) stepIndent = indent;
      const quotedValue = body.match(/^(?:[^:#]+:\s*|-[ \t]+)(["'])/);
      if (quotedValue && quoteIsOpen(body, quotedValue[1], quotedValue[0].length)) {
        continuedQuote = quotedValue[1];
        note('Çok satırlı tırnaklı skalerler çözümlenmez.');
      }
      if (/^\s*(?:[^:#]+:\s*|-[ \t]+)(?:[|>][+-]?[1-9]?[+-]?)(?:\s*)$/.test(body)) {
        blockIndent = indent;
        const stepRun = section === 'jobs' && job && field === 'steps' && stepIndent >= 0 &&
          ((indent === stepIndent && /^-\s+run\s*:/.test(body)) ||
           (indent === stepIndent + 2 && /^run\s*:/.test(body)));
        blockCapturesReferences = Boolean(stepRun);
        if (!blockCapturesReferences) note('Bazı çok satırlı skalerler incelenmedi.');
      }
      if (indent === 0) {
        section = ''; job = null; field = ''; onIndent = -1; jobIndent = -1; fieldIndent = -1;
        const m = body.match(/^(on|"on"|'on'|jobs)\s*:\s*(.*)$/);
        if (!m) continue;
        section = m[1] === 'jobs' ? 'jobs' : 'on';
        if (section === 'on') { sawOn = true; if (m[2]) list(m[2], result.triggers); }
        else { sawJobs = true; if (m[2]) note('Flow map veya satır içi jobs çözümlenmez.'); }
        continue;
      }
      if (section === 'on') {
        if (onIndent < 0) onIndent = indent;
        if (indent === onIndent && (indent === 2 || indent === 4)) {
          const m = body.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
          if (m) { add(result.triggers, m[1]); if (/^[{]/.test(m[2])) note('Tetikleyici ayrıntılarındaki flow map çözümlenmez.'); }
          else note('Tetikleyici yapısının bir bölümü çözümlenmedi.');
        } else if (indent < onIndent || onIndent !== 2 && onIndent !== 4) note('Tetikleyici girintisi beklenen biçimde değil.');
        continue;
      }
      if (section !== 'jobs') continue;
      if (jobIndent < 0) jobIndent = indent;
      if (indent === jobIndent) {
        job = null; field = ''; fieldIndent = -1; outputIndent = -1; stepIndent = -1;
        if (jobIndent !== 2 && jobIndent !== 4) { note('İş girintisi yalnız 2 veya 4 boşluk olarak desteklenir.'); continue; }
        const m = body.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (!m) { note('İş tanımı çözümlenmedi.'); continue; }
        if (m[2]) { note('Satır içi iş tanımı ve flow map çözümlenmez.'); continue; }
        job = { id: m[1], name: '', line: index + 1, needs: [], outputs: [], consumes: [], runner: '' };
        result.jobs.push(job); continue;
      }
      if (!job) continue;
      if (indent < jobIndent || indent <= jobIndent + 1) { note('İş alanında yanlış girinti görüldü.'); job = null; continue; }
      if (fieldIndent < 0) {
        if (indent !== jobIndent + 2 && indent !== jobIndent + 4) { note('İş alanında yanlış girinti görüldü.'); continue; }
        fieldIndent = indent;
      }
      if (indent === fieldIndent) {
        field = ''; outputIndent = -1; stepIndent = -1;
        const m = body.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (!m) { note('İş alanı çözümlenmedi.'); continue; }
        field = m[1];
        if (field === 'name') job.name = scalar(m[2]);
        if (field === 'runs-on') job.runner = scalar(m[2]);
        if (field === 'needs' && m[2]) list(m[2], job.needs);
        if (field === 'outputs' && m[2]) note('Satır içi outputs çözümlenmez.');
      } else if (indent < fieldIndent) {
        note('İş alanında tutarsız girinti görüldü.'); field = ''; continue;
      } else if (field === 'needs') {
        const m = body.match(/^-\s+(.+?)\s*$/);
        if (m) list(m[1], job.needs); else note('Needs bloğu çözümlenmedi.');
      } else if (field === 'outputs') {
        if (outputIndent < 0) outputIndent = indent;
        if (indent === outputIndent) {
          const m = body.match(/^([A-Za-z_][\w-]*)\s*:/);
          if (m) add(job.outputs, m[1]); else note('Outputs anahtarı çözümlenmedi.');
        } else note('İç içe veya tutarsız girintili outputs çözümlenmez.');
      }
      // Yalnız ifadelerdeki açık property başvuruları aranır.
      collectReferences(body, job.consumes);
    }
    if (!sawOn || !sawJobs) return null;
    if (result.jobs.some(item => item.consumes.length)) note('İfade içindeki çıktı başvuruları metinde görülmüştür; ihtiyaç ve çıktı tanımlarıyla tutarlılığı veya çalışma zamanı tüketimi doğrulanmadı.');
    note('Statik ve kısmi okumadır; YAML doğrulanmadı, koşullar ve çalışma sonuçları değerlendirilmedi.');
    return result;
  };
})();
