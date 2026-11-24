'use strict';

const https = require('node:https');
const tls = require('node:tls');
const { lookup } = require('node:dns/promises');
const { BlockList, isIP } = require('node:net');
const { networkInterfaces } = require('node:os');
const { gunzipSync } = require('node:zlib');
const { sourceSnapshot } = require('./kaynak-paketi.cjs');

const MAX_DOCUMENT = 512 * 1024;
const MAX_HEADERS = 16 * 1024;
const MAX_HOPS = 3;
const MAX_TIME = 15000;
const redirects = new Set([301, 302, 303, 307, 308]);
const blocked4 = new BlockList();
const public6 = new BlockList();
const blocked6 = new BlockList();
// IANA special-purpose ranges and the Azure host virtual address.
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['168.63.129.16', 32]
]) blocked4.addSubnet(ip, bits, 'ipv4');
public6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]
]) blocked6.addSubnet(ip, bits, 'ipv6');

class WebSourceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const error = (status, message) => new WebSourceError(status, message);

function publicUrl(raw) {
  const address = typeof raw === 'string' ? raw.trim() : '';
  if (!address || address.length > 1800 || /[\u0000-\u0020\u007f\\]/.test(address) ||
      !/^https:\/\/[^/]+/i.test(address)) {
    throw error(400, 'Herkese açık bir HTTPS belge bağlantısı girin.');
  }
  if (/[?#]/.test(address)) throw error(400, 'Bağlantının ? ile başlayan parametrelerini ve # ile başlayan bölümünü kaldırıp yeniden deneyin.');
  const authority = address.slice(8).split('/')[0];
  if (/[@%]/.test(authority)) throw error(400, 'Kullanıcı bilgisi veya kodlanmış adres içeren bağlantılar okunamaz.');
  let url;
  try { url = new URL(address); } catch { throw error(400, 'Bağlantı geçerli bir HTTPS adresi değil.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(url.hostname) ||
      url.hostname.length > 253 ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|corp|test|invalid|onion|arpa|example)$/i.test(url.hostname)) {
    throw error(403, 'Bu bağlantı okunamaz. Herkese açık bir alan adı ve standart HTTPS bağlantısı gerekli.');
  }
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    throw error(400, 'GitHub’daki dosya, dal veya değişiklik bağlantısı depo olarak incelenemez. Depo ana adresini verin; yalnız belgeyi okumak için GitHub’daki Raw bağlantısını kullanın.');
  }
  return url;
}

function globalAddress(ip) {
  if (typeof ip !== 'string' || ip.includes('%')) return false;
  const family = isIP(ip);
  return family === 4 ? !blocked4.check(ip, 'ipv4') :
    family === 6 && public6.check(ip, 'ipv6') && !blocked6.check(ip, 'ipv6');
}

let dnsPending = 0;
function resolveAddresses(host, signal) {
  signal.throwIfAborted();
  if (dnsPending >= 4) throw error(429, 'Alan adı sorguları sürüyor. Biraz sonra yeniden deneyin.');
  dnsPending++;
  // Use the OS resolver (including Windows DNS configuration). The trailing dot
  // forbids search-domain expansion. No connection is started until all answers pass.
  const answer = lookup(host + '.', { all: true, order: 'verbatim' }).finally(() => { dnsPending--; });
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    answer.then(
      addresses => resolve(addresses.map(item => item.address)),
      cause => reject(error(502, cause.code === 'ENOTFOUND' ? 'Belge alan adı için bir adres bulunamadı.' : 'Belge alan adı güvenli biçimde çözümlenemedi.'))
    ).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function pinnedAddress(url, signal, resolve) {
  const addresses = await resolve(url.hostname, signal);
  signal.throwIfAborted();
  if (!Array.isArray(addresses) || !addresses.length) throw error(502, 'Belge alan adı için bir adres bulunamadı.');
  const local = new BlockList();
  for (const entry of Object.values(networkInterfaces()).flat()) {
    const address = entry?.address?.split('%')[0];
    const version = isIP(address);
    if (version) local.addAddress(address, version === 4 ? 'ipv4' : 'ipv6');
  }
  if (addresses.length > 64 || addresses.some(ip => !globalAddress(ip) || local.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6'))) {
    throw error(403, 'Belge alan adı yerel, özel veya doğrulanamayan bir adrese yöneliyor.');
  }
  return addresses.find(ip => isIP(ip) === 4) || addresses[0];
}

function fetchHop(url, ip, signal, request) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      // A numeric hostname prevents a second DNS lookup. The original host is used
      // for HTTP Host, TLS SNI and certificate verification. A private agent avoids proxy/reuse.
      req = request({
        protocol: 'https:', hostname: ip, family: isIP(ip), port: 443, servername: url.hostname,
        path: url.pathname, method: 'GET', agent: false, signal, maxHeaderSize: MAX_HEADERS,
        rejectUnauthorized: true, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(url.hostname, cert),
        headers: { Host: url.hostname, Accept: 'text/html, text/markdown, text/plain', 'Accept-Encoding': 'identity',
          'User-Agent': 'Urun-Tani-Document/1' }
      }, async res => {
        // A redirect body is never buffered. Every new location is validated independently.
        if (redirects.has(res.statusCode)) {
          res.destroy();
          return resolve({ redirect: typeof res.headers.location === 'string' ? res.headers.location : '' });
        }
        if (res.statusCode !== 200) {
          res.destroy();
          return reject(error(502, 'Belge sunucusu herkese açık okunabilir bir yanıt vermedi.'));
        }
        try {
          const type = String(res.headers['content-type'] || '');
          const mime = type.split(';', 1)[0].trim().toLowerCase();
          const charsets = [...type.matchAll(/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/gi)]
            .map(match => (match[1] ?? match[2]).toLowerCase());
          if (!['text/plain', 'text/markdown', 'text/x-markdown', 'text/html'].includes(mime) ||
              ((type.match(/(?:^|;)\s*charset\b/gi) || []).length !== charsets.length) ||
              charsets.some(charset => !['utf-8', 'utf8', 'us-ascii'].includes(charset))) {
            throw error(415, 'Bu bağlantı UTF-8 metin, Markdown veya HTML belge döndürmedi.');
          }
          const coding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
          if (!['identity', 'gzip'].includes(coding)) throw error(415, 'Belge desteklenmeyen bir sıkıştırma biçiminde gönderildi.');
          const length = res.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_DOCUMENT)) throw error(413, 'Belge 512 KB sınırını aşıyor.');
          const chunks = [];
          let size = 0;
          for await (const bytes of res) {
            signal.throwIfAborted();
            size += bytes.length;
            if (size > MAX_DOCUMENT) throw error(413, 'Belge 512 KB sınırını aşıyor.');
            chunks.push(bytes);
          }
          let content = Buffer.concat(chunks, size);
          if (coding === 'gzip') {
            try { content = gunzipSync(content, { maxOutputLength: MAX_DOCUMENT }); }
            catch (cause) {
              if (cause.code === 'ERR_BUFFER_TOO_LARGE') throw error(413, 'Açılmış belge 512 KB sınırını aşıyor.');
              throw error(415, 'Sıkıştırılmış belge okunamadı.');
            }
          }
          if (charsets.includes('us-ascii') && content.some(byte => byte > 127)) throw error(415, 'Belge, bildirdiği metin kodlamasıyla eşleşmiyor.');
          resolve({ mime, content });
        } catch (cause) {
          res.destroy();
          reject(cause);
        }
      });
      req.once('error', reject);
      req.end();
    } catch (cause) {
      req?.destroy();
      reject(cause);
    }
  });
}

