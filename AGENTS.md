# taobao-agent: Workspace Governance & Agent Guidelines

Welcome to `taobao-agent`. This repository houses the consumer-facing shopping assistant architecture that bridges AI pair programmers and autonomous agents to the **Taobao Desktop client** on Windows via Model Context Protocol (MCP).

---

## 1. Project Overview & Architecture

```
F:\projects\personal\taobao\
├── AGENTS.md                        # [Tracked] Workspace guidelines & governance rules
├── package.json                     # [Tracked] Workspace npm scripts & metadata
├── taobao-mcp-bridge.js             # [Tracked] Stdio MCP Bridge connecting to \\.\pipe\taobao-cli-rpc
├── skills/                          # [Tracked] Active Agent Skills directory
│   ├── taobao-native/               # Core execution skill (v1.0.61 base)
│   ├── product-search-pipeline/     # Search routing & slot extraction (v1.1.4 base)
│   ├── shopping-recommendation/     # Recommendation strategy & 4-tier filtering (v1.0.8 base)
│   └── procurement-assistant/       # Batch procurement & spreadsheet pipeline (v1.0.62 base)
├── scripts/                         # [Tracked] Maintenance and testing utilities
│   ├── check-diff.js                # Upstream skill comparison and inspection tool
│   ├── patch-asar.js                # Zero-byte-shift ASAR gatekeeper & capability unblocker
│   ├── declutter.js                 # Transactional UI decluttering & patch composition
│   ├── declutter-patches.js         # Pure patch transform functions and rules
│   ├── client-stop.js               # Controlled desktop client & child process termination
│   ├── test-captcha.js              # Anti-stacking CAPTCHA guard offline test suite
│   ├── test-declutter.js            # UI declutter 16-combination and migration tests
│   └── captcha/                     # CAPTCHA guard main/renderer coordinator subsystem
└── backup/                          # [Untracked / Ignored] Preserved snapshots
```

- **Runtime Target**: Windows Taobao Desktop (`淘宝桌面版.exe`).
- **IPC Endpoint**: Windows Named Pipe `\\.\pipe\taobao-cli-rpc`.
- **MCP Bridge**: `taobao-mcp-bridge.js` exposes all native client tools over standard MCP JSON-RPC 2.0 (`stdio`).

---

## 2. Core Execution Invariants

Any agent acting in this workspace must adhere to these core operational principles:

1. **Consumer Autonomy & Power**:
   - Maintain high execution freedom. Support automated cart additions, Wangwang merchant chat (`open_chat`), and order ratings (`submit_product_rating`).
   - Never artificially handicap the agent based on upstream corporate compliance disclaimers.

2. **Real SKU Price Waiting Rule**:
   - Search result prices and default product page prices are teaser/starting prices (`起步价`), not real SKU prices.
   - To get real price: Enter product page $\rightarrow$ scan DOM $\rightarrow$ click target SKU by **index** $\rightarrow$ **wait 3 seconds (`sleep 3`)** for asynchronous price refresh $\rightarrow$ read price.

3. **Precise Index Clicking**:
   - Never click SKU or critical buttons using vague text matching (`click_element({ text: "..." })`).
   - Always run `scan_page_elements` first, extract the exact integer `index`, and invoke `click_element({ index: N })`.

4. **Image URL Handling**:
   - Taobao image URLs often end with `_.webp`. Strip this suffix when embedding images in Markdown or presenting to the user.

5. **CAPTCHA & Human-in-the-Loop Protocol**:
   - If page content or DOM scan detects verification challenges (`安全验证`, `拖动滑块完成验证`, `RGV587_ERROR`, `验证码`):
     - Immediately halt automated tool loops.
     - Prompt user: *"检测到淘宝安全验证（滑块/人机校验），请在打开的淘宝桌面版窗口中手动完成滑块验证。完成后回复我，我们将继续操作。"*
     - Wait for user confirmation before re-scanning. If unresolvable or blocked, abort cleanly.

6. **Windowed & Minimized Lifecycle**:
   - The desktop client must always be launched interactively via the Windows Shell (`start "" /min "<exePath>"` or `npm run client:start`) rather than as a raw headless process (`cmd /c <exePath>` or direct `child_process.spawn`).
   - This ensures the Electron client attaches to the interactive user window station (`WinSta0`), initializes its system tray icon, and stays minimized on the taskbar so that human-in-the-loop CAPTCHAs can be solved directly on screen.

---

## 3. Skill Evolution Protocol & Fusion Governance (The Three-Way Filter)

