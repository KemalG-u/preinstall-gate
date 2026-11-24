'use strict';

const path = require('node:path').posix;
const { createHash } = require('node:crypto');

const SOURCE_LIMIT = 24 * 1024;
const OUTPUT_LIMIT = 16 * 1024;
const AST_FILE_BUDGET = 16000;
const AST_TOTAL_BUDGET = 160000;
const TRIAL_LIMIT = 24;
const USE_LIMIT = 24;
const extensions = /\.(?:js|mjs)$/i;
const textMethods = new Map([
  ['trim', [0, 0]], ['trimStart', [0, 0]], ['trimEnd', [0, 0]],
  ['toLowerCase', [0, 0]], ['toUpperCase', [0, 0]], ['slice', [0, 2]],
  ['substring', [0, 2]], ['charAt', [0, 1]], ['charCodeAt', [0, 1]],
  ['concat', [0, 2]], ['replace', [2, 2]], ['replaceAll', [2, 2]],
]);
const comparisons = new Map([
  ['===', (left, right) => left === right], ['!==', (left, right) => left !== right],
  ['<', (left, right) => left < right], ['<=', (left, right) => left <= right],
  ['>', (left, right) => left > right], ['>=', (left, right) => left >= right],
  ['+', (left, right) => left + right],
]);

class Unsupported extends Error {}
const reject = () => { throw new Unsupported(); };
const runError = (status, message) => Object.assign(new Error(message), { status });

// A single literal code point or a single character class, with no repetitions,
// groups, backreferences, alternations, or other backtracking constructs.
function singleCharacterPattern(pattern) {
  const charClass = pattern.startsWith('[') && pattern.endsWith(']');
  const body = charClass ? pattern.slice(1, -1) : pattern;
  if (!body || body.length > 180) return false;
  let count = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '\\') {
      if (!'\\^$.*+?()[]{}|/-'.includes(body[++index] || '\0')) return false;
    } else if (char === ']' || (!charClass && '^$.*+?()[]{}|'.includes(char))) return false;
    count++;
  }
  return charClass || count === 1;
}

function regexp(node) {
  if (!/^(?!.*(.).*\1)[giu]{0,3}$/.test(node.flags) || !singleCharacterPattern(node.pattern)) reject();
  try {
    new RegExp(node.pattern, node.flags);
  } catch {
    reject();
  }
  return () => new RegExp(node.pattern, node.flags);
}

