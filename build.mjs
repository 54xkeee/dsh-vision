import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "lib");
mkdirSync(outDir, { recursive: true });

// --- Server half: self-contained ESM (schemastery bundled; node builtins kept).
await build({
	entryPoints: [join(root, "src/index.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	external: ["node:fs", "node:path", "node:os", "node:crypto", "node:child_process", "@deepseek-ai/dsh-llm"],
	outfile: join(outDir, "index.js"),
	logLevel: "info"
});

// --- Client half: CJS bundle wrapped into the browser module-loader contract.
const result = await build({
	entryPoints: [join(root, "src/client/entry.ts")],
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2020",
	write: false,
	external: ["react", "react/jsx-runtime"],
	jsx: "automatic",
	logLevel: "info"
});

const raw = result.outputFiles[0].text;
const wrapped = [
	"window.__ModuleLoader__.load({",
	"\tid: \"dsh-vision\",",
	"\tfactory: (require) => {",
	"\t\tvar module = { exports: {} };",
	"\t\tvar exports = module.exports;",
	raw,
	"\t\treturn module.exports;",
	"\t}",
	"});",
	""
].join("\n");
writeFileSync(join(outDir, "client.js"), wrapped);
console.log("client.js written:", (wrapped.length / 1024).toFixed(1), "KiB");
