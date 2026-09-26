# Upstream Skill Sync Log

## [2026-09-26] Version Sync: v1.0.43 → v1.0.61

- **Skill**: `taobao-native` (Upstream: `taobao-native-internal`)
- **Prior Local Version**: `1.0.43`
- **New Version**: `1.0.61`
- **Governance**: Fused according to the **Three-Way Filter Policy** defined in [`AGENTS.md`](./AGENTS.md).

---

### 1. 🟢 ADOPTED (Technical & Algorithmic Enhancements)
- **Modular Reference Routing**: Adopted upstream domain routing table in [`SKILL.md`](./skills/taobao-native/SKILL.md) redirecting keyword tasks to dedicated `references/*.md` files.
- **Cart Structured Deletion**: Adopted `cartItems[].deleteIndex` from `scan_page_elements` for robust cart item deletion in [`references/cart.md`](./skills/taobao-native/references/cart.md).
- **Official SKU Selection Panel**: Added support for `request_sku_selection({ itemId, title })` as the interactive panel workflow.
- **Drawer Scope Evaluation**: Adopted `[class*=Drawer]` scope selector and page down scrolling for reading reviews in [`references/review.md`](./skills/taobao-native/references/review.md).
- **Main Image Parsing**: Adopted extraction from `[商品主图]` / `[商品图]` and `.webp` suffix removal in [`references/product_details.md`](./skills/taobao-native/references/product_details.md).

---

### 2. 🔴 REJECTED (Corporate Compliance Disclaimers Filtered Out)
- **Review Submission Ban**: Filtered out upstream disclaimers forbidding `submit_product_rating` (*"当前导购助手不支持自动填写或提交商品评价"*). Preserved full automated rating capabilities for users.
- **Wangwang Chat Ban**: Filtered out upstream restrictions forbidding `open_chat` and `send_chat_message` (*"当前导购助手不支持自动打开客服、进入旺旺聊天"*). Preserved full merchant communication capability.
- **Cart Automation Ban**: Rejected upstream bans prohibiting DOM-based cart additions and automated checkout when requested by the consumer.

---

### 3. 🟡 TRANSLATED (Internal Protocols Decoupled)
- **A2A / Closed Cloud Protocols**: Decoupled cloud-only `search_products_a2a` and internal JSON structures into standard MCP tool calls and clean Markdown output.
- **A2UI Payment Messages**: Translated internal message payloads into standard Alipay cashier handling.

---

## [2026-09-26] Skill Import: `product-search-pipeline` (v1.1.4)

- **Skill**: `product-search-pipeline`
- **Governance**: Fused according to the **Three-Way Filter Policy**.
- **🟢 ADOPTED**:
  - Structured slot extraction pipeline (品类、预算、品牌、使用场景等).
  - Search parameter mapping rules (keyword max 4 tokens, sort mapping, budget-to-price-range formulas).
  - Multi-category budget allocation ratios (⭐⭐⭐ 40-60%, ⭐⭐ 30-40%).
- **🔴 REJECTED**:
  - Compliance disclaimers limiting automated cart additions and direct checkout.
- **🟡 TRANSLATED**:
  - Decoupled internal search service calls into standard URL search automation (`navigate_to_url` + `https://s.taobao.com/search?q=...`) and DOM candidate parsing.

---

## [2026-09-26] Skill Import: `shopping-recommendation` (v1.0.8)

- **Skill**: `shopping-recommendation`
- **Governance**: Fused according to the **Three-Way Filter Policy**.
- **🟢 ADOPTED**:
  - Core recommendation principle: "先推荐后澄清" (Entity delivery first before asking clarifying questions).
  - 4-step candidate filtering pipeline: Semantic relevance $\rightarrow$ Hard attribute constraints $\rightarrow$ Price boundary (+20% drop, +10-20% note) $\rightarrow$ Brand deduplication.
  - 3-tier starter framework: 必备 (Core) / 建议 (Nice-to-have) / 不用买 (Avoid trap).
  - Standardized Markdown recommendation card presentation with `_.webp` removal.
- **🔴 REJECTED**:
  - Corporate restrictions banning automated ratings and Wangwang customer service interactions.
- **🟡 TRANSLATED**:
  - Translated proprietary JSON widget schemas (`---a2ui_JSON---`) into clean Markdown cards and interactive guide questions.

---

## [2026-09-26] Skill Import: `procurement-assistant` (v1.0.62)

- **Skill**: `procurement-assistant` (Upstream: `procurement-assistant`)
- **Governance**: Fused according to the **Three-Way Filter Policy**.
- **🟢 ADOPTED**:
  - Batch procurement ingestion from Excel, CSV, and tabular text.
  - Two-step confirmation table output before initiating heavy searches.
  - Strict serial execution of searches to prevent rate-limiting or GUI freezing.
  - Budget-to-range mapping for procurement quotas.
  - Seamless panel previewing via `open_page_panel({ page: "cart" })`.
- **🔴 REJECTED**:
  - Bans on automated batch carting and checkout workflows.
- **🟡 TRANSLATED**:
  - Replaced internal RPC procurement services (`search_products_service`) with desktop MCP tool navigation and DOM element extraction.
