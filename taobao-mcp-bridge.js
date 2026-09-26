#!/usr/bin/env node
/**
 * Taobao Desktop MCP Server Bridge for Windows
 * Bridges standard MCP JSON-RPC 2.0 (stdio) to Taobao Desktop's Named Pipe (\\.\pipe\taobao-cli-rpc).
 */

const net = require('net');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { compareSkill } = require('./scripts/check-diff');

const PIPE_PATH = '\\\\.\\pipe\\taobao-cli-rpc';
const LAUNCH_TIMEOUT_MS = 25000;
const POLL_INTERVAL_MS = 500;

function log(...args) {
  process.stderr.write(`[taobao-mcp] ${args.join(' ')}\n`);
}

/**
 * Locate the Taobao Desktop executable on Windows.
 */
function findExecutable() {
  const appData = process.env.APPDATA;
  if (appData) {
    const locFile = path.join(appData, 'taobao', 'install-location.txt');
    try {
      if (fs.existsSync(locFile)) {
        const installDir = fs.readFileSync(locFile, 'utf8').trim();
        const exePath = path.join(installDir, '淘宝桌面版.exe');
        if (fs.existsSync(exePath)) return exePath;
      }
    } catch (_) {}
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const defaultExe = path.join(localAppData, 'Programs', 'taobao', '淘宝桌面版.exe');
    if (fs.existsSync(defaultExe)) return defaultExe;
  }

  return null;
}

const SOCKET_TIMEOUT_MS = 30000;
const PING_TIMEOUT_MS = 2000;

/**
 * Ping or connect to the named pipe.
 */
function testPipeConnection(timeoutMs = PING_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const client = net.connect(PIPE_PATH, () => {
      if (!settled) {
        settled = true;
        client.destroy();
        resolve(true);
      }
    });
    client.setTimeout(timeoutMs);
    client.on('timeout', () => {
      if (!settled) {
        settled = true;
        client.destroy();
        resolve(false);
      }
    });
    client.on('error', () => {
      if (!settled) {
        settled = true;
        client.destroy();
        resolve(false);
      }
    });
  });
}

let launchingPromise = null;

/**
 * Auto-launch Taobao Desktop if not already running.
 */
async function ensureAppRunning() {
  if (await testPipeConnection()) {
    return true;
  }

  if (launchingPromise) {
    return launchingPromise;
  }

  launchingPromise = (async () => {
    const exePath = findExecutable();
    if (!exePath) {
      log('Executable not found, trying protocol handler taodesktop:// (minimized)');
      spawn('cmd.exe', ['/c', 'start', '""', '/min', 'taodesktop://'], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }).unref();
    } else {
      log('Launching Taobao Desktop (windowed & minimized) from:', exePath);
      spawn('cmd.exe', ['/c', 'start', '""', '/min', `"${exePath}"`], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }).unref();
    }

    const start = Date.now();
    while (Date.now() - start < LAUNCH_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (await testPipeConnection()) {
        log('Taobao Desktop is ready and named pipe is available.');
        launchingPromise = null;
        return true;
      }
    }

    launchingPromise = null;
    throw new Error('Timed out waiting for Taobao Desktop named pipe to become available.');
  })();

  return launchingPromise;
}

/**
 * Send request payload to Taobao's named pipe.
 */
function callPipe(payload, timeoutMs = SOCKET_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = net.connect(PIPE_PATH, () => {
      client.write(JSON.stringify(payload) + '\n');
    });

    if (timeoutMs > 0) {
      client.setTimeout(timeoutMs);
      client.on('timeout', () => {
        if (!settled) {
          settled = true;
          client.destroy();
          reject(new Error(`Pipe request timed out after ${timeoutMs}ms for tool: ${payload?.tool || 'unknown'}`));
        }
      });
    }

    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });

    client.on('end', () => {
      if (!settled) {
        settled = true;
        try {
          const parsed = JSON.parse(buffer.trim());
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Failed to parse pipe response: ${buffer.slice(0, 100)}`));
        }
      }
    });

    client.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * Execute RPC call with auto-launch retry.
 */
async function rpcWithRetry(payload) {
  try {
    return await callPipe(payload);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      log('Connection failed, attempting to launch Taobao Desktop...');
      await ensureAppRunning();
      return await callPipe(payload);
    }
    throw err;
  }
}

// Stdio JSON-RPC 2.0 loop
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    log('Failed to parse stdin JSON-RPC:', trimmed.slice(0, 100));
    return;
  }

  const { id, method, params } = request;

  // 1. initialize handshake
  if (method === 'initialize') {
    const response = {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'taobao-native',
          version: '1.0.0',
        },
      },
    };
    process.stdout.write(JSON.stringify(response) + '\n');
    return;
  }

  // 2. notifications/initialized
  if (method === 'notifications/initialized') {
    return;
  }

  // 3. ping
  if (method === 'ping') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n');
    return;
  }

  // 4. tools/list
  if (method === 'tools/list') {
    try {
      const resp = await rpcWithRetry({ tool: '_help', arguments: {} });
      const tools = (resp?.result?.tools || []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
      }));

      // Add local workspace upstream diff inspection tool
      tools.push({
        name: 'get_upstream_skill_diff',
        description: "Compares local skills in skills/ against Taobao Desktop's live builtin skills directory to inspect upstream updates and differences.",
        inputSchema: {
          type: 'object',
          properties: {
            skillName: {
              type: 'string',
              description: "Name of the skill to compare (defaults to 'taobao-native')",
            },
          },
        },
      });

      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { tools } }) + '\n');
    } catch (err) {
      log('tools/list error:', err.message);
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: `Taobao Desktop connection error: ${err.message}`,
          },
        }) + '\n'
      );
    }
    return;
  }

  // 5. tools/call
  if (method === 'tools/call') {
    const toolName = params?.name;

    // Handle get_upstream_skill_diff locally
    if (toolName === 'get_upstream_skill_diff') {
      const targetSkill = params?.arguments?.skillName || 'taobao-native';
      const diffResult = compareSkill(targetSkill);
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(diffResult, null, 2) }],
            isError: !!diffResult.error,
          },
        }) + '\n'
      );
      return;
    }

    const args = { ...(params?.arguments || {}), sourceApp: 'Antigravity' };

    try {
      const resp = await rpcWithRetry({ tool: toolName, arguments: args });

      if (resp.error) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: String(resp.error) }],
              isError: true,
            },
          }) + '\n'
        );
      } else {
        const textOutput = typeof resp.result === 'string'
          ? resp.result
          : JSON.stringify(resp.result || resp, null, 2);

        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: textOutput }],
              isError: false,
            },
          }) + '\n'
        );
      }
    } catch (err) {
      log(`tools/call error on [${toolName}]:`, err.message);
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Execution failed: ${err.message}` }],
            isError: true,
          },
        }) + '\n'
      );
    }
    return;
  }

  // Fallback for unknown methods
  if (id !== undefined) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      }) + '\n'
    );
  }
});

log('Taobao Desktop MCP Bridge running on stdio');

// Check upstream skill updates on startup (non-blocking)
try {
  const check = compareSkill('taobao-native');
  if (check && check.isUpstreamNewer) {
    log(`Notice: Upstream skill update detected (desktop: v${check.upstreamVersion}, local: v${check.localVersion}). Use MCP tool 'get_upstream_skill_diff' to inspect.`);
  }
} catch (err) {
  log('Startup skill check warning:', err.message);
}
