// Pure transformations: every output is composed from immutable original contents.
const IDS = ['home-widgets', 'search-promotions', 'main-menu'];
const HOME_FILES = ['tbhome.css', 'home.css'];
const PREFIX = 'taobao-agent-declutter:v3:';
const LEGACY_MARKER = 'taobao-agent-declutter:v1';
const REVISION = 3;
const RULES = {
  'home-widgets': '[data-taobao-agent-home-widget],\n.business-entry-bbs-card,\n.business-entry-live-card,\n.client-tao-coin-wrapper {\n  display: none !important;\n}',
  // New home: the sponsored query/brand overlay has no input or button descendants.
  // The desktop-search embedded document is a separate functional search surface.
  'search-promotions': '[data-sg-type="hotWord"],\n.tbh-logo.tbh-logo-for-client,\n[class*=search] div[class*=placeholder] {\n  display: none !important;\n}',
};
const PRELOAD = 'out/preload/index.js';
function empty() { return Object.fromEntries(IDS.map(id => [id, false])); }
function targets(id) {
  if (id === 'all') return IDS;
  if (!IDS.includes(id)) throw new Error('A patch target is required: ' + IDS.join(' | ') + ' | all');
  return [id];
}
function cssBlock(id) { return '\n\n/* ' + PREFIX + id + ' */\n' + RULES[id] + '\n'; }
function composeCss(bundled, originalOverlay, enabled) {
  if (!enabled['home-widgets'] && !enabled['search-promotions']) return originalOverlay;
  let base = bundled;
  if (originalOverlay !== null && originalOverlay.toString('utf8') !== bundled) {
    base += '\n\n/* Preserved pre-existing hot-update CSS */\n' + originalOverlay.toString('utf8');
  }
  for (const id of ['home-widgets', 'search-promotions']) if (enabled[id]) base += cssBlock(id);
  return Buffer.from(base);
}
function replaceOnce(source, anchor, replacement, description) {
  if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) {
    throw new Error('Unsupported client: expected one ' + description + ' anchor.');
  }
  return source.replace(anchor, replacement);
}
function preload(source, enabled) {
  if (!enabled['home-widgets'] && !enabled['search-promotions']) return source;
  const start = source.indexOf('async injectEarlyCSS(){');
  const end = source.indexOf('handleContextMenu(', start);
  if (start < 0 || end < start) throw new Error('Unsupported home stylesheet loader.');
  const anchor = 'const n=document.createElement("style");n.textContent=t,document.head.appendChild(n)';
  const correction = '/* ' + PREFIX + 'home-loader */' +
    'if(location.pathname==="/wow/z/app/tbpc/tbhome-client/new-home"&&' +
    '/^(pre-)?pages-fast\\.m\\.taobao\\.com$/.test(location.hostname))' +
    '{const css=await e.ipcRenderer.invoke("get-preloaded-css","tbhomeCss");' +
    // The new home page owns its theme. Inject only our blocks, not legacy base rules.
    't+=(css.match(/\\/\\* taobao-agent-declutter:v3:(?:home-widgets|search-promotions) \\*\\/[\\s\\S]*?(?=\\/\\* taobao-agent-declutter:v3:|$)/g)||[]).join("\\n");' +
    'if(css.includes("taobao-agent-declutter:v3:home-widgets")){' +
    // Current DOM: each promotional widget has its own smallBlock wrapper; VIP is separate.
    'const hide=()=>document.querySelectorAll(".business-entry-bbs-card,.business-entry-live-card,.client-tao-coin-wrapper").forEach(widget=>{' +
    'const card=widget.closest("[class*=smallBlock--]");if(card)card.setAttribute("data-taobao-agent-home-widget","")});' +
    'hide();new MutationObserver(hide).observe(document,{childList:true,subtree:true})}}';
  const segment = replaceOnce(source.slice(start, end), anchor, correction + anchor, 'home CSS insertion');
  return source.slice(0, start) + segment + source.slice(end);
}
function mainMenu(source, enabled) {
  if (!enabled['main-menu']) return source;
  const anchor = 'children:T.map(e=>s.jsx(S,{title:e.name,placement:"right",disabled:!0,';
  const replacement = 'children:T.filter(e=>!["ai","iguang","caigoubao"].includes(e.icon))' +
    '/* ' + PREFIX + 'main-menu */.map(e=>s.jsx(S,{title:e.name,placement:"right",disabled:!0,';
  return replaceOnce(source, anchor, replacement, 'main-menu render');
}
module.exports = { IDS, HOME_FILES, PREFIX, LEGACY_MARKER, REVISION, PRELOAD, empty, targets, cssBlock, composeCss, preload, mainMenu };
