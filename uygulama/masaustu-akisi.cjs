'use strict';

function callOf(node) {
  return node?.type === 'CallExpression' ? node : null;
}

function member(node, object, property) {
  return node?.type === 'MemberExpression' && !node.computed &&
    node.object.type === 'Identifier' && node.object.name === object && node.property.name === property;
}

function string(node) {
  return node?.type === 'StringLiteral' ? node.value : null;
}

function* descendants(root, stopAtFunctions = false) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node?.type) continue;
    yield node;
    if (stopAtFunctions && /Function|Method/.test(node.type)) continue;
    for (const [property, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        const statements = stopAtFunctions && property === 'body' && node.type === 'BlockStatement';
        for (const child of statements ? throughReturn(value) : value) pending.push(child);
      }
      else if (value?.type) pending.push(value);
    }
  }
}

function variables(body) {
  return body.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations);
}

function throughReturn(body) {
  const stop = body.findIndex(node => node.type === 'ReturnStatement' || node.type === 'ThrowStatement' ||
    (node.type === 'IfStatement' && node.test.type === 'BooleanLiteral' && node.test.value === true &&
      ['ReturnStatement', 'ThrowStatement'].includes(node.consequent.type)));
  return stop < 0 ? body : body.slice(0, stop);
}

function bindingContains(pattern, name) {
  if (!pattern) return false;
  switch (pattern.type) {
    case 'Identifier': return pattern.name === name;
    case 'AssignmentPattern': return bindingContains(pattern.left, name);
    case 'RestElement': return bindingContains(pattern.argument, name);
    case 'ObjectPattern': return pattern.properties.some(node => bindingContains(node.value || node, name));
    case 'ArrayPattern': return pattern.elements.some(node => bindingContains(node, name));
    default: return false;
  }
}

function isShadowed(body, name) {
  let bindings = 0;
  for (const node of descendants({ type: 'Program', body })) {
    if ((node.type === 'VariableDeclarator' || /^(?:Function|Class)(?:Declaration|Expression)$/.test(node.type)) && bindingContains(node.id, name)) bindings++;
    if (/^Import.*Specifier$/.test(node.type) && node.local.name === name) bindings++;
    if (node.params?.some(param => bindingContains(param, name)) || (node.type === 'CatchClause' && bindingContains(node.param, name))) return true;
    if (bindings > 1) return true;
  }
  return false;
}

function electronBinding(body, name) {
  for (const node of body) {
    if (node.type !== 'ImportDeclaration' || string(node.source) !== 'electron') continue;
    const binding = node.specifiers.find(item => item.type === 'ImportSpecifier' && item.imported.name === name);
    if (binding) return isShadowed(body, binding.local.name) ? null : binding.local.name;
  }
  for (const node of variables(body)) {
    const init = callOf(node.init);
    if (node.id.type !== 'ObjectPattern' || init?.callee.name !== 'require' || string(init.arguments[0]) !== 'electron') continue;
    const binding = node.id.properties.find(item => item.key?.name === name && item.value.type === 'Identifier');
    if (binding) return isShadowed(body, binding.value.name) ? null : binding.value.name;
  }
  return null;
}

function windowsBranch(node) {
  const test = node.test;
  return node.type === 'IfStatement' && test?.operator === '===' &&
    ((member(test.left, 'process', 'platform') && string(test.right) === 'win32') ||
     (member(test.right, 'process', 'platform') && string(test.left) === 'win32'));
}

