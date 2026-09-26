#!/usr/bin/env node
/**
 * Standalone Upstream Skill Diff Tool
 * Compares skills in skills/ against Taobao Desktop's live builtin skills directory.
 */

const fs = require('fs');
const path = require('path');

function getDesktopSkillsStore() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const storePath = path.join(appData, 'taobao', 'agent-skills-store.json');
  try {
    if (fs.existsSync(storePath)) {
      return JSON.parse(fs.readFileSync(storePath, 'utf8'));
    }
  } catch (err) {
    console.error('[check-diff] Error reading agent-skills-store.json:', err.message);
  }
  return null;
}

function parseFrontmatterVersion(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const versionMatch = m[1].match(/version:\s*["']?([^"'\r\n]+)["']?/);
  return versionMatch ? versionMatch[1].trim() : null;
}

function getSkillFiles(dir) {
  const result = {};
  if (!fs.existsSync(dir)) return result;

  function walk(currentDir, baseDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      if (entry.name === '.DS_Store' || entry.name.endsWith('.bak')) continue;

      if (entry.isDirectory()) {
        walk(fullPath, baseDir);
      } else if (entry.isFile()) {
        result[relPath] = {
          size: fs.statSync(fullPath).size,
          path: fullPath,
        };
      }
    }
  }

  walk(dir, dir);
  return result;
}

const os = require('os');

function resolveUpstreamInfo(skillName, store) {
  const tbHome = path.join(os.homedir(), '.taobao');
  let userDirs = [];
  if (fs.existsSync(tbHome)) {
    try {
      userDirs = fs.readdirSync(tbHome).filter((d) => {
        try {
          return fs.statSync(path.join(tbHome, d)).isDirectory();
        } catch {
          return false;
        }
      });
      // Prioritize active signed-in user profiles before 'default'
      userDirs.sort((a, b) => (a === 'default' ? 1 : b === 'default' ? -1 : 0));
    } catch {}
  }

  const candidateKeys = [];
  if (skillName === 'taobao-native') {
    candidateKeys.push('taobao-native-internal');
  } else if (skillName === 'procurement-assistant') {
    candidateKeys.push('procurement-assistant', 'procurement-assistant-local');
  } else {
    candidateKeys.push(skillName);
  }

  for (const k of candidateKeys) {
    // 1. Check user dirs first
    for (const u of userDirs) {
      const p = path.join(tbHome, u, 'skills', 'builtin', k);
      if (fs.existsSync(p)) {
        const skillMd = path.join(p, 'SKILL.md');
        const v = fs.existsSync(skillMd) ? parseFrontmatterVersion(fs.readFileSync(skillMd, 'utf8')) : null;
        return {
          key: k,
          path: p,
          version: v || (store && store.buildIn && store.buildIn[k] ? store.buildIn[k].version : 'unknown'),
        };
      }
    }
    // 2. Check store.buildIn
    if (store && store.buildIn && store.buildIn[k] && fs.existsSync(store.buildIn[k].path)) {
      const p = store.buildIn[k].path;
      const skillMd = path.join(p, 'SKILL.md');
      const v = fs.existsSync(skillMd) ? parseFrontmatterVersion(fs.readFileSync(skillMd, 'utf8')) : null;
      return {
        key: k,
        path: p,
        version: v || store.buildIn[k].version || 'unknown',
      };
    }
  }

  return null;
}

