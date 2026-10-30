import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

import { ENDPOINT_REGISTRY } from "../../packages/workbench-contracts/src/endpoints.ts";

const WEB_FETCH_FILES = new Set([
	"workbench/web/src/lib/api/client.ts",
	"workbench/web/src/lib/api/prompt.ts",
	"workbench/web/src/lib/api/batch-digest.ts",
]);
const WEB_FILE_FETCH_FILES = new Set([
	"workbench/web/src/components/renderers/HtmlRenderer.tsx",
]);
const WEB_RESPONSE_PARSER_FILES = new Set([
	"workbench/web/src/lib/api/client.ts",
	"workbench/web/src/lib/api/prompt.ts",
	"workbench/web/src/lib/api/batch-digest.ts",
]);

async function sourceFiles(directory) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const files = [];
	for (const entry of entries) {
		if (entry.name === "dist" || entry.name === "node_modules") continue;
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(target)));
		else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(target);
	}
	return files;
}

function scriptKind(file) {
	if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

function parseSource(source, file) {
	return ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKind(file),
	);
}

function staticString(expression) {
	const value = expression && unwrapExpression(expression);
	return value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
		? value.text
		: null;
}

function importSpecifiers(source, file) {
	const specifiers = [];
	const visit = (node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier
		) {
			const specifier = staticString(node.moduleSpecifier);
			if (specifier) specifiers.push(specifier);
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			const specifier = staticString(node.arguments[0]);
			if (specifier) specifiers.push(specifier);
		}
		ts.forEachChild(node, visit);
	};
	visit(parseSource(source, file));
	return specifiers;
}

