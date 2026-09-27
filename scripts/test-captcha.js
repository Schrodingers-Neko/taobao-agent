#!/usr/bin/env node
'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),os=require('os');
const {EventEmitter}=require('events');
const acorn=require('acorn'),asar=require('@electron/asar');
const {createMainGuard}=require('./captcha/main-runtime'),{createRendererGuard}=require('./captcha/renderer-runtime');
const {Clock,Element,environment,flush}=require('./captcha/test-environment');
const d=require('./declutter'),transforms=require('./captcha/transforms');
const success={ret:['SUCCESS::调用成功'],data:{ok:true}};
const challenge={ret:['RGV587_ERROR::SM'],data:{url:'https://h5.m.taobao.com/verify?test=offline'}};
const param={api:'mtop.test.fixture',v:'1.0',data:{fixture:true},H5Request:true,dataType:'json'};
let sdkSource,preloadSource;
function setup(){
  const ipc=new EventEmitter(),clock=new Clock();let user={isLogin:true,userId:'account-a'},current;
  const manager={browser:{get currentView(){return current&&{webContents:current.wc};}},showWindow(){}};
  const context=()=>({pluginManager:{getPlugin:n=>n==='navigation'?{getUserInfo:()=>user}:manager}});
  const main=createMainGuard({ipcMain:ipc},context,clock);
  const a=environment(ipc,1,clock),b=environment(ipc,2,clock);current=a;
  for(const e of [a,b])e.guard=createRendererGuard(e.ipc,e.win,e.doc);
  return {ipc,clock,main,a,b,setUser:v=>user=v,manager};
}
function loadSDK(e,guarded=true){
  if(!guarded)e.win.lib={};
  const globals={window:e.win,document:e.doc,navigator:e.win.navigator,location:e.win.location,Promise,console,Date,
    setTimeout:e.clock.setTimeout,clearTimeout:e.clock.clearTimeout};
  vm.runInNewContext(sdkSource+';window.JSON=JSON;',globals,{timeout:1000});
  const sdk=e.win.lib.mtop;sdk.config.H5Request=true;sdk.config.AntiCreep=true;sdk.config.AntiFlood=true;
  // The desktop has already completed its SDK warmup before the order workload.
  sdk.CLASS.__firstProcessor=Promise.resolve();
  if(guarded)e.guard.installSDK(sdk);
  return sdk;
}
function complete(s,e=s.a){
  const frame=e.doc.body.querySelectorAll('iframe')[0];assert(frame);
  e.win.dispatchEvent({type:'message',source:frame.contentWindow,origin:'https://h5.m.taobao.com',
    data:JSON.stringify({type:'child',content:encodeURIComponent(JSON.stringify({_m_h5_smt:'verified-fixture'}))})});
  assert.equal(s.main.status().state,'verified_awaiting_confirmation');
  return s.main.status().challengeId;
}
async function vendorDefect(){
  const s=setup(),sdk=loadSDK(s.a,false),pending=[];
  for(let i=0;i<20;i++)pending.push(sdk.request({...param}));
  await flush();for(const x of s.a.transports)x.respond(challenge);await flush();
  assert.equal(s.a.doc.body.querySelectorAll('iframe').length,20);
  assert.equal(s.a.win.listenerCount('message'),20);
  // Close fixture widgets cleanly; no requests are sent to Taobao.
  for(const root of [...s.a.doc.body.children])root.dispatchEvent({type:'close'});
  await Promise.allSettled(pending);s.a.guard.unload();s.b.guard.unload();s.main.dispose();
  console.log('PASS: original ordinary SDK reproduces 20 stacked dialogs.');
}
async function ordinary(){
  const s=setup(),sdkA=loadSDK(s.a),sdkB=loadSDK(s.b),pending=[];
  for(let i=0;i<20;i++)pending.push((i%2?sdkA:sdkB).request({...param}).catch(e=>e));
  await flush();assert.equal(s.a.transports.length+s.b.transports.length,20);
  for(const x of [...s.a.transports,...s.b.transports])x.respond(challenge);await flush();
  const results=await Promise.all(pending);assert(results.every(e=>['CAPTCHA_REQUIRED','REQUEST_CANCELLED'].includes(e.code)));
  assert.equal(s.a.doc.body.querySelectorAll('iframe').length+s.b.doc.body.querySelectorAll('iframe').length,1);
  assert.equal(s.main.status().state,'verification_required');
  const count=s.a.transports.length+s.b.transports.length;
  await assert.rejects(sdkA.request(param),e=>e.code==='CAPTCHA_REQUIRED');assert.equal(s.a.transports.length+s.b.transports.length,count);
  const frame=s.a.doc.body.querySelectorAll('iframe')[0],message={type:'child',content:encodeURIComponent(JSON.stringify({token:'x'}))};
  for(const ev of [{origin:'https://evil.example',source:frame.contentWindow},{origin:'https://h5.m.taobao.com',source:{}},
    {origin:'https://h5.m.taobao.com',source:frame.contentWindow,data:'malformed'}])s.a.win.dispatchEvent({type:'message',data:message,...ev});
  assert.equal(s.main.status().state,'verification_required');
  assert.equal(s.main.resume(s.main.status().challengeId).error.code,'CAPTCHA_REQUIRED');
  const close=s.a.doc.body.querySelectorAll('button').find(x=>x.textContent.startsWith('关闭'));close.onclick();
  assert.equal(s.main.status().dialogOpen,false);assert.equal(s.a.doc.body.querySelectorAll('iframe').length,0);
  const control=s.a.doc.body.children.find(x=>x.textContent==='重新打开验证');control.onclick();
  const id=complete(s);
  assert.equal(s.main.resume('stale').error.code,'STALE_CHALLENGE');
  await assert.rejects(sdkA.request(param),e=>e.code==='CAPTCHA_REQUIRED');
  assert.equal(s.main.resume(id).result.state,'idle');assert.equal(s.main.resume(id).error.code,'STALE_CHALLENGE');
  assert.equal(s.a.transports.length+s.b.transports.length,count,'resume must never replay requests');
  const unrelated=s.a.guard.begin({...param,api:'different'});assert.equal(unrelated.verification,undefined);unrelated.finish();
  const serialized=typeof param.data==='string'?param.data:JSON.stringify(param.data);
  const fresh=s.a.guard.begin({...param,data:serialized});assert.equal(fresh.verification._m_h5_smt,'verified-fixture');fresh.finish();
  const consumed=s.a.guard.begin({...param,data:serialized});assert.equal(consumed.verification,undefined);consumed.finish();
  for(const e of [s.a,s.b]){assert.equal(e.guard.counters().requests,0);assert.equal(e.win.listenerCount('message'),0);e.guard.unload();}
  assert.equal(s.clock.timers.size,0);assert.equal(s.main.status().counters.requests,0);s.main.dispose();
  console.log('PASS: 20 challenges across two renderers, one dialog, pause, strict message validation, close/reopen, explicit resume and no replay.');
}
async function lifecycle(){
  const s=setup(),sdk=loadSDK(s.a);
  for(let i=0;i<30;i++){
    const p=sdk.request({...param});await flush();s.a.transports.at(-1).respond(success);assert.equal((await p).retType,sdk.RESPONSE_TYPE.SUCCESS);await flush();
    assert.equal(s.a.guard.counters().requests,0);assert.equal(s.clock.timers.size,0);
  }
  const timeout=sdk.request({...param,timeout:10}).catch(e=>e);await flush();const xhr=s.a.transports.at(-1);
  s.clock.tick(11);await flush();assert.equal((await timeout).code,'REQUEST_TIMEOUT');assert(xhr.aborted);
  xhr.respond(challenge);await flush();assert.equal(s.main.status().state,'idle');assert.equal(s.clock.timers.size,0);
  const jsonp=sdk.request({...param,dataType:'jsonp',timeout:20}).catch(e=>e);await flush();
  assert(s.a.doc.head.children.some(x=>x.tag==='script'));s.clock.tick(21);await jsonp;await flush();
  assert.equal(s.a.doc.head.children.length,0);assert.equal(Object.keys(s.a.win).filter(k=>k.startsWith('taobaoGuardJsonp')).length,0);
  const unloaded=sdk.request(param).catch(e=>e);await flush();s.a.guard.unload();await unloaded;await flush();
  assert.equal(s.clock.timers.size,0);assert.equal(s.main.status().counters.requests,0);s.b.guard.unload();s.main.dispose();
  console.log('PASS: repeated ordinary requests, XHR/JSONP timeout and cleanup, renderer unload, and late challenged responses.');
}
async function native(){
  const s=setup(),host={mtopId:0,disposed:false,_homeViewReady:true,_webviewReady:false,resolveHomeViewContents:()=>s.a.wc,resolveWebviewContents:()=>null,buildEnvParam:()=>({}),dispose(){this.disposed=true;}};
  s.main.bindHost(host);
  await assert.rejects(host.request({...param,useWebview:true}),e=>e.code==='MTOP_NOT_READY');
  const baseline=s.ipc.eventNames().map(n=>[n,s.ipc.listenerCount(n)]);
  const send=s.a.wc.send;
  s.a.wc.send=(n,data)=>{send(n,data);if(n==='mtop-response')s.ipc.emit('mtop-response-callback:'+data.mtopId,{sender:s.a.wc},{mtopId:data.mtopId,res:success});};
  for(let i=0;i<30;i++)assert.deepEqual(await host.request(param),success);
  assert.deepEqual(s.ipc.eventNames().map(n=>[n,s.ipc.listenerCount(n)]),baseline);assert.equal(s.clock.timers.size,0);
  s.a.wc.send=send;
  const p=host.request({...param,timeout:10}).catch(e=>e),id=host.mtopId;
  s.clock.tick(11);assert.equal((await p).code,'REQUEST_TIMEOUT');
  assert.equal(s.a.guard.begin.bind(s.a.guard) instanceof Function,true);
  assert.throws(()=>s.a.guard.begin({...param,mtopId:id}),e=>e.code==='REQUEST_CANCELLED');
  s.ipc.emit('mtop-response-callback:'+id,{sender:s.a.wc},{mtopId:id,res:challenge});assert.equal(s.main.status().state,'idle');
  const pending=host.request(param).catch(e=>e);s.a.wc.destroy();assert.equal((await pending).code,'RENDERER_DESTROYED');
  s.a.guard.unload();s.b.guard.unload();host.dispose();assert.equal(s.ipc.eventNames().length,0);
  console.log('PASS: listener-before-send, native timeout, cancellation admission, missing readiness and renderer destruction.');
}
async function auth(){
  const s=setup();let calls=0;
  class Creds {
    refresh(){if(this.inflight)return this.inflight;calls++;return this.inflight=Promise.reject({code:'NETWORK_ERROR'}).finally(()=>this.inflight=null);}
    resetCache(){this.inflight=null;}
  }
  s.main.bindCredentials(Creds.prototype);const c=new Creds();
  await Promise.allSettled([c.refresh(),c.refresh()]);assert.equal(calls,1);
  s.clock.tick(59999);await assert.rejects(c.refresh());assert.equal(calls,1);
  s.clock.tick(1);await assert.rejects(c.refresh());assert.equal(calls,2);
  c.resetCache();await assert.rejects(c.refresh());assert.equal(calls,3);
  let warmups=0;class Login{syncLoginStatus(){warmups++;return Promise.resolve();}}
  s.main.bindLogin(Login.prototype);const login=new Login();
  await Promise.all([login.syncLoginStatus(true),login.syncLoginStatus(true),login.syncLoginStatus(true)]);assert.equal(warmups,1);
  s.setUser({isLogin:true,userId:'account-b'});await login.syncLoginStatus(true);assert.equal(warmups,2);
  await assert.rejects(c.refresh());assert.equal(calls,4);assert.equal(s.clock.timers.size,0);
  const host={mtopId:0,disposed:false,_homeViewReady:true,_webviewReady:false,resolveHomeViewContents:()=>s.a.wc,resolveWebviewContents:()=>s.b.wc,buildEnvParam:()=>({}),dispose(){}};
  s.main.bindHost(host);s.ipc.on('mtop-webview-ready',ev=>{host.mtopWebviewContents=ev.sender;host._webviewReady=true;});
  s.b.ipc.send('mtop-webview-ready');await flush();await assert.rejects(c.refresh());assert.equal(calls,5);
  s.b.ipc.send('mtop-webview-ready');await flush();await assert.rejects(c.refresh());assert.equal(calls,5,'identical ready notifications must not repeatedly reset cooldown');
  s.setUser({isLogin:false,userId:''});assert.equal(s.main.nativeGate().error.code,'LOGIN_REQUIRED');
  assert.deepEqual([...s.main.localTools],['get_current_tab','list_available_pages','navigate','navigate_to_url','close_page','read_page_content','scroll_page','inspect_page','scan_page_elements','click_element','input_text','keyboard']);
  s.a.guard.unload();s.b.guard.unload();s.main.dispose();
  console.log('PASS: concurrent refresh deduplication, 60-second cooldown boundaries, account change and login synchronization.');
}
async function loadingView(){
  const s=setup(),body=s.a.doc.body,root=s.a.doc.documentElement;s.a.doc.body=null;s.a.doc.documentElement=null;
  const p=s.a.guard.begin(param);assert.throws(()=>s.a.guard.inspect(p,challenge),e=>e.code==='CAPTCHA_REQUIRED');p.finish();
  assert.equal(s.main.status().state,'verification_required');assert.equal(s.a.doc.listenerCount('DOMContentLoaded'),1);
  s.a.doc.body=body;s.a.doc.documentElement=root;s.a.doc.dispatchEvent({type:'DOMContentLoaded'});
  assert.equal(body.querySelectorAll('iframe').length,1);assert.equal(s.a.doc.listenerCount('DOMContentLoaded'),0);
  s.a.guard.unload();s.b.guard.unload();s.main.dispose();console.log('PASS: challenge presentation waits for a loading visible view without leaking listeners.');
}
function loadStream(e,guarded=true){
  const source=guarded?transforms.renderer(preloadSource,'out/preload/index.js'):preloadSource;
  const start=source.indexOf('var R=Object.defineProperty');
  const ast=acorn.parse(source,{ecmaVersion:'latest'});
  const chain=ast.body.find(n=>n.type==='ExpressionStatement'&&source.slice(n.start,n.end).startsWith('ne.use('));
  assert(start>0&&chain);
  const globals={window:e.win,document:e.doc,navigator:e.win.navigator,location:e.win.location,Promise,console,Date,
    AbortController,ReadableStream,TextDecoder,setTimeout:e.clock.setTimeout,clearTimeout:e.clock.clearTimeout};
  vm.runInNewContext(source.slice(start,chain.end)+';globalThis.Stream=ne;',globals,{timeout:1000});
  if(guarded)e.guard.installStream(globals.Stream);
  return globals.Stream;
}
async function streaming(){
  for(const mixed of [false,true]){
    const s=setup(),sa=loadStream(s.a),sb=loadStream(s.b),sdkA=loadSDK(s.a),sdkB=loadSDK(s.b);
    const fetches=[],pending=[];
    const fakeFetch=(url,options)=>new Promise(resolve=>fetches.push({url,options,resolve}));
    for(let i=0;i<20;i++){
      const e=i%2?s.a:s.b;
      if(mixed&&i%3===0)pending.push((e===s.a?sdkA:sdkB).request({...param}).catch(e=>e));
      else pending.push(new(e===s.a?sa:sb)({...param,experimental:{fetch:fakeFetch}}).requestStream().catch(e=>e));
    }
    await flush();assert.equal(fetches.length+s.a.transports.length+s.b.transports.length,20);
    for(const f of fetches)f.resolve({headers:{get:()=> 'application/json'},clone:()=>({json:async()=>challenge}),
      body:{getReader:()=>({read:async()=>({done:true}),releaseLock(){}})}});
    for(const x of [...s.a.transports,...s.b.transports])x.respond(challenge);
    await flush();const results=await Promise.all(pending);assert(results.every(e=>['CAPTCHA_REQUIRED','REQUEST_CANCELLED'].includes(e.code)));
    assert.equal(s.a.doc.body.querySelectorAll('iframe').length+s.b.doc.body.querySelectorAll('iframe').length,1);
    const count=fetches.length;
    await assert.rejects(new sa({...param,experimental:{fetch:fakeFetch}}).requestStream(),e=>e.code==='CAPTCHA_REQUIRED');assert.equal(fetches.length,count);
    const id=complete(s);s.main.resume(id);assert.equal(fetches.length,count);
    for(const e of [s.a,s.b]){assert.equal(e.guard.counters().requests,0);assert.equal(e.doc.listenerCount('visibilitychange'),0);e.guard.unload();}
    assert(fetches.every(f=>f.options.signal.aborted));assert.equal(s.clock.timers.size,0);s.main.dispose();
  }
  console.log('PASS: 20 streaming and mixed ordinary/streaming challenges across two renderers; one dialog, AbortSignal cleanup and no replay.');
}
async function main(){
  if(process.argv.includes('--interrupt-guard')){const o=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--interrupt-guard')+1]));await d.applyDeclutter('captcha-guard',{...o,hooks:{afterArchiveWrite(){process.exit(42);}}});throw Error('Interruption hook did not run');}
  const fixture=path.join(__dirname,'captcha/fixtures/mtop-2.4.16.txt');
  sdkSource=fs.readFileSync(fixture,'utf8');
  const live=d.context();const manifest=JSON.parse(fs.readFileSync(live.manifestPath));
  const archive=manifest.baseline.archive.file,files=Object.fromEntries(transforms.FILES.map(p=>[p,asar.extractFile(archive,path.join(...p.split('/'))).toString()]));
  preloadSource=files['out/preload/index.js'];
  await vendorDefect();await ordinary();await lifecycle();await native();await auth();await streaming();await loadingView();
  const e={code:'CAPTCHA_REQUIRED',message:'paused',challengeId:'test',retryable:false};
  const bridge=require('../taobao-mcp-bridge');assert.deepEqual(JSON.parse(bridge.serializeToolError(e)),e);assert.equal(bridge.serializeToolError('legacy'),'legacy');
  assert.equal(bridge.nativeToolError({error:e}),e);assert.equal(bridge.nativeToolError({result:{error:e}}),e);assert.equal(bridge.nativeToolError({result:e}),e);assert.equal(bridge.nativeToolError({error:'legacy'}),'legacy');assert.equal(bridge.nativeToolError({result:{data:{ok:true}}}),null);
  let launches=0,calls=0;
  const closed={call:async()=>{calls++;throw Object.assign(new Error('closed'),{code:'ENOENT'});},launch:async()=>{launches++;}};
  for(const tool of ['_help','get_verification_status','resume_after_verification'])await assert.rejects(bridge.rpcWithRetry({tool},closed),/closed/);
  assert.equal(launches,0);assert.equal(calls,3);
  calls=0;assert.deepEqual(await bridge.rpcWithRetry({tool:'navigate'},{call:async()=>{if(++calls===1)throw Object.assign(new Error('closed'),{code:'ENOENT'});return {result:'ready'};},launch:async()=>{launches++;}}),{result:'ready'});
  assert.equal(launches,1);assert.equal(calls,2);
  calls=0;assert.deepEqual(await bridge.rpcWithRetry({tool:'navigate'},{call:async()=>{calls++;return {error:e};},launch:async()=>assert.fail('Structured errors must not retry')}),{error:e});assert.equal(calls,1);
  const output=transforms.compose(files);for(const [p,s]of Object.entries(output))new vm.Script(s,{filename:p});
  assert.throws(()=>transforms.main(files['out/main/index.js'].replace('async function Dm(', 'async function UnsupportedGuard(')),/Unsupported/);
  console.log('PASS: bridge structured errors, real installed source anchors, bundle syntax and unsupported source rejection.');
  await guardCallChain(output['out/main/index.js']);
  await require('./captcha/test-install').runFixtures(files,archive);
  if(process.argv.includes('--install')||process.argv.includes('--smoke-install'))await require('./captcha/test-install').run(files,archive,process.argv.includes('--smoke-install'));
}
async function guardCallChain(source){
  const decoded=require('./captcha/static-source')(source);
  const dm=decoded.decoded(decoded.ast.body.find(n=>n.id?.name==='Dm'));
  const wc=decoded.decoded(decoded.ast.body.find(n=>n.id?.name==='Wc'));
  const s=setup();let requests=0,loggedIn=true;
  const plugin={getPlugin:n=>n==='navigation'?{getUserInfo:()=>({isLogin:loggedIn})}:n==='window-manager'?{mtop:{request:async()=>{requests++;return {data:{value:true}};}}}:null};
  const globals={$m:{pluginManager:plugin},Lm:0,Om:null,Um:{},Date,Promise};
  vm.runInNewContext(dm+';globalThis.guard=Dm;',globals,{timeout:1000});
  for(const tool of s.main.localTools){await globals.guard('cli',true);assert.equal(requests,0,tool+' must skip ABExperimentQuery');}
  await globals.guard('cli',false);assert.equal(requests,1,'cloud guard retains experiment query');
  loggedIn=false;assert((await globals.guard('cli',true)).error.includes('未登录'));
  let attempts=0,sleeps=0;
  class AuthError extends Error{constructor(code,options){super(code);this.code=code;this.options=options;}}
  const g={Promise,Vc:AuthError,Uc:{NETWORK_ERROR:'NETWORK_ERROR',REFRESH_FAILED:'REFRESH_FAILED'},qc:[500,1000,2000],Kc:async()=>{sleeps++;}};
  vm.runInNewContext(wc+';globalThis.Source=Wc;',g,{timeout:1000});
  for(const code of ['MTOP_NOT_READY','CAPTCHA_REQUIRED']){
    attempts=sleeps=0;const src=new g.Source({request:async()=>{attempts++;throw {code,retryable:false};}},{});
    await assert.rejects(src.load());assert.equal(attempts,1);assert.equal(sleeps,0);
  }
  attempts=sleeps=0;const src=new g.Source({request:async()=>{attempts++;throw {code:'REQUEST_TIMEOUT',retryable:false};}},{});
  await assert.rejects(src.load());assert.equal(attempts,3);assert.equal(sleeps,3);
  s.a.guard.unload();s.b.guard.unload();s.main.dispose();
  console.log('PASS: extracted Dm preserves login and cloud checks; local flag skips only experiment query; extracted credentials do not retry missing readiness/CAPTCHA.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