function keyboardBinding(body) {
  const windows = body.filter(windowsBranch).flatMap(node => [...descendants(node.consequent, true)]);
  const koffi = windows.find(node => node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
    node.init?.type === 'CallExpression' && node.init.callee.name === 'require' && string(node.init.arguments[0]) === 'koffi');
  if (!koffi) return null;
  const user32 = windows.find(node => node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
    node.init?.type === 'CallExpression' && member(node.init.callee, koffi.id.name, 'load') &&
    string(node.init.arguments[0])?.toLowerCase() === 'user32.dll');
  if (!user32) return null;
  const signature = (name) => windows.find(node => node.type === 'AssignmentExpression' && node.operator === '=' &&
    node.left.type === 'Identifier' && node.right.type === 'CallExpression' && member(node.right.callee, user32.id.name, 'func') &&
    (string(node.right.arguments[0]) || '').split('(')[0].trimEnd().split(/\s+/).at(-1) === name);
  const key = signature('keybd_event');
  const scan = signature('VkKeyScanA');
  return key && scan && ![key, scan].some(node => isShadowed(body, node.left.name)) ?
    { key: key.left.name, scan: scan.left.name, line: key.loc.start.line } : null;
}

function keyboardSequence(fn, { key, scan }, constants) {
  const statements = throughReturn(fn.body.body);
  const value = node => node?.type === 'NumericLiteral' ? node.value : constants.get(node?.name);
  const presses = statements.flatMap((statement, index) => {
    const call = callOf(statement.expression);
    if (call?.callee.name !== key) return [];
    return [{ index, line: call.loc.start.line, code: value(call.arguments[0]), flags: value(call.arguments[2]) }];
  });
  const control = presses.findIndex((press, index) => press.code === 0x11 && press.flags === 0 &&
    presses[index + 1]?.code === 0x43 && presses[index + 1].flags === 0 &&
    presses[index + 2]?.code === 0x43 && presses[index + 2].flags === 2 &&
    presses[index + 3]?.code === 0x11 && presses[index + 3].flags === 2);
  if (control < 0) return null;
  const enter = presses.slice(control + 4).find(press => press.code === 0x0d && press.flags === 0);
  if (!enter) return null;
  const characterLoop = statements.slice(presses[control + 3].index + 1, enter.index)
    .find(node => node.type === 'ForOfStatement' && node.right.type === 'Identifier' && fn.params[0]?.name === node.right.name);
  const call = callOf(characterLoop?.body?.expression);
  const loopBinding = characterLoop?.left.declarations?.[0]?.id?.name;
  const handlers = new Map(variables(statements).filter(node => node.id.type === 'Identifier' &&
    /FunctionExpression$/.test(node.init?.type || '')).map(node => [node.id.name, node.init]));
  const characterHandler = call && loopBinding && call.arguments[0]?.name === loopBinding && handlers.get(call.callee.name);
  if (!characterHandler) return null;
  if (characterHandler.body.type !== 'BlockStatement' || !characterHandler.params[0]?.name) return null;
  const characterBody = throughReturn(characterHandler.body.body);
  const characterVars = variables(characterBody);
  const scanned = characterVars.find(node => node.id.type === 'Identifier' && node.init?.type === 'CallExpression' &&
    node.init.callee.name === scan && member(node.init.arguments[0]?.callee, characterHandler.params[0].name, 'charCodeAt'));
  if (!scanned) return null;
  const mapped = characterVars.find(node => node.id.type === 'Identifier' && node.init?.operator === '&' &&
    node.init.left.name === scanned.id.name && value(node.init.right) === 0xff);
  if (!mapped) return null;
  const sendsCharacter = characterBody.some(statement => {
    const node = callOf(statement.expression);
    if (!node || node.arguments[0]?.name !== mapped.id.name) return false;
    if (node.callee.name === key) return true;
    const helper = handlers.get(node.callee.name);
    if (helper?.body.type !== 'BlockStatement' || !helper.params[0]?.name) return false;
    return throughReturn(helper.body.body).some(statement => {
      const press = callOf(statement.expression);
      return press?.callee.name === key && press.arguments[0]?.name === helper.params[0].name;
    });
  });
  return sendsCharacter ? { control: presses[control].line, typing: characterLoop.loc.start.line, enter: enter.line } : null;
}

