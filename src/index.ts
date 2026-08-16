import { execFile } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
	VISION_MODEL,
	VISION_PROMPT_VERSION,
	VisionPromiseCache,
	normalizeDetail,
	normalizeVisionMode,
	normalizeVisionResponse,
	buildVisionPrompt,
	visionCacheKey,
	sha256,
	makeVisionRecord,
	visionRecordText,
	isVisionRecordMessage,
	visionRecordsFromMessages,
	findVisionRecord,
	buildVisionManifest,
	collectMessageAttachmentRefs,
	flattenMessageContent,
	repairLegacyPlanningStream
} from "./vision-core.ts";
import { webVisionQueue } from "./web-channels.ts";
import { runIdeCli } from "./ide-channels.ts";

/**
 * dsh-vision — server half.
 *
 * 识图后端：浏览器端把图片(base64)+提示词 POST 到 /api/vision，
 * 服务端按 channel 转发：
 *   - antigravity : 反重力(Antigravity IDE)官方 agentapi —— 走 g1-pro 订阅额度（推荐，已实测打通）
 *   - genlang     : Gemini Developer API（generativelanguage.googleapis.com, ?key=）
 *   - cockpit     : Cockpit Tools 的 OpenAI 兼容反代（启用 Gemini API 服务后填 base/key）
 *   - aicode      : cloudcode-pa 直连（OAuth；需 IDE workspace 绑定，预留）
 *
 * 网络说明：DSH 运行在 WSL，直连 Google 被墙；genlang 用 Windows curl.exe
 * 走 Windows 网络栈；antigravity 通道直接调本机 Antigravity 语言服务器的 agentapi。
 */

export const name = "dsh-vision";
export const inject = ["webServer", "llm", "tools", "sessions", "attachments"];

const DEFAULT_CURL = "/mnt/c/Windows/System32/curl.exe";

export const Config = z.object({
	defaultModel: z.string().default("gemini-3.7-flash"),
	// auto 解析优先级：web（豆包，默认）→ antigravity → genlang → cockpit
	defaultChannel: z.union([
		z.const("auto"),
		z.const("web"),
		z.const("ide"),
		z.const("antigravity"),
		z.const("genlang"),
		z.const("cockpit"),
		z.const("aicode")
	]).default("auto"),
	// 网页版 AI 通道（豆包等；零成本，无需 API key，走浏览器登录态）
	webChannel: z.object({
		enabled: z.boolean().default(true),
		// 队列端口（WSL 侧服务；Windows 桥接通过 localhost 转发轮询）
		queuePort: z.number().default(9340),
		// 等待网页 AI 回复超时（毫秒）
		timeoutMs: z.number().default(240000)
	}).default({}),
	// 通用 IDE CLI 通道（Claude Code / Gemini CLI / Qwen Code / MiMo 等编程软件会员额度）
	// 换一个 IDE 只需改配置：exe=可执行文件, args 模板含 {prompt}, imageRef 模板含 {path}
	ideCli: z.object({
		enabled: z.boolean().default(false),
		exe: z.string().default(""),
		// 参数模板，{prompt} 占位（如 "-p {prompt}"；Gemini CLI 图片引用用 "@{path}"）
		argsTemplate: z.string().default("-p {prompt}"),
		imageRefTemplate: z.string().default("{path}"),
		timeoutMs: z.number().default(120000),
		cwd: z.string().default("")
	}).default({}),
	// Gemini Developer API key (AIza... / AQ. 新格式)
	genlangKey: z.string().default(""),
	// Cockpit OpenAI 兼容反代
	cockpitBaseUrl: z.string().default("http://127.0.0.1:65386"),
	cockpitKey: z.string().default(""),
	// Antigravity agentapi 通道配置（反重力额度；留空则不启用，由用户本地填写）
	antigravityWorkspace: z.string().default(""),
	antigravityProjectId: z.string().default(""),
	antigravityLsExe: z.string().default(""),
	antigravityWindowsHome: z.string().default(""),
	antigravityBrainDir: z.string().default(""),
	// Antigravity OAuth 账号 JSON（aicode 通道用；凭据由用户本地填写，不内置）
	oauthAccount: z.string().default(""),
	oauthClientId: z.string().default(""),
	oauthClientSecret: z.string().default(""),
	// vision-toolkit: 每个上游各注册一个识图包装 provider；旧单值字段继续兼容
	visionUpstreams: z.array(z.string()),
	upstreamProvider: z.string().default("deepseek"),
	// 视觉结果内存 LRU 与会话清单上限
	cacheMax: z.number().default(64),
	manifestMax: z.number().default(12),
	rehydrateMax: z.number().default(4),
	// 空数组保持旧版 image_path 行为；配置后仅接收这些目录中的本地图片
	allowedImageDirs: z.array(z.string()).default([]),
	// Windows curl.exe 路径
	curlPath: z.string().default(DEFAULT_CURL)
});

function configFile() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "dsh-vision.json");
}

function loadOverrides() {
	try {
		const p = configFile();
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		/* ignore */
	}
	return {};
}