function fetchCalls(source, file) {
	const calls = [];
	const visit = (node) => {
		if (ts.isCallExpression(node)) {
			const isFetch =
				ts.isIdentifier(node.expression) && node.expression.text === "fetch";
			const isMemberFetch =
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "fetch";
			if (!isFetch && !isMemberFetch) {
				ts.forEachChild(node, visit);
				return;
			}
			let method = "GET";
			const init = node.arguments[1] && unwrapExpression(node.arguments[1]);
			if (init && ts.isObjectLiteralExpression(init)) {
				for (const property of init.properties) {
					if (
						ts.isPropertyAssignment(property) &&
						propertyName(property) === "method"
					) {
						method = staticString(property.initializer) ?? method;
					}
				}
			}
			const argument = node.arguments[0] && unwrapExpression(node.arguments[0]);
			const apiPath = staticString(argument);
			calls.push({
				apiPath,
				method,
				argumentIdentifier:
					argument && ts.isIdentifier(argument) ? argument.text : null,
				isDynamicTemplate: Boolean(argument && ts.isTemplateExpression(argument)),
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(parseSource(source, file));
	return calls;
}

function within(target, directory) {
	const relative = path.relative(directory, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWebImport(file, specifier, webRoot) {
	if (specifier.startsWith("@/")) {
		return path.resolve(webRoot, specifier.slice(2));
	}
	return specifier.startsWith(".")
		? path.resolve(path.dirname(file), specifier)
		: null;
}

function propertyName(property) {
	if (!property.name) return null;
	if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
		return property.name.text;
	}
	return null;
}

function unwrapExpression(expression) {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isParenthesizedExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function containsLegacyErrorEnvelope(source, file) {
	const sourceFile = parseSource(source, file);
	let found = false;
	const visit = (node) => {
		if (found) return;
		if (ts.isObjectLiteralExpression(node)) {
			let hasFalseOk = false;
			let hasError = false;
			let hasSpread = false;
			for (const property of node.properties) {
				if (ts.isSpreadAssignment(property)) hasSpread = true;
				const name = propertyName(property);
				if (name === "error") hasError = true;
				if (
					name === "ok" &&
					ts.isPropertyAssignment(property) &&
					unwrapExpression(property.initializer).kind === ts.SyntaxKind.FalseKeyword
				) {
					hasFalseOk = true;
				}
			}
			if (hasFalseOk && (hasError || hasSpread)) {
				found = true;
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

export async function checkWorkbenchBoundaries(
	root,
	{ endpointRegistry = ENDPOINT_REGISTRY } = {},
) {
	const absoluteRoot = path.resolve(root);
	const findings = [];
	const report = (rule, file, message) => {
		findings.push({ rule, file: path.relative(absoluteRoot, file).split(path.sep).join("/"), message });
	};

	const webRoot = path.join(absoluteRoot, "workbench/web/src");
	const webPackageRoot = path.join(absoluteRoot, "workbench/web");
	const serverRoot = path.join(absoluteRoot, "workbench/server");
	const contractsPackageRoot = path.join(
		absoluteRoot,
		"packages/workbench-contracts",
	);
	const webFiles = await sourceFiles(webPackageRoot);
	const webSourceFiles = webFiles.filter((file) => within(file, webRoot));
	const legacyFacadeFile = path.join(webRoot, "lib/api.ts");
	if (webSourceFiles.includes(legacyFacadeFile)) {
		report(
			"web-legacy-api-facade",
			legacyFacadeFile,
			"the removed API compatibility facade cannot be reintroduced",
		);
	}
	for (const file of webSourceFiles) {
		const relative = path.relative(absoluteRoot, file).split(path.sep).join("/");
		const source = await readFile(file, "utf8");
		const calls = fetchCalls(source, file);
		const hasForbiddenFetch = WEB_FETCH_FILES.has(relative)
			? false
			: WEB_FILE_FETCH_FILES.has(relative)
				? calls.some((call) => call.argumentIdentifier !== "fileUrl")
				: calls.length > 0;
		if (hasForbiddenFetch) {
			report("web-direct-api-fetch", file, "direct /api fetch is restricted to low-level clients and SSE starters");
		}
		if (
			relative.startsWith("workbench/web/src/lib/api/") &&
			!WEB_RESPONSE_PARSER_FILES.has(relative) &&
			/\.\s*json\s*\(/.test(source)
		) {
			report("web-legacy-response-parser", file, "migrated API modules cannot parse legacy items/error responses");
		}
	}

	for (const file of webFiles) {
		const source = await readFile(file, "utf8");
		for (const specifier of importSpecifiers(source, file)) {
			const resolved = resolveWebImport(file, specifier, webRoot);
			if (
				specifier.includes("workbench/server") ||
				specifier.includes("@llm-wiki-agent/server") ||
				(resolved && within(resolved, serverRoot))
			) {
				report("web-server-internals-import", file, `web cannot import server internals: ${specifier}`);
			}
		}
	}
	const routesRoot = path.join(absoluteRoot, "workbench/server/src/routes");
	for (const file of await sourceFiles(routesRoot)) {
		const source = await readFile(file, "utf8");
		if (containsLegacyErrorEnvelope(source, file)) {
			report("server-route-legacy-error-envelope", file, "route modules must use code/message/details failure envelopes");
		}
	}

	const serverFiles = await sourceFiles(serverRoot);
	for (const file of [...webFiles, ...serverFiles]) {
		const source = await readFile(file, "utf8");
		for (const specifier of importSpecifiers(source, file)) {
			const resolved = specifier.startsWith(".")
				? path.resolve(path.dirname(file), specifier)
				: null;
			if (
				specifier.startsWith("@llm-wiki/workbench-contracts/") ||
				specifier.includes("workbench-contracts/src") ||
				(resolved && within(resolved, contractsPackageRoot))
			) {
				report("contracts-root-entrypoint-only", file, `contracts must be imported from the package root: ${specifier}`);
			}
		}
	}

	const contractsRoot = path.join(contractsPackageRoot, "src");
	for (const file of await sourceFiles(contractsRoot)) {
		const source = await readFile(file, "utf8");
		for (const specifier of importSpecifiers(source, file)) {
			if (specifier === "zod") continue;
			const resolved = specifier.startsWith(".")
				? path.resolve(path.dirname(file), specifier)
				: null;
			if (!resolved || !within(resolved, contractsRoot)) {
				report("contracts-forbidden-import", file, `contracts may only import zod or local contract modules: ${specifier}`);
			}
		}
	}
	const contractsPackageFile = path.join(
		absoluteRoot,
		"packages/workbench-contracts/package.json",
	);
	try {
		const packageJson = JSON.parse(await readFile(contractsPackageFile, "utf8"));
		const exportKeys = Object.keys(packageJson.exports ?? {});
		if (exportKeys.length !== 1 || exportKeys[0] !== ".") {
			report(
				"contracts-package-root-export-only",
				contractsPackageFile,
				"contracts package may only expose its root entrypoint",
			);
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}

	return findings.sort((a, b) =>
		`${a.file}:${a.rule}`.localeCompare(`${b.file}:${b.rule}`),
	);
}

async function main() {
	const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
	const findings = await checkWorkbenchBoundaries(root);
	if (findings.length === 0) {
		console.log("Workbench boundary check passed.");
		return;
	}
	for (const finding of findings) {
		console.error(`${finding.file}: ${finding.rule}: ${finding.message}`);
	}
	process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
