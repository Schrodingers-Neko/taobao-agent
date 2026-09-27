const acorn = require('acorn');
// Evaluate only the vendor string table and pure decoder expressions; never execute the bundle.
module.exports = function inspect(source) {
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const scopes = new WeakMap();
function children(node) {
  return Object.values(node).flatMap(x => Array.isArray(x) ? x : [x]).filter(x => x && typeof x.type === 'string');
}
function scopeTree(node, parent, declarationKind) {
  let scope = parent;
  if (node.type === 'Program' || /Function/.test(node.type) || node.type === 'BlockStatement') scope = { parent, bindings: new Map() };
  scopes.set(node, scope);
  if (node.type === 'FunctionDeclaration') parent.bindings.set(node.id.name, node);
  if (/Function/.test(node.type)) for (const p of node.params) if (p.type === 'Identifier') scope.bindings.set(p.name, null);
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') scope.bindings.set(node.id.name, declarationKind === 'const' ? node.init : null);
  for (const child of children(node)) scopeTree(child, scope, node.type === 'VariableDeclaration' ? node.kind : declarationKind);
}
scopeTree(ast, null);
function binding(name, scope) {
  for (let s = scope; s; s = s.parent) if (s.bindings.has(name)) return s.bindings.get(name);
  throw Error('Unknown binding ' + name);
}
let table, offset, rotated = false;
function decode(value) {
  const custom = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return Buffer.from(value.replace(/[a-zA-Z0-9+/]/g, c => standard[custom.indexOf(c)]), 'base64').toString('utf8');
}
function evaluate(node, scope = scopes.get(node), env = new Map(), depth = 0) {
  if (!node || depth > 80) throw Error('Unsupported/cyclic');
  const ev = x => evaluate(x, scopes.get(x) || scope, env, depth + 1);
  switch (node.type) {
    case 'Literal': return node.value;
    case 'Identifier': return env.has(node.name) ? env.get(node.name) : ev(binding(node.name, scope));
    case 'UnaryExpression': {
      const v = ev(node.argument);
      if (node.operator === '-') return -v;
      if (node.operator === '+') return +v;
      if (node.operator === '!') return !v;
      if (node.operator === '~') return ~v;
      throw Error('Unary');
    }
    case 'ArrayExpression': return node.elements.map(ev);
    case 'ObjectExpression': return Object.fromEntries(node.properties.map(p => [p.computed ? ev(p.key) : p.key.name || p.key.value, ev(p.value)]));
    case 'MemberExpression': {
      const obj = ev(node.object), key = node.computed ? ev(node.property) : node.property.name;
      if (!Object.hasOwn(obj, key)) throw Error('Unknown property');
      return obj[key];
    }
    case 'BinaryExpression': {
      const a = ev(node.left), b = ev(node.right);
      switch (node.operator) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b;
        case '%': return a % b; case '===': return a === b; case '!==': return a !== b;
        case '==': return a == b; case '<': return a < b; case '>': return a > b;
        case '>>': return a >> b; case '&': return a & b; case '^': return a ^ b;
        default: throw Error('Binary');
      }
    }
    case 'CallExpression': {
      const args = node.arguments.map(ev);
      if (node.callee.type === 'Identifier' && node.callee.name === 'parseInt') return parseInt(...args);
      if (node.callee.type === 'Identifier' && node.callee.name === '_0x_0x391f') return decode(table[args[0] - offset]);
      const fn = ev(node.callee);
      if (!fn || !/Function/.test(fn.type)) throw Error('Non-static call');
      const next = new Map(env);
      fn.params.forEach((p, i) => { if (p.type !== 'Identifier') throw Error('Parameter'); next.set(p.name, args[i]); });
      const body = fn.body.type === 'BlockStatement' ? fn.body.body : [{ type: 'ReturnStatement', argument: fn.body }];
      if (body.some(s => !['VariableDeclaration', 'FunctionDeclaration', 'ReturnStatement'].includes(s.type))) throw Error('Impure function');
      const ret = body.find(s => s.type === 'ReturnStatement');
      if (!ret) throw Error('No static return');
      return evaluate(ret.argument, scopes.get(ret.argument), next, depth + 1);
    }
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': return node;
    default: throw Error('Unsupported ' + node.type);
  }
}
const decoder = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === '_0x_0x391f');
offset = evaluate(decoder.body.body[0].expression.right.right);
const tableFn = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === '_0x_0x19af');
table = evaluate(tableFn.body.body[0].declarations[0].init);
const rotation = ast.body.find(n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' && n.expression.callee.type === 'FunctionExpression' && n.expression.arguments[0]?.name === '_0x_0x19af');
const target = evaluate(rotation.expression.arguments[1]);
let checksum;
function find(node, test) { if (test(node)) return node; for (const c of children(node)) { const hit = find(c, test); if (hit) return hit; } }
checksum = find(rotation.expression.callee, n => n.type === 'VariableDeclarator' && n.id.name === '_0x46647b').init;
let rotations = 0;
for (; rotations < table.length; rotations++) {
  try { if (evaluate(checksum) === target) { rotated = true; break; } } catch {}
  table.push(table.shift());
}
if (!rotated) throw Error('String-table rotation failed');
function decoded(node) {
  const changes = [];
  function visit(n) {
    if (['CallExpression','BinaryExpression','UnaryExpression','MemberExpression'].includes(n.type)) {
      try {
        const value = evaluate(n);
        if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') {
          changes.push([n.start, n.end, ' ' + JSON.stringify(value) + ' ']); return;
        }
      } catch {}
    }
    for (const c of children(n)) visit(c);
  }
  visit(node);
  let out = source.slice(node.start, node.end);
  for (const [start, end, value] of changes.sort((a,b) => b[0]-a[0])) out = out.slice(0,start-node.start)+value+out.slice(end-node.start);
  return out;
}

return { ast, evaluate, decoded, children, find };
};
