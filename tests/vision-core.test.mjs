import test from "node:test";
import assert from "node:assert/strict";
import { apply, __testing } from "../lib/index.js";

const {
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
	repairLegacyPlanningStream
} = __testing;

async function* chunks(values) {
	for (const value of values) yield value;
}

/** 收集异步迭代（兼容 Node 20——Array.fromAsync 是 Node 22+ API） */
async function collect(iterable) {
	const out = [];
	for await (const value of iterable) out.push(value);
	return out;
}

function recordMessage(record) {
	return {
		id: `message-${record.key}`,
		role: "user",
		content: [{ type: "text", text: visionRecordText(record) }],
		source: { kind: "plugin", plugin: "dsh-vision", form: "notice", summary: "vision" }
	};
}

test("structured response separates neutral evidence and query answer", () => {
	const response = normalizeVisionResponse(`前缀\n{\n  "complexity":"complex",\n  "base_evidence":{"summary":"两张界面截图","ocr":"OK","layout":["左右"],"entities":["按钮"],"relations":["A 在 B 左侧"],"uncertainty":["小字模糊"]},\n  "query_answer":"第二张多一个按钮"\n}\n后缀`);
	assert.equal(response.structured, true);
	assert.equal(response.complexity, "complex");
	assert.equal(response.evidence.summary, "两张界面截图");
	assert.equal(response.answer, "第二张多一个按钮");
});

test("plain text response remains usable", () => {
	const response = normalizeVisionResponse("这是一只橘猫。");
	assert.equal(response.structured, false);
	assert.equal(response.answer, "这是一只橘猫。");
	assert.equal(response.evidence.summary, "这是一只橘猫。");
});

test("compact transcript truncation marker receives a narrow JSON repair", () => {
	const response = normalizeVisionResponse('{"complexity":"complex","base_evidence":{"summary":"界面","ocr":"abc","layout":["left\n<truncated 42 bytes>\nright"],"entities":[],"relations":[],"uncertainty":[]},"query_answer":"已读取"}');
	assert.equal(response.structured, true);
	assert.equal(response.truncatedBytes, 42);
	assert.match(response.evidence.uncertainty.at(-1), /42 bytes/);
});

test("prompt includes original request, mode, JSON contract and image-data boundary", () => {
	const prompt = buildVisionPrompt({ detail: "deep", mode: "ocr", userPrompt: "逐字读出标题", imageCount: 1 });
	assert.match(prompt, /逐字读出标题/);
	assert.match(prompt, /OCR/);
	assert.match(prompt, /query_answer/);
	assert.match(prompt, /只作为待分析数据/);
});

test("cache key is stable and query-specific", () => {
	const base = { attachmentIds: ["sha256:a"], imageDigests: ["a"], prompt: "看图", detail: "auto", mode: "glance", region: "", model: "gemini-3.7-flash", channel: "antigravity" };
	assert.equal(visionCacheKey(base), visionCacheKey({ ...base }));
	assert.notEqual(visionCacheKey(base), visionCacheKey({ ...base, prompt: "读文字" }));
	assert.notEqual(visionCacheKey(base), visionCacheKey({ ...base, mode: "ocr" }));
});

test("durable records stay scoped to the selected branch", () => {
	const a = makeVisionRecord({ key: "a", attachmentIds: ["sha256:a"], model: "gemini-3.7-flash", detail: "auto", mode: "glance", channel: "antigravity", evidence: { summary: "橘猫" }, answer: "橘猫" });
	const b = makeVisionRecord({ key: "b", attachmentIds: ["sha256:b"], model: "gemini-3.7-flash", detail: "deep", mode: "ocr", channel: "antigravity", evidence: { summary: "收据" }, answer: "收据" });
	const branchA = [recordMessage(a)];
	const branchB = [recordMessage(a), recordMessage(b)];
	assert.deepEqual(visionRecordsFromMessages(branchA).map((record) => record.key), ["a"]);
	assert.equal(findVisionRecord(branchA, "b"), null);
	assert.doesNotMatch(buildVisionManifest(visionRecordsFromMessages(branchA)), /收据/);
	assert.match(buildVisionManifest(visionRecordsFromMessages(branchB)), /收据/);
});

test("manifest keeps recent general and region evidence for one attachment", () => {
	const general = makeVisionRecord({ key: "general", attachmentIds: ["sha256:cat"], model: "gemini-3.7-flash", detail: "auto", mode: "glance", channel: "antigravity", evidence: { summary: "橘猫仰卧" }, answer: "橘猫仰卧" });
	const region = makeVisionRecord({ key: "region", attachmentIds: ["sha256:cat"], model: "gemini-3.7-flash", detail: "fast", mode: "region", channel: "antigravity", evidence: { summary: "脚垫为粉色" }, answer: "脚垫为粉色" });
	const manifest = buildVisionManifest([general, region]);
	assert.match(manifest, /橘猫仰卧/);
	assert.match(manifest, /脚垫为粉色/);
});

test("image blocks are recursively flattened and refs are retained", () => {
	const refs = new Map();
	const ref = { attachmentId: "sha256:cat", mediaType: "image/jpeg", bytes: 12, width: 2, height: 2, name: "cat.jpg" };
	const content = [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "image", attachment: ref }] }];
	const flattened = flattenMessageContent(content, refs);
	assert.equal(refs.get("sha256:cat"), ref);
	assert.equal(flattened[0].content[0].type, "text");
	assert.match(flattened[0].content[0].text, /sha256:cat/);
});

