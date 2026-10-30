import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isolateTestHome } from "../test/support/isolated-home.js";
import { createBashScriptCommand } from "./platform/bash.js";

test("real init and graph scripts support isolated profiles, Unicode, spaces and literal purpose text", { timeout: 40_000 }, async () => {
	const home = await mkdtemp(path.join(tmpdir(), "wiki platform 中文 spaces-"));
	const restore = isolateTestHome(home);
	const previousPath = process.env.PATH;
	let stopBuilds: (() => Promise<void>) | undefined;
	let unsubscribe = () => {};
	try {
		// Git Bash's common installation must work even when bash.exe is not on PATH.
		if (process.platform === "win32") {
			const shell = createBashScriptCommand("unused.sh", [], { cwd: home, readShellPath: () => undefined }).command;
			const shellDirectory = path.dirname(shell);
			const gitRoot = path.basename(path.dirname(shellDirectory)).toLowerCase() === "usr" ? path.dirname(path.dirname(shellDirectory)) : path.dirname(shellDirectory);
			const hidden = new Set([shellDirectory, path.join(gitRoot, "usr", "bin")].map((directory) => path.resolve(directory).toLowerCase()));
			process.env.PATH = (previousPath ?? "").split(path.delimiter).filter((directory) => !hidden.has(path.resolve(directory).toLowerCase())).join(path.delimiter);
			assert.ok(!process.env.PATH.split(path.delimiter).some((directory) => path.resolve(directory).toLowerCase() === shellDirectory.toLowerCase()));
		}
		const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
		const skill = path.join(home, ".codex", "skills", "llm-wiki");
		await mkdir(path.join(skill, "scripts"), { recursive: true });
		await cp(path.join(repoRoot, "scripts", "init-wiki.sh"), path.join(skill, "scripts", "init-wiki.sh"));
		await cp(path.join(repoRoot, "templates"), path.join(skill, "templates"), { recursive: true });
		const { createWiki, initExistingWiki } = await import("./wiki-init.js");
		const purpose = "中文研究 $HOME '引号' $(touch must-not-exist) ; & 原样 C:\\literal";
		const created = await createWiki("知识库 空格 & $引号'", purpose);
		assert.equal(created.path, path.join(home, "llm-wiki", "知识库 空格 & $引号'"));
		assert.ok((await readFile(path.join(created.path, "index.md"), "utf8")).includes(purpose));
		assert.ok((await readFile(path.join(created.path, ".wiki-schema.md"), "utf8")).includes(created.path));
		assert.ok(created.stdout.includes(created.path));
		assert.doesNotMatch(created.stdout, /wiki-create-/);
		await writeFile(path.join(created.path, "wiki", "entities", "topic.md"), "---\nid: topic\ntype: entity\n---\n# 中文主题\n\n可检索的合成资料。\n");
		const external = path.join(home, "已有目录 & 中文");
		await mkdir(external);
		const initialized = await initExistingWiki(external, purpose);
		assert.equal(initialized.path, external);
		assert.ok((await readFile(path.join(external, "index.md"), "utf8")).includes(purpose));
		await assert.rejects(readFile(path.join(home, "must-not-exist")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		const graph = await import("./graph.js");
		stopBuilds = graph.stopActiveGraphRebuilds;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("graph build did not finish")), 20_000);
			unsubscribe = graph.subscribeGraphEvents((event) => {
				if (event.kbPath !== created.path) return;
				clearTimeout(timer);
				if (event.type === "graph_updated") resolve(); else reject(new Error(event.message));
			});
			graph.triggerGraphRebuild(created.path);
		});
		const data = await graph.readGraphData(created.path);
		assert.equal(data.needsBuild, false);
		if (!data.needsBuild) assert.ok(data.data.nodes.some((node) => node.source_path === "wiki/entities/topic.md"));
	} finally {
		unsubscribe();
		await stopBuilds?.();
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		restore();
		await rm(home, { recursive: true, force: true });
	}
});
