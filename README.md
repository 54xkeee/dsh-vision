# 👁️ dsh-vision

**Eyes for text-only DeepSeek on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — powered by Doubao Web by default, zero cost, no API key.**

[简体中文](README.zh-CN.md)

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
  <img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >=20" />
  <a href="https://github.com/54xkeee/dsh-vision"><img src="https://img.shields.io/github/stars/54xkeee/dsh-vision?style=flat-square" alt="GitHub stars" /></a>
</p>

> **TL;DR**: no API key, no paid tier — log into Doubao once in your browser, and DeepSeek can see images in every conversation. Paste, recognize, answer.

## ✨ Why you'll love it

| Pain point | dsh-vision solution |
|---|---|
| Vision APIs cost money and need keys | **Doubao Web by default** — zero cost, no API key, just a browser login |
| DeepSeek is text-only; pasting an image is rejected | Wrapper adapters claim image input; images become text placeholders automatically |
| Other plugins lock you into one vendor | Doubao Web (default) + Antigravity IDE quota (flash/pro) + Gemini API + Cockpit proxy — auto fallback chain |
| The model "forgets" what it saw | **Vision evidence memory**: results persist in the session, reused across turns, restored after compaction |
| Paying to re-recognize the same image | **Content-hash cache**: same image + same question = recognized once per process |
| Complex images get shallow answers | **Auto detail escalation**: standard pass first, auto-upgrade to deep for complex scenes |
| WSL / firewalled networks | **winCurl fallback** for API channels; Doubao Web channel runs through your Windows browser |

## 🎯 Real results (2026-08, full end-to-end calls)

**Input**: an orange cat photo + *"What animal is this and what is it doing? Answer in Chinese."*

**Output (Doubao Web channel — default)**:
> 这是一只橘猫（家猫），它四仰八叉仰躺在床上睡觉，肚皮露在外面，四肢舒展，睡得十分放松惬意。猫咪把肚子露出来，说明它对周围环境很有安全感。

**Output (Antigravity channel · flash tier)**:
> 这是一只**橘猫**（橘色虎斑家猫）。它正仰面熟睡/惬意放松：四脚朝天、露出圆滚滚毛茸茸的肚子，正舒适地躺在深色床垫/毯子上睡觉。

```
you paste an image + ask
  → dsh-vision turns the image into a placeholder; DeepSeek (the brain) sees it
  → DeepSeek calls the vision tool → Doubao Web (default) / other channels recognize it
  → text evidence flows back → DeepSeek continues the answer
```

## 🚀 Quick start

### Path 0: Doubao Web (default, zero cost)

1. Install the plugin:
   ```sh
   dsh plugin --profile web add dsh-vision-web
   ```
2. Start the Windows bridge (drives your logged-in Chrome):
   ```sh
   # on Windows: connect a Chrome with remote debugging, then run
   node bridge.mjs    # see the Bridge section below
   ```
