#!/usr/bin/env node
// Re-applies the screenshot fixes documented in
// Desktop/openclaw-screenshot-bug-fixes.md to the globally-installed openclaw
// package. Idempotent: skips patches whose marker is already present.
//
// Usage: node scripts/patch-openclaw.mjs [openclaw-root]
//   default openclaw-root: $(npm root -g)/openclaw

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const explicitRoot = process.argv[2];
const npmGlobal = explicitRoot
	? explicitRoot.replace(/\/openclaw\/?$/, "")
	: execSync("npm root -g", { encoding: "utf8" }).trim();
const openclawDir = join(npmGlobal, "openclaw");
const distDir = join(openclawDir, "dist");

if (!existsSync(distDir)) {
	console.error(`patch-openclaw: openclaw dist not found at ${distDir}`);
	process.exit(1);
}

function findOne(prefix) {
	const matches = readdirSync(distDir).filter(
		(name) => name.startsWith(prefix) && name.endsWith(".js")
	);
	if (matches.length !== 1) {
		throw new Error(
			`expected exactly one ${prefix}*.js in ${distDir}, found ${matches.length}: ${matches.join(", ")}`
		);
	}
	return join(distDir, matches[0]);
}

function applyPatch({ file, label, marker, before, after }) {
	const original = readFileSync(file, "utf8");
	if (original.includes(marker)) {
		console.log(`[${label}] already patched: ${file}`);
		return;
	}
	const occurrences = original.split(before).length - 1;
	if (occurrences === 0) {
		throw new Error(`[${label}] anchor not found in ${file}`);
	}
	if (occurrences > 1) {
		throw new Error(`[${label}] anchor found ${occurrences} times in ${file} (expected 1)`);
	}
	const patched = original.replace(before, after);
	writeFileSync(file, patched);
	console.log(`[${label}] applied to ${file}`);
}

const mcpHttp = findOne("mcp-http-");
const pluginService = findOne("plugin-service-");

// Patch 1: normalizeToolCallContent must preserve image blocks.
// Without this, image content tool results are coerced to {type, text} and
// the MCP SDK rejects them with a Zod invalid_union error.
applyPatch({
	file: mcpHttp,
	label: "mcp-http normalizeToolCallContent",
	marker: 'block.type === "image" && typeof block.data === "string"',
	before:
		'\tif (Array.isArray(content)) return content.map((block) => ({\n' +
		'\t\ttype: block.type ?? "text",\n' +
		'\t\ttext: block.text ?? (typeof block === "string" ? block : JSON.stringify(block))\n' +
		'\t}));',
	after:
		'\tif (Array.isArray(content)) return content.map((block) => {\n' +
		'\t\tif (block && typeof block === "object" && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {\n' +
		'\t\t\treturn { type: "image", data: block.data, mimeType: block.mimeType };\n' +
		'\t\t}\n' +
		'\t\treturn {\n' +
		'\t\t\ttype: block.type ?? "text",\n' +
		'\t\t\ttext: block.text ?? (typeof block === "string" ? block : JSON.stringify(block))\n' +
		'\t\t};\n' +
		'\t});',
});

// Patch 2a: import fs and path so the screenshot action can write savePath.
applyPatch({
	file: pluginService,
	label: "plugin-service fs/path imports",
	marker: 'import fs from "node:fs/promises";',
	before:
		'import crypto from "node:crypto";\n' +
		'import { Type } from "@sinclair/typebox";\n',
	after:
		'import crypto from "node:crypto";\n' +
		'import fs from "node:fs/promises";\n' +
		'import path from "node:path";\n' +
		'import { Type } from "@sinclair/typebox";\n',
});

// Patch 2b: declare savePath in the screenshot action schema.
applyPatch({
	file: pluginService,
	label: "plugin-service savePath schema",
	marker: "savePath: Type.Optional(Type.String())",
	before:
		'\trequest: Type.Optional(BrowserActSchema)\n' +
		'});',
	after:
		'\trequest: Type.Optional(BrowserActSchema),\n' +
		'\tsavePath: Type.Optional(Type.String())\n' +
		'});',
});

