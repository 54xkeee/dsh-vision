import { useRef, useState } from "react";

/** 会话头部识图面板：支持多图、粘贴、档位与任务模式。 */
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_IMAGES = 8;

const btnStyle = {
	position: "relative",
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	minHeight: 28,
	padding: "3px 10px",
	border: "0",
	borderRadius: 6,
	background: "var(--dsw-alias-bg-base)",
	color: "var(--dsw-alias-label-tertiary)",
	fontSize: 12,
	lineHeight: "18px",
	cursor: "pointer",
	fontFamily: "var(--dsw-font-mono)"
};
const panelStyle = {
	position: "fixed",
	top: 52,
	right: 16,
	zIndex: 1000,
	width: 420,
	maxWidth: "calc(100vw - 32px)",
	maxHeight: "calc(100vh - 68px)",
	overflowY: "auto",
	boxSizing: "border-box",
	padding: "12px",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: 12,
	background: "var(--dsw-specific-menu)",
	boxShadow: "var(--dsw-shadow-lv3)",
	fontSize: 13,
	lineHeight: "20px",
	color: "var(--dsw-alias-label-primary)",
	textAlign: "left"
};
const inputStyle = {
	width: "100%",
	boxSizing: "border-box",
	padding: "6px 8px",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: 8,
	background: "var(--dsw-alias-bg-base)",
	color: "var(--dsw-alias-label-primary)",
	fontSize: 12,
	lineHeight: "18px",
	fontFamily: "var(--dsw-font-sans)"
};
const rowStyle = { display: "flex", gap: 8, alignItems: "center", marginTop: 8 };
const labelStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, flex: "none" };
const resultStyle = {
	marginTop: 8,
	padding: "8px 10px",
	borderRadius: 8,
	background: "var(--dsw-alias-bg-base)",
	border: "1px solid var(--dsw-alias-border-l2)",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	maxHeight: 260,
	overflowY: "auto",
	fontSize: 12,
	lineHeight: "18px"
};
const errStyle = { ...resultStyle, color: "var(--dsw-alias-state-danger)" };

function readImage(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error || new Error("read error"));
		reader.onload = () => {
			const dataUrl = String(reader.result);
			resolve({
				dataUrl,
				b64: dataUrl.split(",")[1],
				mime: file.type || "image/jpeg",
				name: file.name || "paste"
			});
		};
		reader.readAsDataURL(file);
	});
}