const namedEntities = new Map(Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' }));
const visibleText = value => value.replace(/&(?:#(x[\da-f]{1,6}|\d{1,7})|([a-z]{2,12}));/gi, (entity, numeric, named) => {
  if (named) return namedEntities.get(named.toLowerCase()) ?? entity;
  const n = numeric[0].toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
  return n >= 32 && n <= 0x10ffff && !(n >= 0x7f && n <= 0x9f) && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
});
const compact = value => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\s]+/gu, ' ').trim();
const titleText = value => compact(value).slice(0, 160);
const blockTags = new Set(['p','br','div','main','article','section','li','ul','ol','tr','td','table','pre','blockquote','dl','dd','dt','hr','h1','h2','h3','h4','h5','h6']);
const hiddenTags = new Set(['head','template','svg','math','object']);
const headTags = new Set(['base','link','meta','title','noscript','noframes','style','script','template']);
const whitespace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
const nameStart = ch => ch !== undefined && /[a-z]/i.test(ch);
const namePart = ch => ch !== undefined && /[a-z0-9_:-]/i.test(ch);

// The scanner always advances through the input; malformed tags and large
// attributes cannot make a repeated regular-expression search block the server.
function tagEnd(input, start) {
  let quote;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return { end: i + 1, ok: true };
    else if (ch === '<') return { end: i, ok: false };
  }
  return { end: input.length, ok: false };
}
function nextTag(input, start) {
  let i = input.indexOf('<', start);
  while (i !== -1) {
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      return { start: i, end: end === -1 ? input.length : end + 3 };
    }
    if (input[i + 1] === '!') {
      const boundary = tagEnd(input, i + 2);
      if (boundary.ok || boundary.end === input.length) return { start: i, end: boundary.end };
      i = input.indexOf('<', boundary.end);
      continue;
    }
    const closing = input[i + 1] === '/';
    let j = i + (closing ? 2 : 1);
    const nameAt = j;
    if (nameStart(input[j])) {
      while (namePart(input[j])) j++;
      if (whitespace(input[j]) || input[j] === '/' || input[j] === '>') {
        const boundary = tagEnd(input, j);
        if (boundary.ok) {
          return { start: i, end: boundary.end, closing, name: input.slice(nameAt, j).toLowerCase(), attributesAt: j };
        }
        if (boundary.end === input.length) return { start: i, end: boundary.end };
        i = input.indexOf('<', boundary.end);
        continue;
      }
    }
    i = input.indexOf('<', Math.max(i + 1, j));
  }
  return null;
}
function hidesContent(input, start, end) {
  let i = start;
  while (i < end) {
    while (i < end && (whitespace(input[i]) || input[i] === '/')) i++;
    const nameAt = i;
    while (i < end && !whitespace(input[i]) && !['=','/'].includes(input[i])) i++;
    if (i === nameAt) { i++; continue; }
    const key = input.slice(nameAt, i).toLowerCase();
    while (i < end && whitespace(input[i])) i++;
    let value = '';
    if (input[i] === '=') {
      i++;
      while (i < end && whitespace(input[i])) i++;
      const quote = input[i] === '"' || input[i] === "'" ? input[i++] : undefined;
      const valueAt = i;
      if (quote) { while (i < end && input[i] !== quote) i++; }
      else { while (i < end && !whitespace(input[i])) i++; }
      if (key === 'aria-hidden') value = input.slice(valueAt, i).toLowerCase();
      if (quote && i < end) i++;
    }
    if (key === 'hidden' || (key === 'aria-hidden' && value === 'true')) return true;
  }
  return false;
}
function rawEnd(input, start, name) {
  // name comes from the fixed rawTags set.
  const end = new RegExp('</' + name + '(?=[/\\s>])', 'ig');
  end.lastIndex = start;
  let match;
  while ((match = end.exec(input))) {
    const boundary = tagEnd(input, end.lastIndex);
    if (boundary.ok) return { start: match.index, end: boundary.end };
    if (boundary.end === input.length) return null;
    end.lastIndex = boundary.end;
  }
  return null;
}
const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const rawTags = new Set(['script','style','iframe','noscript','textarea','xmp','noembed','noframes','plaintext','title']);