/** WSL 与 Windows 互操作：body 必须写到 Windows 可见路径（stdin 管道在 interop 下不可靠）。 */
function winTempPaths() {
	const name = `dsh-vision-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
	// /mnt/c/Temp 是 Windows 的 C:\Temp（ASCII 路径，避开中文用户名转码问题）
	return { wsl: `/mnt/c/Temp/${name}`, win: `C:\\Temp\\${name}` };
}

/** 用 Windows curl.exe 发 POST；body 写 Windows 可见临时文件。 */
async function curlPost(curlPath, url, headers, bodyBuf, extraArgs = [], signal) {
	const { wsl, win } = winTempPaths();
	writeFileSync(wsl, bodyBuf);
	const args = [curlPath, "-s", "-S", "--max-time", "180", "-X", "POST", ...extraArgs, "--data-binary", `@${win}`];
	for (const h of headers) args.push("-H", h);
	args.push(url);
	try {
			return await new Promise((resolve, reject) => {
				execFile(args[0], args.slice(1),
					{ timeout: 190000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal },
					(error, stdout, stderr) => {
						if (signal?.aborted) return reject(signal.reason || error);
						if (error && !stdout) resolve({ ok: false, stdout: "", stderr: String(stderr || error.message).slice(0, 500) });
					else resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
				});
		});
	} finally {
		try { unlinkSync(wsl); } catch { /* ignore */ }
	}
}

function abortableDelay(ms, signal) {
	return new Promise((resolveDelay, reject) => {
		if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
		const timer = setTimeout(done, ms);
		function done() {
			signal?.removeEventListener("abort", aborted);
			resolveDelay(undefined);
		}
		function aborted() {
			clearTimeout(timer);
			reject(signal.reason || new Error("aborted"));
		}
		signal?.addEventListener("abort", aborted, { once: true });
	});
}

async function oauthAccessToken(cfg, signal) {
	const p = cfg.oauthAccount || "";
	if (!p) throw new Error("aicode 通道需要配置 oauthAccount（账号 JSON 路径）");
	if (!cfg.oauthClientId || !cfg.oauthClientSecret) {
		throw new Error("aicode 通道需要配置 oauthClientId / oauthClientSecret（Google OAuth 凭据）");
	}
	let accounts;
	try {
		accounts = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		throw new Error(`无法读取账号文件 ${p}: ${e.message}`);
	}
	const acct = Array.isArray(accounts) ? accounts[0] : accounts;
	const rt = acct.refresh_token || acct.refreshToken;
	if (!rt) throw new Error(`账号文件 ${p} 里没有 refresh_token`);
	const body = Buffer.from(
		`client_id=${cfg.oauthClientId}&client_secret=${cfg.oauthClientSecret}` +
		`&grant_type=refresh_token&refresh_token=${rt}`
	);
	const res = await curlPost(cfg.curlPath, "https://oauth2.googleapis.com/token",
		["Content-Type: application/x-www-form-urlencoded"], body, ["--max-time", "30"], signal);
	if (!res.ok) throw new Error(`OAuth 请求失败: ${res.stderr || res.stdout?.slice(0, 200)}`);
	try {
		const d = JSON.parse(res.stdout);
		if (!d.access_token) throw new Error(`换 token 失败: ${JSON.stringify(d).slice(0, 300)}`);
		return d.access_token;
	} catch (e) {
		if (e instanceof SyntaxError) throw new Error(`换 token 响应异常: ${res.stdout.slice(0, 200)}`);
		throw e;
	}
}

/** 通道 genlang: 标准 Gemini API（?key=），503 自动重试 */
async function runGenlang(cfg, model, prompt, images, signal) {
	if (!cfg.genlangKey) return { error: "未配置 genlangKey（Gemini API key）。可在 ~/.dsh/dsh-vision.json 填写。" };
	const payload = JSON.stringify({
		contents: [{ parts: [
			{ text: prompt },
			...images.map((image) => ({ inline_data: { mime_type: image.mime || "image/jpeg", data: image.b64 } }))
		] }]
	});
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.genlangKey)}`;
	for (let attempt = 0; attempt < 3; attempt++) {
		const res = await curlPost(cfg.curlPath, url, ["Content-Type: application/json"], Buffer.from(payload), [], signal);
		if (!res.ok) return { error: `请求失败: ${res.stderr || res.stdout?.slice(0, 300)}` };
		try {
			const d = JSON.parse(res.stdout);
			if (d.candidates?.[0]?.content?.parts?.[0]?.text) {
				return { text: d.candidates[0].content.parts[0].text };
			}
			const err = d.error;
			if (err?.code === 503 && attempt < 2) {
				await abortableDelay(2000 * (attempt + 1), signal);
				continue;
			}
			return { error: `Gemini ${err?.code || "?"}: ${err?.message || JSON.stringify(d).slice(0, 300)}` };
		} catch {
			return { error: `Gemini 响应异常: ${res.stdout.slice(0, 300)}` };
		}
	}
	return { error: "重试耗尽" };
}

