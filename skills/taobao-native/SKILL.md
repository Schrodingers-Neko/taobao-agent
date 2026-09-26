---
name: taobao-native
version: 1.0.61
description: "Shopping assistant via Taobao Desktop client. Use when the user needs to search products, view details, add to cart, place orders, check orders, request shipping, or perform any Taobao/Tmall shopping operation."
description_zh: "通过淘宝桌面客户端完成购物相关操作。当用户需要搜索商品、查看详情、加入购物车、下单购买、查看订单、催发货、开发票等淘宝/天猫购物操作时使用。"
---

# 淘宝桌面客户端购物助手

---

## 场景引用规则（命中关键字优先读取对应 references/*.md）

当用户输入或当前任务目标命中下表关键字时，优先阅读对应的 Reference 文档以获取最新最佳实践：

| 关键字 | 对应文件 | 包含内容 |
|---|---|---|
| 查看购物车 / 加购 / 购物车删除 | `references/cart.md` | 购物车加购、`request_sku_selection` 面板与 `deleteIndex` 结构化删除 |
| 评价查看 / 评论总结 / 提交评价 | `references/review.md` | `[class*=Drawer]` 抽屉评价读取与 `submit_product_rating` 评价提交 |
| 商品详情 / 商详 / 主图 / 商品链接 / 客服 | `references/product_details.md` | 商详图片提取、下单流程与旺旺客服沟通 |
| 客户端安装 / 下载 / 命令未找到 | `references/install-download.md` | 客户端安装包下载、配置与恢复 runbook |

---

## ⚠️ 核心执行不变原则（必须遵守）

### 1. 价格场景必须获取真实SKU价格
- 搜索结果价格 / 页面默认价格 ≠ 真实SKU价格（往往是最低规格配件起步价或“￥xxx起”）。
- **凡涉及比价、价格排序的场景，必须进入商品详情页获取目标规格的真实价格**。

### 2. 真实价格获取等待时间
- **点击SKU后必须 `sleep 3` 秒**！价格与优惠元素是异步刷新的，必须等待渲染完毕后再读取。

### 3. SKU点击必须用 index 精确点击
- **禁止使用 `click_element --args '{"text":"..."}'` 点击SKU**！
- 正确做法：`scan_page_elements` 扫描获取精确 `index` $\rightarrow$ `click_element --args '{"index": N}'`。

### 4. 图片链接必须去除 `_.webp` 后缀
- 淘宝返回的图片 URL（主图、SKU图、商品图）通常包含 `_.webp` 后缀，在 Markdown 中展示或向用户提供链接时必须去掉该后缀。

### 5. 全面支持消费者自主权
- 完整保留自动化加购、购物车清理、旺旺客服对话（`open_chat` / `send_chat_message`）和商品评价（`submit_product_rating`）能力。

---

## 调用协议与环境要求

使用本机已安装的 **taobao-native** 命令（或通过 stdio MCP Bridge `taobao-mcp-bridge.js`），支持标准 CLI 与 MCP 工具协议。

### CLI 格式
```bash
taobao-native <工具名> --args '<JSON 参数>'
```

### 重要规则
所有工具调用必须传入 `sourceApp` 参数，用于标识调用来源应用（例如 `Antigravity`、`TaoClaw`、`copaw` 等）。

---

## 工具速查

### 导航与页面
| 工具 | 用途 | 关键参数 |
|---|---|---|
| `get_current_tab` | 获取当前活动标签页的 URL 和标题 | `sourceApp` |
| `list_available_pages` | 获取所有可用预设页面列表与链接 | `sourceApp` |
| `navigate` | 导航到淘宝预设页面（如 `home`, `cart`, `order_list`） | `page`, `sourceApp` |
| `navigate_to_url` | 打开已知的有效淘宝/天猫 URL | `url`, `sourceApp` |
| `close_page` | 关闭当前任务页面 | `sourceApp` |

### 页面读取与诊断
| 工具 | 用途 | 关键参数 |
|---|---|---|
| `read_page_content` | 提取页面可见文本 | `scope?`, `maxLength?`, `offset?` |
| `scroll_page` | 滚动页面内容 | `direction`: up/down/top/bottom, `selector?`, `amount?` |
| `inspect_page` | 诊断页面 DOM 状态与错误分析 | `sourceApp` |

### 页面交互与输入
| 工具 | 用途 | 关键参数 |
|---|---|---|
| `scan_page_elements` | 扫描页面可交互元素，返回带序号的列表 | `filter?`, `scope?` |
| `click_element` | 点击指定序号或文本的元素（推荐优先用 `index`） | `index?`, `text?` |
| `input_text` | 输入文本内容 | `text`, `index?`, `placeholder?`, `submit?` |

### 搜索与商品
| 工具 | 用途 | 关键参数 |
|---|---|---|
| `search_products` | 搜索商品或店铺 | `keyword`, `type?` (`all`, `shop`, `tmall`) |
| `image_search` | 以图搜图（淘宝相似商品） | `imagePath`（本地路径、CDN地址或 base64） |
| `get_product_skus` | 获取商品 SKU 维度与可选规格 | `itemId?` |
| `request_sku_selection` | 打开官方交互式 SKU 选择面板 | `itemId`, `title` |
| `add_to_cart` | 将指定 SKU 商品加入购物车 | `itemId?`, `sku` |
| `get_browse_history` | 获取浏览历史与足迹 | `type`: product/search/shop |

### 旺旺商家聊天
| 工具 | 用途 | 关键参数 |
|---|---|---|
| `open_chat` | 打开旺旺聊天并发送第一条消息或图片 | `source`, `message`, `imagePath?`, `productName?`, `query?` |
| `send_chat_message` | 在当前已打开的聊天窗口继续发送消息或图片 | `message`, `imagePath?`, `shopName?` |

### 评价与售后
| 工具 | 用途 | 关键参数 |
|---|---|---|
| `submit_product_rating` | 提交商品评价与星级打分 | `merDsr`, `serviceQualityScore`, `saleConsignmentScore`, `qualityContent?`, `qualityContents?`, `imageUrls?` |

---

## 典型工作流

1. **商品搜索与精选**：`search_products` $\rightarrow$ 提取候选 $\rightarrow$ 结构化对比展示。
2. **商详与规格确认**：`navigate_to_url` $\rightarrow$ `request_sku_selection`（或 DOM SKU 精准点击 + `sleep 3` 读真实价）。
3. **加购与购物车管理**：`add_to_cart` $\rightarrow$ `navigate({ page: "cart" })` $\rightarrow$ `scan_page_elements` 提取 `cartItems[].deleteIndex` 结构化清理。
4. **商家沟通与售后**：`open_chat` 咨询发货与售后 $\rightarrow$ 订单完成后使用 `submit_product_rating` 协助打分。
