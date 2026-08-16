// dsh-vision 豆包桥接（Windows 侧运行）
// 轮询 WSL 队列 http://localhost:9340/pending → CDP 控制已登录 Chrome → 豆包发图识图 → 回写结果
import puppeteer from "puppeteer-core";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9333";
const QUEUE = process.env.QUEUE_URL || "http://localhost:9340";
const POLL_MS = 2000;
const REPLY_TIMEOUT_MS = 240000;

let browser = null;

async function connect() {
	if (browser) {
		try {
			await browser.pages();
			return browser;
		} catch {
			browser = null;
		}
	}
	console.log("[bridge] 连接 Chrome CDP:", CDP);
	browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
	console.log("[bridge] CDP 已连接");
	return browser;
}

async function getDoubaoPage() {
	const b = await connect();
	const pages = await b.pages();
	const page = pages.find((p) => p.url().includes("doubao.com/chat"))
		|| pages.find((p) => p.url().includes("doubao.com"));
	if (!page) {
		const fresh = await b.newPage();
		await fresh.goto("https://www.doubao.com/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
		await new Promise((r) => setTimeout(r, 8000));
		return fresh;
	}
	return page;
}

/** 上传图片：找 accept 含图片的隐藏 file input */
async function uploadImage(page, filePath) {
	const inputs = await page.$$('input[type="file"]');
	if (!inputs.length) throw new Error("豆包页面找不到文件上传入口");
	// 优先选 accept 含图片格式的
	let target = null;
	for (const input of inputs) {
		const accept = await input.evaluate((el) => el.accept);
		if (/png|jpg|jpeg|webp/i.test(accept)) { target = input; break; }
	}
	if (!target) target = inputs[0];
	await target.uploadFile(filePath);
	await new Promise((r) => setTimeout(r, 5000));
}

/** 输入文字（Semi Design 的 textarea 需要真实键盘事件） */
async function typePrompt(page, text) {
	const ta = await page.$("textarea");
	if (!ta) throw new Error("豆包输入框未找到（可能未登录）");
	await ta.click();
	await page.keyboard.type(text, { delay: 25 });
	await new Promise((r) => setTimeout(r, 600));
}

/** 最后一条 AI 回复文本：跨消息子元素遍历，取最后一个含文本的 content-* 容器，排除追问建议(suggest/button/a) */
async function lastContentText(page) {
	return await page.evaluate(() => {
		const items = [...document.querySelectorAll('[class*="message-list"] > *')];
		let lastText = "";
		for (const item of items) {
			const contents = [...item.querySelectorAll('[class*="content-"]')];
			for (const c of contents) {
				const clone = c.cloneNode(true);
				clone.querySelectorAll('[class*="suggest"], button, a, [role="button"]').forEach((e) => e.remove());
				const t = (clone.innerText || "").trim();
				if (t) lastText = t;
			}
		}
		return lastText;
	});
}

/**
 * 发送后等待 AI 回复完成。
 * 豆包会把新消息合并进已有容器（不新增子元素），所以按「基线文本变化 + 连续稳定」判断：
 * 回复文本必须不同于发送前的基线，且连续两次轮询相同 = 生成完成。
 */
async function waitReply(page, baseline) {
	const startedAt = Date.now();
	let lastText = "";
	let stableCount = 0;
	while (Date.now() - startedAt < REPLY_TIMEOUT_MS) {
		await new Promise((r) => setTimeout(r, 3000));
		const text = await lastContentText(page);
		if (text && text !== baseline) {
			if (text === lastText) {
				stableCount++;
				if (stableCount >= 2) return text;
			} else {
				stableCount = 0;
			}
		}
		lastText = text;
	}
	throw new Error("等待豆包回复超时");
}

async function handleJob(job) {
	console.log(`[bridge] 处理任务 ${job.id}: ${job.prompt.slice(0, 50)}`);
	const page = await getDoubaoPage();
	await page.bringToFront();
	// 图片写入 Windows 可见临时目录
	const fs = await import("node:fs");
	const path = await import("node:path");
	const stamp = `${job.id}-${job.images.length}`;
	const filePaths = [];
	for (let i = 0; i < job.images.length; i++) {
		const img = job.images[i];
		const ext = img.mime === "image/png" ? ".png" : img.mime === "image/webp" ? ".webp" : ".jpg";
		const p = `C:\\Temp\\doubao-bridge\\img-${stamp}-${i}${ext}`;
		fs.writeFileSync(p, Buffer.from(img.b64, "base64"));
		filePaths.push(p);
	}
	try {
		const baseline = await lastContentText(page);
		for (const p of filePaths) await uploadImage(page, p);
		const question = job.prompt.slice(0, 200);
		await typePrompt(page, question);
		await page.keyboard.press("Enter");
		console.log("[bridge] 已发送，等待豆包回复…");
		const reply = await waitReply(page, baseline);
		console.log(`[bridge] 回复完成 (${reply.length} 字): ${reply.slice(0, 60)}…`);
		await fetch(`${QUEUE}/result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: job.id, text: reply })
		});
	} catch (e) {
		console.log(`[bridge] 任务 ${job.id} 失败: ${String(e?.message || e).slice(0, 200)}`);
		await fetch(`${QUEUE}/result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: job.id, error: String(e?.message || e).slice(0, 1000) })
		});
	} finally {
		for (const p of filePaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
	}
}

async function main() {
	console.log("[bridge] dsh-vision 豆包桥接启动, 队列:", QUEUE);
	for (;;) {
		try {
			const res = await fetch(`${QUEUE}/pending`, { signal: AbortSignal.timeout(8000) });
			if (res.ok) {
				const job = await res.json();
				if (job && job.id) {
					await handleJob(job);
					continue;
				}
			}
		} catch (e) {
			console.log("[bridge] 队列不可达:", String(e?.message || e).slice(0, 80));
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
}

main().catch((e) => {
	console.error("[bridge] 致命错误:", e);
	process.exit(1);
});
