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