function discoverDesktopJobs(files, parse) {
  const programs = files.filter(file => !file.isPackage && file.text.includes('electron'))
    .flatMap(file => {
      try {
        return [{ name: file.name, body: parse(file.text, { sourceType: 'unambiguous', plugins: ['jsx'] }).program.body }];
      } catch {
        return [];
      }
    });
  const signals = new Map();
  for (const { name, body } of programs) {
    const renderer = electronBinding(body, 'ipcRenderer');
    if (!renderer) continue;
    for (const node of descendants({ type: 'Program', body })) {
      if (node.type !== 'CallExpression' || !member(node.callee, renderer, 'send')) continue;
      const channel = string(node.arguments[0]);
      if (channel) signals.set(channel, { path: name, line: node.loc.start.line, role: 'trigger', label: 'Arayüzdeki bildirim çağrısı' });
    }
  }
  const jobs = [];
  for (const { name, body } of programs) {
    const main = electronBinding(body, 'ipcMain');
    const keyboard = main && keyboardBinding(body);
    if (!keyboard) continue;
    const functions = new Map(body.filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, node]));
    const constants = new Map(variables(body).filter(node => node.id.type === 'Identifier' && node.init?.type === 'NumericLiteral')
      .map(node => [node.id.name, node.init.value]));
    for (const statement of body) {
      const listener = callOf(statement.expression);
      if (!listener || !member(listener.callee, main, 'on')) continue;
      const sender = signals.get(string(listener.arguments[0]));
      const handler = listener.arguments[1];
      if (!sender || !handler?.body || !/FunctionExpression$/.test(handler.type)) continue;
      const calls = [...descendants(handler.body, true)].filter(node => node.type === 'CallExpression');
      for (const node of calls) {
        const dispatcher = functions.get(node.callee.name);
        const dispatch = dispatcher && throughReturn(dispatcher.body.body).find(windowsBranch);
        if (!dispatch) continue;
        const targets = [...descendants(dispatch.consequent, true)].filter(node => node.type === 'CallExpression');
        for (const target of targets) {
          const fn = functions.get(target.callee.name);
          const sequence = fn && target.arguments.length && keyboardSequence(fn, keyboard, constants);
          if (!sequence) continue;
          const proof = (line, role, label) => ({ path: name, line, role, label });
          jobs.push({
            id: `desktop:${name}:${listener.loc.start.line}`,
            title: 'Etkin pencereye tuş ve mesaj gönder',
            summary: 'Kaynakta görülen Windows yolunda, klavye işlevi hazırsa etkin pencereye önce Ctrl+C gönderir, ardından bir mesaj yazıp Enter’a basar.',
            trigger: 'Arayüzün bildirimi ana programa ulaştığında.',
            output: 'Ctrl+C, mesajın harfleri ve Enter, Windows’a tuş vuruşları olarak gönderilir.',
            consumer: 'Tuşları o anda etkin olan pencere alır. Sonrasında ne olacağı o pencerenin bunları nasıl işlediğine bağlıdır.',
            trialNote: 'Bu iş kaynak üzerinden takip edildi. Gerçek tuşları görmek için ayrı bir Windows oturumu ve tuşları alacak bir deneme penceresi gerekir.',
            evidence: [sender, proof(listener.loc.start.line, 'trigger', 'Ana program bildirimi alıyor'),
              proof(target.loc.start.line, 'producer', 'Windows için tuş gönderme adımı çağrılıyor'),
              proof(sequence.control, 'producer', 'Ctrl+C gönderiliyor'),
              proof(sequence.typing, 'producer', 'Mesaj harf harf yazılıyor'),
              proof(sequence.enter, 'producer', 'Enter gönderiliyor'),
              proof(keyboard.line, 'consumer', 'Tuşlar Windows’un klavye işlevine gidiyor')],
          });
          if (jobs.length >= 6) return jobs;
          break;
        }
        if (jobs.at(-1)?.id === `desktop:${name}:${listener.loc.start.line}`) break;
      }
    }
  }
  return jobs;
}

module.exports = { discoverDesktopJobs };