function replacement(node) {
  if (node.type !== 'StringLiteral' || node.value.length > 256) reject();
  for (let index = 0; index < node.value.length; index++) {
    if (node.value[index] === '$' && '$&'.includes(node.value[index + 1] || '\0')) index++;
    else if (node.value[index] === '$' && /[\x60'0-9<]/.test(node.value[index + 1] || '')) reject();
  }
  return () => node.value;
}

function limit(value) {
  if (typeof value === 'string' && value.length > OUTPUT_LIMIT) {
    throw runError(422, 'Dönüşümün çıktısı deneme sınırını aştı. Daha kısa bir metinle deneyin.');
  }
  return value;
}

function expression(node, names, depth = 0) {
  if (!node || depth > 20) reject();
  const nested = value => expression(value, names, depth + 1);
  switch (node.type) {
    case 'Identifier': {
      if (!names.has(node.name)) reject();
      return values => values.get(node.name);
    }
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      if (typeof node.value === 'string' ? node.value.length > 512 :
        typeof node.value === 'number' && !Number.isSafeInteger(node.value)) reject();
      return () => node.value;
    case 'UnaryExpression': {
      if (!['!', 'typeof', '-'].includes(node.operator)) reject();
      const value = nested(node.argument);
      if (node.operator === '!') return values => !value(values);
      if (node.operator === 'typeof') return values => typeof value(values);
      return values => -value(values);
    }
    case 'BinaryExpression': {
      const operator = comparisons.get(node.operator);
      if (!operator) reject();
      const left = nested(node.left);
      const right = nested(node.right);
      return values => limit(operator(left(values), right(values)));
    }
    case 'ConditionalExpression': {
      const condition = nested(node.test);
      const yes = nested(node.consequent);
      const no = nested(node.alternate);
      return values => condition(values) ? yes(values) : no(values);
    }
    case 'MemberExpression': {
      if (node.computed || node.property.name !== 'length') reject();
      const read = nested(node.object);
      return values => {
        const value = read(values);
        if (typeof value !== 'string') reject();
        return value.length;
      };
    }
    case 'CallExpression': {
      const member = node.callee;
      if (member.type !== 'MemberExpression' || member.computed) reject();
      const method = member.property.name;
      const range = textMethods.get(method);
      if (!range || node.arguments.length < range[0] || node.arguments.length > range[1]) reject();
      const read = nested(member.object);
      const builtin = String.prototype[method];
      let args;
      if (method === 'replace' || method === 'replaceAll') {
        const [find, replace] = node.arguments;
        if (find.type !== 'RegExpLiteral' && (find.type !== 'StringLiteral' || !find.value || find.value.length > 256)) reject();
        if (method === 'replaceAll' && find.type === 'RegExpLiteral' && !find.flags.includes('g')) reject();
        args = [find.type === 'RegExpLiteral' ? regexp(find) : nested(find), replacement(replace)];
      } else {
        args = node.arguments.map(nested);
      }
      return values => {
        const receiver = read(values);
        if (typeof receiver !== 'string') reject();
        return limit(Reflect.apply(builtin, receiver, args.map(arg => arg(values))));
      };
    }
    default:
      reject();
  }
}

function inputGuard(statement, parameter) {
  const test = statement.test;
  const body = statement.consequent.type === 'BlockStatement' ? statement.consequent.body : [statement.consequent];
  const error = body[0]?.argument;
  const checksType = node => node?.type === 'UnaryExpression' && node.operator === 'typeof' &&
    node.argument.type === 'Identifier' && node.argument.name === parameter;
  const message = error?.arguments?.[0];
  const safeMessage = message?.type === 'StringLiteral' || (message?.type === 'TemplateLiteral' &&
    message.expressions.length <= 1 && message.expressions.every(checksType));
  return !statement.alternate && test.type === 'BinaryExpression' && test.operator === '!==' &&
    checksType(test.left) &&
    test.right.type === 'StringLiteral' && test.right.value === 'string' && body.length === 1 &&
    body[0].type === 'ThrowStatement' && error?.type === 'NewExpression' && error.callee.name === 'TypeError' &&
    error.arguments.length === 1 && safeMessage;
}

function compileFunction(node) {
  if (node.async || node.generator || node.params.length !== 1 || node.params[0].type !== 'Identifier') reject();
  const parameter = node.params[0].name;
  const names = new Set([parameter]);
  const locals = new Map();
  if (node.body.type !== 'BlockStatement') return { output: expression(node.body, names), parameter, locals, returned: node.body };
  const body = node.body.body;
  if (body.length < 1 || body.length > 8 || body.at(-1).type !== 'ReturnStatement') reject();
  for (const [index, statement] of body.slice(0, -1).entries()) {
    if (index === 0 && statement.type === 'IfStatement' && inputGuard(statement, parameter)) continue;
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const' || statement.declarations.length !== 1) reject();
    const { id, init } = statement.declarations[0];
    if (id.type !== 'Identifier' || names.has(id.name)) reject();
    locals.set(id.name, expression(init, names));
    names.add(id.name);
  }
  const returned = body.at(-1);
  return { output: expression(returned.argument, names), parameter, locals, returned };
}

const functionType = node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);

function exportedFunctions(program) {
  const entries = [];
  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration' && functionType(statement.declaration)) {
      entries.push({ name: 'default', node: statement.declaration });
    } else if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'FunctionDeclaration') {
      entries.push({ name: statement.declaration.id.name, node: statement.declaration });
    } else if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration' &&
      statement.declaration.kind === 'const' && statement.declaration.declarations.every(item =>
        item.id.type === 'Identifier' && functionType(item.init))) {
      for (const item of statement.declaration.declarations) entries.push({ name: item.id.name, node: item.init });
    } else if (statement.type !== 'FunctionDeclaration') {
      // Import and module-level setup can change a function's behavior.
      return [];
    }
  }
  return entries;
}

function walk(node, visit, parent = null, depth = 0) {
  if (depth > 90) reject();
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, node, depth + 1);
    } else if (value && typeof value === 'object') {
      walk(value, visit, node, depth + 1);
    }
  }
}

const unknown = Symbol('unknown literal');

