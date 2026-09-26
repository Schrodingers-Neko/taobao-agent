#!/usr/bin/env node
/**
 * Taobao Desktop ASAR Inoculation Utility
 * Safely manages in-place byte bypasses in app.asar:
 *   1. Gatekeeper bypass: Neutralizes cloud beta whitelist lockout (if(_0x2505bf) -> if(!1&&false), 13 bytes).
 *   2. Feature unblocker: Neutralizes runtime vendor tool suppression (!om['has'](...) -> !0/*...*\/, 29 bytes).
 * 
 * Usage:
 *   node scripts/patch-asar.js --status          Check patch status and hashes
 *   node scripts/patch-asar.js --patch           Apply 13-byte gatekeeper bypass
 *   node scripts/patch-asar.js --patch-features  Apply 29-byte tool feature unblocker
 *   node scripts/patch-asar.js --patch-all       Apply both bypasses
 *   node scripts/patch-asar.js --restore         Revert to original vendor binary
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// 1. Gatekeeper Signature (13 bytes)
const GK_TARGET_SIG = Buffer.from('if(_0x2505bf)');
const GK_PATCHED_SIG = Buffer.from('if(!1&&false)');
const GK_CONTEXT_LEAD = Buffer.from('120d,0x11c2)]);');
const GK_CONTEXT_TRAIL = Buffer.from("return'未登录，已打");

// 2. Feature Unblocker Signature (29 bytes)
const FT_TARGET_SIG = Buffer.from("!om['has'](_0x32d1ec['name'])");
const FT_PATCHED_SIG = Buffer.from("!0/*-----------------------*/");
const FT_CONTEXT_LEAD = Buffer.from("filter'](_0x32d1ec=>");
const FT_CONTEXT_TRAIL = Buffer.from(");}function lm()");

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

function scanSignature(indexBuf, absIndexStart, targetSig, patchedSig, contextLead, contextTrail) {
  // 1. Look for unpatched signature
  let targetRel = indexBuf.indexOf(targetSig);
  while (targetRel !== -1) {
    const lead = indexBuf.subarray(Math.max(0, targetRel - 40), targetRel);
    const trail = indexBuf.subarray(targetRel + targetSig.length, targetRel + targetSig.length + 40);
    if (lead.includes(contextLead) || trail.includes(contextTrail)) {
      return {
        state: 'ORIGINAL',
        relOffset: targetRel,
        absOffset: absIndexStart + targetRel,
      };
    }
    targetRel = indexBuf.indexOf(targetSig, targetRel + targetSig.length);
  }

  // 2. Look for patched signature
  let patchedRel = indexBuf.indexOf(patchedSig);
  while (patchedRel !== -1) {
    const lead = indexBuf.subarray(Math.max(0, patchedRel - 40), patchedRel);
    const trail = indexBuf.subarray(patchedRel + patchedSig.length, patchedRel + patchedSig.length + 40);
    if (lead.includes(contextLead) || trail.includes(contextTrail)) {
      return {
        state: 'PATCHED',
        relOffset: patchedRel,
        absOffset: absIndexStart + patchedRel,
      };
    }
    patchedRel = indexBuf.indexOf(patchedSig, patchedRel + patchedSig.length);
  }

  return { state: 'UNKNOWN', relOffset: -1, absOffset: -1 };
}

function findGatekeeperSignature(asarPath, meta) {
  const fd = fs.openSync(asarPath, 'r');
  const indexBuf = Buffer.alloc(meta.indexSize);
  fs.readSync(fd, indexBuf, 0, meta.indexSize, meta.absIndexStart);
  fs.closeSync(fd);

  return scanSignature(indexBuf, meta.absIndexStart, GK_TARGET_SIG, GK_PATCHED_SIG, GK_CONTEXT_LEAD, GK_CONTEXT_TRAIL);
}

function findFeatureSignature(asarPath, meta) {
  const fd = fs.openSync(asarPath, 'r');
  const indexBuf = Buffer.alloc(meta.indexSize);
  fs.readSync(fd, indexBuf, 0, meta.indexSize, meta.absIndexStart);
  fs.closeSync(fd);

  return scanSignature(indexBuf, meta.absIndexStart, FT_TARGET_SIG, FT_PATCHED_SIG, FT_CONTEXT_LEAD, FT_CONTEXT_TRAIL);
}

function showStatus() {
  const asarPath = findAsarPath();
  const bakPath = asarPath + '.original.bak';

  log('Target ASAR:', asarPath);
  log('Backup file:', fs.existsSync(bakPath) ? bakPath : '(none)');

  const meta = parseAsarHeader(asarPath);
  const gkInfo = findGatekeeperSignature(asarPath, meta);
  const ftInfo = findFeatureSignature(asarPath, meta);

  console.log('\n--- ASAR Inoculation Status ---');
  console.log('1. Gatekeeper Bypass : ', gkInfo.state, `(Offset: ${gkInfo.absOffset > 0 ? gkInfo.absOffset : 'N/A'})`);
  console.log('2. Feature Unblocker : ', ftInfo.state === 'PATCHED' ? 'PATCHED (UNBLOCKED)' : ftInfo.state === 'ORIGINAL' ? 'ORIGINAL (SUPPRESSED)' : 'UNKNOWN', `(Offset: ${ftInfo.absOffset > 0 ? ftInfo.absOffset : 'N/A'})`);
  console.log('Current Hash         : ', sha256(asarPath));
  if (fs.existsSync(bakPath)) {
    console.log('Backup Hash          : ', sha256(bakPath));
  }
  console.log('-------------------------------\n');
}