3. Log into [doubao.com](https://www.doubao.com) in that Chrome once.
4. Restart `dsh web`, paste an image — done. **No API key anywhere.**

### Path 1: Antigravity IDE quota (if you use Antigravity)

Configure your workspace and the plugin auto-prefers it (flash/pro tiers by model name):

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

Ports/CSRF are auto-discovered on every call — no manual config after IDE restarts.

### Path 2: Gemini API (fallback channel)

```yaml
      config:
        genlangKey: AIza...   # https://aistudio.google.com/apikey
```

### Path 3: Any IDE CLI (Claude Code / Gemini CLI / Qwen Code / MiMo…)

If you have a subscription to a coding IDE, use its local CLI for recognition (config-driven, no code changes):

```yaml
      config:
        ideCli:
          enabled: true
          exe: claude                      # or gemini / qwen / any CLI
          argsTemplate: "-p {prompt}"      # {prompt} replaced with the question + image refs
          imageRefTemplate: "{path}"       # Gemini CLI: "@{path}"
          timeoutMs: 120000
```

The channel passes the question plus image file paths to the CLI and takes stdout as the answer — Claude Code, Gemini CLI, Qwen Code, MiMo and similar all work through the same config block.

### Usage

1. **Panel**: click 「识图」 in the session header → add/paste images → prompt → mode/detail/channel → recognize.
2. **In conversation**: pick a `deepseek-vision` route in the model picker, paste an image and send — the model calls vision automatically.

## 🌉 The Doubao bridge (how the zero-cost channel works)

The Doubao Web channel automates your **logged-in browser** instead of calling an API:

```
DSH plugin (WSL) ──submit──▶ queue service (127.0.0.1:9340)
                                  ▲ polling
Windows bridge (node + puppeteer-core) ──┘
        │ CDP connect to Chrome (remote-debugging-port)
        ▼
Doubao sidebar: upload image → type question → Enter → wait for reply
        │
        ▼ text reply → POST /result → DSH plugin
```

- **One-time login**: log into Doubao once in the bridge's Chrome profile; the bridge reuses it forever.
- **Windows → WSL localhost forwarding** carries the queue traffic; no firewall changes needed.
- Ships as `bridge.mjs` — run it once beside DSH (`node bridge.mjs`), it polls forever.
- WSL cannot reach Windows ports directly; that's why the queue lives on the WSL side and the bridge polls **from** Windows.

## 🧠 The vision engine — how complex recognition actually works

A naive "see → describe" loop fails on dense screenshots, tables, UI mockups and multi-image comparisons. dsh-vision turns recognition into a **structured, self-escalating, memory-backed pipeline**:

### 1. Auto detail escalation — it knows when one pass isn't enough

`detail: auto` runs a **two-pass strategy**:

```
pass 1 (standard + triage) ──▶ complexity == "simple" ──▶ done
                            └─▶ complexity == "complex" ──▶ pass 2 (deep) ──▶ escalated result
```

The vision model itself classifies complexity. These all count as **complex** and trigger the deep pass automatically:

- multi-subject relationships · dense small text · OCR-heavy content
- tables / charts / code / UI screens · counting · comparison / spot-the-difference
- professional imagery · multi-step spatial reasoning

### 2. Four task modes, one tool

| Mode | What it does | Typical use |
|---|---|---|
| `glance` | general understanding, evidence selected around your question | everyday questions |
| `ocr` | transcribes visible text in natural reading order, preserving headings/tables/UI hierarchy | screenshots, docs, error messages |
| `region` | focuses on one area — normalized coords `0.1,0.2,0.8,0.9` **or** plain language (`"top right"`) | UI bugs, chart details |
| `compare` | item-by-item differences between ≥2 images, with confidence | before/after, versions, A/B |

### 3. Structured evidence, not raw prose

Every pass asks the VLM for a **strict JSON evidence object**:

```json
{
  "complexity": "simple|complex",
  "base_evidence": {
    "summary": "neutral overview",
    "ocr": "visible text (empty if none)",
    "layout": ["layout observations"],
    "entities": ["entities"],
    "relations": ["relations"],
    "uncertainty": ["explicit unknowns"]
  },
  "query_answer": "direct answer to the user"
}
```

Observations vs. inference are separated, uncertainty is explicit (never hallucinated), and lists are capped to keep context tight.

### 4. Long-context visual memory — the model never "forgets" what it saw

- Every result is written into the **session timeline** as a durable `<dsh-vision-evidence>` record.
- **Reuse across turns**: the same image + same question hits the existing record — recognized once, remembered forever.
- **Vision memory manifest**: every request stream carries a compact catalog of recent evidence, so the model can follow up — zoom in, re-OCR, compare against a new screenshot — without you re-pasting.
- **Compaction rehydration**: after DSH compresses a long session, recent vision records are restored automatically.

### 5. Content-hash caching — never pay twice for the same pixels

Cache key = `SHA-256(image bytes) + prompt + detail + mode + region + model + channel + prompt-version`, in-process LRU.

## ⚙️ Configuration

| Key | Default | Description |
|---|---|---|
| `defaultChannel` | `auto` | `auto` (Antigravity first if configured, else Doubao Web) / `web` / `antigravity` / `genlang` / `cockpit` / `aicode` |
| `defaultModel` | `gemini-3.7-flash` | Panel default model (name containing `pro` → Antigravity pro tier) |
| `webChannel.enabled` | `true` | Doubao Web channel on/off |
| `webChannel.queuePort` | `9340` | WSL queue port |
| `webChannel.timeoutMs` | `240000` | Web reply timeout |
| `antigravityWorkspace` | `""` | Antigravity IDE workspace (WSL path) |
| `antigravityProjectId` | `""` | Antigravity project id |
| `antigravityLsExe` | `""` | `language_server.exe` path |
| `antigravityWindowsHome` | `""` | Windows home (project file) |
| `antigravityBrainDir` | `""` | Brain transcript dir |
| `genlangKey` | `""` | Gemini API key (`AIza…` / `AQ.`) |
| `cockpitBaseUrl` / `cockpitKey` | `http://127.0.0.1:65386` / `""` | Cockpit proxy |
| `oauthAccount` / `oauthClientId` / `oauthClientSecret` | `""` | aicode direct channel (bring your own credentials) |
| `visionUpstreams` | `["deepseek"]` | Upstream LLMs to wrap for conversation vision |
| `cacheMax` | `64` | In-memory LRU cache size |
| `allowedImageDirs` | `[]` | If set, `image_path` only reads these dirs |
| `curlPath` | `/mnt/c/Windows/System32/curl.exe` | Windows curl for WSL fallback |

## 🔧 Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Web channel times out | Bridge not running (`node bridge.mjs`) or Chrome not logged into Doubao — check both |
| Web channel: `fetch failed` from bridge | Queue service not up (the DSH plugin starts it; check plugin loaded) |
| Antigravity: `找不到 language_server.exe` | Antigravity IDE not running — start & log in |
| Gemini `503 high demand` | Gemini overloaded; retry or switch model |
| WSL can't reach APIs | Set `curlPath` (Windows curl) — API channels fall back to it automatically |

## 🔒 Privacy

- **Doubao Web**: images go to your own logged-in Doubao session — same as using the website by hand.
- **API keys**: stored in your local config only; error messages are auto-redacted, never logged.
- **OAuth credentials**: not bundled — the aicode channel asks you to bring your own, kept in your local config.

## 🏗️ Architecture

```
src/
├── index.ts        # server: adapters, vision tool, /api/vision, compaction rehydration
├── vision-core.ts  # prompt building, response normalization, evidence records, stream repair
├── web-channels.ts # Doubao Web queue service (WSL side)
└── client/
    └── plugin.tsx  # client panel (multi-image / paste / mode / detail / channel)

bridge.mjs          # Windows bridge: polls the queue, drives Doubao via CDP
```

## 🛠️ Development

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

- vision-toolkit architecture (placeholders + vision tool + wrapper adapters + evidence memory) shared with [dsh-youreyes](https://github.com/54xkeee/dsh-youreyes)
- Channel and error-handling conventions follow community plugins like [dsh-vision-proxy](https://github.com/Flyvhidbwo/dsh-vision-proxy)