function literalValue(node, depth = 0) {
  if (!node || depth > 12) return unknown;
  if (['BooleanLiteral', 'NumericLiteral', 'StringLiteral'].includes(node.type)) return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'UnaryExpression') {
    if (node.operator === 'void') return undefined;
    const value = literalValue(node.argument, depth + 1);
    if (value !== unknown && node.operator === '!') return !value;
    if (typeof value === 'number' && node.operator === '-') return -value;
  }
  if (node.type === 'BinaryExpression' && comparisons.has(node.operator)) {
    const left = literalValue(node.left, depth + 1);
    const right = literalValue(node.right, depth + 1);
    if (left !== unknown && right !== unknown) return comparisons.get(node.operator)(left, right);
  }
  return unknown;
}

function literalTruth(node) {
  const value = literalValue(node);
  return value === unknown ? undefined : Boolean(value);
}

function argumentKind(node) {
  const value = literalValue(node);
  if (value !== unknown) return typeof value === 'string' ? 'text' : 'other';
  if (node.type === 'TemplateLiteral' || (node.type === 'UnaryExpression' && node.operator === 'typeof')) return 'text';
  if (['BigIntLiteral', 'RegExpLiteral', 'ObjectExpression', 'ArrayExpression', 'FunctionExpression',
    'ArrowFunctionExpression', 'ClassExpression', 'NewExpression', 'UnaryExpression'].includes(node.type)) return 'other';
  if (node.type === 'BinaryExpression') return node.operator === '+' ? 'unknown' : 'other';
  return 'unknown';
}

function abrupt(node, depth = 0) {
  if (depth > 30) return false;
  if (!node) return false;
  if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(node.type)) return true;
  if (node.type === 'BlockStatement') return node.body.some(child => abrupt(child, depth + 1));
  if (node.type === 'IfStatement') {
    const truth = literalTruth(node.test);
    return truth === true ? abrupt(node.consequent, depth + 1) : truth === false ? abrupt(node.alternate, depth + 1) :
      abrupt(node.consequent, depth + 1) && abrupt(node.alternate, depth + 1);
  }
  return false;
}

const optionalScope = /^(?:Function.*|ArrowFunctionExpression|ObjectMethod|Class(?:Private)?Method|WhileStatement|DoWhileStatement|For.*Statement|TryStatement|CatchClause|SwitchCase)$/;
const maybeExitScope = /^(?:BlockStatement|IfStatement|LabeledStatement|For.*Statement|WhileStatement|DoWhileStatement|SwitchStatement|TryStatement)$/;

function visibleCalls(node, visit, parent = null, conditional = false, depth = 0) {
  if (depth > 90) reject();
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, conditional);
  const read = (child, optional = conditional) => visibleCalls(child, visit, node, optional, depth + 1);
  if (['Program', 'BlockStatement', 'SwitchCase'].includes(node.type)) {
    if (node.type === 'SwitchCase') read(node.test, true);
    let optional = conditional || node.type === 'SwitchCase';
    for (const child of node.body || node.consequent) {
      read(child, optional);
      if (abrupt(child)) break;
      if (maybeExitScope.test(child.type)) optional = true;
    }
    return;
  }
  if (['IfStatement', 'ConditionalExpression'].includes(node.type)) {
    const truth = literalTruth(node.test);
    read(node.test);
    if (truth !== false) read(node.consequent, conditional || truth === undefined);
    if (truth !== true) read(node.alternate, conditional || truth === undefined);
    return;
  }
  if (node.type === 'LogicalExpression') {
    const value = literalValue(node.left);
    read(node.left);
    if (value === unknown || (node.operator === '&&' && value) ||
      (node.operator === '||' && !value) || (node.operator === '??' && value == null)) {
      read(node.right, conditional || value === unknown);
    }
    return;
  }
  if (node.type === 'WhileStatement' || node.type === 'ForStatement') {
    read(node.init);
    read(node.test, true);
    if (literalTruth(node.test) !== false) {
      read(node.body, true);
      read(node.update, true);
    }
    return;
  }
  const optional = conditional || optionalScope.test(node.type) || node.type.startsWith('Optional');
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => read(child, optional));
    else if (value && typeof value === 'object') read(value, optional);
  }
}

const kindFor = name => /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:[./]|$)|[._-](?:test|spec)\.[^.]+$/i.test(name) ?
  'test' : /(?:^|\/)(?:example|examples|sample|samples|demo|demos)(?:[./]|$)|[._-](?:example|demo)\.[^.]+$/i.test(name) ?
    'example' : 'application';