/** 通道 cockpit: OpenAI 兼容反代（Cockpit 的 Gemini API 服务 / 反重力额度） */
async function runCockpit(cfg, model, prompt, images, signal) {
	if (!cfg.cockpitKey) return { error: "未配置 cockpitKey（Cockpit API 服务密钥）。可在 ~/.dsh/dsh-vision.json 填写。" };
	const payload = JSON.stringify({
		model,
		messages: [{ role: "user", content: [
			{ type: "text", text: prompt },
			...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mime || "image/jpeg"};base64,${image.b64}` } }))
		] }],
		max_tokens: 2048
	});
	const base = (cfg.cockpitBaseUrl || "").replace(/\/+$/, "");
	const url = `${base}/v1/chat/completions`;
	const res = await curlPost(cfg.curlPath, url,
		["Content-Type: application/json", `Authorization: Bearer ${cfg.cockpitKey}`],
		Buffer.from(payload), ["--noproxy", "*"], signal);
	if (!res.ok) return { error: `请求失败: ${res.stderr || res.stdout?.slice(0, 300)}` };
	try {
		const d = JSON.parse(res.stdout);
		if (d.choices?.[0]?.message?.content) return { text: d.choices[0].message.content };
		return { error: `Cockpit 返回: ${JSON.stringify(d).slice(0, 300)}` };
	} catch {
		return { error: `Cockpit 响应异常: ${res.stdout.slice(0, 300)}` };
	}
}

/** 通道 aicode: Antigravity 内部通道（OAuth + cloudcode-pa，Vertex 请求格式） */
async function runAicode(cfg, model, prompt, images, signal) {
	try {
		const token = await oauthAccessToken(cfg, signal);
		const payload = JSON.stringify({
			request: {
				model,
				contents: [{ role: "user", parts: [
					{ text: prompt },
					...images.map((image) => ({ inlineData: { mimeType: image.mime || "image/jpeg", data: image.b64 } }))
				] }]
			}
		});
		const url = "https://cloudcode-pa.googleapis.com/v1internal:generateContent";
		const res = await curlPost(cfg.curlPath, url,
			["Content-Type: application/json", `Authorization: Bearer ${token}`],
			Buffer.from(payload), [], signal);
		if (!res.ok) return { error: `请求失败: ${res.stderr || res.stdout?.slice(0, 300)}` };
		try {
			const d = JSON.parse(res.stdout);
			if (d.candidates?.[0]?.content?.parts?.[0]?.text) return { text: d.candidates[0].content.parts[0].text };
			if (d.error?.code === 500) {
				return { error: "cloudcode-pa 500：该通道需要 Antigravity IDE 会话的 workspace 绑定。建议在 Cockpit Tools 的 API 服务页启用 Gemini 通道（反重力额度），插件改用 cockpit 通道。" };
			}
			return { error: `aicode ${d.error?.code || "?"}: ${d.error?.message || JSON.stringify(d).slice(0, 300)}` };
		} catch {
			return { error: `aicode 响应异常: ${res.stdout.slice(0, 300)}` };
		}
	} catch (e) {
		return { error: String(e.message || e).slice(0, 400) };
	}
}

function imageExtension(mime) {
	if (mime === "image/png") return ".png";
	if (mime === "image/webp") return ".webp";
	if (mime === "image/gif") return ".gif";
	return ".jpg";
}

function windowsFileUri(wslPath) {
	const match = String(wslPath).match(/^\/mnt\/([a-z])\/(.*)$/i);
	if (!match) return `file://${encodeURI(wslPath)}`;
	return `file:///${encodeURI(`${match[1].toUpperCase()}:/${match[2]}`).replace(":", "%3A")}`;
}

/** 通道 antigravity: 官方 agentapi（反重力 g1-pro 订阅额度, 已实测打通） */
async function runAntigravity(cfg, model, prompt, images, signal) {
	const imagePaths = [];
	try {
		signal?.throwIfAborted();
		const wslDir = cfg.antigravityWorkspace;
		mkdirSync(wslDir, { recursive: true });
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const links = images.map((image, index) => {
			const imageName = `dsh-vision-${stamp}-${index + 1}${imageExtension(image.mime)}`;
			const imagePath = join(wslDir, imageName);
			writeFileSync(imagePath, Buffer.from(image.b64, "base64"));
			imagePaths.push(imagePath);
			return `图片 ${index + 1}${image.id ? `（attachment=${image.id}）` : ""}: ![img${index + 1}](${windowsFileUri(imagePath)})`;
		});

		const { port, csrf, error: discoveryError } = await findLs(signal);
		if (!port || !csrf) {
			return { error: discoveryError || "找不到运行中的 Antigravity 语言服务器。请先启动并登录 Antigravity IDE。" };
		}
		const fullPrompt = `${prompt}\n\n${links.join("\n")}`;
		const tier = model.includes("pro") ? "pro" : "flash";
		const existingWslEnv = process.env.WSLENV || "";
		const env = {
			WSLENV: ["ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_PROJECT_ID", existingWslEnv]
				.filter(Boolean).join(":"),
			ANTIGRAVITY_LS_ADDRESS: `http://127.0.0.1:${port}`,
			ANTIGRAVITY_CSRF_TOKEN: csrf,
			ANTIGRAVITY_PROJECT_ID: cfg.antigravityProjectId
		};
		const ensureProject = await ensureProjectFile(cfg);
		if (ensureProject) return ensureProject;
		const started = await new Promise((resolveStarted, reject) => {
			execFile(cfg.antigravityLsExe, ["agentapi", "new-conversation", `--model=${tier}`, fullPrompt],
				{ cwd: wslDir, env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal },
				(error, stdout, stderr) => {
					if (signal?.aborted) return reject(signal.reason || error);
					if (error) resolveStarted({ error: String(stderr || error.message).slice(0, 1200) });
					else resolveStarted({ stdout: String(stdout) });
				});
		});
		if (started.error) return { error: `agentapi new-conversation 失败: ${started.error}` };
		let conversation;
		try {
			conversation = JSON.parse(started.stdout);
		} catch {
			return { error: `agentapi 输出异常: ${started.stdout.slice(0, 500)}` };
		}
		if (conversation.error) return { error: `agentapi 错误: ${conversation.error}` };
		const conversationId = conversation.response?.newConversation?.conversationId;
		if (!conversationId) return { error: `未拿到 conversationId: ${JSON.stringify(conversation).slice(0, 500)}` };

		const logDir = join(cfg.antigravityBrainDir, conversationId, ".system_generated", "logs");
		const fullTranscript = join(logDir, "transcript_full.jsonl");
		const compactTranscript = join(logDir, "transcript.jsonl");
		const startedAt = Date.now();
		let transcript = "";
		let offset = 0;
		let remainder = "";
		while (Date.now() - startedAt < 240000) {
			signal?.throwIfAborted();
			try {
				const nextTranscript = existsSync(fullTranscript)
					? fullTranscript
					: Date.now() - startedAt >= 8000 && existsSync(compactTranscript) ? compactTranscript : "";
				if (!nextTranscript) throw new Error("transcript pending");
				if (transcript !== nextTranscript) {
					transcript = nextTranscript;
					offset = 0;
					remainder = "";
				}
				const size = statSync(transcript).size;
				if (size < offset) { offset = 0; remainder = ""; }
				if (size > offset) {
					const length = size - offset;
					const buffer = Buffer.alloc(length);
					const fd = openSync(transcript, "r");
					try { readSync(fd, buffer, 0, length, offset); } finally { closeSync(fd); }
					offset = size;
					const lines = (remainder + buffer.toString("utf8")).split("\n");
					remainder = lines.pop() || "";
					for (const line of lines) {
						try {
							const entry = JSON.parse(line);
							if (entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE" && entry.content?.trim()) {
								return { text: entry.content.trim() };
							}
						} catch { /* 等待完整行 */ }
					}
				}
			} catch { /* transcript 尚未出现 */ }
			await abortableDelay(2000, signal);
		}
		return { error: "等待反重力回复超时" };
	} catch (error) {
		if (signal?.aborted) throw signal.reason || error;
		return { error: String(error?.message || error).slice(0, 1200) };
	} finally {
		for (const imagePath of imagePaths) {
			try { unlinkSync(imagePath); } catch { /* ignore cleanup errors */ }
		}
	}
}

/** auto 通道解析：配置了反重力（本地用户）→ antigravity；否则 → web（豆包，开源默认）；再 → genlang/cockpit */
function resolveAutoChannel(cfg) {
	if (cfg.antigravityWorkspace && cfg.antigravityProjectId && cfg.antigravityLsExe) return "antigravity";
	if (cfg.webChannel?.enabled !== false) return "web";
	if (cfg.genlangKey) return "genlang";
	if (cfg.cockpitKey) return "cockpit";
	return "web";
}

async function runVisionChannel(cfg, channel, model, prompt, images, signal) {
	if (channel === "web") {
		// 网页版 AI（豆包等）：走 WSL 队列 + Windows 浏览器桥接
		webVisionQueue.port = cfg.webChannel?.queuePort || 9340;
		const result = await webVisionQueue.recognize({
			prompt,
			images: images.map((img) => ({ b64: img.b64, mime: img.mime })),
			model,
			timeoutMs: cfg.webChannel?.timeoutMs || 240000,
			signal
		});
		return result.error ? result : { text: result.text };
	}
	if (channel === "ide") {
		// 通用 IDE CLI（Claude Code / Gemini CLI / Qwen Code / MiMo 等会员额度）
		if (cfg.ideCli?.enabled !== true || !cfg.ideCli?.exe) {
			return { error: "ide 通道未启用：请在配置里设置 ideCli.enabled=true 和 ideCli.exe（IDE CLI 路径）" };
		}
		return await runIdeCli({
			exe: cfg.ideCli.exe,
			argsTemplate: cfg.ideCli.argsTemplate || "-p {prompt}",
			imageRefTemplate: cfg.ideCli.imageRefTemplate || "{path}",
			prompt,
			images: images.map((img) => ({ b64: img.b64, mime: img.mime })),
			timeoutMs: cfg.ideCli.timeoutMs || 120000,
			cwd: cfg.ideCli.cwd || undefined,
			signal
		});
	}
	if (channel === "antigravity") return runAntigravity(cfg, model, prompt, images, signal);
	if (channel === "genlang") return runGenlang(cfg, model, prompt, images, signal);
	if (channel === "cockpit") return runCockpit(cfg, model, prompt, images, signal);
	if (channel === "aicode") return runAicode(cfg, model, prompt, images, signal);
	return { error: `未知 channel: ${channel}` };
}

async function runAdaptiveVision(cfg, channel, requestedModel, detail, visionMode, userPrompt, region, images, signal) {
	const selectedDetail = normalizeDetail(detail);
	const selectedMode = normalizeVisionMode(visionMode);
	const model = VISION_MODEL;
	const runOne = async (oneDetail, triage) => {
		const prompt = buildVisionPrompt({
			detail: oneDetail,
			mode: selectedMode,
			userPrompt,
			region,
			imageCount: images.length,
			triage
		});
		const raw = await runVisionChannel(cfg, channel, model, prompt, images, signal);
		if (raw.error) return raw;
		const normalized = normalizeVisionResponse(raw.text);
		return { text: normalized.answer, evidence: normalized.evidence, complexity: normalized.complexity, structured: normalized.structured, truncatedBytes: normalized.truncatedBytes };
	};

	if (selectedDetail !== "auto") {
		const result = await runOne(selectedDetail, false);
		return { ...result, detail: selectedDetail, mode: selectedMode, model, escalated: false };
	}
	const first = await runOne("standard", true);
	if (first.error) return { ...first, detail: "auto", mode: selectedMode, model, escalated: false };
	if (first.complexity !== "complex") {
		return { ...first, detail: "auto", mode: selectedMode, model, escalated: false };
	}
	const deep = await runOne("deep", false);
	if (deep.error) {
		return { ...first, detail: "auto", mode: selectedMode, model, escalated: false, escalationError: deep.error };
	}
	return { ...deep, detail: "auto", mode: selectedMode, model, escalated: true };
}

/** 从运行中的 LS 进程提取 gRPC 端口与 CSRF token。 */
async function findLs(signal) {
	signal?.throwIfAborted();
	const run = (cmd, args, timeout = 15000) => new Promise((resolveRun, reject) => {
		execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal },
			(error, stdout) => {
				if (signal?.aborted) return reject(signal.reason || error);
				resolveRun(String(stdout || ""));
			});
	});
	// 1. 找 language_server.exe PID
	const tl = await run("/mnt/c/Windows/System32/tasklist.exe",
		["/FI", "IMAGENAME eq language_server.exe"]);
	let pid = null;
	for (const line of tl.split("\n")) {
		if (line.includes("language_server.exe")) {
			const parts = line.trim().split(/\s+/);
			pid = parts[1] || null;
			break;
		}
	}
	if (!pid) return { port: null, csrf: null, error: "找不到 language_server.exe 进程。请先启动并登录 Antigravity IDE。" };
	// 2. 该 PID 的 127.0.0.1 LISTENING 端口
	const ns = await run("/mnt/c/Windows/System32/netstat.exe", ["-ano", "-p", "tcp"]);
	const ports = [];
	for (const line of ns.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 5 && parts[0] === "TCP" && parts[3] === "LISTENING" && parts[4] === pid) {
			const m = parts[1].match(/^127\.0\.0\.1:(\d+)$/);
			if (m) ports.push(m[1]);
		}
	}
	if (!ports.length) return { port: null, csrf: null, error: `language_server.exe PID ${pid} 没有监听 127.0.0.1 端口。` };
	// 3. CSRF（进程命令行）
	const csrfOut = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
		["-NoProfile", "-Command",
		 `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`], 30000);
	const m = csrfOut.match(/--csrf_token\s+([a-f0-9-]{20,})/);
	const csrf = m ? m[1] : null;
	// 4. Windows 侧 socket 探测 h2c gRPC 端口（回 SETTINGS 帧 type=0x04 的是 gRPC）
	const probe = (
		"$ports=@(" + ports.join(",") + ");" +
		"foreach($p in $ports){" +
		"  try{" +
			"    $c=New-Object System.Net.Sockets.TcpClient;" +
			"    $c.ReceiveTimeout=1500; $c.SendTimeout=1500;" +
		"    $c.Connect('127.0.0.1',$p);" +
		"    $s=$c.GetStream();" +
		"    $pre=[byte[]](0x50,0x52,0x49,0x20,0x2a,0x20,0x48,0x54,0x54,0x50,0x2f,0x32,0x2e,0x30,0x0d,0x0a,0x0d,0x0a,0x53,0x4d,0x0d,0x0a,0x0d,0x0a);" +
		"    $s.Write($pre,0,$pre.Length);" +
		"    $buf=New-Object byte[] 9;" +
		"    $n=$s.Read($buf,0,9);" +
		"    if($n -ge 4 -and $buf[3] -eq 4){ Write-Output $p; $s.Close(); $c.Close(); break }" +
		"    $s.Close(); $c.Close()" +
		"  }catch{}" +
		"}"
	);
	const probeOut = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
		["-NoProfile", "-Command", probe], 30000);
	for (const line of probeOut.split("\n")) {
		const t = line.trim();
		if (/^\d+$/.test(t)) return { port: Number(t), csrf, error: null };
	}
	return {
		port: null,
		csrf,
		error: `已找到 language_server.exe PID ${pid} 和端口 ${ports.join(", ")}，但 h2c gRPC SETTINGS 探测全部失败。`
	};
}

