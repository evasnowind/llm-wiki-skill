import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { sanitizeOutput } from "./run-quality-and-tests.mjs";

export const MAX_GITHUB_ANNOTATION_BYTES = 8_000;

function pathPattern(value) {
	return value.replaceAll("\\", "/").split("/").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]+");
}

/** Compilers may print Windows paths with either slash style or URI encoding. */
export function sanitizePlatformOutput(value, { repoRoot, sandbox, home, userHome = homedir() } = {}) {
	let output = stripVTControlCharacters(String(value));
	for (const [root, replacement] of [[repoRoot, "<repo>"], [sandbox, "<sandbox>"], [home, "<home>"], [userHome, "<user-home>"]]) {
		if (typeof root !== "string" || root.length < 2) continue;
		for (const candidate of new Set([root, encodeURI(root.replaceAll("\\", "/"))])) output = output.replace(new RegExp(pathPattern(candidate), "gi"), replacement);
	}
	return sanitizeOutput(output, { repoRoot: repoRoot ?? "<repo>", home: home ?? userHome });
}

function diagnosticExcerpt(output) {
	const lines = output.split("\n");
	const footer = lines.findLastIndex((line) => /^\s*✖ failing tests:/u.test(line));
	const start = Math.max(0, footer);
	const passed = (line) => /^\s*(?:[✔✓]|ok(?:\s+\d|$)|#\s*Subtest:)/u.test(line);
	let firstError = lines.findIndex((line, index) => index >= start && !passed(line)
		&& /\berror TS\d+|\b[A-Za-z]*Error(?:\s*\[[^\]]+\])?:|\bERR_[A-Z_]+|Cannot find module|not recognized|permission denied|\bnpm error\b/iu.test(line));
	if (firstError < 0) firstError = lines.findIndex((line, index) => index >= start && !passed(line) && /^(?:\s*[✖✕]|\s*not ok\s+\d)/u.test(line));
	if (firstError < 0) firstError = lines.findIndex((line, index) => index >= start && !passed(line) && /\bfailed\b/iu.test(line));
	const tailStart = Math.max(start, lines.length - 48);
	if (firstError < 0) return lines.slice(tailStart).join("\n");
	const contextStart = Math.max(start, firstError - 3);
	if (contextStart >= tailStart) return lines.slice(contextStart).join("\n");
	const contextEnd = Math.min(firstError + 24, tailStart);
	return ["[first error]", ...lines.slice(contextStart, contextEnd), "[output tail]", ...lines.slice(tailStart)].join("\n");
}

function escapeData(value) {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** Bounded, single-line workflow command; program output cannot inject another command. */
export function githubErrorAnnotation(title, value, context = {}) {
	const safeTitle = [...stripVTControlCharacters(title)].slice(0, 120).join("");
	const property = escapeData(safeTitle).replaceAll(":", "%3A").replaceAll(",", "%2C");
	const prefix = `::error title=${property}::`;
	const marker = " [diagnostic truncated]";
	const budget = MAX_GITHUB_ANNOTATION_BYTES - Buffer.byteLength(prefix + marker + "\n");
	const excerpt = diagnosticExcerpt(sanitizePlatformOutput(value, context));
	let encoded = "";
	let bytes = 0;
	let truncated = false;
	for (const character of excerpt) {
		const part = escapeData(character);
		const size = Buffer.byteLength(part);
		if (bytes + size > budget) { truncated = true; break; }
		encoded += part;
		bytes += size;
	}
	return prefix + encoded + (truncated ? marker : "") + "\n";
}

export function emitGithubError(title, output, { environment = process.env, write = (value) => process.stdout.write(value), ...context } = {}) {
	if (environment.GITHUB_ACTIONS !== "true") return false;
	write(githubErrorAnnotation(title, output, context));
	return true;
}
