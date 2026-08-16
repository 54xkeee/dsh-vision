/**
 * dsh-vision web-channels — 网页版 AI 识图通道（豆包等）。
 *
 * 架构（WSL 宿主 + Windows 浏览器）：
 *
 *   DSH 插件 (WSL)                      Windows 桥接 (node + puppeteer-core)
 *   ┌─────────────────┐  localhost:9340  ┌──────────────────────────────┐
 *   │ submit(图+提示)  │ ◀──HTTP 轮询───▶ │ 轮询 /pending → CDP 控制      │
 *   │ 轮询 /job/:id   │                  │ 已登录 Chrome(9333) → 豆包    │
 *   │                 │                  │ 发图 → 读回复 → POST /result │
 *   └─────────────────┘                  └──────────────────────────────┘
 *
 * WSL 无法连 Windows 端口（防火墙），但 Windows→WSL 的 localhost 转发默认开启，
 * 所以队列服务监听 WSL 侧 127.0.0.1，由 Windows 桥接主动轮询。
 */

import { createServer } from "node:http";

/** 一个待办识图任务 */
export interface WebVisionJob {
	id: string;
	prompt: string;
	images: { b64: string; mime: string }[];
	model?: string;
	createdAt: number;
	status: "pending" | "running" | "done";
	result?: { text?: string; error?: string };
}

/** 队列服务：submit（DSH）→ pending（桥接轮询）→ result（桥接回写）→ job（DSH 轮询） */
export class WebVisionQueue {
	port: number;
	private jobs = new Map<string, WebVisionJob>();
	private server: ReturnType<typeof createServer> | null = null;

	constructor(port = 9340) {
		this.port = port;
	}

	start() {
		if (this.server) return;
		this.server = createServer((req, res) => this.handle(req, res));
		this.server.listen(this.port, "127.0.0.1");
	}

	stop() {
		this.server?.close();
		this.server = null;
	}

	private handle(req: any, res: any) {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		const path = url.pathname;
		const send = (code: number, obj: any) => {
			res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(obj));
		};
		const readBody = () => new Promise<string>((resolve) => {
			let raw = "";
			req.on("data", (c: Buffer) => { raw += c; if (raw.length > 40 * 1024 * 1024) req.destroy(); });
			req.on("end", () => resolve(raw));
		});

		(async () => {
			try {
				// DSH 插件提交任务
				if (path === "/submit" && req.method === "POST") {
					const body = JSON.parse(await readBody() || "{}");
					const id = String(body.id || `wv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
					const images = Array.isArray(body.images) ? body.images : body.image ? [{ b64: body.image, mime: body.mime || "image/jpeg" }] : [];
					if (!images.length || !images[0].b64) return send(400, { error: "缺少图片" });
					this.jobs.set(id, {
						id,
						prompt: String(body.prompt || "请用中文描述图片内容"),
						images,
						model: body.model,
						createdAt: Date.now(),
						status: "pending"
					});
					return send(200, { id });
				}
				// Windows 桥接轮询待办
				if (path === "/pending" && req.method === "GET") {
					const pending = [...this.jobs.values()].filter((j) => j.status === "pending");
					const job = pending[0];
					if (job) job.status = "running";
					return send(200, job ? { id: job.id, prompt: job.prompt, images: job.images, model: job.model } : null);
				}
				// Windows 桥接回写结果
				if (path === "/result" && req.method === "POST") {
					const body = JSON.parse(await readBody() || "{}");
					const job = this.jobs.get(String(body.id));
					if (!job) return send(404, { error: "任务不存在" });
					job.status = "done";
					job.result = body.error ? { error: String(body.error).slice(0, 4000) } : { text: String(body.text || "") };
					this.jobs.delete(job.id); // 结果保留在内存一小段时间由 job 端点读取
					this.jobCache.set(job.id, job);
					setTimeout(() => this.jobCache.delete(job.id), 30000);
					return send(200, { ok: true });
				}
				// DSH 插件轮询结果（长轮询）
				if (path.startsWith("/job/") && req.method === "GET") {
					const id = decodeURIComponent(path.slice(5));
					const cached = this.jobCache.get(id);
					const job = cached || this.jobs.get(id);
					if (!job) return send(404, { error: "任务不存在或已过期" });
					return send(200, { status: job.status, result: job.result || null });
				}
				return send(404, { error: "not found" });
			} catch (e: any) {
				send(500, { error: String(e?.message || e).slice(0, 500) });
			}
		})();
	}

	/** 结果短期缓存（job 从主表删除后仍可被 DSH 轮询到） */
	private jobCache = new Map<string, WebVisionJob>();

	/** DSH 插件侧：提交任务并等待结果（轮询，最多 timeoutMs） */
	async recognize(input: { prompt: string; images: { b64: string; mime: string }[]; model?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ text?: string; error?: string }> {
		this.start();
		const id = `wv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const submit = await fetch(`http://127.0.0.1:9340/submit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, ...input })
		});
		if (!submit.ok) return { error: `web 通道提交失败: ${await submit.text()}` };
		const timeoutMs = input.timeoutMs || 240000;
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			if (input.signal?.aborted) return { error: "已取消" };
			await new Promise((r) => setTimeout(r, 2000));
			try {
				const res = await fetch(`http://127.0.0.1:9340/job/${id}`, { signal: AbortSignal.timeout(8000) });
				if (!res.ok) continue;
				const body: any = await res.json();
				if (body.status === "done" && body.result) {
					return body.result.error ? { error: body.result.error } : { text: body.result.text };
				}
			} catch { /* 服务暂不可用，重试 */ }
		}
		return { error: "网页 AI 通道等待回复超时（请确认 Windows 桥接服务在运行且 Chrome 已登录）" };
	}
}

/** 单例（插件进程内共享） */
export const webVisionQueue = new WebVisionQueue(9340);