const symbol = /^[\p{L}_$][\p{L}\p{N}_$]{0,39}$/u;
const lineBreak = /\r\n|[\n\r\u2028\u2029]/;

function receiverName(node) {
  if (!['CallExpression', 'NewExpression', 'OptionalCallExpression'].includes(node?.type)) return '';
  const { callee } = node;
  const name = callee.type === 'Identifier' && symbol.test(callee.name) ? callee.name :
    ['MemberExpression', 'OptionalMemberExpression'].includes(callee.type) && !callee.computed &&
    callee.object.type === 'Identifier' && symbol.test(callee.object.name) && symbol.test(callee.property.name) ?
      callee.object.name + '.' + callee.property.name : '';
  return name ? (node.type === 'NewExpression' ? 'new ' + name : name) : '';
}

function isArgument(node, parent) {
  // A call has only one expression child outside its argument list, its callee.
  return Array.isArray(parent?.arguments) && node !== parent.callee &&
    node !== parent.typeArguments && node !== parent.typeParameters;
}

const credential = /(?:github_pat_|gh[pousr]_|xox[baprs]-|AKIA|AIza|sk-(?:proj-|ant-)?)[\w-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:authorization|api[_-]?key|password|secret|(?:access|auth)[_-]?token)\b\s*["']?\s*[:=]\s*["'`]\S/i;

function evidenceExcerpt(lines, node) {
  const { start, end } = node.loc;
  const line = lines[start.line - 1];
  if (!line || /[\x00-\x08\x0b-\x1f\x7f]/.test(line) || credential.test(line)) return '';
  const excerpt = line.slice(start.column, start.line === end.line ? end.column : undefined).trim();
  return excerpt.length <= 400 ? excerpt : '';
}

function consumerCalls(program, file, producerNames, budget) {
  const from = file.name;
  const aliases = new Map();
  const avaImports = new Set();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.attributes?.length || statement.assertions?.length || statement.phase) continue;
    const specifier = statement.source.value;
    if (specifier === 'ava') {
      for (const item of statement.specifiers) if (item.type === 'ImportDefaultSpecifier') avaImports.add(item.local.name);
    }
    if (!/^\.\.?\//.test(specifier)) continue;
    const target = path.normalize(path.join(path.dirname(from), specifier));
    if (target === from || !producerNames.has(target)) continue;
    for (const item of statement.specifiers) {
      const exported = item.type === 'ImportDefaultSpecifier' ? 'default' : item.type === 'ImportSpecifier' ?
        item.imported.name || item.imported.value : null;
      if (exported) aliases.set(item.local.name, target + '\0' + exported);
    }
  }
  if (!aliases.size) return new Map();
  const invalid = new Set();
  const referenced = new Map();
  const locations = new WeakMap();
  const calls = new Map();
  const kind = kindFor(from);
  const lines = file.text.split(lineBreak);
  let remaining = AST_FILE_BUDGET;
  const countNode = () => { if (--remaining < 0 || --budget.remaining < 0) reject(); };
  walk(program, (node, parent) => {
    countNode();
    locations.set(node, parent);
    if (node.type === 'Identifier') {
      if (aliases.has(node.name) && !['ImportSpecifier', 'ImportDefaultSpecifier'].includes(parent?.type) &&
        !(parent?.type === 'CallExpression' && parent.callee === node)) invalid.add(node.name);
      if (!referenced.has(node.name)) referenced.set(node.name, []);
      referenced.get(node.name).push(node);
    }
  });
  const importCall = node => {
    if (node?.type !== 'CallExpression' || node.callee.type !== 'Identifier' || invalid.has(node.callee.name) ||
      node.arguments.length !== 1 || node.arguments[0].type === 'SpreadElement') return null;
    const key = aliases.get(node.callee.name);
    if (!key) return null;
    const input = node.arguments[0];
    const type = argumentKind(input);
    return type === 'other' ? null : { key, input, type };
  };
  const checks = new WeakMap();
  const stableAva = new Set([...avaImports].filter(name => referenced.get(name).every(ref =>
    locations.get(ref)?.type === 'ImportDefaultSpecifier' ||
    (locations.get(ref)?.type === 'CallExpression' && locations.get(ref).callee === ref))));
  const comparison = (start, receiver) => {
    const { callee, arguments: args } = receiver;
    if (receiver.type !== 'CallExpression' || callee.type !== 'MemberExpression' || callee.computed ||
      callee.property.name !== 'is' || callee.object.type !== 'Identifier' || args.length < 2 || args[0] !== start) return false;
    let callback = locations.get(receiver);
    while (callback && !/^(?:Function.*|ArrowFunctionExpression|ObjectMethod|Class(?:Private)?Method)$/.test(callback.type)) {
      callback = locations.get(callback);
    }
    const binding = callback?.params?.[0];
    const invocation = locations.get(callback);
    if (binding?.type !== 'Identifier' || binding.name !== callee.object.name || invocation?.type !== 'CallExpression' ||
      !stableAva.has(invocation.callee.name) || !isArgument(callback, invocation)) return false;
    if (!checks.has(binding)) {
      checks.set(binding, referenced.get(binding.name).every(ref => {
        const member = locations.get(ref);
        const call = locations.get(member);
        return ref === binding || (member?.type === 'MemberExpression' && member.object === ref &&
          call?.type === 'CallExpression' && call.callee === member);
      }));
    }
    return checks.get(binding);
  };
  const add = (start, receiver, conditional, { key, input, type }) => {
    const existing = calls.get(key);
    if (existing?.length >= USE_LIMIT) return;
    const recipient = receiverName(receiver);
    if (!recipient || !start?.loc?.start?.line) return;
    const quote = evidenceExcerpt(lines, receiver.loc.start.line === start.loc.start.line ? receiver : start);
    const use = { path: from, line: start.loc.start.line, kind, recipient, conditional: conditional || type === 'unknown',
      ...(type === 'unknown' && { inputUncertain: true }),
      ...(input.type === 'StringLiteral' && !credential.test(input.value) && { sample: input.value }),
      ...(quote && { quote }),
      ...(kind === 'test' && comparison(start, receiver) && { effect: 'comparison' }) };
    if (existing) existing.push(use);
    else calls.set(key, [use]);
  };
  const initializers = new Map();
  // Only same-block, single-binding consts can carry a result between statements.
  // Any second declaration (including shadowing) or non-argument reference cancels that candidate.
  visibleCalls(program, (node, parent, conditional) => {
    countNode();
    if (isArgument(node, parent)) {
      const direct = importCall(node);
      if (direct) add(node, parent, conditional || parent.type.startsWith('Optional'), direct);
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
      parent?.type === 'VariableDeclaration' && parent.kind === 'const' && parent.declarations.length === 1) {
      const direct = importCall(node.init);
      if (!direct) return;
      const block = locations.get(parent);
      const refs = referenced.get(node.id.name);
      if (!['Program', 'BlockStatement'].includes(block?.type) || !refs.every(ref => ref === node.id ||
        isArgument(ref, locations.get(ref)))) return;
      initializers.set(node.id.name, { declaration: parent, block, conditional, direct });
    }
    if (node.type === 'Identifier' && isArgument(node, parent)) {
      const declaration = initializers.get(node.name);
      const statement = locations.get(parent);
      if (declaration && statement?.type === 'ExpressionStatement' &&
        locations.get(statement) === declaration.block && statement.start >= declaration.declaration.end) {
        add(node, parent, conditional || declaration.conditional || parent.type.startsWith('Optional'), declaration.direct);
      }
    }
  });
  return calls;
}

