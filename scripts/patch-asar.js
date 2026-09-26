#!/usr/bin/env node
/**
 * Taobao Desktop ASAR Inoculation Utility
 * Safely manages the 13-byte bypass for the upstream cloud gatekeeper in app.asar.
 * 
 * Usage:
 *   node scripts/patch-asar.js --status   Check patch status and hashes
 *   node scripts/patch-asar.js --patch    Apply 13-byte in-place bypass
 *   node scripts/patch-asar.js --restore  Revert to original vendor binary
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const TARGET_SIG = Buffer.from('if(_0x2505bf)'); // 13 bytes
const PATCHED_SIG = Buffer.from('if(!1&&false)'); // 13 bytes
const CONTEXT_LEAD = Buffer.from('120d,0x11c2)]);');
const CONTEXT_TRAIL = Buffer.from("return'未登录，已打");

function log(...args) {
  console.log('[patch-asar]', ...args);
}

function findAsarPath() {
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;

  const candidates = [];
  if (appData) {
    const locFile = path.join(appData, 'taobao', 'install-location.txt');
    try {
      if (fs.existsSync(locFile)) {
        const installDir = fs.readFileSync(locFile, 'utf8').trim();
        candidates.push(path.join(installDir, 'resources', 'app.asar'));
      }
    } catch (_) {}
  }

  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'taobao', 'resources', 'app.asar'));
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error('Unable to locate Taobao Desktop app.asar in standard locations.');
}

function sha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  let bytesRead;
  while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) !== 0) {
    hash.update(buf.subarray(0, bytesRead));
  }
  fs.closeSync(fd);
  return hash.digest('hex').toUpperCase();
}

function terminateApp() {
  try {
    execSync('taskkill /F /IM 淘宝桌面版.exe', { stdio: 'ignore' });
    log('Terminated running 淘宝桌面版.exe process(es).');
  } catch (_) {
    // Process was not running
  }
}

function parseAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const headerSize = sizeBuf.readUInt32LE(12);
  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 16);
  fs.closeSync(fd);

  const header = JSON.parse(headerBuf.toString('utf8'));
  const baseOffset = 16 + headerSize;

  const indexNode = header?.files?.out?.files?.main?.files?.['index.js'];
  if (!indexNode || indexNode.offset === undefined) {
    throw new Error('out/main/index.js not found in ASAR header index.');
  }

  return {
    headerSize,
    baseOffset,
    indexOffset: parseInt(indexNode.offset, 10),
    indexSize: indexNode.size,
    absIndexStart: baseOffset + parseInt(indexNode.offset, 10),
  };
}

function findSignatureLocation(asarPath, meta) {
  const fd = fs.openSync(asarPath, 'r');
  const indexBuf = Buffer.alloc(meta.indexSize);
  fs.readSync(fd, indexBuf, 0, meta.indexSize, meta.absIndexStart);
  fs.closeSync(fd);

  // 1. Look for unpatched signature
  let targetRel = indexBuf.indexOf(TARGET_SIG);
  while (targetRel !== -1) {
    const lead = indexBuf.subarray(Math.max(0, targetRel - 30), targetRel);
    const trail = indexBuf.subarray(targetRel + TARGET_SIG.length, targetRel + TARGET_SIG.length + 30);
    if (lead.includes(CONTEXT_LEAD) || trail.includes(CONTEXT_TRAIL)) {
      return {
        state: 'ORIGINAL',
        relOffset: targetRel,
        absOffset: meta.absIndexStart + targetRel,
      };
    }
    targetRel = indexBuf.indexOf(TARGET_SIG, targetRel + TARGET_SIG.length);
  }

  // 2. Look for patched signature
  let patchedRel = indexBuf.indexOf(PATCHED_SIG);
  while (patchedRel !== -1) {
    const lead = indexBuf.subarray(Math.max(0, patchedRel - 30), patchedRel);
    const trail = indexBuf.subarray(patchedRel + PATCHED_SIG.length, patchedRel + PATCHED_SIG.length + 30);
    if (lead.includes(CONTEXT_LEAD) || trail.includes(CONTEXT_TRAIL)) {
      return {
        state: 'PATCHED',
        relOffset: patchedRel,
        absOffset: meta.absIndexStart + patchedRel,
      };
    }
    patchedRel = indexBuf.indexOf(PATCHED_SIG, patchedRel + PATCHED_SIG.length);
  }

  return { state: 'UNKNOWN', relOffset: -1, absOffset: -1 };
}

function showStatus() {
  const asarPath = findAsarPath();
  const bakPath = asarPath + '.original.bak';

  log('Target ASAR:', asarPath);
  log('Backup file:', fs.existsSync(bakPath) ? bakPath : '(none)');

  const meta = parseAsarHeader(asarPath);
  const sigInfo = findSignatureLocation(asarPath, meta);

  console.log('\n--- ASAR Gatekeeper Status ---');
  console.log('Status:       ', sigInfo.state);
  console.log('Absolute byte:', sigInfo.absOffset > 0 ? sigInfo.absOffset : 'N/A');
  console.log('Current Hash: ', sha256(asarPath));
  if (fs.existsSync(bakPath)) {
    console.log('Backup Hash:  ', sha256(bakPath));
  }
  console.log('------------------------------\n');
}

function applyPatch() {
  const asarPath = findAsarPath();
  const bakPath = asarPath + '.original.bak';

  log('Locating target app.asar at:', asarPath);
  const meta = parseAsarHeader(asarPath);
  const sigInfo = findSignatureLocation(asarPath, meta);

  if (sigInfo.state === 'PATCHED') {
    log('ASAR is already patched (gatekeeper bypassed). Nothing to do.');
    return;
  }

  if (sigInfo.state !== 'ORIGINAL') {
    throw new Error('Could not identify recognizable gatekeeper signature in out/main/index.js.');
  }

  // Ensure backup exists
  if (!fs.existsSync(bakPath)) {
    log('Creating pristine backup copy:', bakPath);
    fs.copyFileSync(asarPath, bakPath);
  }

  terminateApp();

  if (TARGET_SIG.length !== PATCHED_SIG.length) {
    throw new Error('Safety assertion failed: TARGET_SIG length does not match PATCHED_SIG length!');
  }

  log(`Writing 13-byte bypass at absolute offset ${sigInfo.absOffset}...`);
  const fd = fs.openSync(asarPath, 'r+');

  // Double check target bytes before write
  const verifyBuf = Buffer.alloc(TARGET_SIG.length);
  fs.readSync(fd, verifyBuf, 0, TARGET_SIG.length, sigInfo.absOffset);
  if (verifyBuf.toString('utf8') !== TARGET_SIG.toString('utf8')) {
    fs.closeSync(fd);
    throw new Error('Offset verification failed! Target bytes did not match expected signature.');
  }

  fs.writeSync(fd, PATCHED_SIG, 0, PATCHED_SIG.length, sigInfo.absOffset);
  fs.closeSync(fd);

  log('Verifying patch application...');
  const updatedSig = findSignatureLocation(asarPath, meta);
  if (updatedSig.state === 'PATCHED') {
    log('SUCCESS: Inoculation patch applied cleanly. The client is now immune to cloud gatekeeper lockouts.');
  } else {
    throw new Error('Verification failed: signature state is not PATCHED after write.');
  }
}

function restoreOriginal() {
  const asarPath = findAsarPath();
  const bakPath = asarPath + '.original.bak';

  if (!fs.existsSync(bakPath)) {
    throw new Error(`Backup file not found at ${bakPath}. Cannot restore.`);
  }

  terminateApp();

  log('Restoring app.asar from backup...');
  fs.copyFileSync(bakPath, asarPath);

  const meta = parseAsarHeader(asarPath);
  const sig = findSignatureLocation(asarPath, meta);
  if (sig.state === 'ORIGINAL') {
    log('SUCCESS: Restored original unpatched app.asar.');
  } else {
    log('Notice: Restored file from backup, status:', sig.state);
  }
}

// CLI entrypoint
const arg = process.argv[2] || '--status';
try {
  if (arg === '--patch') {
    applyPatch();
  } else if (arg === '--restore') {
    restoreOriginal();
  } else if (arg === '--status') {
    showStatus();
  } else {
    console.log('Usage: node scripts/patch-asar.js [--status | --patch | --restore]');
    process.exit(1);
  }
} catch (err) {
  console.error('\n[patch-asar ERROR]:', err.message);
  process.exit(1);
}
