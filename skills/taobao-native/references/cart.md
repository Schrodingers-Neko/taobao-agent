# 购物车相关操作

---

## 1. 商品加购与规格选择

### A. 交互式规格选择链路（推荐优先使用官方 SKU 面板）
- 当用户要求在界面中自行确认规格或需要官方弹出面板时，调用 `request_sku_selection({ itemId, title })` 打开官方 SKU 面板。
- 官方 SKU 面板负责规格、数量以及加购/购买操作。调用后等待用户在面板内完成操作。
- **多商品处理**：官方 SKU 面板一次处理一个商品，多商品加购按商品串行推进。

### B. 自主 DOM 规格选择与加购链路（高级自动化支持）
- 当用户明确要求完全自主代客加购或官方面板未激活时，允许执行精准 DOM 自动化：
  1. 打开商品详情页；
  2. `scan_page_elements` 扫描获取精确规格项 index；
  3. `click_element({ index: N })` 点击目标规格；
  4. **等待 3 秒** (`sleep 3`) 以便异步加载最新真实价格与库存；
  5. 调用 `add_to_cart` 或点击加购按钮完成加购。

---

## 2. 购物车删除商品

### 决策原则
- 购物车删除商品优先使用桌面端结构化 `deleteIndex`。
- 单个删除与批量删除均基于逐项扫描定位推进。

### 单商品删除 · 工具调用链路
1. `navigate({ page: "cart" })`：进入购物车。
2. `input_text({ text: "商品关键词", placeholder: "搜索购物车内商品", submit: true })`：在购物车搜索框中搜索目标商品。
3. `scan_page_elements({})`：扫描页面元素。购物车页面会返回 `cartItems` 结构化数据，包含每个商品的 `{ title, specs, price, deleteIndex }`。
4. 从 `cartItems` 中根据商品标题/规格找到目标商品，提取其 `deleteIndex`。
5. `click_element({ index: <deleteIndex> })`：点击该商品的删除按钮。
6. 弹窗确认删除：再次调用 `scan_page_elements({})` 获取确认弹窗中“删除”按钮的精确 `index`，调用 `click_element({ index: <confirmIndex> })` 确认删除（仅在简单二选一无歧义的原生弹窗中，允许以 `click_element({ text: "删除" })` 作为兜底）。

### 多商品批量删除 · 工具调用链路
1. 按商品逐个执行“单商品删除”流程。
2. 每删除一个商品后重新调用 `scan_page_elements({})` 获取最新的 `cartItems` 和 `deleteIndex`，再删除下一个。
3. 若 `cartItems` 为空或目标商品无对应 `deleteIndex`，可通过精细 DOM 扫描定位删除按钮文本。
