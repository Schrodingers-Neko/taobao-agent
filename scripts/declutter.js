#!/usr/bin/env node
/**
 * Independently reversible home, search, and main-menu patches for Taobao Desktop.
 * Original snapshots remain immutable; a journal recovers interrupted commits.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const asar = require('@electron/asar');
const patchAsar = require('./patch-asar');

const patches = require('./declutter-patches');
const { HOME_FILES } = patches;
const APP_NAME = '淘宝桌面版.exe';

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function hashFile(file) {
  return hash(fs.readFileSync(file));
}
function removeTree(target, parent, prefix) {
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith(prefix)) {
    throw new Error('Refusing cleanup outside its generated directory: ' + resolved);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
function context(options = {}) {
  if (!options.userDataDir && !process.env.APPDATA) throw new Error('APPDATA is not set.');
  const archive = path.resolve(options.asarPath || patchAsar.findAsarPath());
  const userData = path.resolve(options.userDataDir || path.join(process.env.APPDATA, 'taobao'));
  const backupDir = path.join(userData, 'taobao-agent-declutter-backup');
  return {
    archive, userData, backupDir,
    cssDir: path.join(userData, 'hot-update', 'css'),
    manifestPath: path.join(backupDir, 'manifest.json'),
    lockPath: path.join(backupDir, 'operation.lock'),
    restart: options.restart !== false,
    hooks: options.hooks || {},
  };
}
function freshArchive(file) {
  asar.uncache(file);
  return asar.getRawHeader(file);
}
function entries(header) {
  const result = new Map();
  function walk(node, pieces = []) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const next = [...pieces, name];
      result.set(next.join('/'), child);
      if (child.files) walk(child, next);
    }
  }
  walk(header);
  return result;
}
function sidebarPath(file) {
  const candidates = [...entries(freshArchive(file).header).keys()]
    .filter(p => /^out\/renderer\/assets\/css\/browserLikeWindow-[^/]+\.css$/.test(p));
  if (candidates.length !== 1) throw new Error('Expected exactly one browserLikeWindow stylesheet.');
  return path.join(...candidates[0].split('/'));
}
function patchStates(file) {
  const meta = patchAsar.parseAsarHeader(file);
  return {
    gatekeeper: patchAsar.findGatekeeperSignature(file, meta).state,
    features: patchAsar.findFeatureSignature(file, meta).state,
  };
}
function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.taobao-agent-' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, file);
    asar.uncache(file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function copyAtomic(source, target) {
  writeAtomic(target, fs.readFileSync(source));
}
function saveManifest(ctx, manifest) {
  writeAtomic(ctx.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
function inside(file, directory) {
  const relative = path.relative(directory, path.resolve(file));
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function validateSnapshot(ctx, snapshot) {
  for (const item of [snapshot.archive, ...snapshot.css.filter(p => p.existed)]) {
    if (!inside(item.file, ctx.backupDir)) throw new Error('Invalid snapshot file location.');
  }
  if (snapshot.css.length !== HOME_FILES.length ||
      HOME_FILES.some(name => snapshot.css.filter(p => p.filename === name).length !== 1)) {
    throw new Error('Invalid CSS restore records.');
  }
}
function loadManifest(ctx) {
  if (!fs.existsSync(ctx.manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(ctx.manifestPath, 'utf8'));
  if (![2, 3].includes(manifest.version) || manifest.archivePath !== ctx.archive || manifest.cssDir !== ctx.cssDir) {
    throw new Error('Backup manifest does not match this installation.');
  }
  validateSnapshot(ctx, manifest.baseline);
  if (manifest.pending) validateSnapshot(ctx, manifest.pending.snapshot);
  if (manifest.version === 3 && (patches.IDS.some(id => typeof manifest.enabled?.[id] !== 'boolean') ||
      !manifest.expected?.archive || !manifest.expected.css || !manifest.sidecars)) {
    throw new Error('Invalid independent patch registry.');
  }
  return manifest;
}
function capture(ctx, prefix) {
  const root = fs.mkdtempSync(path.join(ctx.backupDir, prefix));
  const archive = { file: path.join(root, 'app.asar.bak'), hash: hashFile(ctx.archive) };
  fs.copyFileSync(ctx.archive, archive.file, fs.constants.COPYFILE_EXCL);
  const css = HOME_FILES.map(filename => {
    const current = path.join(ctx.cssDir, filename);
    if (!fs.existsSync(current)) return { filename, existed: false };
    const file = path.join(root, filename + '.bak');
    fs.copyFileSync(current, file, fs.constants.COPYFILE_EXCL);
    return { filename, existed: true, file, hash: hashFile(file) };
  });
  return { root, archive, css };
}
function verifySnapshot(snapshot) {
  for (const item of [snapshot.archive, ...snapshot.css.filter(p => p.existed)]) {
    if (!fs.existsSync(item.file) || hashFile(item.file) !== item.hash) {
      throw new Error('Backup is missing or its hash changed: ' + item.file);
    }
  }
}
function restoreSnapshot(ctx, snapshot) {
  verifySnapshot(snapshot);
  copyAtomic(snapshot.archive.file, ctx.archive);
  for (const item of snapshot.css) {
    const file = path.join(ctx.cssDir, item.filename);
    if (item.existed) copyAtomic(item.file, file);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  if (hashFile(ctx.archive) !== snapshot.archive.hash) throw new Error('Archive restoration verification failed.');
  for (const item of snapshot.css) {
    const file = path.join(ctx.cssDir, item.filename);
    if (item.existed ? hashFile(file) !== item.hash : fs.existsSync(file)) {
      throw new Error('CSS restoration verification failed: ' + item.filename);
    }
  }
}
function recover(ctx, manifest) {
  if (!manifest?.pending) return manifest;
  restoreSnapshot(ctx, manifest.pending.snapshot);
  const snapshot = manifest.pending.snapshot;
  const stagedRoot = manifest.pending.stagedRoot;
  if (manifest.pending.previousManifest) manifest = manifest.pending.previousManifest;
  else { manifest.state = manifest.pending.previousState; delete manifest.pending; }
  saveManifest(ctx, manifest);
  removeTree(snapshot.root, ctx.backupDir, 'transaction-');
  if (stagedRoot) removeTree(stagedRoot, os.tmpdir(), 'taobao-declutter-');
  console.log('[declutter] Recovered an interrupted transaction.');
  return manifest;
}
function finishTransaction(ctx, manifest, snapshot) {
  delete manifest.pending;
  saveManifest(ctx, manifest);
  try { removeTree(snapshot.root, ctx.backupDir, 'transaction-'); }
  catch (error) { console.warn('[declutter] Committed; temporary snapshot cleanup failed:', error.message); }
}
function unpackOptions(header) {
  const all = entries(header);
  const files = [...all].filter(([file, node]) => !node.files && node.unpacked &&
    !all.get(file.slice(0, file.lastIndexOf('/')))?.unpacked).map(([file]) => file);
  const dirs = [...all].filter(([file, node]) => node.files && node.unpacked &&
    !all.get(file.slice(0, file.lastIndexOf('/')))?.unpacked).map(([file]) => file);
  const pattern = (paths, prefix) => {
    if (!paths.length) return undefined;
    if (paths.some(file => /[{},[\]*?!]/.test(file))) {
      throw new Error('Unsupported glob character in an unpacked path.');
    }
    const alternatives = paths.map(file => prefix + file);
    return alternatives.length === 1 ? alternatives[0] : '{' + alternatives.join(',') + '}';
  };
  return { unpack: pattern(files, '**/'), unpackDir: pattern(dirs, '') };
}
function verifyIntegrity(bytes, integrity, file) {
  if (integrity?.algorithm !== 'SHA256' || integrity.hash !== hash(bytes) ||
      !Number.isSafeInteger(integrity.blockSize) || integrity.blockSize <= 0) {
    throw new Error('Invalid file integrity: ' + file);
  }
  const blocks = [];
  // ASAR v3 includes an empty final block for empty files and exact block multiples.
  for (let offset = 0; offset <= bytes.length; offset += integrity.blockSize) {
    blocks.push(hash(bytes.subarray(offset, offset + integrity.blockSize)));
  }
  if (JSON.stringify(blocks) !== JSON.stringify(integrity.blocks)) {
    throw new Error('Invalid block integrity: ' + file);
  }
}
function verifyRebuild(original, rebuilt, changes = {}) {
  const sourceRaw = freshArchive(original);
  const targetRaw = freshArchive(rebuilt);
  const sourceEntries = entries(sourceRaw.header);
  const targetEntries = entries(targetRaw.header);
  if (JSON.stringify([...sourceEntries.keys()].sort()) !== JSON.stringify([...targetEntries.keys()].sort())) {
    throw new Error('Archive file inventory changed during rebuild.');
  }
  const sourceBuffer = fs.readFileSync(original);
  const targetBuffer = fs.readFileSync(rebuilt);
  let checked = 0;
  let unpacked = 0;
  function bytes(file, raw, buffer, node, relative) {
    if (node.unpacked) return fs.readFileSync(path.join(file + '.unpacked', ...relative.split('/')));
    const start = 8 + raw.headerSize + Number(node.offset);
    if (!Number.isSafeInteger(start) || start < 8 + raw.headerSize || start + node.size > buffer.length) {
      throw new Error('Invalid packed offset: ' + relative);
    }
    return buffer.subarray(start, start + node.size);
  }
  for (const [relative, before] of sourceEntries) {
    const after = targetEntries.get(relative);
    if (!!before.files !== !!after.files || before.link !== after.link ||
        !!before.unpacked !== !!after.unpacked || !!before.executable !== !!after.executable) {
      throw new Error('Archive entry metadata changed: ' + relative);
    }
    if (before.files || before.link) continue;
    const oldBytes = bytes(original, sourceRaw, sourceBuffer, before, relative);
    const newBytes = bytes(rebuilt, targetRaw, targetBuffer, after, relative);
    const expected = Object.hasOwn(changes, relative) ? Buffer.from(changes[relative]) : oldBytes;
    if (!expected.equals(newBytes)) throw new Error('Unexpected content change: ' + relative);
    verifyIntegrity(newBytes, after.integrity, relative);
    checked++;
    if (before.unpacked) unpacked++;
  }
  if (JSON.stringify(patchStates(original)) !== JSON.stringify(patchStates(rebuilt))) {
    throw new Error('Existing gatekeeper or feature patch state changed.');
  }
  console.log('[declutter] Verified ' + checked + ' file contents and hashes, including ' + unpacked + ' unpacked files.');
}
function rendererPath(file) {
  const candidates = [...entries(freshArchive(file).header).keys()]
    .filter(p => /^out\/renderer\/assets\/js\/pages\/browserLikeWindow-[^/]+\.js$/.test(p));
  if (candidates.length !== 1) throw new Error('Expected exactly one main-menu renderer.');
  return candidates[0];
}
function extract(file, relative) {
  return asar.extractFile(file, path.join(...relative.split('/'))).toString('utf8');
}
function sidecarHashes(ctx, baseline) {
  const result = {};
  for (const [relative, node] of entries(freshArchive(baseline).header)) {
    if (node.files || !node.unpacked) continue;
    const bytes = fs.readFileSync(path.join(ctx.archive + '.unpacked', ...relative.split('/')));
    // Legacy backups did not snapshot sidecars; vendor metadata can be stale.
    // Keep the actual sidecar bytes untouched and pin them at registry adoption.
    result[relative] = hash(bytes);
  }
  return result;
}
function verifySidecars(ctx, manifest) {
  for (const [relative, expected] of Object.entries(manifest.sidecars)) {
    if (hashFile(path.join(ctx.archive + '.unpacked', ...relative.split('/'))) !== expected) {
      throw new Error('Unpacked client file changed: ' + relative);
    }
  }
}
function desiredFiles(ctx, manifest, enabled) {
  const baseline = manifest.baseline.archive.file;
  freshArchive(baseline);
  const menu = rendererPath(baseline);
  return {
    [patches.PRELOAD]: patches.preload(extract(baseline, patches.PRELOAD), enabled),
    [menu]: patches.mainMenu(extract(baseline, menu), enabled),
    [sidebarPath(baseline).split(path.sep).join('/')]: extract(baseline, sidebarPath(baseline).split(path.sep).join('/')),
  };
}
function desiredCss(ctx, manifest, enabled) {
  const baseline = manifest.baseline.archive.file;
  return Object.fromEntries(HOME_FILES.map(filename => {
    const original = manifest.baseline.css.find(item => item.filename === filename);
    return [filename, patches.composeCss(
      extract(baseline, 'out/preload/css/' + filename),
      original.existed ? fs.readFileSync(original.file) : null, enabled)];
  }));
}
function installedHashes(ctx) {
  return {
    archive: hashFile(ctx.archive),
    css: Object.fromEntries(HOME_FILES.map(name => {
      const file = path.join(ctx.cssDir, name);
      return [name, fs.existsSync(file) ? hashFile(file) : null];
    })),
  };
}
function verifyInstalled(ctx, expected) {
  if (JSON.stringify(installedHashes(ctx)) !== JSON.stringify(expected)) {
    throw new Error('Client archive or CSS changed outside declutter; refusing to overwrite it.');
  }
}
async function buildArchive(ctx, manifest, root, enabled) {
  const baseline = manifest.baseline.archive.file;
  if (!Object.values(enabled).some(Boolean)) return baseline;
  const changes = desiredFiles(ctx, manifest, enabled);
  freshArchive(ctx.archive);
  if (Object.entries(changes).every(([relative, contents]) => extract(ctx.archive, relative) === contents)) {
    return ctx.archive;
  }
  const source = path.join(root, 'source.asar');
  fs.copyFileSync(baseline, source);
  if (fs.existsSync(ctx.archive + '.unpacked')) {
    fs.cpSync(ctx.archive + '.unpacked', source + '.unpacked', { recursive: true });
  }
  const header = freshArchive(source).header;
  if ([...entries(header).values()].some(node => node.link || node.executable)) {
    throw new Error('This Windows installer cannot preserve archive links or executable flags.');
  }
  const extracted = path.join(root, 'app');
  const rebuilt = path.join(root, 'rebuilt.asar');
  console.log('[declutter] Composing enabled patches from the original ASAR.');
  asar.extractAll(source, extracted);
  for (const [relative, contents] of Object.entries(changes)) {
    fs.writeFileSync(path.join(extracted, ...relative.split('/')), contents);
  }
  await asar.createPackageWithOptions(extracted, rebuilt, unpackOptions(header));
  const raw = freshArchive(rebuilt);
  const end = Math.max(8 + raw.headerSize, ...[...entries(raw.header).values()]
    .filter(node => node.offset !== undefined)
    .map(node => 8 + raw.headerSize + Number(node.offset) + node.size));
  const deadline = Date.now() + 10000;
  while (fs.statSync(rebuilt).size < end && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  verifyRebuild(source, rebuilt, changes);
  return rebuilt;
}
function legacyCss(ctx, manifest, filename) {
  const bundled = extract(manifest.baseline.archive.file, 'out/preload/css/' + filename);
  const original = manifest.baseline.css.find(item => item.filename === filename);
  let base = bundled;
  if (original.existed) {
    const previous = fs.readFileSync(original.file, 'utf8');
    if (previous !== bundled) base += '\n\n/* Preserved pre-existing hot-update CSS */\n' + previous;
  }
  const rules = '.business-entry-bbs-card,\n.business-entry-live-card,\n.client-tao-coin-wrapper,\n[data-sg-type="hotWord"],\n.tbh-logo.tbh-logo-for-client {\n  display: none !important;\n}';
  return Buffer.from(base + '\n\n/* ' + patches.LEGACY_MARKER + ' */\n' + rules + '\n');
}
function initializeRegistry(ctx, previous) {
  if (previous) {
    verifySnapshot(previous.baseline);
    const current = installedHashes(ctx);
    if (current.archive !== (previous.state === 'applied' ? previous.appliedHash : previous.baseline.archive.hash)) {
      throw new Error('Legacy archive changed outside declutter.');
    }
    const css = previous.state === 'applied' ? Object.fromEntries(HOME_FILES.map(name => [name, hash(legacyCss(ctx, previous, name))])) :
      Object.fromEntries(previous.baseline.css.map(item => [item.filename, item.existed ? item.hash : null]));
    if (JSON.stringify(current.css) !== JSON.stringify(css)) throw new Error('Legacy CSS changed outside declutter.');
    // Retain the old manifest as an immutable migration record.
    const migration = path.join(ctx.backupDir, 'legacy-manifest-' + crypto.randomUUID() + '.json');
    fs.writeFileSync(migration, JSON.stringify(previous, null, 2) + '\n', { flag: 'wx' });
    const enabled = patches.empty();
    if (previous.state === 'applied') enabled['home-widgets'] = enabled['search-promotions'] = true;
    return {
      version: 3, archivePath: ctx.archive, cssDir: ctx.cssDir, state: previous.state,
      baseline: previous.baseline, originalPatches: previous.originalPatches,
      enabled, expected: current, sidecars: sidecarHashes(ctx, previous.baseline.archive.file), migration,
    };
  }
  const sidebar = extract(ctx.archive, sidebarPath(ctx.archive).split(path.sep).join('/'));
  const preload = extract(ctx.archive, patches.PRELOAD);
  if (sidebar.includes(patches.LEGACY_MARKER) || preload.includes(patches.PREFIX) ||
      extract(ctx.archive, rendererPath(ctx.archive)).includes(patches.PREFIX)) {
    throw new Error('Existing patches lack a restore registry.');
  }
  for (const name of HOME_FILES) {
    const file = path.join(ctx.cssDir, name);
    if (fs.existsSync(file) && /taobao-agent-declutter:v[13]/.test(fs.readFileSync(file, 'utf8'))) {
      throw new Error('Existing CSS patches lack a restore registry.');
    }
  }
  const baseline = capture(ctx, 'baseline-');
  return {
    version: 3, archivePath: ctx.archive, cssDir: ctx.cssDir, state: 'restored',
    baseline, originalPatches: patchStates(ctx.archive), enabled: patches.empty(),
    expected: installedHashes(ctx), sidecars: sidecarHashes(ctx, baseline.archive.file),
  };
}

function appRunning() {
  const output = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq ' + APP_NAME, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  // The image name may use an OEM encoding; the filtered CSV PID stays ASCII.
  return /^"[^"]*","\d+"/m.test(output);
}
async function stopClient() {
  if (!appRunning()) return;
  execFileSync('taskkill.exe', ['/F', '/IM', APP_NAME], { stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!appRunning()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Taobao Desktop is still running; archive replacement was cancelled.');
}
function findExecutable() {
  const archive = patchAsar.findAsarPath();
  const executable = path.join(path.dirname(path.dirname(archive)), APP_NAME);
  if (!fs.existsSync(executable)) throw new Error('Could not locate ' + APP_NAME);
  return executable;
}
function pipeReady() {
  return new Promise(resolve => {
    const client = net.connect('\\\\.\\pipe\\taobao-cli-rpc');
    let settled = false;
    const finish = ready => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(ready);
    };
    client.setTimeout(2000);
    client.once('connect', () => finish(true));
    client.once('error', () => finish(false));
    client.once('timeout', () => finish(false));
  });
}
async function launchClient() {
  const executable = findExecutable();
  await new Promise((resolve, reject) => {
    const shell = spawn('cmd.exe', ['/c', 'start', '""', '/min', '"' + executable + '"'], {
      stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true,
    });
    shell.once('error', reject);
    shell.once('exit', code => code === 0 ? resolve() : reject(new Error('Client launch failed: ' + code)));
  });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await pipeReady()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Taobao Desktop did not expose its named pipe after relaunch.');
}
async function withLock(ctx, operation) {
  fs.mkdirSync(ctx.backupDir, { recursive: true });
  if (fs.existsSync(ctx.lockPath)) {
    const owner = JSON.parse(fs.readFileSync(ctx.lockPath, 'utf8'));
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else throw error;
    }
    if (alive) throw new Error('Another declutter command is running.');
    fs.unlinkSync(ctx.lockPath);
  }
  const fd = fs.openSync(ctx.lockPath, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  fs.closeSync(fd);
  let stopped = false;
  async function stop() {
    if (ctx.restart && !stopped) {
      stopped = true;
      await stopClient();
    }
  }
  try {
    let manifest = loadManifest(ctx);
    if (manifest?.pending) {
      await stop();
      manifest = recover(ctx, manifest);
    }
    return await operation(manifest, stop);
  } finally {
    fs.unlinkSync(ctx.lockPath);
    if (stopped) await launchClient();
  }
}
async function changePatches(target, applying, options = {}) {
  const selected = patches.targets(target); // Validate before touching files or the client.
  const ctx = context(options);
  return withLock(ctx, async (previous, stop) => {
    if (!previous && !applying) {
      console.log('[declutter] No UI patches to restore.');
      return;
    }
    const migrating = previous?.version === 2;
    let manifest = previous?.version === 3 ? previous : initializeRegistry(ctx, previous);
    verifySnapshot(manifest.baseline);
    verifySidecars(ctx, manifest);
    verifyInstalled(ctx, manifest.expected);
    const enabled = { ...manifest.enabled };
    for (const id of selected) enabled[id] = applying;
    if (!migrating && manifest.patchRevision === patches.REVISION && JSON.stringify(enabled) === JSON.stringify(manifest.enabled)) {
      console.log('[declutter] No change; originals and other patches preserved.');
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taobao-declutter-'));
    try {
      const css = desiredCss(ctx, manifest, enabled);
      const staged = await buildArchive(ctx, manifest, root, enabled);
      const expected = {
        archive: hashFile(staged),
        css: Object.fromEntries(HOME_FILES.map(name => [name, css[name] === null ? null : hash(css[name])])),
      };
      verifyInstalled(ctx, manifest.expected);
      if (JSON.stringify(expected) === JSON.stringify(manifest.expected)) {
        manifest.enabled = enabled;
        manifest.patchRevision = patches.REVISION;
        manifest.state = Object.values(enabled).some(Boolean) ? 'applied' : 'restored';
        saveManifest(ctx, manifest);
        console.log('[declutter] Registry updated; installed files unchanged, no restart needed.');
        return;
      }
      await stop();
      verifyInstalled(ctx, manifest.expected);
      const snapshot = capture(ctx, 'transaction-');
      const previousManifest = JSON.parse(JSON.stringify(previous || manifest));
      // Journal records the complete previous registry, including migration version.
      manifest.pending = { snapshot, previousManifest, stagedRoot: root };
      saveManifest(ctx, manifest);
      try {
        if (hashFile(ctx.archive) !== expected.archive) copyAtomic(staged, ctx.archive);
        if (ctx.hooks.afterArchiveWrite) ctx.hooks.afterArchiveWrite();
        for (const filename of HOME_FILES) {
          const file = path.join(ctx.cssDir, filename);
          if (css[filename] === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
          else writeAtomic(file, css[filename]);
          if (ctx.hooks.afterCssWrite) ctx.hooks.afterCssWrite(filename);
        }
        verifyInstalled(ctx, expected);
        verifySidecars(ctx, manifest);
        if (JSON.stringify(patchStates(ctx.archive)) !== JSON.stringify(manifest.originalPatches)) {
          throw new Error('Existing gatekeeper or feature patches changed.');
        }
        manifest.enabled = enabled;
        manifest.patchRevision = patches.REVISION;
        manifest.expected = expected;
        manifest.state = Object.values(enabled).some(Boolean) ? 'applied' : 'restored';
        manifest.updatedAt = new Date().toISOString();
        finishTransaction(ctx, manifest, snapshot);
      } catch (error) {
        try {
          restoreSnapshot(ctx, snapshot);
          saveManifest(ctx, previousManifest);
          removeTree(snapshot.root, ctx.backupDir, 'transaction-');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Commit failed; recovery snapshots retained.');
        }
        throw error;
      }
      console.log('[declutter] ' + (applying ? 'Applied ' : 'Restored ') + target + '; other groups preserved.');
    } finally {
      asar.uncacheAll();
      removeTree(root, os.tmpdir(), 'taobao-declutter-');
    }
  });
}
function applyDeclutter(target, options) { return changePatches(target, true, options); }
function restoreDeclutter(target, options) { return changePatches(target, false, options); }
function showStatus(options = {}) {
  const ctx = context(options);
  const manifest = loadManifest(ctx);
  let health = 'NONE';
  if (manifest) {
    try { verifySnapshot(manifest.baseline); health = 'VERIFIED'; }
    catch (_) { health = 'INVALID'; }
  }
  let contents = 'UNMANAGED';
  if (manifest?.version === 3) {
    try { verifyInstalled(ctx, manifest.expected); verifySidecars(ctx, manifest); contents = 'VERIFIED'; }
    catch (_) { contents = 'DRIFTED'; }
  }
  console.log('--- Taobao Desktop UI Patch Status ---');
  for (const id of patches.IDS) console.log(id.padEnd(22), ':', manifest?.version === 2 ? 'LEGACY (migration required)' :
    manifest?.enabled[id] ? contents === 'VERIFIED' ? 'APPLIED' : 'APPLIED / DRIFTED' : 'NOT APPLIED');
  console.log('Original snapshots     :', health);
  console.log('Installed contents     :', contents);
  console.log('Transaction recovery   :', manifest?.pending ? 'REQUIRED' : 'NONE');
  console.log('Existing patches       :', JSON.stringify(patchStates(ctx.archive)));
  console.log('Visual verification    : Not inferred from installed-file status.');
}
async function main() {
  const command = process.argv[2] || '--status';
  if (command === '--status') showStatus();
  else if (command === '--apply') await applyDeclutter(process.argv[3]);
  else if (command === '--restore') await restoreDeclutter(process.argv[3]);
  else throw new Error('Usage: node scripts/declutter.js --status | (--apply | --restore) <patch-id | all>');
}
if (require.main === module) {
  main().catch(error => { console.error('[declutter ERROR]', error.stack || error); process.exitCode = 1; });
}
module.exports = { applyDeclutter, restoreDeclutter, showStatus, verifyRebuild, installedHashes, context, desiredFiles, desiredCss, patches };
