#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');
const d = require('./declutter'), p = d.patches;
const PRELOAD = 'class Base{async injectEarlyCSS(){let t="";const n=document.createElement("style");n.textContent=t,document.head.appendChild(n)}handleContextMenu(){}}';
const MENU_SOURCE = 'const view={children:T.map(e=>s.jsx(S,{title:e.name,placement:"right",disabled:!0,children:e},e.icon))};' +
  'const top=[s.jsxs("div",{className:"weather-today",children:"weather"}),' +
  's.jsx(S,{id:"pets-tooltip",children:"panda"}),' +
  '(()=>{let e=J.get("shortcutList.screenshot.value");return s.jsx(S,{id:"shots",children:"screenshot"})})(),' +
  '{children:"history"},{children:"settings"},{children:"more"},{children:"profile"},{children:"window-controls"}];';
const SIDEBAR = 'out/renderer/assets/css/browserLikeWindow-fixture.css';
const MENU = 'out/renderer/assets/js/pages/browserLikeWindow-fixture.js';
const OVERLAY = '.custom{font-size:17px}\n/* original overlay */';
const readManifest = o => JSON.parse(fs.readFileSync(d.context(o).manifestPath));
const overlay = (o, n) => path.join(d.context(o).cssDir, n);
async function pack(source, target) {
  asar.uncache(target);
  await asar.createPackageWithOptions(source, target, { unpackDir: 'native', unpack: '**/loose.bin' });
  const raw = asar.getRawHeader(target);
  function end(node) { return Math.max(0, ...Object.values(node.files || {}).map(n => n.files ? end(n) : n.offset === undefined ? 0 : Number(n.offset) + n.size)); }
  while (fs.statSync(target).size < 8 + raw.headerSize + end(raw.header)) await new Promise(r => setTimeout(r, 10));
  asar.uncache(target);
}
async function fixture(root) {
  const source = path.join(root, 'source');
  for (const [relative, bytes] of Object.entries({
    'out/main/index.js': "120d,0x11c2)]);if(!1&&false)return'未登录，已打';filter'](_0x32d1ec=>!0/*-----------------------*/);}function lm()",
    [p.PRELOAD]: PRELOAD, [MENU]: MENU_SOURCE, [SIDEBAR]: '.menu-item{color:black}',
    'out/preload/css/tbhome.css': 'body{background:none}', 'out/preload/css/home.css': 'body{color:black}',
    'native/sub/native.bin': Buffer.from([0, 1, 2, 255]), 'other/loose.bin': Buffer.from([7, 8, 9]),
  })) {
    const file = path.join(source, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const o = { asarPath: path.join(root, 'app.asar'), userDataDir: path.join(root, 'user-data'), restart: false, source };
  await pack(source, o.asarPath); fs.mkdirSync(d.context(o).cssDir, { recursive: true }); fs.writeFileSync(overlay(o, 'home.css'), OVERLAY);
  return o;
}
function assertState(o, enabled) {
  const m = readManifest(o); assert.deepEqual(m.enabled, enabled); assert.deepEqual(d.installedHashes(d.context(o)), m.expected);
  const read = name => asar.extractFile(o.asarPath, path.join(...name.split('/'))).toString();
  const cssEnabled = enabled['home-widgets'] || enabled['search-promotions'];
  assert.equal(read(p.PRELOAD).includes(p.PREFIX + 'home-loader'), cssEnabled); new vm.Script(read(p.PRELOAD)); new vm.Script(read(MENU));
  const items = ['home', 'ai', 'message', 'cart', 'order', 'iguang', 'caigoubao'].map(icon => ({ icon, name: icon }));
  const globals = { T: items, S: {}, s: { jsx: (_, props) => props, jsxs: (_, props) => props }, J: { get: () => 'Ctrl+Shift+A' } };
  const visible = vm.runInNewContext(read(MENU) + ';view.children.map(x=>x.children.icon)', { ...globals });
  assert.deepEqual([...visible], enabled['main-menu'] ? ['home', 'message', 'cart', 'order'] : items.map(x => x.icon));
  const top = vm.runInNewContext(read(MENU) + ';top.filter(Boolean).map(x=>x.children)', { ...globals });
  const essential = ['history', 'settings', 'more', 'profile', 'window-controls'];
  assert.deepEqual([...top], enabled['toolbar'] ? essential : ['weather', 'panda', 'screenshot', ...essential]);
  assert.equal(read(SIDEBAR), '.menu-item{color:black}');
  for (const name of p.HOME_FILES) {
    const file = overlay(o, name);
    if (!cssEnabled) { if (name === 'home.css') assert.equal(fs.readFileSync(file, 'utf8'), OVERLAY); else assert.equal(fs.existsSync(file), false); }
    else {
      const css = fs.readFileSync(file, 'utf8'); assert(css.startsWith(name === 'home.css' ? 'body{color:black}' : 'body{background:none}'));
      if (name === 'home.css') assert(css.includes(OVERLAY));
      for (const id of ['home-widgets', 'search-promotions']) assert.equal(css.includes(p.PREFIX + id), enabled[id]);
    }
  }
}
async function loader() {
  const enabled = { ...p.empty(), 'home-widgets': true };
  for (const [hostname, pathname, loads] of [
    ['pages-fast.m.taobao.com', '/wow/z/app/tbpc/tbhome-client/new-home', 1],
    ['pre-pages-fast.m.taobao.com', '/wow/z/app/tbpc/tbhome-client/new-home', 1],
    ['pages-fast.m.taobao.com', '/other', 0], ['item.taobao.com', '/wow/z/app/tbpc/tbhome-client/new-home', 0],
    ['huodong.taobao.com', '/wow/z/tbhome/pc-growth/desktop-search', 0],
  ]) {
    const calls = [], styles = [];
    const instance = vm.runInNewContext(p.preload(PRELOAD, enabled) + ';new Base()', { location: { hostname, pathname },
      e: { ipcRenderer: { invoke: async (...args) => { calls.push(args); return 'style'; } } },
      document: { createElement: () => ({}), head: { appendChild: style => styles.push(style) } } });
    await instance.injectEarlyCSS(); assert.equal(calls.length, loads); assert.equal(styles.length, 1);
  }
  const marked = [];
  const cards = Array.from({ length: 3 }, () => ({ setAttribute: (...args) => marked.push(args) }));
  const widgets = cards.map(card => ({ closest: selector => { assert.equal(selector, '[class*=smallBlock--]'); return card; } }));
  let inserted, observer;
  const css = 'body{background:white!important}' + p.cssBlock('home-widgets') + p.cssBlock('search-promotions');
  const instance = vm.runInNewContext(p.preload(PRELOAD, enabled) + ';new Base()', {
    location: { hostname: 'pages-fast.m.taobao.com', pathname: '/wow/z/app/tbpc/tbhome-client/new-home' },
    e: { ipcRenderer: { invoke: async () => css } },
    document: { querySelectorAll: () => widgets, createElement: () => ({}), head: { appendChild: style => { inserted = style.textContent; } } },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
  });
  await instance.injectEarlyCSS();
  assert(!inserted.includes('background:white')); assert(inserted.includes(p.PREFIX + 'search-promotions'));
  assert.equal(marked.length, 3); observer(); assert.equal(marked.length, 6);
  assert(marked.every(args => args[0] === 'data-taobao-agent-home-widget'));
  assert.throws(() => p.mainMenu('unknown', { ...p.empty(), 'main-menu': true }), /Unsupported client/);
  assert.throws(() => p.toolbar('unknown', { ...p.empty(), 'toolbar': true }), /Unsupported client/);
}
async function combinations(root) {
  const o = await fixture(root), ctx = d.context(o), original = d.installedHashes(ctx);
  const noTarget = spawnSync(process.execPath, [path.join(__dirname, 'declutter.js'), '--apply'], { encoding: 'utf8' });
  assert.equal(noTarget.status, 1); assert.match(noTarget.stderr, /target is required/); assert.deepEqual(d.installedHashes(ctx), original);
  for (let mask = 0; mask < (1 << p.IDS.length); mask++) {
    await d.restoreDeclutter('all', o); const enabled = p.empty();
    for (let i = 0; i < p.IDS.length; i++) if (mask & (1 << i)) { enabled[p.IDS[i]] = true; await d.applyDeclutter(p.IDS[i], o); }
    if (!fs.existsSync(ctx.manifestPath)) { await d.applyDeclutter('home-widgets', o); await d.restoreDeclutter('home-widgets', o); }
    assertState(o, enabled);
    for (const id of p.IDS) {
      await (enabled[id] ? d.restoreDeclutter : d.applyDeclutter)(id, o); assertState(o, { ...enabled, [id]: !enabled[id] });
      await (enabled[id] ? d.applyDeclutter : d.restoreDeclutter)(id, o); assertState(o, enabled);
    }
  }
  const baseline = readManifest(o).baseline, installed = d.installedHashes(ctx);
  for (const id of p.IDS) await d.applyDeclutter(id, o);
  assert.deepEqual(d.installedHashes(ctx), installed); assert.deepEqual(readManifest(o).baseline, baseline);
  await d.restoreDeclutter('all', o); assert.deepEqual(d.installedHashes(ctx), original);
  const oldRegistry = readManifest(o); oldRegistry.patchRevision = 1;
  fs.writeFileSync(ctx.manifestPath, JSON.stringify(oldRegistry));
  await d.restoreDeclutter('all', o);
  assert.equal(readManifest(o).patchRevision, p.REVISION);
  assert.deepEqual(d.installedHashes(ctx), original); assert.deepEqual(readManifest(o).baseline, baseline);
  await assert.rejects(d.applyDeclutter('all', { ...o, hooks: { afterCssWrite() { throw Error('Injected failure'); } } }), /Injected failure/);
  assert.deepEqual(d.installedHashes(ctx), original); assertState(o, p.empty());
  const child = 'const d=require(' + JSON.stringify(path.join(__dirname, 'declutter.js')) + ');d.applyDeclutter("all",{...JSON.parse(process.argv[1]),hooks:{afterArchiveWrite(){process.exit(99)}}}).catch(e=>{console.error(e);process.exit(1)})';
  const interrupted = spawnSync(process.execPath, ['-e', child, JSON.stringify(o)], { encoding: 'utf8' });
  assert.equal(interrupted.status, 99, interrupted.stderr); assert(readManifest(o).pending);
  await d.restoreDeclutter('all', o); assert.deepEqual(d.installedHashes(ctx), original); assertState(o, p.empty());
  const backup = readManifest(o).baseline.archive.file, originalBackup = fs.readFileSync(backup);
  fs.appendFileSync(backup, 'invalid backup');
  await assert.rejects(d.applyDeclutter('all', o), /Backup is missing or its hash changed/);
  assert.deepEqual(d.installedHashes(ctx), original); fs.writeFileSync(backup, originalBackup);
  fs.appendFileSync(overlay(o, 'home.css'), '\n.external{}'); await assert.rejects(d.applyDeclutter('all', o), /outside declutter/);
  fs.writeFileSync(overlay(o, 'home.css'), OVERLAY); fs.appendFileSync(o.asarPath, 'external'); await assert.rejects(d.applyDeclutter('all', o), /outside declutter/);
  console.log('PASS: sixteen combinations, independent transitions, no-op operations, exact restore, rollback, interrupted recovery, and drift rejection.');
}
async function registryUpgrade(root) {
  const o = await fixture(root), ctx = d.context(o);
  await d.applyDeclutter('main-menu', o);
  const previous = readManifest(o); previous.version = 3; previous.patchRevision = 3; delete previous.enabled['toolbar'];
  fs.writeFileSync(ctx.manifestPath, JSON.stringify(previous));
  const installed = d.installedHashes(ctx);
  await assert.rejects(d.applyDeclutter('toolbar', { ...o, hooks: { afterArchiveWrite() { throw Error('Registry upgrade failure'); } } }), /Registry upgrade failure/);
  assert.deepEqual(readManifest(o), previous); assert.deepEqual(d.installedHashes(ctx), installed);
  const child = 'const d=require(' + JSON.stringify(path.join(__dirname, 'declutter.js')) + ');d.applyDeclutter("toolbar",{...JSON.parse(process.argv[1]),hooks:{afterArchiveWrite(){process.exit(99)}}}).catch(e=>{console.error(e);process.exit(1)})';
  const interrupted = spawnSync(process.execPath, ['-e', child, JSON.stringify(o)], { encoding: 'utf8' });
  assert.equal(interrupted.status, 99, interrupted.stderr); assert(readManifest(o).pending);
  await d.applyDeclutter('toolbar', o);
  const current = readManifest(o);
  assert.equal(current.version, 4); assert.deepEqual(current.baseline, previous.baseline);
  assert(fs.existsSync(current.registryMigration));
  assert.deepEqual(d.installedHashes(ctx).css, installed.css);
  assertState(o, { ...p.empty(), 'main-menu': true, 'toolbar': true });
  await d.restoreDeclutter('toolbar', o);
  assert.deepEqual(d.installedHashes(ctx), installed);
  assertState(o, { ...p.empty(), 'main-menu': true });
  console.log('PASS: three-group registry upgrade, failed/interrupted upgrade recovery, and independent toolbar restore.');
}
async function migration(root) {
  const o = await fixture(root), ctx = d.context(o), original = d.installedHashes(ctx);
  const dir = path.join(ctx.backupDir, 'baseline-test'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.asar.bak'), home = path.join(dir, 'home.css.bak'); fs.copyFileSync(o.asarPath, file); fs.copyFileSync(overlay(o, 'home.css'), home);
  const m = { version: 2, archivePath: o.asarPath, cssDir: ctx.cssDir, state: 'applied', originalPatches: { gatekeeper: 'PATCHED', features: 'PATCHED' },
    baseline: { root: dir, archive: { file, hash: original.archive }, css: [ { filename: 'tbhome.css', existed: false }, { filename: 'home.css', existed: true, file: home, hash: original.css['home.css'] } ] } };
  const old = '.business-entry-bbs-card,\n.business-entry-live-card,\n.client-tao-coin-wrapper,\n[data-sg-type="hotWord"],\n.tbh-logo.tbh-logo-for-client {\n  display: none !important;\n}';
  fs.appendFileSync(path.join(o.source, ...SIDEBAR.split('/')), '\n\n/* ' + p.LEGACY_MARKER + ' */\n.menu-item-duanju {display:none}\n'); await pack(o.source, o.asarPath);
  for (const name of p.HOME_FILES) {
    let css = asar.extractFile(file, path.join('out', 'preload', 'css', name)).toString();
    if (name === 'home.css') css += '\n\n/* Preserved pre-existing hot-update CSS */\n' + OVERLAY;
    fs.writeFileSync(overlay(o, name), css + '\n\n/* ' + p.LEGACY_MARKER + ' */\n' + old + '\n');
  }
  m.appliedHash = d.installedHashes(ctx).archive; fs.writeFileSync(ctx.manifestPath, JSON.stringify(m)); const legacy = d.installedHashes(ctx);
  await assert.rejects(d.applyDeclutter('all', { ...o, hooks: { afterArchiveWrite() { throw Error('Migration failure'); } } }), /Migration failure/);
  assert.equal(readManifest(o).version, 2); assert.deepEqual(d.installedHashes(ctx), legacy);
  const child = 'const d=require(' + JSON.stringify(path.join(__dirname, 'declutter.js')) + ');d.applyDeclutter("all",{...JSON.parse(process.argv[1]),hooks:{afterArchiveWrite(){process.exit(99)}}}).catch(e=>{console.error(e);process.exit(1)})';
  const interrupted = spawnSync(process.execPath, ['-e', child, JSON.stringify(o)], { encoding: 'utf8' });
  assert.equal(interrupted.status, 99, interrupted.stderr); assert(readManifest(o).pending);
  await d.applyDeclutter('all', o); assertState(o, Object.fromEntries(p.IDS.map(id => [id, true])));
  assert.deepEqual(readManifest(o).baseline, m.baseline); assert(fs.existsSync(readManifest(o).migration));
  await d.restoreDeclutter('all', o); assert.deepEqual(d.installedHashes(ctx), original);
  console.log('PASS: legacy migration, failed/interrupted migration recovery, retired sidebar CSS, and retained originals.');
}
async function copiedClient(root, smoke = false, toolbarOnly = false) {
  const live = d.context(), originalManifest = readManifest({ userDataDir: live.userData }); fs.mkdirSync(root, { recursive: true });
  const o = { asarPath: path.join(root, 'app.asar'), userDataDir: path.join(root, 'user-data'), restart: false }, ctx = d.context(o);
  const dir = path.join(ctx.backupDir, 'baseline-copy'); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(live.archive, o.asarPath); fs.cpSync(live.archive + '.unpacked', o.asarPath + '.unpacked', { recursive: true });
  const m = JSON.parse(JSON.stringify(originalManifest)); m.archivePath = ctx.archive; m.cssDir = ctx.cssDir; m.baseline.root = dir; m.baseline.archive.file = path.join(dir, 'app.asar.bak');
  fs.copyFileSync(originalManifest.baseline.archive.file, m.baseline.archive.file);
  for (const r of m.baseline.css) if (r.existed) { const old = r.file; r.file = path.join(dir, r.filename + '.bak'); fs.copyFileSync(old, r.file); }
  fs.mkdirSync(ctx.cssDir, { recursive: true });
  for (const n of p.HOME_FILES) if (fs.existsSync(path.join(live.cssDir, n))) fs.copyFileSync(path.join(live.cssDir, n), path.join(ctx.cssDir, n));
  fs.writeFileSync(ctx.manifestPath, JSON.stringify(m));
  if (toolbarOnly) {
    const original = d.installedHashes(ctx);
    await d.applyDeclutter('toolbar', o);
    assert.deepEqual(d.installedHashes(ctx).css, original.css);
    assert.deepEqual(readManifest(o).baseline, m.baseline);
    await d.restoreDeclutter('toolbar', o);
    assert.deepEqual(d.installedHashes(ctx), original);
    console.log('PASS: toolbar apply/restore on a full disposable client, exact previous archive, CSS and other groups preserved.');
    return;
  }
  await d.applyDeclutter('all', o);
  if (smoke) {
    await d.restoreDeclutter('all', o);
    assert.equal(d.installedHashes(ctx).archive, m.baseline.archive.hash);
    console.log('PASS: revised loader on a full disposable client copy and exact restoration.');
    return;
  }
  for (const id of ['toolbar', 'main-menu', 'home-widgets', 'search-promotions']) await d.restoreDeclutter(id, o);
  assert.equal(d.installedHashes(ctx).archive, m.baseline.archive.hash); assert.equal(fs.existsSync(overlay(o, 'home.css')), false);
  await d.applyDeclutter('main-menu', o); await d.applyDeclutter('search-promotions', o); await d.restoreDeclutter('main-menu', o); await d.restoreDeclutter('search-promotions', o);
  assert.equal(d.installedHashes(ctx).archive, m.baseline.archive.hash);
  console.log('PASS: full client copy, renderer/preload transformations, independent composition, and exact restore.');
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taobao-declutter-check-'));
  try { await loader(); await combinations(path.join(root, 'combinations')); await migration(path.join(root, 'migration')); await registryUpgrade(path.join(root, 'upgrade')); if (process.argv.includes('--real') || process.argv.includes('--real-smoke') || process.argv.includes('--real-toolbar')) await copiedClient(path.join(root, 'real'), process.argv.includes('--real-smoke'), process.argv.includes('--real-toolbar')); }
  finally { if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('taobao-declutter-check-')) throw Error('Unsafe cleanup'); asar.uncacheAll(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