function compareSkill(skillName = 'taobao-native') {
  const store = getDesktopSkillsStore();
  const upstream = resolveUpstreamInfo(skillName, store);

  if (!upstream || !upstream.path) {
    return { error: `Skill "${skillName}" not found in Taobao Desktop builtin store or directories`, skillName };
  }

  const localSkillDir = path.resolve(__dirname, '..', 'skills', skillName);
  const upstreamSkillDir = upstream.path;

  // Versions
  const localSkillMd = path.join(localSkillDir, 'SKILL.md');
  const localVersion = fs.existsSync(localSkillMd)
    ? parseFrontmatterVersion(fs.readFileSync(localSkillMd, 'utf8')) || 'unknown'
    : 'not_installed';
  const upstreamVersion = upstream.version || 'unknown';

  // Files
  const localFiles = getSkillFiles(localSkillDir);
  const upstreamFiles = getSkillFiles(upstreamSkillDir);

  const allFileKeys = Array.from(new Set([...Object.keys(localFiles), ...Object.keys(upstreamFiles)])).sort();

  const fileDiffs = {};
  const changedFiles = [];

  for (const file of allFileKeys) {
    const hasLocal = !!localFiles[file];
    const hasUpstream = !!upstreamFiles[file];

    if (hasLocal && !hasUpstream) {
      fileDiffs[file] = { status: 'LOCAL_ONLY', localSize: localFiles[file].size };
    } else if (!hasLocal && hasUpstream) {
      fileDiffs[file] = { status: 'UPSTREAM_ONLY', upstreamSize: upstreamFiles[file].size };
      changedFiles.push(file);
    } else {
      const localSize = localFiles[file].size;
      const upstreamSize = upstreamFiles[file].size;
      const isIdentical = localSize === upstreamSize &&
        fs.readFileSync(localFiles[file].path).equals(fs.readFileSync(upstreamFiles[file].path));

      fileDiffs[file] = {
        status: isIdentical ? 'IDENTICAL' : 'MODIFIED',
        localSize,
        upstreamSize,
      };
      if (!isIdentical) changedFiles.push(file);
    }
  }

  return {
    skillName,
    internalName: upstream.key,
    localVersion,
    upstreamVersion,
    isUpstreamNewer: upstreamVersion !== localVersion,
    localPath: localSkillDir,
    upstreamPath: upstreamSkillDir,
    changedFiles,
    files: fileDiffs,
  };
}

function getInstalledSkillNames() {
  const skillsDir = path.resolve(__dirname, '..', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir).filter((d) => {
    try {
      return fs.statSync(path.join(skillsDir, d)).isDirectory();
    } catch {
      return false;
    }
  });
}

function printReport(result) {
  if (result.error) {
    console.error(`[${result.skillName || 'unknown'}] Error:`, result.error);
    return;
  }
  console.log('====================================================');
  console.log(`Target Skill     : ${result.skillName} (Upstream: ${result.internalName})`);
  console.log(`Local Version    : ${result.localVersion}`);
  console.log(`Upstream Version : ${result.upstreamVersion} ${result.isUpstreamNewer ? '⚡ (NEWER VERSION DETECTED)' : '✅ (UP TO DATE)'}`);
  console.log(`Local Path       : ${result.localPath}`);
  console.log(`Upstream Path    : ${result.upstreamPath}`);
  console.log('----------------------------------------------------');
  console.log(`Changed / Diverged Files (${result.changedFiles.length}):`);
  for (const file of result.changedFiles) {
    const info = result.files[file];
    console.log(`  • ${file.padEnd(30)} : [${info.status}] (Local: ${info.localSize ?? '-'} bytes, Upstream: ${info.upstreamSize ?? '-'} bytes)`);
  }
  if (result.changedFiles.length === 0) {
    console.log('  All files identical.');
  }
  console.log('====================================================\n');
}

// CLI Execution
if (require.main === module) {
  const arg = process.argv[2];
  if (arg && arg !== '--all') {
    const res = compareSkill(arg);
    printReport(res);
    if (res.error) process.exit(1);
  } else {
    const skills = getInstalledSkillNames();
    console.log(`Scanning ${skills.length} installed skill(s) under skills/...`);
    let hasError = false;
    for (const s of skills) {
      const res = compareSkill(s);
      printReport(res);
      if (res.error) hasError = true;
    }
    if (hasError) process.exit(1);
  }
}

module.exports = { compareSkill, resolveUpstreamInfo, getInstalledSkillNames };