function sourcePrograms(files, parse) {
  return files.flatMap(file => {
    if (!extensions.test(file.name) || Buffer.byteLength(file.text) > SOURCE_LIMIT) return [];
    try {
      return [{ file, program: parse(file.text, { sourceType: 'module' }).program }];
    } catch {
      return [];
    }
  });
}

function discoverTrials(files, consumers, parse) {
  const producerPrograms = sourcePrograms(files, parse);
  const allConsumers = [...new Map((consumers || []).map(file => [file.name, file])).values()];
  const parsedNames = new Set(producerPrograms.map(({ file }) => file.name));
  const consumerPrograms = [...producerPrograms, ...sourcePrograms(allConsumers.filter(file => !parsedNames.has(file.name)), parse)];
  const exports = producerPrograms.map(({ file, program }) => ({ file, entries: exportedFunctions(program) }))
    .filter(({ entries }) => entries.length);
  const producerNames = new Set(exports.map(({ file }) => file.name));
  const usage = new Map();
  const budget = { remaining: AST_TOTAL_BUDGET };
  for (const { file, program } of consumerPrograms) {
    if (budget.remaining <= 0) break;
    try {
      for (const [key, calls] of consumerCalls(program, file, producerNames, budget)) {
        const prior = usage.get(key) || [];
        if (prior.length < USE_LIMIT) usage.set(key, [...prior, ...calls].slice(0, USE_LIMIT));
      }
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
    }
  }
  const trials = [];
  for (const { file, entries } of exports) {
    for (const entry of entries) {
      if (trials.length >= TRIAL_LIMIT) return trials;
      const uses = usage.get(file.name + '\0' + entry.name);
      if (!uses?.length) continue;
      try {
        const plan = compileFunction(entry.node);
        trials.push({ file, plan, uses, name: entry.name,
          symbol: entry.node.id?.name || (entry.name === 'default' ? '' : entry.name) });
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
      }
    }
  }
  return trials;
}

