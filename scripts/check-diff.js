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

function compareSkill(skillName = 'taobao-native') {
  const store = getDesktopSkillsStore();
  if (!store || !store.buildIn) {
    return { error: 'Could not access Taobao Desktop skills store in %APPDATA%\\taobao' };
  }

  // Map local skill name to internal store key
  const internalKey = skillName === 'taobao-native' ? 'taobao-native-internal' : skillName;
  const upstreamInfo = store.buildIn[internalKey];

  if (!upstreamInfo || !upstreamInfo.path) {
    return { error: `Skill "${internalKey}" not found in Taobao Desktop builtin store` };
  }

  const localSkillDir = path.resolve(__dirname, '..', 'skills', skillName);
  const upstreamSkillDir = upstreamInfo.path;

  // Versions
  const localSkillMd = path.join(localSkillDir, 'SKILL.md');
  const localVersion = fs.existsSync(localSkillMd)
    ? parseFrontmatterVersion(fs.readFileSync(localSkillMd, 'utf8')) || 'unknown'
    : 'not_installed';
  const upstreamVersion = upstreamInfo.version || 'unknown';

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
    internalName: internalKey,
    localVersion,
    upstreamVersion,
    isUpstreamNewer: upstreamVersion !== localVersion,
    localPath: localSkillDir,
    upstreamPath: upstreamSkillDir,
    changedFiles,
    files: fileDiffs,
  };
}

// CLI Execution
if (require.main === module) {
  const result = compareSkill('taobao-native');
  if (result.error) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  console.log('====================================================');
  console.log('       TAOBAO-AGENT UPSTREAM SKILL DIFF REPORT      ');
  console.log('====================================================');
  console.log(`Target Skill     : ${result.skillName} (Internal: ${result.internalName})`);
  console.log(`Local Version    : ${result.localVersion}`);
  console.log(`Upstream Version : ${result.upstreamVersion} ${result.isUpstreamNewer ? '⚡ (NEWER VERSION DETECTED)' : '✅ (UP TO DATE)'}`);
  console.log(`Local Path       : ${result.localPath}`);
  console.log(`Upstream Path    : ${result.upstreamPath}`);
  console.log('----------------------------------------------------');
  console.log(`Changed / Diverged Files (${result.changedFiles.length}):`);
  for (const file of result.changedFiles) {
    const info = result.files[file];
    console.log(`  • ${file.padEnd(35)} : [${info.status}] (Local: ${info.localSize ?? '-'} bytes, Upstream: ${info.upstreamSize ?? '-'} bytes)`);
  }
  console.log('----------------------------------------------------');
  console.log('All File Statuses:');
  for (const [file, info] of Object.entries(result.files)) {
    console.log(`  [${info.status.padEnd(13)}] ${file}`);
  }
  console.log('====================================================');
}

module.exports = { compareSkill };
