'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolvePythonExecutable } = require('./kapi-motor.cjs');

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const YAML = /\.ya?ml$/i;
const PARSER = path.join(__dirname, 'workflow-analiz.py');
const MAX_OUTPUT = 1024 * 1024;

function readGraphs(files, signal) {
  return new Promise((resolve, reject) => {
    const environment = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'LOCALAPPDATA', 'USERPROFILE']) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    const deadline = AbortSignal.timeout(8000);
    const child = spawn(resolvePythonExecutable(),
      ['-I', '-B', '-X', 'utf8', PARSER], {
        cwd: path.dirname(process.execPath), env: environment, windowsHide: true,
        shell: false, signal: AbortSignal.any([signal, deadline]), stdio: ['pipe', 'pipe', 'ignore'],
      });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 || size > MAX_OUTPUT) return reject(new Error('YAML parser unavailable'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(files));
  });
}

async function inspectWorkflows(source, signal) {
  const single = source.snapshot?.kind === 'file';
  const files = source.files.filter(file => WORKFLOW.test(file.name) || (single && YAML.test(file.name))).slice(0, 16);
  if (!files.length) return { workflowGraphs: {}, workflowNotes: [] };

  let results;
  try {
    results = await readGraphs(files, signal);
  } catch (error) {
    signal.throwIfAborted();
    return { workflowGraphs: Object.fromEntries(files.map(file => [file.name, null])),
      workflowNotes: ['Yerel YAML okuyucusu kullanılamadı. İş akışındaki çıktı yolları doğrulanamadı.'] };
  }
  const workflowGraphs = Object.fromEntries(files.map(file => [file.name,
    Object.hasOwn(results, file.name) ? results[file.name].graph : null]));
  const workflowNotes = files.flatMap(file => {
    const item = Object.hasOwn(results, file.name) ? results[file.name] : null;
    return item?.reason ? [`${file.name} — ${item.reason}`] : [];
  });
  return { workflowGraphs, workflowNotes };
}

module.exports = { inspectWorkflows };