function ensureBackup(asarPath, bakPath) {
  if (!fs.existsSync(bakPath)) {
    log('Creating pristine backup copy:', bakPath);
    fs.copyFileSync(asarPath, bakPath);
  }
}

function applyGatekeeperPatch() {
  const asarPath = findAsarPath();
  const bakPath = asarPath + '.original.bak';

  log('Locating target app.asar at:', asarPath);
  const meta = parseAsarHeader(asarPath);
  const sigInfo = findGatekeeperSignature(asarPath, meta);

  if (sigInfo.state === 'PATCHED') {
    log('Gatekeeper bypass is already applied. Nothing to do.');
    return;
  }

  if (sigInfo.state !== 'ORIGINAL') {
    throw new Error('Could not identify recognizable gatekeeper signature in out/main/index.js.');
  }

  ensureBackup(asarPath, bakPath);
  terminateApp();

  log(`Writing 13-byte gatekeeper bypass at offset ${sigInfo.absOffset}...`);
  const fd = fs.openSync(asarPath, 'r+');
  const verifyBuf = Buffer.alloc(GK_TARGET_SIG.length);
  fs.readSync(fd, verifyBuf, 0, GK_TARGET_SIG.length, sigInfo.absOffset);
  if (verifyBuf.toString('utf8') !== GK_TARGET_SIG.toString('utf8')) {
    fs.closeSync(fd);
    throw new Error('Offset verification failed! Target bytes did not match expected gatekeeper signature.');
  }

  fs.writeSync(fd, GK_PATCHED_SIG, 0, GK_PATCHED_SIG.length, sigInfo.absOffset);
  fs.closeSync(fd);

  log('Verifying gatekeeper patch application...');
  const updatedSig = findGatekeeperSignature(asarPath, meta);
  if (updatedSig.state === 'PATCHED') {
    log('SUCCESS: Gatekeeper inoculation applied cleanly.');
  } else {
    throw new Error('Verification failed: gatekeeper signature state is not PATCHED after write.');
  }
}

function applyFeaturePatch() {
  const asarPath = findAsarPath();
  const bakPath = asarPath + '.original.bak';

  log('Locating target app.asar at:', asarPath);
  const meta = parseAsarHeader(asarPath);
  const sigInfo = findFeatureSignature(asarPath, meta);

  if (sigInfo.state === 'PATCHED') {
    log('Feature unblocker is already applied. Nothing to do.');
    return;
  }

  if (sigInfo.state !== 'ORIGINAL') {
    throw new Error('Could not identify recognizable feature suppression signature in out/main/index.js.');
  }

  ensureBackup(asarPath, bakPath);
  terminateApp();

  if (FT_TARGET_SIG.length !== FT_PATCHED_SIG.length) {
    throw new Error('Safety assertion failed: FT_TARGET_SIG length does not match FT_PATCHED_SIG length!');
  }

  log(`Writing 29-byte feature unblocker bypass at offset ${sigInfo.absOffset}...`);
  const fd = fs.openSync(asarPath, 'r+');
  const verifyBuf = Buffer.alloc(FT_TARGET_SIG.length);
  fs.readSync(fd, verifyBuf, 0, FT_TARGET_SIG.length, sigInfo.absOffset);
  if (verifyBuf.toString('utf8') !== FT_TARGET_SIG.toString('utf8')) {
    fs.closeSync(fd);
    throw new Error('Offset verification failed! Target bytes did not match expected feature signature.');
  }

  fs.writeSync(fd, FT_PATCHED_SIG, 0, FT_PATCHED_SIG.length, sigInfo.absOffset);
  fs.closeSync(fd);

  log('Verifying feature patch application...');
  const updatedSig = findFeatureSignature(asarPath, meta);
  if (updatedSig.state === 'PATCHED') {
    log('SUCCESS: Feature unblocker applied cleanly. Native RPC tools (add_to_cart, open_chat, etc.) are unblocked.');
  } else {
    throw new Error('Verification failed: feature signature state is not PATCHED after write.');
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
  const gk = findGatekeeperSignature(asarPath, meta);
  const ft = findFeatureSignature(asarPath, meta);
  log('SUCCESS: Restored original unpatched app.asar (GK:', gk.state, ', Features:', ft.state, ').');
}

// Aliases for backward compatibility
const findSignatureLocation = findGatekeeperSignature;
const applyPatch = applyGatekeeperPatch;

// CLI entrypoint
if (require.main === module) {
  const arg = process.argv[2] || '--status';
  try {
    if (arg === '--patch') {
      applyGatekeeperPatch();
    } else if (arg === '--patch-features') {
      applyFeaturePatch();
    } else if (arg === '--patch-all') {
      applyGatekeeperPatch();
      applyFeaturePatch();
    } else if (arg === '--restore') {
      restoreOriginal();
    } else if (arg === '--status') {
      showStatus();
    } else {
      console.log('Usage: node scripts/patch-asar.js [--status | --patch | --patch-features | --patch-all | --restore]');
      process.exit(1);
    }
  } catch (err) {
    console.error('\n[patch-asar ERROR]:', err.message);
    process.exit(1);
  }
}

module.exports = {
  findAsarPath,
  sha256,
  terminateApp,
  parseAsarHeader,
  findGatekeeperSignature,
  findFeatureSignature,
  findSignatureLocation,
  showStatus,
  applyGatekeeperPatch,
  applyFeaturePatch,
  applyPatch,
  restoreOriginal,
};
