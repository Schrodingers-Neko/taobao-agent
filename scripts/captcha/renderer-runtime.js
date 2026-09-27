'use strict';
function createRendererGuard(ipc, win, doc) {
  // The verification iframe keeps its own networking and cannot claim the parent coordinator.
  if(win.top && win.top!==win)return {sdkCallback:f=>f,installSDK(){},installStream(){}};
  const scopes = new Map(), native = new Map();
  const metrics={timers:0,callbacks:0,transportListeners:0};
  const report=()=>ipc.send('captcha:counters',{requests:scopes.size,...metrics});
  let state = ipc.sendSync('captcha:hello'), dialog = null, reopen = null, jsonpSerial = 0;
  let waitingShow=null,pendingControl=false,domWaiting=false;
  function ready(){domWaiting=false;doc.removeEventListener('DOMContentLoaded',ready);const d=waitingShow;waitingShow=null;
    if(state?.state==='verification_required'){if(d&&d.id===state.challengeId)show(d);else if(pendingControl)control();}pendingControl=false;}
  function waitDOM(){if(!domWaiting){domWaiting=true;doc.addEventListener('DOMContentLoaded',ready);}}
  const err = (code, message) => ({ code, message, challengeId: state?.challengeId, retryable: false });
  const paused = () => err('CAPTCHA_REQUIRED','请手动完成淘宝验证并明确确认后恢复操作');
  function begin(p) {
    const result = ipc.sendSync('captcha:begin', { api:p.api, v:p.v, data:p.data, mtopId:p.mtopId });
    if (result.error) throw result.error;
    const controller = new AbortController(), cleanups = new Set();
    let finished=false;
    const timer=win.setTimeout(()=>{scope.abort(err('REQUEST_TIMEOUT','MTop 请求超时'));scope.finish();},p.timeout||30000);
    metrics.timers++;
    const scope = { id:result.id, signal:controller.signal, verification:result.verification, cleanups,
      check() { if (controller.signal.aborted) throw scope.reason;if(finished)throw err('REQUEST_CANCELLED','请求已结束'); },
      abort(reason) { if (!controller.signal.aborted) { scope.reason = reason; controller.abort(); for (const f of [...cleanups]) f(reason); } },
      finish() { if(finished)return;finished=true;win.clearTimeout(timer);metrics.timers--;for (const f of [...cleanups]) f(err('REQUEST_COMPLETE','请求已结束')); cleanups.clear(); scopes.delete(scope.id); if (native.get(p.mtopId) === scope) native.delete(p.mtopId); ipc.send('captcha:finish',scope.id);report(); } };
    scopes.set(scope.id,scope); if (p.mtopId !== undefined) native.set(p.mtopId,scope);report();
    return scope;
  }
  function challenged(response) {
    const ret = Array.isArray(response?.ret) ? response.ret.join(',') : String(response?.ret || '');
    return /RGV587_ERROR::SM|ASSIST_FLAG|CHECKJS_FLAG/.test(ret);
  }
  function inspect(scope, response) {
    scope.check();
    if (!challenged(response)) return;
    const result = ipc.sendSync('captcha:claim',{id:scope.id,response});
    throw result.error || paused();
  }
  function race(scope, operation) {
    return new Promise((resolve,reject) => {
      const abort = reason => reject(reason);
      scope.cleanups.add(abort);
      Promise.resolve(operation).then(resolve,reject).finally(() => scope.cleanups.delete(abort));
    });
  }
  const encode = value => Object.entries(value || {}).filter(([,v]) => v).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
  function installSDK(sdk) {
    const proto = sdk?.CLASS?.prototype;
    if (!proto || proto._captchaGuard) return;
    for (const name of ['request','__sequence','__requestJSON','__requestJSONP']) if (typeof proto[name] !== 'function') throw err('SDK_UNSUPPORTED','不支持的 MTop SDK');
    Object.defineProperty(proto,'_captchaGuard',{value:true});
    const request = proto.request, sequence = proto.__sequence;
    proto.__sequence = function (steps) {
      const scope=this._captchaScope;
      if(!scope)return sequence.call(this,steps);
      scope.check();
      // SDK 2.4.16 swallows an unwind rejection after next() resolved its forward promise.
      // Preserve the middleware contract while propagating rejection through the entire chain.
      const full=steps[1]===this.__processRequestMethod;
      // B/C are SDK continuation sentinels. B discards a promise and calls next twice
      // on rejection; replace only these sentinels with an awaited first-request barrier.
      const flattened=(full?steps.slice(1,-1):steps).flat(Infinity),self=this;
      function dispatch(index){
        scope.check();if(index===flattened.length)return Promise.resolve();
        let resolveForward,rejectForward,downstream,result;
        const forward=new Promise((resolve,reject)=>{resolveForward=resolve;rejectForward=reject;});
        try{
          result=flattened[index].call(self,()=>{
            downstream=dispatch(index+1);resolveForward();return downstream;
          },reason=>{rejectForward(reason);return forward;});
          if(result?.then)result.catch(rejectForward);
          return forward.then(()=>result===undefined?downstream:result);
        }
        catch(e){return Promise.reject(e);}
      }
      const first=this.constructor.__firstProcessor;
      return full&&first&&first!==scope.operation?first.catch(()=>{}).then(()=>dispatch(0)):dispatch(0);
    };
    proto.request = function (options = {}) {
      const success=options.successCallback,failure=options.failureCallback;
      const callbacks=p=>p.then(v=>success?(success(v),undefined):v,e=>{if(failure){failure(e);return;}throw e;});
      let scope;
      try { scope = begin(this.params); } catch (e) { return callbacks(Promise.reject(e)); }
      this._captchaScope = scope;
      if (scope.verification) Object.assign(this.params,scope.verification);
      const guard = function (next) { scope.check(); return next().then(() => inspect(scope,this.options.retJson)); };
      this.middlewares.push(guard);
      let operation;
      try { operation = request.call(this,{...options,successCallback:undefined,failureCallback:undefined}); } catch (e) { operation = Promise.reject(e); }
      scope.operation=operation;
      return callbacks(race(scope,operation).finally(() => {
        this.middlewares = this.middlewares.filter(f=>f!==guard); scope.finish();
        if (this._captchaScope === scope) this._captchaScope = null;
      }));
    };
    proto.__requestJSON = function () {
      const scope = this._captchaScope, p = this.params, o = this.options;
      return new Promise((resolve,reject) => {
        scope.check(); const xhr = new win.XMLHttpRequest(); let finished = false, timer;
        function cleanup() { win.clearTimeout(timer); xhr.onreadystatechange = xhr.onerror = null; scope.cleanups.delete(cancel);metrics.timers--;metrics.transportListeners-=2;report(); }
        function finish(e,value) { if (finished) return; finished=true;cleanup();e?reject(e):(o.results=[value],resolve()); }
        function cancel(e) { finish(e);xhr.abort(); }
        scope.cleanups.add(cancel);
        timer = win.setTimeout(()=>cancel(err('REQUEST_TIMEOUT',o.timeoutErrMsg || '接口超时')),p.timeout||20000);
        metrics.timers++;metrics.transportListeners+=2;report();
        if (o.CDR) {
          const c = /(?:^|;\s*)_m_h5_c=([^;]*)/.exec(doc.cookie);
          if(c) o.querystring.c=decodeURIComponent(c[1]);
        }
        xhr.onreadystatechange=()=>{
          if(xhr.readyState!==4 || finished)return;
          if(xhr.status>=200&&xhr.status<300||xhr.status===304)try{
            const value=/^\s*$/.test(xhr.responseText)?{}:(win.JSON||JSON).parse(xhr.responseText);
            value.responseHeaders=xhr.getAllResponseHeaders()||'';finish(null,value);
          }catch{finish(err('PARSE_JSON_ERROR','解析 JSON 失败'));}
          else finish(err('TRANSPORT_ERROR',o.abortErrMsg||'接口异常退出'));
        };
        xhr.onerror=()=>finish(err('TRANSPORT_ERROR','接口异常退出'));
        let url=o.path+'?'+encode(o.querystring),body;
        if(o.getJSON)url+='&'+encode(o.postdata);else body=encode(o.postdata);
        try {
          xhr.open(o.getJSON?'GET':'POST',url,true);xhr.withCredentials=true;
          xhr.setRequestHeader('Accept','application/json');xhr.setRequestHeader('Content-type','application/x-www-form-urlencoded');
          for(const [k,v] of Object.entries(p.ext_headers||p.headers||{}))xhr.setRequestHeader(k,v);
          scope.check();xhr.send(body);
        } catch(e) { cancel(e); }
      });
    };
    proto.__requestJSONP = function () {
      const scope=this._captchaScope,p=this.params,o=this.options;
      return new Promise((resolve,reject)=>{
        scope.check(); const name='taobaoGuardJsonp'+(++jsonpSerial),script=doc.createElement('script');let done=false,timer;
        function finish(e,values){if(done)return;done=true;win.clearTimeout(timer);script.onerror=null;script.remove();delete win[name];scope.cleanups.delete(cancel);metrics.timers--;metrics.callbacks--;metrics.transportListeners--;report();e?reject(e):(o.results=values,resolve());}
        const cancel=e=>finish(e);scope.cleanups.add(cancel);
        timer=win.setTimeout(()=>finish(err('REQUEST_TIMEOUT',o.timeoutErrMsg||'接口超时')),p.timeout||20000);
        metrics.timers++;metrics.callbacks++;metrics.transportListeners++;report();
        o.querystring.callback=name;script.src=o.path+'?'+encode(o.querystring)+'&'+encode(o.postdata);script.async=true;
        script.onerror=()=>finish(err('TRANSPORT_ERROR',o.abortErrMsg||'接口异常退出'));win[name]=(...v)=>finish(null,v);
        try {scope.check();(doc.head||doc.body||doc.documentElement).appendChild(script);} catch(e){finish(e);}
      });
    };
  }
  function watchSDK(sdk) {
    if(!sdk)return;
    if(sdk.CLASS){installSDK(sdk);return;}
    const d=Object.getOwnPropertyDescriptor(sdk,'CLASS');
    if(d&&!d.configurable)return;
    let value;
    Object.defineProperty(sdk,'CLASS',{configurable:true,enumerable:true,get:()=>value,set(v){value=v;installSDK(sdk);}});
  }
  function sdkCallback(fn) { return value=>{watchSDK(value);return fn(value);}; }
  function watchLibrary(lib){
    if(!lib||typeof lib!=='object')return;
    watchSDK(lib.mtop);
    const descriptor=Object.getOwnPropertyDescriptor(lib,'mtop');
    if(descriptor&&!descriptor.configurable)return;
    let value=lib.mtop;
    Object.defineProperty(lib,'mtop',{configurable:true,enumerable:true,get:()=>value,
      set(v){value=v;watchSDK(v);}});
  }
  function installStream(Class) {
    if(!Class || Class.prototype._captchaGuard)return;
    Object.defineProperty(Class.prototype,'_captchaGuard',{value:true});
    const request=Class.prototype.requestStream,retry=Class.prototype.retry;
    Class.prototype.retry=function(ctx){const f=retry.call(this,ctx);return()=>{this._captchaScope?.check();return f();};};
    Class.use(async(ctx,next)=>{const scope=ctx.params.__captchaScope;scope.check();await next();inspect(scope,ctx.response);});
    Class.prototype.requestStream=function(){
      let scope;try{scope=begin(this.params);}catch(e){return Promise.reject(e);}
      this._captchaScope=scope;Object.defineProperty(this.params,'__captchaScope',{value:scope,configurable:true});
      if(scope.verification)Object.assign(this.params,scope.verification);
      const previous=this.params.experimental||{};
      this.params.experimental={...previous,openWhenHidden:true};
      let operation;try{operation=request.call(this);}catch(e){operation=Promise.reject(e);}
      return race(scope,operation).then(result=>{
        const original=result.stream;
        result.stream=async function*(){try{for await(const chunk of original){scope.check();yield chunk;}}finally{scope.abort(err('REQUEST_COMPLETE','流式请求已结束'));scope.finish();}}();
        return result;
      },e=>{scope.abort(e);scope.finish();throw e;});
    };
  }
  function removeDialog() {
    if(!dialog)return;win.removeEventListener('message',dialog.message);dialog.root.remove();dialog=null;
  }
  function control() {
    if(!doc.body&&!doc.documentElement){pendingControl=true;waitDOM();return;}
    if(reopen)return;reopen=doc.createElement('button');reopen.textContent='重新打开验证';
    reopen.style.cssText='position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:12px;background:#ff5000;color:white';
    reopen.onclick=()=>ipc.send('captcha:reopen');(doc.body||doc.documentElement).appendChild(reopen);
  }
  function show(d) {
    if(!doc.body&&!doc.documentElement){waitingShow=d;waitDOM();return;}
    if(dialog?.id===d.id)return;removeDialog();reopen?.remove();reopen=null;
    const root=doc.createElement('div'),frame=doc.createElement('iframe'),close=doc.createElement('button');
    root.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
    frame.style.cssText='width:400px;height:530px;border:0;background:white';frame.src=d.url;
    close.textContent='关闭验证（保持暂停）';close.style.cssText='position:absolute;top:12px;right:12px';
    close.onclick=()=>{removeDialog();control();ipc.send('captcha:close',d.id);};
    function message(event){
      if(event.source!==frame.contentWindow||event.origin!==d.origin||dialog?.id!==d.id)return;
      let data,values;try{
        data=typeof event.data==='string'?JSON.parse(event.data):event.data;
        if(data?.type!=='child'||typeof data.content!=='string')return;
        values=JSON.parse(decodeURIComponent(data.content));if(typeof values==='string')values=JSON.parse(values);
      }catch{return;}
      if(ipc.sendSync('captcha:complete',{id:d.id,values})){removeDialog();}
    }
    dialog={id:d.id,root,message};win.addEventListener('message',message);
    root.appendChild(frame);root.appendChild(close);(doc.body||doc.documentElement).appendChild(root);
  }
  const handlers=new Map();
  function on(name,fn){handlers.set(name,fn);ipc.on(name,fn);}
  on('captcha:cancel',(_,d)=>scopes.get(d.id)?.abort(d.error));
  on('captcha:cancel-native',(_,d)=>native.get(d.mtopId)?.abort(d.error));
  on('captcha:show',(_,d)=>show(d));
  on('captcha:state',(_,s)=>{
    state=s;
    if(s.state!=='verification_required'){waitingShow=null;pendingControl=false;removeDialog();reopen?.remove();reopen=null;}
    else if(!s.dialogOpen&&!dialog)control();
  });
  const loaded=()=>watchSDK(win.lib?.mtop);
  if(!win.lib)win.lib={};
  watchLibrary(win.lib);
  doc.addEventListener('load',loaded,true);loaded();
  const unload=()=>{for(const scope of [...scopes.values()]){scope.abort(err('RENDERER_DESTROYED','页面已关闭'));scope.finish();}ipc.send('captcha:unload');removeDialog();reopen?.remove();for(const [n,f]of handlers)ipc.removeListener(n,f);doc.removeEventListener('load',loaded,true);doc.removeEventListener('DOMContentLoaded',ready);waitingShow=null;win.removeEventListener('unload',unload);};
  win.addEventListener('unload',unload,{once:true});
  ipc.send('captcha:ready');
  return {installSDK,watchSDK,sdkCallback,installStream,begin,inspect,show,unload,
    counters:()=>({requests:scopes.size,nativeRequests:native.size,dialogs:dialog?1:0,...metrics})};
}
module.exports={createRendererGuard};