function htmlText(input) {
  const hidden = [];
  const lines = [];
  const headings = [];
  let capture;
  let title = '';
  let cursor = 0;
  function append(text) {
    if (hidden.length === 1 && hidden[0] === 'head' && /[^\t\n\f\r ]/.test(text)) hidden.pop();
    if (hidden.length || !text) return;
    const decoded = visibleText(text);
    lines.push(decoded);
    if (capture) capture.content.push(decoded);
  }
  function finishHeading() {
    if (!capture) return;
    const text = titleText(capture.content.join(''));
    if (text && headings.length < 12) headings.push(text);
    capture = undefined;
  }
  let token;
  while ((token = nextTag(input, cursor))) {
    append(input.slice(cursor, token.start));
    cursor = token.end;
    const { name, closing } = token;
    if (!name) continue;
    if (hidden.length === 1 && hidden[0] === 'head' && !closing && !headTags.has(name) && name !== 'html' && name !== 'head') hidden.pop();
    if (closing) {
      if (hidden.length) {
        const last = hidden.lastIndexOf(name);
        if (last !== -1) hidden.length = last;
        continue;
      }
      if (capture?.name === name) finishHeading();
      if (blockTags.has(name)) lines.push('\n');
      continue;
    }
    if (rawTags.has(name)) {
      const boundary = name === 'plaintext' ? null : rawEnd(input, cursor, name);
      if (name === 'title' && !title && (!hidden.length || hidden.every(item => item === 'head')) && boundary) {
        title = titleText(visibleText(input.slice(cursor, boundary.start)));
      }
      cursor = boundary ? boundary.end : input.length;
      continue;
    }
    const hiddenElement = hidesContent(input, token.attributesAt, token.end - 1);
    if (!voidTags.has(name) && (hidden.length || hiddenTags.has(name) || hiddenElement)) {
      // In HTML, a trailing slash does not close a non-void element.
      // Keep actual self-closing foreign content from hiding the rest of the document.
      const foreign = name === 'svg' || name === 'math' || hidden.some(tag => tag === 'svg' || tag === 'math');
      if (!foreign || input[token.end - 2] !== '/') {
        if (hidden.length >= 256) break;
        hidden.push(name);
      }
      continue;
    }
    if (hidden.length || hiddenElement) continue;
    if (blockTags.has(name)) lines.push('\n');
    if (/^h[1-6]$/.test(name)) {
      finishHeading();
      capture = { name, content: [] };
    }
  }
  append(input.slice(cursor));
  finishHeading();
  const text = lines.join('').split(/\r\n|\r|\n/).map(compact).filter(Boolean).join('\n');
  return { title: title || headings[0] || '', headings: [...new Set(headings)], text };
}

