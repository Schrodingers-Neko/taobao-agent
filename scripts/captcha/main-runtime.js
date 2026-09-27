'use strict';

// Serialized into the main bundle. Dependencies are explicit so tests never run vendor code.
function createMainGuard(electron, context, clock = { now: () => Date.now(), setTimeout, clearTimeout }) {
  const ipc = electron.ipcMain;
  const renderers = new Map(), requests = new Map(), credentials = new Set(), ownerCleanup = new Map(), rendererCounters = new Map();
  let state = 'idle', challenge = null, grant = null, serial = 0, host = null, readyOwner = null;
  const localTools = new Set(['get_current_tab','list_available_pages','navigate','navigate_to_url','close_page',
    'read_page_content','scroll_page','inspect_page','scan_page_elements','click_element','input_text','keyboard']);
  const error = (code, message, id) => ({ code, message, ...(id ? { challengeId: id } : {}), retryable: false });
  const paused = () => error('CAPTCHA_REQUIRED', '请手动完成淘宝验证并明确确认后恢复操作', challenge?.id);
  const identity = () => String(context()?.pluginManager?.getPlugin('navigation')?.getUserInfo?.()?.userId || '');
  const key = p => JSON.stringify([identity(),p.api, p.v || '1.0', typeof p.data === 'string' ? p.data : JSON.stringify(p.data || {})]);
  const tools = [
    {name:'get_verification_status',description:'只读取本地验证状态和生命周期计数，不发送网络请求。',inputSchema:{type:'object',properties:{}}},
    {name:'resume_after_verification',description:'仅在用户明确确认已手动完成验证后调用。验证未完成或 challengeId 过期时拒绝；不重放被中断的请求。',inputSchema:{type:'object',properties:{challengeId:{type:'string'}},required:['challengeId'],additionalProperties:false}}
  ];
  const status = () => ({ state, challengeId: challenge?.id, dialogOpen: !!challenge?.open,
    counters: { requests: requests.size, renderers: renderers.size, nativeRequests: host?._captchaPending?.size || 0,
      rendererRequests:[...rendererCounters.values()].reduce((n,c)=>n+c.requests,0),
      rendererTimers:[...rendererCounters.values()].reduce((n,c)=>n+c.timers,0),
      jsonpCallbacks:[...rendererCounters.values()].reduce((n,c)=>n+c.callbacks,0),
      transportListeners:[...rendererCounters.values()].reduce((n,c)=>n+c.transportListeners,0) } });
  const send = (wc, name, data) => { if (wc && !wc.isDestroyed()) wc.send(name, data); };
  function trusted(event) {
    return renderers.has(event.sender.id) && (!event.senderFrame || !event.senderFrame.parent);
  }
  function selectView() {
    const browser = context()?.pluginManager?.getPlugin('window-manager')?.browser;
    const current = browser?.currentView?.webContents;
    if (current && renderers.has(current.id) && !current.isDestroyed()) return current;
    const home = host?.resolveHomeViewContents();
    if (home && renderers.has(home.id) && !home.isDestroyed()) {
      const tab = (browser?.tabs || []).find(t => browser?.views?.[t]?.webContents === home || browser?.tabViews?.get?.(t)?.webContents === home);
      if (tab !== undefined) browser.switchTab(tab);
      return home;
    }
    return null;
  }
  function show() {
    if (!challenge || state !== 'verification_required') return false;
    if (challenge.open) return true;
    const wc = selectView();
    if (!wc) return false;
    challenge.presenter = wc.id; challenge.open = true;
    send(wc, 'captcha:show', { id: challenge.id, url: challenge.url, origin: challenge.origin });
    context()?.pluginManager?.getPlugin('window-manager')?.showWindow?.();
    return true;
  }
  function interrupt() {
    for (const r of [...requests.values()]) {
      send(renderers.get(r.owner), 'captcha:cancel', { id: r.id, error: paused() });
      requests.delete(r.id);
    }
    for (const wc of renderers.values()) send(wc, 'captcha:state', status());
    host?._captchaCancelAll(paused());
  }
  function claim(owner, id, response) {
    const record = requests.get(id);
    if (!record || record.owner !== owner) return { error: error('REQUEST_CANCELLED', '请求已结束') };
    if (state !== 'idle') return { error: paused() };
    let url;
    try { url = new URL(response.data.url); } catch { return { error: error('CAPTCHA_INVALID', '验证地址无效') }; }
    if (url.protocol !== 'https:' || !/(^|\.)(taobao\.com|tmall\.com|alicdn\.com|alibaba\.com)$/.test(url.hostname)) {
      return { error: error('CAPTCHA_INVALID', '验证地址不受信任') };
    }
    challenge = { id: 'captcha-' + (++serial), url: url.href, origin: url.origin, key: record.key, open: false, presenter: null };
    state = 'verification_required'; grant = null;
    interrupt(); show();
    return { error: paused() };
  }
  function begin(owner, params) {
    if (state !== 'idle') return { error: paused() };
    if (params?.mtopId !== undefined && host?._captchaOwners?.get(params.mtopId) !== owner) return {error:error('REQUEST_CANCELLED','原始请求已取消')};
    const id = 'request-' + (++serial), k = key(params);
    requests.set(id, { id, owner, key: k });
    let verification;
    if (grant?.key === k) { verification = grant.values; grant = null; }
    return { id, verification };
  }
  function complete(owner, data) {
    if (state !== 'verification_required' || challenge?.presenter !== owner || data?.id !== challenge.id || !challenge.open) return false;
    const values = data.values;
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length || Object.keys(values).length > 30 ||
      Object.entries(values).some(([k,v]) => ['__proto__','constructor','prototype','api','v','data','mtopId','__captchaScope'].includes(k) ||
        !['string','number','boolean'].includes(typeof v) || typeof v==='number'&&!Number.isFinite(v) || String(v).length > 8192)) return false;
    grant = { key: challenge.key, values: { ...values } };
    state = 'verified_awaiting_confirmation'; challenge.open = false;
    for (const wc of renderers.values()) send(wc, 'captcha:state', status());
    return true;
  }
  function resume(id) {
    if (!challenge || id !== challenge.id) return { error: error('STALE_CHALLENGE', '验证编号已过期') };
    if (state !== 'verified_awaiting_confirmation') return { error: paused() };
    state = 'idle'; challenge = null;
    for (const wc of renderers.values()) send(wc, 'captcha:state', status());
    return { result: status() };
  }
  const handlers = new Map();
  function listen(name, fn) { handlers.set(name, fn); ipc.on(name, fn); }
  function unload(owner) {
    rendererCounters.delete(owner);
    for (const [id,r] of requests) if (r.owner === owner) requests.delete(id);
    if (challenge?.presenter === owner) { challenge.open = false; challenge.presenter = null; }
    if (readyOwner === owner) readyOwner = null;
    if(host?.mtopWebviewContents?.id===owner)host._webviewReady=false;
    if(host?.resolveHomeViewContents()?.id===owner)host._homeViewReady=false;
  }
  listen('captcha:hello', event => {
    if (event.senderFrame?.parent) { event.returnValue = { error: error('UNTRUSTED_FRAME', '子页面不可注册') }; return; }
    const wc = event.sender;
    if (!renderers.has(wc.id)) {
      renderers.set(wc.id, wc);
      const destroyed = () => {
        renderers.delete(wc.id);
        ownerCleanup.delete(wc.id);unload(wc.id);show();
      };
      ownerCleanup.set(wc.id,()=>wc.removeListener('destroyed',destroyed));wc.once('destroyed',destroyed);
    }
    event.returnValue = status();
  });
  listen('captcha:begin', (event, p) => { event.returnValue = trusted(event) ? begin(event.sender.id, p) : { error: error('UNTRUSTED_FRAME','未知页面') }; });
  listen('captcha:finish', (event, id) => { if (trusted(event) && requests.get(id)?.owner === event.sender.id) requests.delete(id); });
  listen('captcha:claim', (event, d) => { event.returnValue = trusted(event) ? claim(event.sender.id, d.id, d.response) : { error: error('UNTRUSTED_FRAME','未知页面') }; });
  listen('captcha:complete', (event, d) => { event.returnValue = trusted(event) && complete(event.sender.id, d); });
  listen('captcha:close', (event, id) => { if (trusted(event) && challenge?.id === id && challenge.presenter === event.sender.id) challenge.open = false; });
  listen('captcha:reopen', event => { if (trusted(event)) show(); });
  listen('captcha:ready', event => { if (trusted(event) && challenge && !challenge.open) show(); });
  listen('captcha:unload', event => { if(trusted(event))unload(event.sender.id); });
  listen('captcha:counters',(event,c)=>{if(trusted(event)&&c&&['requests','timers','callbacks','transportListeners'].every(k=>Number.isInteger(c[k])&&c[k]>=0))rendererCounters.set(event.sender.id,c);});
  function nativeGate() {
    if (state !== 'idle') return { error: paused() };
    const ctx = context();
    if (!ctx?.pluginManager) return { error: error('TOOL_NOT_READY', '工具执行层未初始化') };
    if (!ctx.pluginManager.getPlugin('navigation')?.getUserInfo?.()?.isLogin) return { error: error('LOGIN_REQUIRED', '请先登录淘宝账号') };
    return null;
  }
  function bindHost(instance) {
    host = instance;
    const pending = instance._captchaPending = new Map();
    const owners = instance._captchaOwners = new Map();
    instance._captchaCancelAll = reason => { for (const cancel of [...pending.values()]) cancel(reason); };
    const dispose = instance.dispose.bind(instance);
    instance.dispose = () => { instance._captchaCancelAll(error('CLIENT_DISPOSED','客户端已关闭')); dispose();api.dispose(); };
    function request(p, stream) {
      if (state !== 'idle') return Promise.reject(paused());
      const web = p.useWebview === true;
      const wc = web ? instance.resolveWebviewContents() : instance.resolveHomeViewContents();
      if (instance.disposed || !(web ? instance._webviewReady : instance._homeViewReady) || !wc || wc.isDestroyed()) {
        return Promise.reject(error('MTOP_NOT_READY', 'MTop 页面尚未就绪'));
      }
      const id = ++instance.mtopId, data = { ...p, ...(stream ? instance.buildEnvParam() : {}), mtopId: id };
      delete data.useWebview;
      const base = web ? 'mtop-webview' : 'mtop';
      return new Promise((resolve, reject) => {
        let done = false, timer; const listeners = [], chunks = [];
        function finish(err, value) {
          if (done) return; done = true;
          clock.clearTimeout(timer); for (const [n,f] of listeners) ipc.removeListener(n,f);
          wc.removeListener('destroyed', destroyed);wc.removeListener('did-start-navigation',navigation);pending.delete(id);owners.delete(id);
          send(wc, 'captcha:cancel-native', { mtopId: id, error: err || error('REQUEST_COMPLETE','请求已完成') });
          err ? reject(err) : resolve(value);
        }
        const destroyed = () => finish(error('RENDERER_DESTROYED','请求页面已关闭'));
        const navigation = (_ev,_url,inPlace,mainFrame) => { if(mainFrame&&!inPlace)finish(error('REQUEST_CANCELLED','请求页面正在导航')); };
        function on(name, fn) {
          const f = (ev,d) => { if (ev.sender === wc && d?.mtopId === id && !done) fn(d); };
          ipc.on(name,f); listeners.push([name,f]);
        }
        if (stream) {
          on(base + '-stream-chunk:' + id, d => chunks.push(d.chunk));
          on(base + '-stream-end:' + id, () => finish(null,chunks));
          on(base + '-stream-error:' + id, d => finish(d.error));
        } else on(web ? base + '-response:' + id : 'mtop-response-callback:' + id, d => d.res?.code && d.res.retryable === false ? finish(d.res) : finish(null,d.res));
        wc.once('destroyed', destroyed);wc.on('did-start-navigation',navigation);pending.set(id, reason => finish(reason));owners.set(id,wc.id);
        timer = clock.setTimeout(() => finish(error('REQUEST_TIMEOUT','MTop 请求超时')), p.timeout || (stream ? 30000 : 15000));
        try { wc.send(stream ? base + '-stream-request' : web ? base + '-request' : 'mtop-response', data); }
        catch (err) { finish(error('REQUEST_SEND_FAILED',err.message)); }
      });
    }
    instance.request = p => request(p,false); instance.streamRequest = p => request(p,true);
  }
  function bindCredentials(proto) {
    const refresh = proto.refresh, reset = proto.resetCache;
    proto.refresh = function () {
      credentials.add(this);
      if (this.inflight) return this.inflight;
      if (clock.now() < (this._captchaCooldownUntil || 0)) return Promise.reject(this._captchaCooldownError);
      const epoch = this._captchaEpoch || 0;
      return refresh.call(this).catch(err => {
        if (err.code === 'NETWORK_ERROR' && epoch === (this._captchaEpoch || 0)) {
          this._captchaCooldownUntil = clock.now() + 60000; this._captchaCooldownError = err;
        }
        throw err;
      });
    };
    proto.resetCache = function () {
      this._captchaEpoch = (this._captchaEpoch || 0) + 1;
      this._captchaCooldownUntil = 0; this._captchaCooldownError = null;
      return reset.call(this);
    };
  }
  function bindLogin(proto) {
    const sync = proto.syncLoginStatus;
    proto.syncLoginStatus = function (loggedIn) {
      const k = JSON.stringify([!!loggedIn, identity()]);
      if (this._captchaLoginKey === k) return Promise.resolve();
      if(this._captchaLoginKey!==undefined){grant=null;for(const c of credentials)c.resetCache();}
      this._captchaLoginKey = k;
      return sync.call(this,loggedIn);
    };
  }
  listen('mtop-webview-ready', event => {
    if(!trusted(event)||readyOwner===event.sender.id)return;
    const sender=event.sender;
    queueMicrotask(()=>{if(host?.mtopWebviewContents!==sender||!host?._webviewReady)return;readyOwner=sender.id;
      for(const c of credentials){c._captchaCooldownUntil=0;c._captchaCooldownError=null;}
    });
  });
  const api = { status, resume, claim, begin, complete, nativeGate, localTools, tools, bindHost, bindCredentials, bindLogin, error,
    dispose() { host?._captchaCancelAll(error('CLIENT_DISPOSED','客户端已关闭')); for (const [n,f] of handlers) ipc.removeListener(n,f); handlers.clear();for(const f of ownerCleanup.values())f();ownerCleanup.clear();requests.clear(); renderers.clear();rendererCounters.clear(); grant = challenge = null; credentials.clear(); } };
  return api;
}
module.exports = { createMainGuard };
