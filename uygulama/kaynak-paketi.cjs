'use strict';

const { createHash } = require('node:crypto');

const MAX_SOURCE_REQUEST = 2 * 1024 * 1024;
const MAX_SOURCE_FILES = 400;
const MAX_TEXT = 128 * 1024;
const devices = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i;
const ignoredDirectories = /^(?:\.git|\.svn|\.hg|node_modules|\.venv|__pycache__|coverage)$/i;
const privateName = /^(?:\.env(?:[._-]|$)|\.ssh$|\.aws$|\.azure$|\.gnupg$|\.npmrc$|\.pypirc$|\.netrc$|\.git-credentials$|\.dockercfg$|\.DS_Store$|__MACOSX$|(?:secrets?|credentials?|private[_-]?keys?|service[_-]?accounts?|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$))|\.(?:pem|key|pfx|p12|kdbx|jks|keystore)$/i;
const textName = /\.(?:md|markdown|mdx|txt|rst|adoc|textile|html?|css|[cm]?js|jsx|[cm]?ts|tsx|py|json|toml|ya?ml|xml|ini|cfg|csv|sh|ps1|bat|cmd|go|rs|rb|php|java|kt|kts|c|cc|cpp|h|hpp|cs|swift|sql|vue|svelte|ipynb|properties)$|(?:^|\/)(?:readme|license|copying|notice|makefile|dockerfile|gemfile|rakefile|procfile|justfile|pipfile|go\.mod)$/i;

function sourceFailure(status, message) {
  throw Object.assign(new Error(message), { status });
}

function sourcePath(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 1024 || /[\\:*?"<>|\x00-\x1f\x7f\p{Cs}]/u.test(name)) return null;
  const parts = name.split('/');
  return parts.some(part => !part || /[. ]$/.test(part) || devices.test(part) || Buffer.byteLength(part) > 255) ? null : parts;
}

function pathRegistry(onError) {
  const known = new Map();
  return (name, directory = false) => {
    const parts = sourcePath(name);
    if (!parts) return onError();
    let parent = '';
    let parentKey = '';
    for (const [index, part] of parts.entries()) {
      parent += (index ? '/' : '') + part;
      parentKey += (index ? '/' : '') + part.normalize('NFC').toUpperCase();
      const implied = index !== parts.length - 1;
      const folder = implied || directory;
      const previous = known.get(parentKey);
      if (previous && (previous.path !== parent || previous.folder !== folder || (!implied && previous.explicit))) return onError();
      if (!previous || !implied) known.set(parentKey, { path: parent, folder, explicit: !implied });
    }
  };
}

function privatePath(name) {
  return name.split('/').some(part => privateName.test(part) || ignoredDirectories.test(part));
}

function virtualEntries(input) {
  if (!input || !['file', 'folder'].includes(input.kind) || Object.keys(input).length !== 2 ||
      !Array.isArray(input.files) || !input.files.length || (input.kind === 'file' && input.files.length !== 1)) {
    sourceFailure(400, 'Tek dosya veya seçtiğiniz klasörün metin dosyaları gerekli.');
  }
  if (input.files.length > MAX_SOURCE_FILES) sourceFailure(413, 'Bir defada en fazla 400 dosya seçilebilir.');
  const registerPath = pathRegistry(() => sourceFailure(422, 'Dosya yolları güvenli ve birbirinden farklı olmalı.'));
  let total = 0;
  return input.files.map(file => {
    if (!file || Object.keys(file).length !== 2 || typeof file.name !== 'string' || typeof file.text !== 'string' ||
        (input.kind === 'file' && file.name.includes('/')) || /[\x00\p{Cs}]/u.test(file.text)) {
      sourceFailure(422, 'Dosya adı ve geçerli UTF-8 metin gerekli.');
    }
    registerPath(file.name);
    const size = Buffer.byteLength(file.text);
    total += size;
    if (size > MAX_TEXT) sourceFailure(413, 'Her metin dosyası en fazla 128 KiB olabilir.');
    if (total > MAX_SOURCE_REQUEST) sourceFailure(413, 'Toplam metin 2 MiB sınırını aşıyor.');
    return { name: file.name, text: file.text, size };
  });
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const comparePaths = (a, b) => a < b ? -1 : Number(a > b);

function sourceSnapshot(kind, selected, fileCount, artifact) {
  const files = [...new Map(selected.map(file => [file.name, file.text])).entries()]
    .sort(([a], [b]) => comparePaths(a, b))
    .map(([path, text]) => ({ path, sha256: digest(text), bytes: Buffer.byteLength(text) }));
  // A canonical JSON sequence avoids ambiguity between path and digest boundaries.
  const evidenceSha256 = digest(JSON.stringify(files.map(file => [file.path, file.sha256])));
  return { kind, artifactSha256: artifact === undefined ? null : digest(artifact), evidenceSha256,
    fileCount, readCount: files.length, files, cloudAllowed: kind === 'github' };
}

module.exports = { MAX_SOURCE_REQUEST, MAX_TEXT, privatePath, textName, pathRegistry, virtualEntries, sourceSnapshot, comparePaths };
