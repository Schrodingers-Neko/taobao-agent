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
│   └── patch-asar.js                # 13-byte ASAR gatekeeper inoculation utility
├── backup/                          # [Untracked / Ignored] Preserved snapshots
└── TESTING_INSTRUCTIONS.md          # [Untracked / Ignored] Detailed local testing runbooks
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

## 4. Client Inoculation & ASAR Gatekeeper Management

To prevent upstream MTOP cloud token timeouts or A/B experiment flag drops from locking the agent out with:
`{"error": "内测期间仅开放部分用户使用，请关注后续公告"}`

The workspace maintains a safe, 13-byte in-place bypass utility: [`scripts/patch-asar.js`](file:///F:/projects/personal/taobao/scripts/patch-asar.js).

| Command | Action |
| :--- | :--- |
| `npm run patch:status` | Inspect whether client `app.asar` is `ORIGINAL`, `PATCHED`, or `UNKNOWN`. |
| `npm run patch` | Verify pre-flight backup, dynamically locate signature in `out/main/index.js`, and apply 13-byte in-place bypass (`if(_0x2505bf)` $\rightarrow$ `if(!1&&false)`). |
| `npm run restore` | Revert `app.asar` from `app.asar.original.bak` back to official unpatched binary. |

---

## 5. Local Testing Runbooks for Agents

Detailed, step-by-step testing runbooks are maintained in the local (untracked) file:
👉 [`TESTING_INSTRUCTIONS.md`](file:///F:/projects/personal/taobao/TESTING_INSTRUCTIONS.md)

Refer to `TESTING_INSTRUCTIONS.md` for:
- **Runbook A: Skill Fusion Testing Procedure**: How to inspect upstream diffs, apply the Three-Way Policy, and document upgrades.
- **Runbook B: End-to-End Live Verification Procedure**: How to safely test MCP connectivity, tab discovery, cart inspection, and tear-down against the live desktop client.