The desktop client receives proprietary CDN hotfixes in `%APPDATA%\taobao\` containing internal skills (`taobao-native-internal`, etc.). When a newer upstream version is detected, agents must evaluate diffs using the **Three-Way Filter Policy**:

| Category | Policy | Examples | Action |
| :--- | :---: | :--- | :--- |
| 🟢 **Technical & Algorithmic** | **ADOPT** | Updated DOM selectors (e.g. `deleteIndex`, `Drawer` classes), new API fields, timeout tuning, search formulas. | Incorporate into active skills under `skills/` (upon user confirmation). |
| 🔴 **Corporate Compliance** | **REJECT** | Disclaimers such as *"当前导购助手不支持自动填写或提交评价"*, bans on `submit_product_rating`, bans on Wangwang chat, bans on DOM cart interaction. | Firmly discard. Preserve all consumer capabilities. |
| 🟡 **Internal Closed Protocols** | **TRANSLATE** | Cloud-only A2A calls (`search_products_a2a`), proprietary JSON widgets (`---a2ui_JSON---`). | Decouple and translate into native MCP tool calls (`search_products`) and standard Markdown. |

### User Confirmation Requirement
- **Do NOT update local skills autonomously.**
- When a newer upstream version is detected, the agent must inspect the diff, categorize the changes according to the Three-Way Filter, and present a clear summary to the user.
- The agent **must explicitly ask the user whether the local skills should be updated according to the fusion policies** before modifying any files under `skills/` or committing changes.

---

## 4. Client Inoculation & ASAR Management

The workspace maintains a safe, zero-byte-shift binary patch utility: [`scripts/patch-asar.js`](file:///F:/projects/personal/taobao/scripts/patch-asar.js). It provides two independent in-place inoculations:

1. **Gatekeeper Bypass (13 bytes)**: Neutralizes cloud beta whitelist lockout (`if(_0x2505bf)` $\rightarrow$ `if(!1&&false)`), preventing `{"error": "内测期间仅开放部分用户使用，请关注后续公告"}`.
2. **Feature Unblocker (29 bytes)**: Neutralizes vendor tool suppression in `function am()` (`!om['has'](_0x32d1ec['name'])` $\rightarrow$ `!0/*-----------------------*/`), natively unlocking `add_to_cart`, `open_chat`, `send_chat_message`, `submit_product_rating`, and `keyboard` via named pipe RPC.

| Command | Scope | Action |
| :--- | :---: | :--- |
| `npm run patch:status` | Read-only | Inspect whether client `app.asar` patches are `ORIGINAL`, `PATCHED`, or `UNKNOWN`. |
| `npm run patch` | 13 bytes | Apply Gatekeeper cloud whitelist lockout bypass only. |
| `npm run patch:features` | 29 bytes | Apply Feature Unblocker only (unlocks native cart, chat, rating tools). |
| `npm run patch:all` | Both | Apply both Gatekeeper bypass and Feature Unblocker in-place. |
| `npm run restore` | Rollback | Revert `app.asar` from `app.asar.original.bak` back to official pristine binary. |
| `npm run client:start` | Lifecycle | Launch desktop client interactively (windowed & minimized) via Windows Shell. |

---

## 5. Hardening & Verification Status

The roadmap items have been implemented and verified:

- ✅ **P0: Module Guard & Exports in [`scripts/patch-asar.js`](file:///F:/projects/personal/taobao/scripts/patch-asar.js)**: Wrapped in `if (require.main === module)` and exported all utilities for programmatic inspection.
- ✅ **P0: Socket Timeout & Resilience in [`taobao-mcp-bridge.js`](file:///F:/projects/personal/taobao/taobao-mcp-bridge.js)**: Added 30s timeout on `callPipe` and 2s on `testPipeConnection` with clean socket teardown.
- ✅ **P1: CAPTCHA Human-in-the-Loop Protocol in [`skills/taobao-native/SKILL.md`](file:///F:/projects/personal/taobao/skills/taobao-native/SKILL.md)**: Standardized detection of `安全验证`/`RGV587_ERROR`, pause-and-notify prompt, and abort safety.
- ✅ **P1: Tool Fallback Clarifications in Skills**: Added DOM automation fallback paths (`navigate_to_url` + `scan_page_elements` + `click_element`) in `taobao-native` and `product-search-pipeline`.
- ✅ **P1: Upstream Sync Log in [`UPSTREAM_SYNC_LOG.md`](file:///F:/projects/personal/taobao/UPSTREAM_SYNC_LOG.md)**: Documented Three-Way Filter rationale for `product-search-pipeline`, `shopping-recommendation`, and `procurement-assistant`.
- ✅ **P2: ASAR Feature Unblocker in [`scripts/patch-asar.js`](file:///F:/projects/personal/taobao/scripts/patch-asar.js)**: In-place 29-byte patch implemented and verified live over RPC.