const useNames = { test: 'Test kodu', example: 'Örnek kod', application: 'Uygulama kodu' };
const knownRules = {
  trim: ['Kenar boşluklarını temizle', 'Yazının başındaki ve sonundaki boşlukları kaldırır.', 'Kenar boşlukları temizlenmiş bir metin.', '  Merhaba dünya  '],
  trimStart: ['Baştaki boşlukları temizle', 'Yazının başındaki boşlukları kaldırır.', 'Başındaki boşlukları temizlenmiş bir metin.', '  Merhaba dünya'],
  trimEnd: ['Sondaki boşlukları temizle', 'Yazının sonundaki boşlukları kaldırır.', 'Sonundaki boşlukları temizlenmiş bir metin.', 'Merhaba dünya  '],
  toLowerCase: ['Küçük harfe dönüştür', 'Yazıyı küçük harflere dönüştürür.', 'Küçük harflerle yazılmış metin.', 'Merhaba DÜNYA'],
  toUpperCase: ['Büyük harfe dönüştür', 'Yazıyı büyük harflere dönüştürür.', 'Büyük harflerle yazılmış metin.', 'Merhaba dünya'],
};

function selectedCharacters({ pattern, flags }) {
  if (!pattern.startsWith('[') || !pattern.endsWith(']') || flags.includes('i')) return [];
  const body = pattern.slice(1, -1);
  const characters = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\') characters.push(body[++i]);
    else if (char === '-' || (char === '^' && i === 0)) return [];
    else characters.push(char);
  }
  return [...new Set(characters)];
}

function explainRule({ plan, symbol: exported, name }) {
  const node = plan.returned.type === 'ReturnStatement' ? plan.returned.argument : plan.returned;
  const member = node.type === 'CallExpression' && node.callee;
  if (member?.type === 'MemberExpression' && !member.computed && member.object.type === 'Identifier' &&
    member.object.name === plan.parameter && !plan.locals.size) {
    if (!node.arguments.length && Object.hasOwn(knownRules, member.property.name)) return knownRules[member.property.name];
    const [find, replace] = node.arguments;
    if (['replace', 'replaceAll'].includes(member.property.name) && find.type === 'RegExpLiteral' &&
      find.flags.includes('g') && replace.value === '\\$&') {
      const characters = selectedCharacters(find);
      if (characters.length === 2 && characters.includes('"') && characters.includes('\\')) {
        return ['Çift tırnak ve ters eğik çizgiyi işaretle',
          'Metindeki her çift tırnağın (") ve ters eğik çizginin (\\) önüne bir ters eğik çizgi ekler.',
          'Çift tırnakların ve ters eğik çizgilerin işaretlendiği metin.', 'Adı "Deniz"'];
      }
      return ['Seçili işaretlere ters eğik çizgi ekle',
        'Metinde kaynak kuralına uyan her işaretin önüne ters eğik çizgi (\\) koyar.',
        'Eşleşen işaretlerin önüne ters eğik çizgi eklenmiş metin.', 'Fiyat: 10.50 + KDV?'];
    }
    if (['replace', 'replaceAll'].includes(member.property.name)) {
      return ['Metindeki eşleşmeleri değiştir', 'Yazıda eşleşen bölümleri kaynakta belirtilen kuralla değiştirir.',
        'Kaynakta belirtilen değiştirme kuralı uygulanmış bir metin.', 'Örnek metin'];
    }
  }
  const label = [exported, name === 'default' ? '' : name].find(value => value && symbol.test(value));
  return [label ? `${label} — Metni işle` : 'Dışarı açılan işlevle metni işle',
    'Verilen metni kaynakta tanımlanan kuralla işler ve bir değer döndürür.',
    'Bu metin için işlevin hesapladığı değer.', 'Örnek metin'];
}

