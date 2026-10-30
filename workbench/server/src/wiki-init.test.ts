import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	initExistingWiki,
	initScriptCandidates,
	KnowledgeBaseSetupInputError,
	validateWikiName,
} from "./wiki-init.js";

test("initScriptCandidates supports Codex and Claude skill install locations", () => {
	const home = path.join("/", "Users", "example");
	assert.deepEqual(initScriptCandidates(home), [
		path.join(home, ".codex", "skills", "llm-wiki", "init-wiki.sh"),
		path.join(home, ".codex", "skills", "llm-wiki", "scripts", "init-wiki.sh"),
		path.join(home, ".codex", "skills", "llm-wiki-skill", "init-wiki.sh"),
		path.join(home, ".codex", "skills", "llm-wiki-skill", "scripts", "init-wiki.sh"),
		path.join(home, ".claude", "skills", "llm-wiki-skill", "init-wiki.sh"),
		path.join(home, ".claude", "skills", "llm-wiki-skill", "scripts", "init-wiki.sh"),
		path.join(home, ".claude", "skills", "llm-wiki", "init-wiki.sh"),
		path.join(home, ".claude", "skills", "llm-wiki", "scripts", "init-wiki.sh"),
	]);
});

test("创建和初始化的可恢复输入错误带稳定标记，且不回显目标路径", async () => {
	assert.throws(
		() => validateWikiName("../escape"),
		(err) => err instanceof KnowledgeBaseSetupInputError,
	);

	const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-init-input-"));
	const missing = path.join(root, "missing");
	try {
		await assert.rejects(
			() => initExistingWiki(missing, "topic"),
			(err) =>
				err instanceof KnowledgeBaseSetupInputError &&
				err.message === "请选择一个存在的文件夹" &&
				!err.message.includes(missing),
		);

		const emptyPurpose = path.join(root, "empty-purpose");
		await mkdir(emptyPurpose);
		await assert.rejects(
			() => initExistingWiki(emptyPurpose, " "),
			(err) =>
				err instanceof KnowledgeBaseSetupInputError &&
				err.message === "研究方向不能为空",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("默认知识库名拒绝点号开头的目录", () => {
	assert.throws(
		() => validateWikiName(".draft"),
		(err) =>
			err instanceof KnowledgeBaseSetupInputError &&
			err.message === "知识库名不能以 . 开头",
	);
});

test("knowledge base names reject Windows reserved devices and unsupported final directory names", () => {
	for (const name of ["CON", "con.txt", "PRN", "AUX.backup", "NUL", "COM1", "COM9.md", "LPT1", "LPT9.txt", "COM¹", "COM².md", "COM³", "LPT¹", "LPT².log", "LPT³", "CON .txt", "bad:name", "bad?name", 'bad"name', "bad<name", "bad>name", "bad|name", "bad*name", "bad\u0000name", "bad\u001fname", "notes.", "notes.  "]) {
		assert.throws(() => validateWikiName(name), (error) => error instanceof KnowledgeBaseSetupInputError, JSON.stringify(name));
	}
	for (const name of ["中文 研究", "notes.name", "COM0", "COM10", "LPT0", "LPT10", " my notes "]) {
		assert.equal(validateWikiName(name), name.trim());
	}
});
