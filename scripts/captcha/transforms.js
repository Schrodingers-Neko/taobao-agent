'use strict';
const acorn = require('acorn');
const inspect = require('./static-source');
const { createMainGuard } = require('./main-runtime');
const { createRendererGuard } = require('./renderer-runtime');
const FILES = ['out/main/index.js', 'out/preload/index.js', 'out/preload/mtop.js'];
let cachedMainSource,cachedMainOutput;
function parse(source, file) {
  try { return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' }); }
  catch (e) { throw new Error('Unsupported ' + file + ' JavaScript: ' + e.message); }
}
function walk(n, fn) {
  if (!n || typeof n !== 'object') return;
  if (typeof n.type === 'string') fn(n);
  for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(x => walk(x, fn)) : v && typeof v === 'object' && walk(v, fn);
}
function one(list, test, label) {
  const hits = list.filter(test);
  if (hits.length !== 1) throw new Error('Unsupported client: expected one ' + label + ' anchor, found ' + hits.length);
  return hits[0];
}
function nodes(root) { const list = []; walk(root, n => list.push(n)); return list; }
function replaceOnce(source, anchor, value, label = anchor) {
  if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) throw new Error('Unsupported client: expected one ' + label + ' anchor.');
  return source.replace(anchor, value);
}
function edit(source, edits) {
  for (const [start, end, value] of edits.sort((a,b) => b[0]-a[0])) source = source.slice(0,start)+value+source.slice(end);
  return source;
}
function main(source) {
  if(source===cachedMainSource)return cachedMainOutput;
  if (source.includes('__taobaoCaptchaGuard')) throw new Error('CAPTCHA guard must be composed from the immutable baseline.');
  const { ast, evaluate, decoded } = inspect(source);
  const cls = name => one(ast.body, n => n.type === 'ClassDeclaration' && n.id?.name === name, name);
  const fn = name => one(ast.body, n => n.type === 'FunctionDeclaration' && n.id?.name === name, name);
  const member = (c, name) => one(c.body.body, m => (m.computed ? evaluate(m.key) : m.key.name) === name, c.id.name+'.'+name);
  const edits = [], insert = (at, text) => edits.push([at,at,text]);
  const host = cls('As');
  for (const m of ['resolveHomeViewContents','resolveWebviewContents','buildEnvParam','request','streamRequest','dispose']) member(host,m);
  insert(member(host,'constructor').value.body.end-1, ';__taobaoCaptchaGuard.bindHost(this);');
  for (const [name, method] of [['Gc','bindCredentials'],['rE','bindLogin']]) {
    const c = cls(name);
    for (const m of name === 'Gc' ? ['refresh','resetCache'] : ['syncLoginStatus']) member(c,m);
    insert(c.end, ';__taobaoCaptchaGuard.'+method+'('+name+'.prototype);');
  }
  const refresh=member(cls('Gc'),'refresh');
  insert(refresh.value.body.start+1,'const __captchaEpoch=this._captchaEpoch||0;');
  const loaded=one(nodes(refresh.value.body),n=>n.type==='VariableDeclaration'&&n.declarations.some(v=>v.id?.name==='_0x1813a7'),'credential result assignment');
  insert(loaded.end,'if(__captchaEpoch!==(this._captchaEpoch||0))throw __taobaoCaptchaGuard.error("ACCOUNT_CHANGED","账号已变化，丢弃旧凭据");');
  const dm = fn('Dm'), dispatcher = fn('jm');
  if (dm.params.length !== 1 || dispatcher.params.length !== 3) throw new Error('Unsupported guard/dispatcher signature.');
  insert(dm.params[0].end, ',__captchaLocal=false');
  const login = one(nodes(dm.body), n => n.type === 'IfStatement' && decoded(n.test).includes('"isLogin"'), 'local login check');
  insert(login.end, 'if(__captchaLocal)return null;');
  const authDecl = one(nodes(dispatcher), n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id?.name === '_0x2505bf'), 'native guard result');
  const authCall = one(nodes(authDecl), n => n.type === 'CallExpression' && n.arguments[0]?.name === 'Dm', 'guard invocation');
  const tool = dispatcher.params[0].name, args = dispatcher.params[1].left.name;
  edits.push([authCall.arguments[0].start,authCall.arguments[0].end,
    '(__source)=>Dm(__source,__taobaoCaptchaGuard.localTools.has('+tool+'))']);
  insert(authDecl.start, 'const __captchaBefore=__taobaoCaptchaGuard.nativeGate();if(__captchaBefore)return __captchaBefore;');
  const gate = one(nodes(dispatcher), n => n.type === 'IfStatement' && ['if(!1&&false)','if(_0x2505bf)'].some(s=>source.slice(n.start).startsWith(s)), 'gatekeeper condition');
  insert(gate.start, 'const __captchaAfter=__taobaoCaptchaGuard.nativeGate();if(__captchaAfter)return __captchaAfter;');
  insert(dispatcher.body.start+1,
    'if('+tool+'==="get_verification_status")return {result:__taobaoCaptchaGuard.status()};'+
    'if('+tool+'==="resume_after_verification")return __taobaoCaptchaGuard.resume('+args+'.challengeId);');
  const help = one(nodes(dispatcher), n => n.type==='IfStatement' && decoded(n.test).includes('"_help"'), '_help branch');
  const helpResult = one(nodes(help), n => n.type==='ReturnStatement', '_help return');
  insert(helpResult.start, '_0x5bc214.result?.tools?.push(...__taobaoCaptchaGuard.tools);');
  const outerCatch = one(nodes(dispatcher), n => n.type==='CatchClause' && n.param?.name === '_0x593378', 'native structured error catch');
  insert(outerCatch.body.start+1, 'if(_0x593378?.code&&_0x593378.retryable===false)return {error:_0x593378};');
  const fetch = member(cls('Wc'),'fetchOnce');
  const networkCatch = one(nodes(fetch.value.body), n => n.type==='CatchClause' && decoded(n.body).includes('NETWORK_ERROR'), 'credential transport catch');
  insert(networkCatch.body.start+1, 'if(["MTOP_NOT_READY","CAPTCHA_REQUIRED","REQUEST_CANCELLED","RENDERER_DESTROYED","CLIENT_DISPOSED","SDK_UNSUPPORTED"].includes('+networkCatch.param.name+'?.code))throw '+networkCatch.param.name+';');
  let result = edit(source,edits);
  result = '"use strict";const __taobaoCaptchaGuard=('+createMainGuard.toString()+')(require("electron"),()=> $m);\n'+result;
  parse(result,'patched main');
  const signature=source.slice(gate.start,gate.start+13);replaceOnce(result,signature,signature,'preserved gatekeeper signature');
  cachedMainSource=source;cachedMainOutput=result;
  return result;
}
function renderer(source, relative) {
  if(source.includes('__taobaoCaptchaRenderer'))throw new Error('Renderer guard baseline is already patched.');
  let out=source;
  const prelude='"use strict";const __taobaoCaptchaRenderer=('+createRendererGuard.toString()+')(require("electron").ipcRenderer,window,document);\n';
  if(relative==='out/preload/index.js') {
    out=replaceOnce(out,'function k(e,t){','function k(e,t){if(e==="lib.mtop")t=__taobaoCaptchaRenderer.sdkCallback(t);','home SDK watcher');
    const tree=parse(out,relative), statements=tree.body.filter(n=>n.type==='ExpressionStatement');
    const chain=one(statements,n=>nodes(n).filter(c=>c.type==='CallExpression'&&c.callee.type==='MemberExpression'&&c.callee.object.name==='ne'&&c.callee.property.name==='use').length===3,'stream middleware chain');
    out=out.slice(0,chain.end)+';__taobaoCaptchaRenderer.installStream(ne);'+out.slice(chain.end);
    out=replaceOnce(out,'Q(i,{method:e.params.method,','Q(i,{signal:e.params.__captchaScope?.signal,method:e.params.method,','stream AbortSignal');
    out=replaceOnce(out,'start(c){var l,d,p,m;Q(i,','start(c){const __scope=e.params.__captchaScope;const __stop=()=>{try{c.error(__scope.reason)}catch{}};__scope?.cleanups.add(__stop);var l,d,p,m;Q(i,','stream reader cancellation');
    out=replaceOnce(out,'onerror(e){throw c.error(e),r||n(e),e}','onerror(e){__scope?.cleanups.delete(__stop);throw c.error(e),r||n(e),e}','stream error cleanup');
    out=replaceOnce(out,'onclose(){try{c.close()}catch{}}','onclose(){__scope?.cleanups.delete(__stop);try{c.close()}catch{}}','stream close cleanup');
    out=replaceOnce(out,'await async function(e,t){const n=e.getReader();let o;for(;!(o=await n.read()).done;)t(o.value)}',
      'await async function(e,t){const n=e.getReader();let o;try{for(;!(o=await n.read()).done;)t(o.value)}finally{n.releaseLock()}}','stream transport reader cleanup');
    out=replaceOnce(out,'function y(){document.removeEventListener("visibilitychange",u),','function y(){n?.removeEventListener("abort",__captchaAbort);document.removeEventListener("visibilitychange",u),','stream listener cleanup');
    out=replaceOnce(out,'null==n||n.addEventListener("abort",()=>{y(),t()});','const __captchaAbort=()=>{y(),t()};null==n||n.addEventListener("abort",__captchaAbort,{once:true});','stream abort handler');
    out=replaceOnce(out,'}v()})}function Y(e)', '}if(n?.aborted){t()}else v()})}function Y(e)','cancelled stream admission');
    out=replaceOnce(out,'window.lib.mtop.request(t).then(', '__taobaoCaptchaRenderer.installSDK(window.lib.mtop);window.lib.mtop.request(t).then(','native home SDK installation');
    out=replaceOnce(out,'mtopId:t.mtopId,error:n','mtopId:t.mtopId,error:n','home structured stream error');
  } else if(relative==='out/preload/mtop.js') {
    out=replaceOnce(out,'!function(e,t){','!function(e,t){if(e==="lib.mtop")t=__taobaoCaptchaRenderer.sdkCallback(t);','webview SDK watcher');
    out=replaceOnce(out,'window.lib.mtop.request(t).then(', '__taobaoCaptchaRenderer.installSDK(window.lib.mtop);window.lib.mtop.request(t).then(','webview SDK installation');
    out=replaceOnce(out,'error:o?.message||"Stream request failed"','error:o?.code?o:o?.message||"Stream request failed"','webview structured stream error');
    out=replaceOnce(out,'if(o?.requestStream){','if(o?.requestStream){if(o.CLASS)__taobaoCaptchaRenderer.installStream(o.CLASS);else if(o.prototype?.requestStream)__taobaoCaptchaRenderer.installStream(o);else throw {code:"SDK_UNSUPPORTED",message:"未识别的流式 SDK",retryable:false};','webview stream admission');
  } else throw new Error('Unknown CAPTCHA preload target.');
  out=prelude+out;parse(out,relative+' patched');return out;
}
function compose(files) {
  return Object.fromEntries(FILES.map(p=>[p,p==='out/main/index.js'?main(files[p]):renderer(files[p],p)]));
}
module.exports={FILES,main,renderer,compose,parse};
