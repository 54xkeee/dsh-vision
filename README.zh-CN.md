# 👁️ dsh-vision

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的纯文本 DeepSeek 一双眼睛——默认走豆包 Web，零成本、免 API key。**

[English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
  <img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >=20" />
  <a href="https://github.com/54xkeee/dsh-vision"><img src="https://img.shields.io/github/stars/54xkeee/dsh-vision?style=flat-square" alt="GitHub stars" /></a>
</p>

> **一句话**：不用 API key、不用付费——浏览器里登录一次豆包，DeepSeek 就能在每轮对话里看图。粘贴、识图、回答。

## ✨ 为什么值得用

| 痛点 | dsh-vision 的解法 |
|---|---|
| 视觉 API 花钱还要 key | **豆包 Web 默认通道**——零成本、免 API key，浏览器登录即可 |
| DeepSeek 纯文本，粘贴图片被拒 | 包装适配器声明图片输入，图片自动转文本占位 |
| 别的插件锁死一家厂商 | 豆包 Web（默认）+ 反重力额度（flash/pro）+ Gemini API + Cockpit 反代——自动降级链 |
| 模型看到图但"忘了" | **视觉证据记忆**：结果持久化在会话，跨轮复用，压缩后恢复 |
| 同一张图反复花钱识别 | **内容哈希缓存**：同图同问每进程最多识别一次 |
| 复杂画面识别不准 | **档位自动升级**：先标准检查，复杂画面自动深度检查 |
| WSL / 被墙环境 | API 通道有 winCurl 降级；豆包通道走你的 Windows 浏览器 |

## 🎯 真实效果（2026-08 实测，全链路真实调用）

**输入**：一张橘猫照片 + `这是什么动物？它在做什么？请用中文回答。`

**输出（豆包 Web 通道——默认）**：
> 这是一只橘猫（家猫），它四仰八叉仰躺在床上睡觉，肚皮露在外面，四肢舒展，睡得十分放松惬意。猫咪把肚子露出来，说明它对周围环境很有安全感。

**输出（反重力通道 · flash 档）**：
> 这是一只**橘猫**（橘色虎斑家猫）。它正仰面熟睡/惬意放松：四脚朝天、露出圆滚滚毛茸茸的肚子，正舒适地躺在深色床垫/毯子上睡觉。

```
你粘贴图片 + 提问
  → dsh-vision 把图片转成占位符，DeepSeek（大脑）看到
  → DeepSeek 调用 vision 工具 → 豆包 Web（默认）/ 其他通道识图
  → 文字证据回填 → DeepSeek 继续回答
```

## 🚀 快速开始

### 方式零：豆包 Web（默认，零成本）

1. 装插件：
   ```sh
   dsh plugin --profile web add dsh-vision
   ```
2. 启动 Windows 桥接（驱动你已登录的 Chrome）：
   ```sh
   # 在 Windows 侧：连接一个开了调试端口的 Chrome，然后运行
   node bridge.mjs    # 详见下方「豆包桥接」章节
   ```
3. 在那个 Chrome 里登录一次 [doubao.com](https://www.doubao.com)。
4. 重启 `dsh web`，粘贴图片——搞定。**全程不需要任何 API key。**

### 方式一：反重力额度（如果你用 Antigravity）

配置好工作区后，插件自动优先走反重力（按模型名选 flash/pro 档）：

```yaml
- insert:
    - id: vision
      name: dsh-vision
      config:
        antigravityWorkspace: /path/to/workspace
        antigravityProjectId: your-project-id
        antigravityLsExe: /path/to/language_server.exe
        antigravityWindowsHome: /mnt/c/Users/you
        antigravityBrainDir: /mnt/c/Users/you/.gemini/antigravity/brain
```

端口/CSRF 每次调用自动发现，IDE 重启也不用改配置。

### 方式二：Gemini API（降级通道）

```yaml
      config:
        genlangKey: AIza...   # https://aistudio.google.com/apikey
```

### 使用

1. **面板**：会话头部点「识图」→ 添加/粘贴图片 → 提示词 → 模式/档位/通道 → 识别。
2. **对话流**：模型选择器选 `deepseek-vision` 路由，粘贴图片发送——模型自动调用识图。

## 🌉 豆包桥接（零成本通道怎么跑）

豆包 Web 通道自动化的是你**已登录的浏览器**，而不是调 API：

```
DSH 插件 (WSL) ──submit──▶ 队列服务 (127.0.0.1:9340)
                                ▲ 轮询
Windows 桥接 (node + puppeteer-core) ──┘
        │ CDP 连接 Chrome（调试端口）
        ▼
豆包侧边栏：上传图片 → 输入提问 → 回车 → 等回复
        │
        ▼ 回复文本 → POST /result → DSH 插件
```

- **一次登录**：在桥接用的 Chrome profile 里登录一次豆包，之后一直复用。
- **Windows→WSL localhost 转发**承载队列通信，无需改防火墙。
- 桥接以 `bridge.mjs` 随仓库分发——在 DSH 旁边跑一次（`node bridge.mjs`），永久轮询。
- WSL 无法直连 Windows 端口，所以队列放在 WSL 侧、桥接从 Windows 侧**主动轮询**。

## 🧠 识图引擎——复杂识图到底怎么工作

天真的"看图→描述"循环在密集截图、表格、UI 原型和多图对比面前会崩。dsh-vision 把识图做成了**结构化、自动升级、带记忆**的流水线：

### 1. 档位自动升级——它知道一遍不够

`detail: auto` 走**两遍策略**：

```
第一遍（standard + 预判）──▶ complexity == "simple" ──▶ 完成
                            └─▶ complexity == "complex" ──▶ 第二遍（deep）──▶ escalated 结果
```

视觉模型自己判断复杂度。以下情况都判为 **complex** 并自动触发深度检查：

- 多主体关系 · 密集小字 · OCR 密集内容
- 表格 / 图表 / 代码 / 界面 · 计数 · 对比 / 找差异
- 专业画面 · 多步空间推理

### 2. 四种任务模式，一个工具

| 模式 | 干什么 | 典型场景 |
|---|---|---|
| `glance` | 通用理解，围绕你的问题选证据 | 日常提问 |
| `ocr` | 按自然阅读顺序转录文字，保留标题/段落/表格/界面层级 | 截图、文档、报错 |
| `region` | 聚焦一个区域——归一化坐标 `0.1,0.2,0.8,0.9` **或**自然语言（"右上角"） | UI bug、图表细节 |
| `compare` | 逐项列出 ≥2 张图的异同与置信度 | 前后对比、版本对比、A/B |

### 3. 结构化证据，不是流水账

每次识图都要求输出**严格 JSON 证据对象**：

```json
{
  "complexity": "simple|complex",
  "base_evidence": {
    "summary": "中性概述",
    "ocr": "可见文字（没有则为空）",
    "layout": ["布局观察"],
    "entities": ["实体"],
    "relations": ["关系"],
    "uncertainty": ["明确的不确定项"]
  },
  "query_answer": "直接回答用户"
}
```

观察与推断分离、不确定性显式写出（绝不脑补）、每项列表限长——上下文保持紧凑。

### 4. 长上下文视觉记忆——模型永远不会"忘"它看过什么

- 每次结果作为**持久化 `<dsh-vision-evidence>` 记录**写入会话时间线。
- **跨轮复用**：同一张图 + 同一个问题命中已有记录——识别一次，永远记住。
- **视觉记忆清单**：每次请求流自动附带近期证据目录，模型可以主动追问——放大区域、重新 OCR、跟新截图对比——你什么都不用重新粘贴。
- **compaction 恢复**：长会话压缩后，近期视觉记录自动恢复。

### 5. 内容哈希缓存——同样的像素绝不付两次钱

缓存键 = `SHA-256(图片字节) + prompt + detail + mode + region + model + channel + prompt版本`，进程内 LRU。

## ⚙️ 完整配置

| Key | 默认 | 说明 |
|---|---|---|
| `defaultChannel` | `auto` | `auto`（配置了反重力则优先反重力，否则豆包 Web）/ `web` / `antigravity` / `genlang` / `cockpit` / `aicode` |
| `defaultModel` | `gemini-3.7-flash` | 面板默认模型（名字含 `pro` → 反重力 pro 档） |
| `webChannel.enabled` | `true` | 豆包 Web 通道开关 |
| `webChannel.queuePort` | `9340` | WSL 队列端口 |
| `webChannel.timeoutMs` | `240000` | 网页回复等待超时 |
| `antigravityWorkspace` | `""` | 反重力工作区（WSL 路径） |
| `antigravityProjectId` | `""` | 反重力项目 id |
| `antigravityLsExe` | `""` | `language_server.exe` 路径 |
| `antigravityWindowsHome` | `""` | Windows 主目录（项目文件用） |
| `antigravityBrainDir` | `""` | Brain transcript 目录 |
| `genlangKey` | `""` | Gemini API key（`AIza…` / `AQ.`） |
| `cockpitBaseUrl` / `cockpitKey` | `http://127.0.0.1:65386` / `""` | Cockpit 反代 |
| `oauthAccount` / `oauthClientId` / `oauthClientSecret` | `""` | aicode 直连（自带凭据，不内置） |
| `visionUpstreams` | `["deepseek"]` | 对话流包装的上游 LLM |
| `cacheMax` | `64` | 内存 LRU 缓存条数 |
| `allowedImageDirs` | `[]` | 非空时仅允许 `image_path` 读取这些目录 |
| `curlPath` | `/mnt/c/Windows/System32/curl.exe` | WSL 降级用 Windows curl |

## 🔧 Troubleshooting

| 症状 | 原因 & 解决 |
|---|---|
| Web 通道超时 | 桥接没跑（`node bridge.mjs`）或 Chrome 没登录豆包——两个都查 |
| 桥接报 `fetch failed` | 队列服务没起（DSH 插件启动它；确认插件已加载） |
| 反重力报「找不到 language_server.exe」 | Antigravity IDE 没运行——启动并登录 |
| Gemini `503 high demand` | Gemini 过载；重试或换模型 |
| WSL 连不上 API | 配 `curlPath`（Windows curl）——API 通道自动降级用它 |

## 🔒 隐私

- **豆包 Web**：图片发给你自己登录的豆包会话——和手动用网页一样。
- **API key**：只存本地配置；错误信息自动脱敏，绝不写日志。
- **OAuth 凭据**：不内置——aicode 通道要求用户自带，存本地配置。

## 🏗️ 架构

```
src/
├── index.ts        # 服务端：适配器、vision 工具、/api/vision、compaction 恢复
├── vision-core.ts  # 提示词构建、响应归一、证据记录、流修复
├── web-channels.ts # 豆包 Web 队列服务（WSL 侧）
└── client/
    └── plugin.tsx  # 客户端面板（多图/粘贴/模式/档位/通道）

bridge.mjs          # Windows 桥接：轮询队列，CDP 驱动豆包
```

## 🛠️ 开发

```bash
git clone https://github.com/54xkeee/dsh-vision
cd dsh-vision
npm install
npm run build     # esbuild → lib/index.js + lib/client.js
npm test          # node --test
```

## 📄 License

[MIT](LICENSE)

## 🙏 Credits

- vision-toolkit 架构（占位符 + vision 工具 + 包装适配器 + 证据记忆）与 [dsh-youreyes](https://github.com/54xkeee/dsh-youreyes) 共享
- 通道与错误处理约定参考 [dsh-vision-proxy](https://github.com/Flyvhidbwo/dsh-vision-proxy) 等社区插件