function markdownHeadings(text) {
  let fence;
  const headings = [];
  let title = '';
  let previous = '';
  for (const line of text.split(/\r\n|\n|\r/)) {
    const delimiter = /^ {0,3}(\x60{3,}|~{3,})/.exec(line);
    if (delimiter && !fence) { fence = { mark: delimiter[1][0], length: delimiter[1].length }; previous = ''; continue; }
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.mark && delimiter[1].length >= fence.length &&
          !line.slice(delimiter[0].length).trim()) fence = undefined;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
    const underline = previous && /^ {0,3}(=+|-+)\s*$/.exec(line);
    if (atx || underline) {
      let label = atx ? line.slice(atx[0].length).trimEnd() : previous;
      if (atx && label.endsWith('#')) {
        let end = label.length;
        while (end > 0 && label[end - 1] === '#') end--;
        if (end === 0 || whitespace(label[end - 1])) label = label.slice(0, end);
      }
      const heading = titleText(label.slice(0, 300).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_\x60]/g, ''));
      if (heading && headings.length < 12) headings.push(heading);
      if (heading && !title && (atx ? atx[1] === '#' : underline[1][0] === '=')) title = heading;
      previous = '';
    } else previous = /^\S/.test(line) ? line : '';
  }
  return { title: title || headings[0] || '', headings: [...new Set(headings)], text };
}

function redirectUrl(raw, previous) {
  // Validate the raw authority too, before WHATWG parsing can normalize an encoded host.
  if (!raw || /[?#\\\u0000-\u0020\u007f]/.test(raw) || /^(?:\/\/\/|https:\/\/\/)/i.test(raw)) {
    throw error(403, 'Belgenin yönlendirdiği bağlantı bu incelemede kabul edilmedi.');
  }
  if (/^\/\//.test(raw)) return publicUrl('https:' + raw);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return publicUrl(raw);
  return publicUrl(new URL(raw, previous).href);
}

async function readWebDocument(raw, parentSignal, { resolve = resolveAddresses, request = https.request } = {}) {
  let url = publicUrl(raw);
  const requestedUrl = url.href;
  const timeout = AbortSignal.timeout(MAX_TIME);
  const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const ip = await pinnedAddress(url, signal, resolve);
      const result = await fetchHop(url, ip, signal, request);
      signal.throwIfAborted();
      if (Object.hasOwn(result, 'redirect')) {
        if (hop === MAX_HOPS) throw error(502, 'Belge bağlantısı çok fazla yönlendirme içeriyor.');
        url = redirectUrl(result.redirect, url);
        continue;
      }
      let input;
      try { input = new TextDecoder('utf-8', { fatal: true }).decode(result.content); }
      catch { throw error(415, 'Belge geçerli UTF-8 metin değil.'); }
      if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/u.test(input)) throw error(415, 'Belge metin dışında karakterler içeriyor.');
      const format = result.mime === 'text/html' ? 'html' :
        result.mime !== 'text/plain' || /\.(?:md|markdown)$/i.test(url.pathname) ? 'markdown' : 'plain';
      const document = format === 'html' ? htmlText(input) : format === 'markdown' ? markdownHeadings(input) : { text: input, title: '', headings: [] };
      if (!document.text.trim()) throw error(422, 'Bağlantı açıldı ama okunabilir belge metni bulunamadı.');
      let name;
      try { name = titleText(decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || url.hostname)); }
      catch { name = url.hostname; }
      name = (name || url.hostname).replace(/[\\/]/g, '·');
      const files = [{ name, text: document.text }];
      return { files, paths: [name], snapshot: sourceSnapshot('web', files, 1, result.content),
        document: { format, title: document.title, headings: document.headings, url: url.href, requestedUrl } };
    }
  } catch (cause) {
    if (timeout.aborted) throw error(504, 'Belgenin okuma süresi doldu. Yeniden deneyin.');
    if (parentSignal?.aborted) throw error(408, 'Belge okuma işlemi kesildi.');
    if (cause instanceof WebSourceError) throw cause;
    throw error(502, 'Belgeye güvenli bir HTTPS bağlantısı kurulamadı.');
  }
}

module.exports = { readWebDocument, publicUrl, globalAddress, MAX_DOCUMENT };