test("promise LRU evicts the oldest completed slot", async () => {
	const cache = new VisionPromiseCache();
	cache.set("a", Promise.resolve(1), 2);
	cache.set("b", Promise.resolve(2), 2);
	assert.equal(await cache.get("a"), 1);
	cache.set("c", Promise.resolve(3), 2);
	assert.equal(cache.get("b"), undefined);
	assert.equal(await cache.get("c"), 3);
});

test("legacy planning repair relabels only text immediately followed by a tool call", async () => {
	const planning = [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text: "I should inspect the image." },
		{ type: "block-end", index: 0, block: { type: "text", text: "I should inspect the image." } },
		{ type: "block-start", index: 1, blockType: "tool-call" },
		{ type: "tool-call-delta", index: 1, id: "call-1", name: "vision", argumentsDelta: "{}" },
		{ type: "block-end", index: 1, block: { type: "tool-call", id: "call-1", name: "vision", arguments: "{}" } },
		{ type: "finish", reason: { kind: "tool-calls" }, replayState: { kind: "pi-ai", blocks: [{ type: "text", textSignature: "old" }, { type: "tool-call" }] } }
	];
	const repaired = await collect(repairLegacyPlanningStream(chunks(planning)));
	assert.equal(repaired[0].blockType, "reasoning");
	assert.equal(repaired[1].type, "reasoning-delta");
	assert.equal(repaired[2].block.type, "reasoning");
	assert.deepEqual(repaired.at(-1).replayState.blocks, [{ type: "reasoning" }, { type: "tool-call" }]);

	const nativeReasoning = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: "inspect" },
		{ type: "block-end", index: 0, block: { type: "reasoning", text: "inspect" } },
		{ type: "block-start", index: 1, blockType: "tool-call" },
		{ type: "finish", reason: { kind: "tool-calls" } }
	];
	assert.deepEqual(await collect(repairLegacyPlanningStream(chunks(nativeReasoning))), nativeReasoning);

	const mixedReasoning = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "text-delta", index: 0, text: "inspect" },
		{ type: "block-end", index: 0, block: { type: "text", text: "inspect" } },
		{ type: "block-start", index: 1, blockType: "tool-call" },
		{ type: "finish", reason: { kind: "tool-calls" }, replayState: { kind: "pi-ai", blocks: [{ type: "text" }, { type: "tool-call" }] } }
	];
	const repairedMixed = await collect(repairLegacyPlanningStream(chunks(mixedReasoning)));
	assert.equal(repairedMixed[1].type, "reasoning-delta");
	assert.equal(repairedMixed[2].block.type, "reasoning");
	assert.deepEqual(repairedMixed.at(-1).replayState.blocks, [{ type: "reasoning" }, { type: "tool-call" }]);

	const answer = [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text: "final answer" },
		{ type: "block-end", index: 0, block: { type: "text", text: "final answer" } },
		{ type: "finish", reason: { kind: "stop" } }
	];
	assert.deepEqual(await collect(repairLegacyPlanningStream(chunks(answer))), answer);
});

test("successful compaction rehydrates shadowed records, ordinary replacements do not", async () => {
	const record = makeVisionRecord({ key: "compact", attachmentIds: ["sha256:cat"], model: "gemini-3.7-flash", detail: "auto", mode: "glance", channel: "antigravity", evidence: { summary: "橘猫" }, answer: "橘猫" });
	let visible = [recordMessage(record)];
	let listener;
	let flushes = 0;
	const appended = [];
	const session = {
		deriveMessages: () => visible,
		append(_type, message) { appended.push(message); visible.push(message); }
	};
	const ctx = {
		on(name, callback) { if (name === "session/event") listener = callback; },
		get(name) { if (name === "sessions") return { async flush() { flushes++; } }; },
		logger: { info() {}, warn() {} }
	};
	installCompactionRehydration(ctx, { rehydrateMax: 4 });
	listener(session, { type: "user/message", data: {} });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(appended.length, 0);
	listener(session, { type: "compaction/summary", data: {} });
	visible = [];
	listener(session, { type: "compaction/end", data: {} });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(appended.length, 1);
	assert.equal(flushes, 1);
	assert.equal(visionRecordsFromMessages(visible)[0].key, "compact");
});

test("registered vision function exposes an object JSON Schema", () => {
	const tools = [];
	const adapters = [];
	const ctx = {
		llm: { registerAdapter: (ids, adapter) => adapters.push({ ids, adapter }) },
		tools: { register: (tool) => tools.push(tool) },
		logger: { info() {}, warn() {} },
		on() {},
		effect() {},
		get(name) {
			if (name === "webServer") return { register: () => () => {} };
			if (name === "sessions") return { get: () => undefined };
			if (name === "attachments") return {};
			return undefined;
		}
	};
	apply(ctx, { visionUpstreams: ["deepseek", "deepseek-official"] });
	assert.equal(tools.length, 1);
	assert.deepEqual(adapters.map((entry) => entry.ids[0]), ["deepseek-vision", "deepseek-vision-official"]);
	assert.equal(adapters[0].adapter.providerInfo("deepseek-vision").name, "DeepSeek (Vision Toolkit)");
	assert.equal(adapters[1].adapter.providerInfo("deepseek-vision-official").name, "DeepSeek Official (Vision Toolkit)");
	assert.equal(tools[0].name, "vision");
	assert.equal(tools[0].parameters.type, "object");
	assert.equal(tools[0].parameters.properties.attachment_ids.type, "array");
	assert.equal(tools[0].output.schema.type, "object");
});