// Patch 2c: read savePath param + write the file copy + path-missing guard.
applyPatch({
	file: pluginService,
	label: "plugin-service savePath handler",
	marker: "browser:screenshot error: failed to save to",
	before:
		'\t\t\t\tcase "screenshot": {\n' +
		'\t\t\t\t\tconst targetId = readStringParam(params, "targetId");\n' +
		'\t\t\t\t\tconst fullPage = Boolean(params.fullPage);\n' +
		'\t\t\t\t\tconst ref = readStringParam(params, "ref");\n' +
		'\t\t\t\t\tconst element = readStringParam(params, "element");\n' +
		'\t\t\t\t\tconst type = params.type === "jpeg" ? "jpeg" : "png";\n' +
		'\t\t\t\t\tconst result = proxyRequest ? await proxyRequest({\n',
	after:
		'\t\t\t\tcase "screenshot": {\n' +
		'\t\t\t\t\tconst targetId = readStringParam(params, "targetId");\n' +
		'\t\t\t\t\tconst fullPage = Boolean(params.fullPage);\n' +
		'\t\t\t\t\tconst ref = readStringParam(params, "ref");\n' +
		'\t\t\t\t\tconst element = readStringParam(params, "element");\n' +
		'\t\t\t\t\tconst type = params.type === "jpeg" ? "jpeg" : "png";\n' +
		'\t\t\t\t\tconst savePath = readStringParam(params, "savePath");\n' +
		'\t\t\t\t\tconst result = proxyRequest ? await proxyRequest({\n',
});

applyPatch({
	file: pluginService,
	label: "plugin-service savePath copy block",
	marker: "await fs.copyFile(result.path, savePath)",
	before:
		'\t\t\t\t\t\tprofile\n' +
		'\t\t\t\t\t});\n' +
		'\t\t\t\t\treturn await browserToolDeps.imageResultFromFile({\n' +
		'\t\t\t\t\t\tlabel: "browser:screenshot",\n' +
		'\t\t\t\t\t\tpath: result.path,\n' +
		'\t\t\t\t\t\tdetails: result\n' +
		'\t\t\t\t\t});\n' +
		'\t\t\t\t}\n' +
		'\t\t\t\tcase "navigate":',
	after:
		'\t\t\t\t\t\tprofile\n' +
		'\t\t\t\t\t});\n' +
		'\t\t\t\t\tif (!result.path) return { content: [{ type: "text", text: `browser:screenshot error: server returned no image path (result: ${JSON.stringify(result)})` }] };\n' +
		'\t\t\t\t\tif (savePath) {\n' +
		'\t\t\t\t\t\ttry {\n' +
		'\t\t\t\t\t\t\tawait fs.mkdir(path.dirname(savePath), { recursive: true });\n' +
		'\t\t\t\t\t\t\tawait fs.copyFile(result.path, savePath);\n' +
		'\t\t\t\t\t\t} catch (saveErr) {\n' +
		'\t\t\t\t\t\t\treturn { content: [{ type: "text", text: `browser:screenshot error: failed to save to ${savePath}: ${saveErr?.message ?? String(saveErr)}` }] };\n' +
		'\t\t\t\t\t\t}\n' +
		'\t\t\t\t\t}\n' +
		'\t\t\t\t\treturn await browserToolDeps.imageResultFromFile({\n' +
		'\t\t\t\t\t\tlabel: "browser:screenshot",\n' +
		'\t\t\t\t\t\tpath: result.path,\n' +
		'\t\t\t\t\t\tdetails: result\n' +
		'\t\t\t\t\t});\n' +
		'\t\t\t\t}\n' +
		'\t\t\t\tcase "navigate":',
});

console.log("patch-openclaw: done");