function prepareTrial(trial) {
  const { file, plan, uses, name } = trial;
  const usable = value => typeof value === 'string' && value.length <= 2000 && !value.includes('\0');
  const [title, summary, output, example] = explainRule(trial);
  const sourceSample = uses.find(use => usable(use.sample))?.sample;
  const sampleInput = sourceSample ?? example;
  const start = plan.returned.loc.start.line;
  const end = plan.returned.loc.end.line;
  const verifiedUses = [...new Map(uses.map(({ path, line, kind, recipient, conditional, inputUncertain, effect, quote }) =>
    [`${path}:${line}:${recipient}`, { path, line, kind, recipient, conditional, inputUncertain, effect, quote,
      label: (effect === 'comparison' ? 'Test, çıkan metni beklenen metinle karşılaştırır.' :
        `${useNames[kind]} ${recipient} çağrısına girdi verir.`) +
        (inputUncertain ? ' Girdinin metin olup olmadığı kaynakta kesinleşmiyor.' : '') }])).values()].slice(0, 8);
  const relevantKinds = [...new Set(verifiedUses.map(use => use.kind))];
  const useGroups = new Map();
  for (const use of verifiedUses) {
    const key = use.kind + '\0' + use.recipient;
    const earlier = useGroups.get(key);
    if (!earlier || (earlier.inputUncertain && !use.inputUncertain) ||
      (!earlier.effect && use.effect && earlier.inputUncertain === use.inputUncertain)) useGroups.set(key, use);
  }
  const consumer = [...useGroups.values()].slice(0, 3).map(use =>
    (use.effect === 'comparison' ? 'Test, çıkan metni beklenen metinle karşılaştırır.' :
      `${useNames[use.kind]}, sonucu ${use.recipient} çağrısına girdi olarak veriyor.`) +
    (use.inputUncertain ? ' Kaynakta girdinin metin olduğu doğrulanamadı.' : '')).join(' ');
  const runner = (input, signal) => {
    signal?.throwIfAborted();
    if (!usable(input)) throw runError(400, 'Deneme metni en fazla 2.000 karakter olabilir ve boş karakter içeremez.');
    const values = new Map([[plan.parameter, input]]);
    try {
      for (const [name, calculate] of plan.locals) values.set(name, calculate(values));
      const output = plan.output(values);
      if (typeof output !== 'string' && typeof output !== 'boolean' && !Number.isFinite(output)) reject();
      return { output: String(output), detail: 'Bu değer, kaynakta okunan hesaplama kuralının verdiğin metne uygulanmasıyla üretildi.' };
    } catch (error) {
      if (error instanceof Unsupported) throw runError(422, 'Bu girdiyle desteklenen bir sonuç alınamadı.');
      throw error;
    }
  };
  return {
    job: {
      id: 'js:' + createHash('sha256').update(`${file.name}\0${name}\0${plan.returned.start}`).digest('hex').slice(0, 24),
      origin: 'source', title, summary, output, consumer,
      trigger: `İşlev metinle çağrıldığında çalışır. ${relevantKinds.map(kind => useNames[kind]).join(', ')} içindeki çağrı kaynakta görüldü.`,
      evidence: [
        { path: file.name, line: start, role: 'producer', label: 'İşlevin sonucunu döndürdüğü kaynak satırı',
          quote: evidenceExcerpt(file.text.split(lineBreak), plan.returned) || undefined },
        ...verifiedUses.map(use => ({ ...use, role: 'consumer' })),
      ],
    },
    span: { path: file.name, start, end },
    runner,
    fields: { mode: 'bounded', inputLabel: 'Örnek metin', sampleInput, verifiedUses,
      description: 'Kaynakta bulunan hesaplama kuralı bu metne tek başına uygulanır. Sonucu kullanan adım bu denemede çalışmaz.' },
  };
}

module.exports = { discoverTrials, prepareTrial };
