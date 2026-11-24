# guxi · A股实时股息率排行榜

一个纯前端 + 一个边缘代理函数的 A 股股息率排行榜，部署在 Cloudflare Pages 上。
打开即用，无需数据库、无需构建、无第三方框架。

## 功能

- 全市场约 5,500 只 A 股实时股息率排行，红涨绿跌
- 三种口径一键切换：**TTM 滚动 12 个月 / 上年年报 / 近 3 年平均**
- 可排序表格 + 多条件筛选（行业、股息率、市值、剔除 ST/次新）+ 4 个预设（稳健高息 / 周期高息 / 待核验）
- 点击任意一行展开该股逐条分红明细（报告期、每 10 股派息、除权除息日、方案进度）
- 质量标记：分红不连续、分红率 > 90%、周期高位、含 2 次年报、需核验、稳健
- 右侧行业股息率分布条形图
- 导出当前筛选结果为 CSV
- 行情 5 分钟自动刷新，localStorage 缓存 12 小时（二次打开秒出）

## 架构

```
浏览器 ──► /api/em?u=...  (Pages Function, 边缘缓存 60s) ──► 东方财富公开接口
   │
   └─ 若函数不可用（静态托管 / 本地 file:// 打开）→ 自动回退 JSONP 直连
```

- `index.html`：单文件应用（内联 CSS / JS），只依赖同源 `/api/em`
- `functions/api/em.js`：同源代理，白名单限制为 `push2.eastmoney.com` 与 `datacenter-web.eastmoney.com`，剔除 JSONP 回调参数后返回标准 JSON，并用 `caches.default` 做 60 秒边缘缓存

这样做的原因：东方财富接口不返回 CORS 头，直连只能靠 JSONP（无法缓存、易被拦截）；走自己的域后既能缓存，也不怕浏览器拦截第三方脚本。

## 部署

### 方式一：CLI（最快）

```bash
npm i -g wrangler
wrangler login
wrangler pages deploy . --project-name guxi
```

### 方式二：连接 Git 仓库

Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git → 选择本仓库：

| 配置项 | 值 |
| --- | --- |
| Framework preset | None |
| Build command | 留空 |
| Build output directory | `.` |

`functions/` 会被自动识别为 Pages Functions，无需额外配置。

### 本地开发

```bash
npm i
npm run dev      # wrangler pages dev . --port 8788
```

不装 wrangler 也能用：直接双击 `index.html`，会自动回退到 JSONP 直连模式。

## 数据口径

| 指标 | 定义 |
| --- | --- |
| 股息率 TTM | 近 12 个月内**已实施除权**的现金分红合计 ÷ 现价 |
| 上年年报 | 上一完整会计年度现金分红 ÷ 现价 |
| 近 3 年平均 | 近 3 个年度派息合计 ÷ 现价 ÷ 年数 |
| 分红率 | 上年年报每 10 股派息 ÷ 10 ÷ 上年基本每股收益 |
| 连分年数 | 近 6 年窗口内连续分红的年数，`6+` 表示窗口内每年都有 |

口径说明：

- **只算现金分红**，送转股不计入股息率
- 榜首常见 10%+ 多为一次性特别分红或两次年报挤进同一窗口，已用 `含 2 次年报`、`需核验` 标记
- 周期行业（煤炭、航运、化工等）盈利顶部股息率虚高，次年易腰斩，标记为 `周期高位`

## 免责声明

数据来自东方财富公开接口，仅供参考，可能存在延迟或误差，不构成任何投资建议。

## License

MIT
