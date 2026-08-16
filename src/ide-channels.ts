/**
 * dsh-vision ide-channels — 通用 IDE CLI 接入器。
 *
 * 用编程软件的本地 CLI（会员额度）识图：Claude Code、Gemini CLI、Qwen Code、
 * MiMo 等任何支持命令行提问的 IDE/编程工具。图片写到临时目录后以路径引用
 * 附在 prompt 里，由 CLI 自己读图；stdout 即回复。
 *
 * 配置驱动：一个 ideCli 配置块 + 参数模板，换一个 IDE 只需改配置。
 *
 * 示例配置：
 *   Claude Code: exe=claude, args="-p {prompt}", imageRef="{path}"
 *   Gemini CLI : exe=gemini, args="-p {prompt}", imageRef="@{path}"
 *   反重力 agentapi 属于专用实现（index.ts 的 runAntigravity），不走这里。
 */

import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface IdeCliOptions {
	exe: string;
	/** 参数模板，{prompt} 占位会被替换为完整提问（含图片引用） */
	argsTemplate: string;
	/** 图片引用模板，{path} 占位（默认 "{path}"，Gemini CLI 用 "@{path}"） */
	imageRefTemplate?: string;
	prompt: string;
	images: { b64: string; mime: string }[];
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** 图片临时目录（默认系统临时目录） */
	tempDir?: string;
}

function imageExtension(mime: string) {
	if (mime === "image/png") return ".png";
	if (mime === "image/webp") return ".webp";
	if (mime === "image/gif") return ".gif";
	return ".jpg";
}

/**
 * 执行一次 IDE CLI 识图：写图片 → 组 prompt → 跑 CLI → stdout 为回复。
 * 返回 { text } 或 { error }。
 */
export async function runIdeCli(options: IdeCliOptions) {
	const tmpDir = options.tempDir || join(require("node:os").tmpdir(), "dsh-vision-ide");
	const imagePaths: string[] = [];
	try {
		options.signal?.throwIfAborted();
		if (!options.exe) return { error: "未配置 ideCli.exe（IDE CLI 可执行文件）" };
		mkdirSync(tmpDir, { recursive: true });
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const refTemplate = options.imageRefTemplate || "{path}";
		const refs = options.images.map((image, index) => {
			const path = join(tmpDir, `ide-${stamp}-${index + 1}${imageExtension(image.mime)}`);
			writeFileSync(path, Buffer.from(image.b64, "base64"));
			imagePaths.push(path);
			return refTemplate.split("{path}").join(path);
		});
		const fullPrompt = refs.length
			? `${options.prompt}\n\n图片：\n${refs.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
			: options.prompt;

		// 参数模板解析："{prompt}" 替换；支持 shell 分词（按空格拆，引号内的保留）
		const args = parseArgs(options.argsTemplate || "-p {prompt}", fullPrompt);

		const stdout = await new Promise<string>((resolveRun, reject) => {
			execFile(options.exe, args, {
				cwd: options.cwd,
				timeout: options.timeoutMs || 120000,
				maxBuffer: 16 * 1024 * 1024,
				windowsHide: true,
				signal: options.signal,
				shell: false
			}, (error, out, stderr) => {
				if (options.signal?.aborted) return reject(options.signal.reason || error);
				if (error) {
					const detail = String(stderr || error.message).trim();
					if (out?.trim()) return resolveRun(String(out).trim()); // 部分输出也算成功
					return reject(new Error(`IDE CLI 执行失败: ${detail.slice(0, 400)}`));
				}
				resolveRun(String(out || "").trim());
			});
		});

		if (!stdout) return { error: "IDE CLI 无输出（可能是参数模板不对或 CLI 不支持该用法）" };
		return { text: stdout };
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason || error;
		return { error: String((error as any)?.message || error).slice(0, 1200) };
	} finally {
		for (const p of imagePaths) {
			try { unlinkSync(p); } catch { /* ignore cleanup errors */ }
		}
	}
}

/** 把参数模板按 shell 规则拆词（支持双引号/单引号分组），并替换 {prompt} 占位。 */
function parseArgs(template: string, prompt: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inDouble = false;
	let inSingle = false;
	for (let i = 0; i < template.length; i++) {
		const ch = template[i];
		if (inDouble) {
			if (ch === '"') { inDouble = false; continue; }
			current += ch;
		} else if (inSingle) {
			if (ch === "'") { inSingle = false; continue; }
			current += ch;
		} else if (ch === '"') { inDouble = true; }
		else if (ch === "'") { inSingle = true; }
		else if (ch === " " || ch === "\t") {
			if (current) { tokens.push(current); current = ""; }
		} else { current += ch; }
	}
	if (current) tokens.push(current);
	return tokens.map((t) => t.split("{prompt}").join(prompt));
}