/** 确保本地项目文件存在（agentapi StartCascade 需要）。 */
async function ensureProjectFile(cfg) {
	const home = cfg.antigravityWindowsHome;
	const projPath = join(home, ".gemini", "config", "projects", `${cfg.antigravityProjectId}.json`);
	if (existsSync(projPath)) return null;
	try {
		mkdirSync(dirname(projPath), { recursive: true });
		const winDir = cfg.antigravityWorkspace.replace(/^\/mnt\/([a-z])/, (_, d) => `${d.toUpperCase()}:`).replace(/\//g, "\\");
		const folderUri = "file:///" + winDir.replace(/\\/g, "/").replace(":", "%3A");
		writeFileSync(projPath, JSON.stringify({
			id: cfg.antigravityProjectId,
			name: "dsh-vision",
			projectResources: { resources: [{ gitFolder: { folderUri, allowWrite: true } }] }
		}));
	} catch (e) {
		return { error: `创建项目文件失败: ${e.message}` };
	}
	return null;
}

/**
 * vision-toolkit：把视觉能力融入对话流程。
 * 1) deepseek-vision 包装适配器：用户消息里的图片块 → 文本占位（不报错，模型可见），
 *    再转发给原 deepseek 适配器。
 * 2) vision agent 工具：模型看到占位符后调用它（attachment_id / image_path），
 *    用反重力额度识图，把描述文本放回模型上下文。
 */

const VISION_PROVIDER = "deepseek-vision";

function visionProviderName(upstreamProvider) {
	if (upstreamProvider === "deepseek") return VISION_PROVIDER;
	if (upstreamProvider === "deepseek-official") return `${VISION_PROVIDER}-official`;
	return `${VISION_PROVIDER}-${upstreamProvider}`;
}

/** attachmentId -> 完整 ImageAttachmentRef（含 bytes/尺寸，供 readImage 完整性校验） */
const attachmentRefs = new Map();
const visionCache = new VisionPromiseCache();

function restoreRecordAttachmentRefs(records) {
	for (const record of records || []) {
		for (const ref of record.attachmentRefs || []) {
			if (ref?.attachmentId) attachmentRefs.set(ref.attachmentId, ref);
		}
	}
}

/** 包装适配器：图片占位化后转发给指定上游 provider。 */
function createVisionAdapter(ctx, cfg, wrapperName, upstreamProvider) {
	if (upstreamProvider === wrapperName || upstreamProvider === VISION_PROVIDER || upstreamProvider.startsWith(`${VISION_PROVIDER}-`)) {
		throw new Error(`upstreamProvider 禁止指向包装适配器自身: ${upstreamProvider}`);
	}
	const upstream = (options) => ctx.llm.stream({ ...options, provider: upstreamProvider });
	const exposeVision = (provider, info) => ({
		...info,
		provider,
		inputModalities: ["text", "image"]
	});
	return {
		providerInfo(provider) {
			return {
				id: provider,
				name: upstreamProvider === "deepseek-official"
					? "DeepSeek Official (Vision Toolkit)"
					: "DeepSeek (Vision Toolkit)"
			};
		},
		providerRetryPolicy() {
			return undefined;
		},
		async listModels(provider) {
			try {
				const models = await ctx.llm.listModels(upstreamProvider);
				return models.map((model) => exposeVision(provider, model));
			} catch (error) {
				ctx.logger?.warn(`[dsh-vision] 读取上游 ${upstreamProvider} 模型目录失败，使用兼容目录: ${String(error?.message || error).slice(0, 200)}`);
				const models = upstreamProvider === "deepseek-official"
					? [
						{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
						{ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" }
					]
					: [
						{ id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash" },
						{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }
					];
				return models.map((model) => exposeVision(provider, model));
			}
		},
		async resolveModel(provider, model, signal) {
			try {
				const info = await ctx.llm.resolveModelInfo(upstreamProvider, model, signal);
				return exposeVision(provider, info);
			} catch {
				return { provider, id: model, name: model, inputModalities: ["text", "image"] };
			}
		},
		async *stream(options) {
			const session = options.sessionId ? ctx.get("sessions")?.get(options.sessionId) : undefined;
			const sessionMessages = session?.deriveMessages() || [];
			collectMessageAttachmentRefs(sessionMessages, attachmentRefs);
			const records = visionRecordsFromMessages(sessionMessages.length ? sessionMessages : options.messages || []);
			restoreRecordAttachmentRefs(records);
			const messages = (options.messages || [])
				.filter((message) => !isVisionRecordMessage(message))
				.map((message) => ({
					...message,
					content: message.content ? flattenMessageContent(message.content, attachmentRefs) : message.content
				}));
			const manifest = buildVisionManifest(records, cfg.manifestMax);
			if (manifest) {
				messages.push(createUserMessage({
					content: [{ type: "text", text: manifest }],
					source: { kind: "plugin", plugin: "dsh-vision", form: "catalog" }
				}));
			}
			const result = await upstream({ ...options, messages });
			for await (const chunk of repairLegacyPlanningStream(result)) yield chunk;
		}
	};
}

function pathIsAllowed(cfg, imagePath) {
	const roots = Array.isArray(cfg.allowedImageDirs) ? cfg.allowedImageDirs.filter(Boolean) : [];
	if (!roots.length) return true;
	const candidate = realpathSync(imagePath);
	return roots.some((root) => {
		let resolvedRoot;
		try { resolvedRoot = realpathSync(root); } catch { resolvedRoot = resolve(root); }
		return candidate === resolvedRoot || candidate.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep);
	});
}

function mimeForPath(imagePath) {
	const lower = String(imagePath).toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/jpeg";
}

function uniqueStrings(values) {
	return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

async function cachedVision(key, maximum, producer) {
	const cached = visionCache.get(key);
	if (cached) return { result: await cached, cacheHit: true };
	const pending = producer();
	visionCache.set(key, pending, maximum);
	try {
		const result = await pending;
		if (result.error) visionCache.delete(key);
		return { result, cacheHit: false };
	} catch (error) {
		visionCache.delete(key);
		throw error;
	}
}

/** vision 工具：支持单图、多图、OCR、区域细查与对比，并把证据写入当前 Session 时间线。 */
function registerVisionTool(ctx, cfg) {
	const run = async (args, exec) => {
		const prompt = String(args.prompt || "用中文详细描述图片内容").trim();
		const detail = normalizeDetail(args.detail);
		const mode = normalizeVisionMode(args.mode);
		const region = String(args.region || "").trim();
		// 通道：args.channel → 配置默认 → auto 解析（反重力优先，否则豆包 web）
		const channelArg = String(args.channel || cfg.defaultChannel || "auto");
		const channel = channelArg === "auto" ? resolveAutoChannel(cfg) : channelArg;
		const attachmentIds = uniqueStrings([args.attachment_id, ...(Array.isArray(args.attachment_ids) ? args.attachment_ids : [])]);
		const imagePaths = uniqueStrings([args.image_path, ...(Array.isArray(args.image_paths) ? args.image_paths : [])]);
		if (!attachmentIds.length && !imagePaths.length) return { error: "需要 attachment_id、attachment_ids、image_path 或 image_paths" };
		if (attachmentIds.length + imagePaths.length > 8) return { error: "一次最多处理 8 张图片" };
		if (mode === "compare" && attachmentIds.length + imagePaths.length < 2) return { error: "compare 模式至少需要 2 张图片" };
		if (mode === "region" && !region) return { error: "region 模式需要 region，例如 0.1,0.2,0.8,0.9" };

		const messages = exec.agent?.session?.deriveMessages() || [];
		collectMessageAttachmentRefs(messages, attachmentRefs);
		const records = visionRecordsFromMessages(messages);
		restoreRecordAttachmentRefs(records);
		const attachments = ctx.get("attachments");
		const images = [];
		for (const id of attachmentIds) {
			const ref = attachmentRefs.get(id);
			if (!attachments) return { error: "attachments 服务未就绪" };
			if (!ref) return { error: `当前会话里缺少附件 ${id} 的完整引用，请重新粘贴该图片` };
			try {
				const stored = await attachments.readImage(ref, exec.signal);
				const bytes = Buffer.from(stored.data);
				const canonicalRef = stored.ref || ref;
				attachmentRefs.set(id, canonicalRef);
				images.push({ id, b64: bytes.toString("base64"), mime: canonicalRef.mediaType || "image/jpeg", digest: sha256(bytes), ref: canonicalRef });
			} catch (error) {
				if (exec.signal.aborted) throw exec.signal.reason || error;
				return { error: `读取附件 ${id} 失败: ${String(error?.message || error).slice(0, 500)}` };
			}
		}
		for (const imagePath of imagePaths) {
			try {
				if (!pathIsAllowed(cfg, imagePath)) return { error: `图片路径超出 allowedImageDirs: ${imagePath}` };
				const bytes = readFileSync(imagePath);
				images.push({ id: `path:${resolve(imagePath)}`, b64: bytes.toString("base64"), mime: mimeForPath(imagePath), digest: sha256(bytes) });
			} catch (error) {
				return { error: `读取图片失败: ${String(error?.message || error).slice(0, 500)}` };
			}
		}

		const key = visionCacheKey({
			attachmentIds: images.map((image) => image.id),
			imageDigests: images.map((image) => image.digest),
			prompt,
			detail,
			mode,
			region,
			model: VISION_MODEL,
			channel
		});
		const durable = findVisionRecord(messages, key);
		if (durable) {
			return {
				text: durable.answer,
				attachment_ids: durable.attachmentIds,
				cache_hit: true,
				model: durable.model,
				detail: durable.detail,
				mode: durable.mode,
				channel: durable.channel,
				escalated: Boolean(durable.escalated),
				evidence_json: JSON.stringify(durable.evidence || {})
			};
		}

		const { result, cacheHit } = await cachedVision(key, cfg.cacheMax, async () => {
			let outcome = await runAdaptiveVision(cfg, channel, VISION_MODEL, detail, mode, prompt, region, images, exec.signal);
			let usedChannel = channel;
			// 降级链：反重力/web → genlang → web
			if (outcome.error && channel !== "genlang" && cfg.genlangKey) {
				outcome = await runAdaptiveVision(cfg, "genlang", VISION_MODEL, detail, mode, prompt, region, images, exec.signal);
				usedChannel = "genlang-fallback";
			} else if (outcome.error && channel !== "web" && cfg.webChannel?.enabled !== false) {
				outcome = await runAdaptiveVision(cfg, "web", VISION_MODEL, detail, mode, prompt, region, images, exec.signal);
				usedChannel = "web-fallback";
			}
			return { ...outcome, channel: usedChannel };
		});
		if (result.error) return { error: result.error };
		const record = makeVisionRecord({
			key,
			attachmentIds: images.map((image) => image.id),
			attachmentRefs: images.map((image) => image.ref).filter(Boolean),
			imageDigests: images.map((image) => image.digest),
			prompt: prompt.slice(0, 12000),
			promptHash: sha256(prompt),
			model: result.model || VISION_MODEL,
			detail,
			mode,
			region,
			channel: result.channel,
			escalated: Boolean(result.escalated),
			evidence: result.evidence || { summary: result.text },
			answer: String(result.text || "").slice(0, 20000)
		});
		exec.deferContext(createUserMessage({
			content: [{ type: "text", text: visionRecordText(record) }],
			source: {
				kind: "plugin",
				plugin: "dsh-vision",
				form: "notice",
				summary: `视觉证据已记录：${record.attachmentIds.join(", ")}`.slice(0, 120)
			}
		}));
		return {
			text: record.answer,
			attachment_ids: record.attachmentIds,
			cache_hit: cacheHit,
			model: record.model,
			detail: record.detail,
			mode: record.mode,
			channel: record.channel,
			escalated: record.escalated,
			evidence_json: JSON.stringify(record.evidence)
		};
	};

	ctx.tools.register(defineTool({
		name: "vision",
		description: "用视觉模型检查对话图片或本地图片。看到 [图片附件 attachment=...] 时调用；把用户本轮原话完整传入 prompt。单图用 attachment_id，多图用 attachment_ids。mode 可选 glance、ocr、region、compare。channel 可选 auto、web（豆包）、antigravity、genlang、cockpit。",
		parameters: {
			attachment_id: { type: "string", description: "单个对话图片附件 id" },
			attachment_ids: { type: "array", items: { type: "string" }, description: "多个对话图片附件 id，顺序会保留" },
			image_path: { type: "string", description: "本地图片文件路径" },
			image_paths: { type: "array", items: { type: "string" }, description: "多个本地图片文件路径" },
			prompt: { type: "string", description: "理解要求；传入用户本轮完整原话" },
			detail: { type: "string", enum: ["auto", "fast", "standard", "deep"], description: "思考档位，默认 auto" },
			mode: { type: "string", enum: ["glance", "ocr", "region", "compare"], description: "任务模式，默认 glance" },
			region: { type: "string", description: "region 模式的区域，例如归一化坐标 0.1,0.2,0.8,0.9，或自然语言区域" },
			channel: { type: "string", enum: ["auto", "web", "ide", "antigravity", "genlang", "cockpit"], description: "识图通道，默认 auto（配置了反重力则反重力，否则豆包 web）；ide=编程工具 CLI（Claude Code/Gemini CLI 等）" }
		},
		output: {
			schema: {
				type: "object",
				properties: {
					text: { type: "string", required: true },
					attachment_ids: { type: "array", items: { type: "string" }, required: true },
					cache_hit: { type: "boolean", required: true },
					model: { type: "string", required: true },
					detail: { type: "string", required: true },
					mode: { type: "string", required: true },
					channel: { type: "string", required: true },
					escalated: { type: "boolean", required: true },
					evidence_json: { type: "string", required: true }
				},
				additionalProperties: false
			},
			render(_args, value) {
				return [{ type: "text", text: String(value.text) }];
			}
		},
		timeoutMs: 260000,
		async execute(args, exec) {
			const result = await run(args, exec);
			if (result.error) throw new Error(result.error);
			return result;
		}
	}));
	ctx.logger?.info("[dsh-vision] vision 工具已注册");
}

function normalizeApiImages(body) {
	const source = Array.isArray(body.images) && body.images.length
		? body.images
		: body.image ? [{ image: body.image, mime: body.mime, name: body.name }] : [];
	if (!source.length) throw new Error("缺少 image 或 images");
	if (source.length > 8) throw new Error("一次最多处理 8 张图片");
	let totalBytes = 0;
	return source.map((item, index) => {
		let base64 = String(item?.image || item?.data || "").trim();
		const dataUrl = base64.match(/^data:([^;,]+);base64,(.*)$/s);
		const mime = String(item?.mime || dataUrl?.[1] || "image/jpeg");
		if (dataUrl) base64 = dataUrl[2];
		if (!base64) throw new Error(`第 ${index + 1} 张图片缺少 base64`);
		const bytes = Buffer.from(base64, "base64");
		if (!bytes.length) throw new Error(`第 ${index + 1} 张图片数据为空`);
		if (bytes.length > 8 * 1024 * 1024) throw new Error(`第 ${index + 1} 张图片超过 8MB`);
		totalBytes += bytes.length;
		if (totalBytes > 32 * 1024 * 1024) throw new Error("图片总大小超过 32MB");
		return {
			id: `api:${sha256(bytes)}`,
			b64: bytes.toString("base64"),
			mime,
			name: String(item?.name || `image-${index + 1}`),
			digest: sha256(bytes),
			bytes: bytes.length
		};
	});
}

/** 只在 DSH compaction 事务后补回被摘要遮蔽的近期视觉记录；普通回溯/替换不会触发。 */
function installCompactionRehydration(ctx, cfg) {
	const beforeCompaction = new WeakMap();
	ctx.on("session/event", (session, event) => {
		if (event.type === "compaction/summary") {
			beforeCompaction.set(session, visionRecordsFromMessages(session.deriveMessages()));
			return;
		}
		if (event.type !== "compaction/end") return;
		const before = beforeCompaction.get(session) || [];
		beforeCompaction.delete(session);
		if (event.data?.error || !before.length) return;
		queueMicrotask(async () => {
			try {
				const visibleKeys = new Set(visionRecordsFromMessages(session.deriveMessages()).map((record) => record.key));
				const limit = Math.max(1, Math.floor(Number(cfg.rehydrateMax) || 4));
				const missing = before.filter((record) => !visibleKeys.has(record.key)).slice(-limit);
				if (!missing.length) return;
				for (const record of missing) {
					session.append("user/message", createUserMessage({
						content: [{ type: "text", text: visionRecordText(record) }],
						source: {
							kind: "plugin",
							plugin: "dsh-vision",
							form: "notice",
							summary: `视觉证据已从摘要恢复：${(record.attachmentIds || []).join(", ")}`.slice(0, 120)
						}
					}), { surfaceOp: "append" });
				}
				await ctx.get("sessions")?.flush(session);
				ctx.logger?.info(`[dsh-vision] compaction 后恢复 ${missing.length} 条视觉记录`);
			} catch (error) {
				ctx.logger?.warn(`[dsh-vision] compaction 视觉记录恢复失败: ${String(error?.message || error).slice(0, 300)}`);
			}
		});
	});
}

export function apply(ctx, config) {
	const cfg = { ...config, ...loadOverrides() };
	installCompactionRehydration(ctx, cfg);

	// vision-toolkit：注册包装适配器 + vision 工具
	const upstreams = uniqueStrings(
		Array.isArray(cfg.visionUpstreams) && cfg.visionUpstreams.length
			? cfg.visionUpstreams
			: [cfg.upstreamProvider || "deepseek"]
	);
	for (const upstreamProvider of upstreams) {
		const wrapperName = visionProviderName(upstreamProvider);
		try {
			ctx.llm.registerAdapter([wrapperName], createVisionAdapter(ctx, cfg, wrapperName, upstreamProvider));
			ctx.logger?.info(`[dsh-vision] 适配器 ${wrapperName} 已注册（图片→占位文本→${upstreamProvider}）`);
		} catch (e) {
			ctx.logger?.warn(`[dsh-vision] 适配器 ${wrapperName} 注册失败: ${e?.message}`);
		}
	}
	try {
		registerVisionTool(ctx, cfg);
	} catch (e) {
		ctx.logger?.warn(`[dsh-vision] vision 工具注册失败: ${e?.message}`);
	}

	const webServer = ctx.get("webServer");	if (!webServer) {
		ctx.logger?.info("[dsh-vision] no webServer present — /api/vision route skipped");
		return;
	}
	const dispose = webServer.register({
		kind: "exact",
			path: "/api/vision",
			handler: async (req, res) => {
				const controller = new AbortController();
				const abort = () => {
					if (!controller.signal.aborted) controller.abort(new Error("vision client disconnected"));
				};
				const close = () => { if (!res.writableEnded) abort(); };
				req.once("aborted", abort);
				res.once("close", close);
				const send = (code, obj) => {
					if (res.destroyed || res.writableEnded) return;
					res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
					res.end(JSON.stringify(obj));
				};
				try {
					let raw = "";
					let requestBytes = 0;
					for await (const chunk of req) {
						requestBytes += chunk.length;
						if (requestBytes > 48 * 1024 * 1024) return send(413, { error: "请求体超过 48MB" });
						raw += chunk;
					}
					const body = JSON.parse(raw || "{}");
					const images = normalizeApiImages(body);
					const prompt = String(body.prompt || "请用中文详细描述图片内容。").trim();
					const detail = normalizeDetail(body.detail);
					const mode = normalizeVisionMode(body.mode);
					const region = String(body.region || "").trim();
					if (mode === "compare" && images.length < 2) return send(400, { error: "compare 模式至少需要 2 张图片" });
					if (mode === "region" && !region) return send(400, { error: "region 模式需要 region" });
					const requestedChannel = body.channel || cfg.defaultChannel || "auto";
					const autoChannel = requestedChannel === "auto";
					const channel = autoChannel ? resolveAutoChannel(cfg) : requestedChannel;
					const key = visionCacheKey({
						attachmentIds: images.map((image) => image.id),
						imageDigests: images.map((image) => image.digest),
						prompt,
						detail,
						mode,
						region,
						model: VISION_MODEL,
						channel
					});
					ctx.logger?.info(`[dsh-vision] channel=${channel} model=${VISION_MODEL} detail=${detail} mode=${mode} images=${images.length} imageBytes=${images.reduce((sum, image) => sum + image.bytes, 0)}`);
					const cached = await cachedVision(key, cfg.cacheMax, async () => {
						let result = await runAdaptiveVision(cfg, channel, VISION_MODEL, detail, mode, prompt, region, images, controller.signal);
						let usedChannel = channel;
						if (result.error && autoChannel && cfg.genlangKey) {
							result = await runAdaptiveVision(cfg, "genlang", VISION_MODEL, detail, mode, prompt, region, images, controller.signal);
							usedChannel = "genlang-fallback";
						}
						return { ...result, channel: usedChannel };
					});
					const result = cached.result;
					if (result.error) return send(502, { error: result.error, channel });
					return send(200, {
						text: result.text,
						channel: result.channel,
						model: result.model,
						detail: result.detail,
						mode: result.mode,
						escalated: result.escalated,
						complexity: result.complexity,
						structured: result.structured,
						truncated_bytes: result.truncatedBytes || 0,
						evidence: result.evidence,
						cache_hit: cached.cacheHit,
						prompt_version: VISION_PROMPT_VERSION
					});
				} catch (e) {
					if (!controller.signal.aborted) send(500, { error: String(e?.message || e).slice(0, 1200) });
				} finally {
					req.removeListener("aborted", abort);
					res.removeListener("close", close);
				}
		}
	});
	ctx.effect(() => dispose, "dsh-vision: webServer route");
	ctx.logger?.info("[dsh-vision] /api/vision route registered");
}

export const __testing = Object.freeze({
	normalizeDetail,
	normalizeVisionMode,
	normalizeVisionResponse,
	buildVisionPrompt,
	visionCacheKey,
	makeVisionRecord,
	visionRecordText,
	visionRecordsFromMessages,
	findVisionRecord,
	buildVisionManifest,
	flattenMessageContent,
	VisionPromiseCache,
	installCompactionRehydration,
	repairLegacyPlanningStream,
	visionProviderName
});
