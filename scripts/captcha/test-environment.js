'use strict';
const { EventEmitter }=require('events');
class Clock {
  constructor(){this.time=0;this.serial=0;this.timers=new Map();}
  now=()=>this.time;
  setTimeout=(fn,ms)=>{const id=++this.serial;this.timers.set(id,{fn,at:this.time+ms});return id;};
  clearTimeout=id=>this.timers.delete(id);
  tick(ms){this.time+=ms;for(const [id,t]of [...this.timers])if(t.at<=this.time){this.timers.delete(id);t.fn();}}
}
class Element extends EventEmitter {
  constructor(tag){super();this.setMaxListeners(100);this.tag=tag;this.children=[];this.style={};this.contentWindow={};}
  appendChild(c){this.children.push(c);c.parentNode=this;return c;}
  removeChild(c){this.children=this.children.filter(x=>x!==c);c.parentNode=null;}
  remove(){this.parentNode?.removeChild(this);}
  addEventListener(n,f){this.on(n,f);}removeEventListener(n,f){this.removeListener(n,f);}
  dispatchEvent(ev){this.emit(ev.type,ev);}
  getBoundingClientRect(){return {width:1200,height:800,top:0};}
  querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.querySelectorAll(tag)]);}
}
function environment(ipcMain,id,clock){
  const ipc=new EventEmitter(),wc=new EventEmitter(),win=new Element('window'),doc=new Element('document');
  const transports=[];wc.id=id;wc.destroyed=false;wc.isDestroyed=()=>wc.destroyed;
  wc.getURL=()=>win.location.href;wc.send=(n,d)=>ipc.emit(n,{},d);
  wc.destroy=()=>{wc.destroyed=true;wc.emit('destroyed');};
  function event(){return {sender:wc,senderFrame:{parent:null}};}
  ipc.sendSync=(n,d)=>{const ev=event();ipcMain.emit(n,ev,d);return ev.returnValue;};
  ipc.send=(n,d)=>ipcMain.emit(n,event(),d);
  Object.assign(win,{top:win,innerWidth:1200,innerHeight:800,scrollTo(){},setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,
    location:{href:'https://m.taobao.com/',hostname:'m.taobao.com',protocol:'https:'},navigator:{userAgent:'Chrome Desktop'},lib:{},Promise});
  Object.assign(doc,{head:new Element('head'),body:new Element('body'),documentElement:new Element('html'),cookie:'_m_h5_tk=test_9999999999999',
    createElement:tag=>new Element(tag),getElementsByTagName:n=>[doc[n]],createEvent:()=>({initEvent(n){this.type=n;}})});
  win.document=doc;
  class XHR {
    constructor(){this.readyState=0;this.aborted=false;transports.push(this);}
    open(method,url){this.method=method;this.url=url;}setRequestHeader(){}send(data){this.body=data;this.sent=true;}
    getAllResponseHeaders(){return '';}
    respond(value){this.status=200;this.responseText=JSON.stringify(value);this.readyState=4;this.onreadystatechange?.();}
    abort(){this.aborted=true;}
  }
  win.XMLHttpRequest=XHR;
  return {ipc,wc,win,doc,transports,clock};
}
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
module.exports={Clock,Element,environment,flush};