function VisionPanel({ t }) {
	const rootRef = useRef(null);
	const fileRef = useRef(null);
	const [images, setImages] = useState([]);
	const [prompt, setPrompt] = useState(t("defaultPrompt"));
	const [channel, setChannel] = useState("auto");
	const [detail, setDetail] = useState("auto");
	const [mode, setMode] = useState("glance");
	const [region, setRegion] = useState("");
	const [busy, setBusy] = useState(false);
	const [text, setText] = useState("");
	const [error, setError] = useState("");

	const onFiles = async (files) => {
		const selected = Array.from(files || []).filter(Boolean);
		if (!selected.length) return;
		if (images.length + selected.length > MAX_IMAGES) { setError(t("tooMany")); return; }
		if (selected.some((file) => file.size > MAX_IMAGE)) { setError(t("tooLarge")); return; }
		try {
			const added = await Promise.all(selected.map(readImage));
			setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
			setError("");
			setText("");
		} catch (cause) {
			setError(String(cause?.message || cause));
		}
	};

	const run = async () => {
		if (!images.length) { setError(t("noImage")); return; }
		if (mode === "compare" && images.length < 2) { setError(t("compareNeedsTwo")); return; }
		if (mode === "region" && !region.trim()) { setError(t("regionNeeded")); return; }
		setBusy(true);
		setError("");
		setText("");
		try {
			const res = await fetch("/api/vision", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					images: images.map(({ b64, mime, name }) => ({ image: b64, mime, name })),
					prompt,
					channel,
					detail,
					mode,
					region
				})
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			setText(body.text);
		} catch (cause) {
			setError(String(cause?.message || cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={panelStyle} ref={rootRef} onPaste={(event) => {
			const files = Array.from(event.clipboardData?.items || [])
				.filter((item) => item.type.startsWith("image/"))
				.map((item) => item.getAsFile())
				.filter(Boolean);
			if (files.length) { event.preventDefault(); onFiles(files); }
		}}>
			<input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
				onChange={(event) => { onFiles(event.target.files); event.target.value = ""; }} />
			<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
				<button type="button" style={{ ...btnStyle, minHeight: 30 }} onClick={() => fileRef.current?.click()}>
					{t("pickImage")}
				</button>
				<span style={labelStyle}>{t("imageCount").replace("{count}", String(images.length))}</span>
				{images.length ? <button type="button" style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => setImages([])}>{t("clearImages")}</button> : null}
			</div>
			{images.length ? (
				<div style={{ display: "flex", gap: 6, marginTop: 8, overflowX: "auto", paddingBottom: 2 }}>
					{images.map((image, index) => (
						<div key={`${image.name}-${index}`} style={{ position: "relative", flex: "none" }}>
							<img src={image.dataUrl} alt={image.name} title={image.name} style={{ height: 56, width: 72, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", objectFit: "cover" }} />
							<button type="button" aria-label={t("removeImage")} onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
								style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, padding: 0, border: 0, borderRadius: 9, background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", cursor: "pointer" }}>×</button>
						</div>
					))}
				</div>
			) : <div style={{ ...rowStyle, marginTop: 6 }}><span style={labelStyle}>{t("hintPaste")}</span></div>}
			<textarea rows={2} style={{ ...inputStyle, marginTop: 8 }} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
			<div style={rowStyle}><span style={labelStyle}>{t("model")}: gemini-3.7-flash</span></div>
			<div style={rowStyle}>
				<span style={labelStyle}>{t("mode")}</span>
				<select style={{ ...inputStyle, width: 170 }} value={mode} onChange={(event) => setMode(event.target.value)}>
					<option value="glance">{t("modeGlance")}</option>
					<option value="ocr">{t("modeOcr")}</option>
					<option value="region">{t("modeRegion")}</option>
					<option value="compare">{t("modeCompare")}</option>
				</select>
				<span style={labelStyle}>{t("detail")}</span>
				<select style={{ ...inputStyle, width: 145 }} value={detail} onChange={(event) => setDetail(event.target.value)}>
					<option value="auto">{t("detailAuto")}</option>
					<option value="fast">{t("detailFast")}</option>
					<option value="standard">{t("detailStandard")}</option>
					<option value="deep">{t("detailDeep")}</option>
				</select>
			</div>
			{mode === "region" ? <input style={{ ...inputStyle, marginTop: 8 }} value={region} placeholder={t("regionPlaceholder")} onChange={(event) => setRegion(event.target.value)} /> : null}
			<div style={rowStyle}>
				<span style={labelStyle}>{t("channel")}</span>
				<select style={{ ...inputStyle, width: 170 }} value={channel} onChange={(event) => setChannel(event.target.value)}>
					<option value="auto">{t("chAuto")}</option>
					<option value="web">{t("chWeb")}</option>
					<option value="antigravity">{t("chAntigravity")}</option>
					<option value="cockpit">{t("chCockpit")}</option>
					<option value="genlang">{t("chGenlang")}</option>
					<option value="aicode">{t("chAicode")}</option>
				</select>
				<button type="button" disabled={busy || !images.length} style={{ ...btnStyle, minHeight: 30, marginLeft: "auto", background: "var(--dsw-alias-state-primary)", color: "#fff" }} onClick={run}>
					{busy ? t("running") : t("run")}
				</button>
			</div>
			{error ? <div style={errStyle}>{error}</div> : null}
			{text ? <div><div style={resultStyle}>{text}</div><button type="button" style={{ ...btnStyle, marginTop: 6 }} onClick={() => navigator.clipboard?.writeText(text)}>{t("copy")}</button></div> : null}
		</div>
	);
}

const zh = {
	"button": "识图",
	"buttonAria": "Gemini 识图",
	"pickImage": "添加图片",
	"clearImages": "清空",
	"removeImage": "移除图片",
	"imageCount": "已选 {count}/8",
	"hintPaste": "选择图片，或直接 Ctrl+V 粘贴截图",
	"defaultPrompt": "请用中文详细描述图片内容。",
	"model": "模型",
	"mode": "任务",
	"modeGlance": "通用识图",
	"modeOcr": "OCR 文字",
	"modeRegion": "区域细查",
	"modeCompare": "多图对比",
	"regionPlaceholder": "区域：如 0.1,0.2,0.8,0.9 或‘右上角’",
	"detail": "档位",
	"detailAuto": "自动",
	"detailFast": "快速",
	"detailStandard": "标准",
	"detailDeep": "深度",
	"channel": "通道",
	"chAuto": "自动",
	"chWeb": "豆包 Web (免 key)",
	"chAntigravity": "反重力额度 (agentapi)",
	"chCockpit": "Cockpit 反代",
	"chGenlang": "Gemini API key",
	"chAicode": "Antigravity 直连",
	"run": "识别",
	"running": "识别中…",
	"copy": "复制结果",
	"noImage": "请先添加或粘贴图片",
	"tooLarge": "单张图片超过 8MB，请压缩后再试",
	"tooMany": "一次最多选择 8 张图片",
	"compareNeedsTwo": "多图对比至少选择 2 张图片",
	"regionNeeded": "区域细查需要填写区域",
	"error": "识别失败"
};

const en = {
	"button": "Vision",
	"buttonAria": "Gemini vision",
	"pickImage": "Add images",
	"clearImages": "Clear",
	"removeImage": "Remove image",
	"imageCount": "Selected {count}/8",
	"hintPaste": "Pick images or press Ctrl+V to paste screenshots",
	"defaultPrompt": "Describe the image content in detail.",
	"model": "Model",
	"mode": "Task",
	"modeGlance": "General vision",
	"modeOcr": "OCR text",
	"modeRegion": "Inspect region",
	"modeCompare": "Compare images",
	"regionPlaceholder": "Region: 0.1,0.2,0.8,0.9 or 'top right'",
	"detail": "Detail",
	"detailAuto": "Auto",
	"detailFast": "Fast",
	"detailStandard": "Standard",
	"detailDeep": "Deep",
	"channel": "Channel",
	"chAuto": "Auto",
	"chWeb": "Doubao Web (no key)",
	"chAntigravity": "Antigravity quota (agentapi)",
	"chCockpit": "Cockpit proxy",
	"chGenlang": "Gemini API key",
	"chAicode": "Antigravity direct",
	"run": "Run",
	"running": "Running…",
	"copy": "Copy",
	"noImage": "Add or paste an image first",
	"tooLarge": "An image exceeds 8MB",
	"tooMany": "Select up to 8 images",
	"compareNeedsTwo": "Comparison needs at least 2 images",
	"regionNeeded": "Region inspection needs a region",
	"error": "Recognition failed"
};

export const inject = ["slots", "locale"];

export function apply(ctx) {
	ctx.effect(() => ctx.locale.register("vision", { zh, en }), "dsh-vision: dictionaries");
	ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
		name: "conversation.session.header.actions",
		id: "dsh-vision",
		order: 20,
		locale: "vision"
	}, (props) => {
		const { t } = props;
		const [open, setOpen] = useState(false);
		const rootRef = useRef(null);
		return (
			<div style={{ position: "relative", display: "inline-flex" }} ref={rootRef}>
				<button type="button" style={btnStyle}
					onMouseEnter={(event) => { event.currentTarget.style.color = "var(--dsw-alias-label-secondary)"; }}
					onMouseLeave={(event) => { if (!open) event.currentTarget.style.color = ""; }}
					onClick={() => setOpen((value) => !value)} aria-expanded={open} title={t("buttonAria")}>
					{t("button")}
				</button>
					{open ? <><div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setOpen(false)} /><VisionPanel t={t} /></> : null}
			</div>
		);
	}));
}
