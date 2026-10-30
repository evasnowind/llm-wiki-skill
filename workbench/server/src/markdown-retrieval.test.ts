import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseMarkdownDocument } from "./markdown-retrieval.js";
import { searchKnowledgeBase, buildKnowledgeContextMessage } from "./retrieval.js";

test("Markdown headings preserve physical lines, duplicates, setext and fenced code", () => {
	const text = ["---", "tags: [可靠性]", "---", "# 指南", "", "## 重复", "A", "```md", "# 假标题", "```", "## 重复", "B", "Setext", "------", "C"].join("\n");
	const document = parseMarkdownDocument(text, "fallback");
	assert.deepEqual(document.metadata, [" 可靠性 "]);
	assert.equal(document.title, "指南");
	const repeated = document.blocks.filter((block) => block.headingPath.at(-1) === "重复");
	assert.equal(repeated.length, 2);
	assert.equal(repeated[0]?.startLine, 6);
	assert.equal(repeated[1]?.startLine, 11);
	assert.ok(repeated[0]?.text.includes("# 假标题"));
	assert.deepEqual(document.blocks.at(-1)?.headingPath, ["指南", "Setext"]);
	assert.equal(document.blocks.at(-1)?.startLine, 13);
});

const CORPUS: Record<string, string> = {
	"purpose.md": "# 研究目标\n研究个人知识管理。",
	"index.md": "# 索引\n索引不提供报销上限。",
	"wiki/overview.md": "# 概述\n生成概述认为报销上限是九千元。",
	"wiki/topics/reliability.md": [
		"---", "tags: [故障恢复, durable-import]", "aliases:", "  - 可靠入库", "  - Resilience Manual", "---", "# 入库指南", "欢迎阅读。", "## 入队", "任务先写入持久队列。", "## 恢复", "进程重启后扫描未完成任务并恢复。", "### 重试", "指数退避从两秒开始，最多重试五次。", "### 取消", "取消会停止后续步骤，保留已保存的原文。", "## 重复", "旧版标记甲。", "## 重复", "新版标记乙。", "## 代码示例", "```md", "# 幻影标题", "[ [这不是双链] ]", "```", "这里展示示例代码，不是产品开关。",
	].join("\n"),
	"wiki/topics/deep.md": `# 深层手册\n${Array.from({ length: 60 }, (_, i) => `背景段落 ${i}：普通说明文字，不含检索答案。\n`).join("\n")}\n## 数据落盘\nquartz-protocol 成功条件是先 fsync 再 rename。`,
	"wiki/topics/setext.md": "Setext Manual\n==============\n简介。\nSatellite Deployment\n--------------------\n卫星部署采用两阶段切换。",
	"wiki/topics/seed.md": "# LinkseedAlpha\n下一步参考 [[wiki/topics/linked.md]]。",
	"wiki/topics/linked.md": "# 关联手册\n一跳目标包含独立的核验清单。\n下一步 [[wiki/topics/second-hop.md]]。",
	"wiki/topics/second-hop.md": "# 二跳\n不能沿第二跳自动扩展。",
	"wiki/topics/bare-seed.md": "# BareseedBravo\n参考 [[unique-ledger]]。",
	"wiki/topics/unique-ledger.md": "# 唯一账本\n账本使用追加日志。",
	"wiki/topics/amb-seed.md": "# AmbseedCharlie\n参考 [[shared]]。",
	"wiki/topics/a/shared.md": "# 共名甲\n甲是不同文档。",
	"wiki/topics/b/shared.md": "# 共名乙\n乙是不同文档。",
	"wiki/topics/code-seed.md": "# CodeseedDelta\n`[[wiki/topics/linked.md]]`\n```md\n[[wiki/topics/unique-ledger.md]]\n```",
	"raw/receipts.md": "---\ntags: [财务原始凭证]\n---\n# 报销规定\n## 住宿\n住宿报销上限为六百元。\n## 餐饮\n餐饮报销上限为八十元。",
	"raw/windows.md": "# CRLF Manual\r\n\r\n## Windows Notes\r\n原文保留两格  空白。\r\n",
	"raw/plain.txt": "plaintext-needle 会议决定星期三发版。\n下一行也保留。",
	"raw/source-seed.md": "# SourceseedEcho\n原始材料参考 [[raw/source-target.md]] 和 [[wiki/topics/linked.md]]。",
	"raw/source-target.md": "# 原始佐证\n供应商承诺七个工作日交付。",
	"raw/alias.md": "---\naliases: [Supply Agreement]\ntag: 供应链\n---\n# 供货原文\n合同承诺采用纸质签名。",
};

interface EvaluationCase {
	name: string;
	query: string;
	expected?: string;
	heading?: string;
	excerpt?: string;
	mode?: "knowledge" | "sources-only";
	includes?: string;
	excludes?: string[];
	maxPages?: number;
	budget?: number;
	explicitRefs?: string[];
	empty?: boolean;
}

// Fixed synthetic questions with annotated owning document/section; no model or user KB is used.
const CASES: EvaluationCase[] = [
	{ name: "deep paragraph", query: "quartz-protocol", expected: "wiki/topics/deep.md", heading: "数据落盘", excerpt: "fsync 再 rename" },
	{ name: "Chinese retry question", query: "失败后如何重试？", expected: "wiki/topics/reliability.md", heading: "重试", excerpt: "最多重试五次" },
	{ name: "Chinese cancellation", query: "取消任务会保留什么", expected: "wiki/topics/reliability.md", heading: "取消", excerpt: "保留已保存的原文" },
	{ name: "Chinese recovery", query: "进程重启后怎么恢复", expected: "wiki/topics/reliability.md", heading: "恢复", excerpt: "扫描未完成任务" },
	{ name: "frontmatter tag", query: "durable-import", expected: "wiki/topics/reliability.md" },
	{ name: "block alias", query: "Resilience Manual", expected: "wiki/topics/reliability.md" },
	{ name: "Chinese alias", query: "可靠入库", expected: "wiki/topics/reliability.md" },
	{ name: "setext heading", query: "Satellite Deployment", expected: "wiki/topics/setext.md", heading: "Satellite Deployment", excerpt: "两阶段切换" },
	{ name: "duplicate heading physical location", query: "新版标记乙", expected: "wiki/topics/reliability.md", heading: "重复", excerpt: "新版标记乙" },
	{ name: "filename lookup", query: "reliability", expected: "wiki/topics/reliability.md" },
	{ name: "exact link one hop", query: "LinkseedAlpha", expected: "wiki/topics/seed.md", includes: "wiki/topics/linked.md", excludes: ["wiki/topics/second-hop.md"] },
	{ name: "unique bare name", query: "BareseedBravo", expected: "wiki/topics/bare-seed.md", includes: "wiki/topics/unique-ledger.md" },
	{ name: "ambiguous bare name", query: "AmbseedCharlie", expected: "wiki/topics/amb-seed.md", excludes: ["wiki/topics/a/shared.md", "wiki/topics/b/shared.md"] },
	{ name: "links in code are inert", query: "CodeseedDelta", expected: "wiki/topics/code-seed.md", excludes: ["wiki/topics/linked.md", "wiki/topics/unique-ledger.md"] },
	{ name: "raw exact amount", query: "住宿报销上限", mode: "sources-only", expected: "raw/receipts.md", heading: "住宿", excerpt: "六百元" },
	{ name: "raw second section", query: "餐饮报销", mode: "sources-only", expected: "raw/receipts.md", heading: "餐饮", excerpt: "八十元" },
	{ name: "raw CRLF lines", query: "Windows Notes", mode: "sources-only", expected: "raw/windows.md", heading: "Windows Notes", excerpt: "两格  空白" },
	{ name: "raw txt", query: "plaintext-needle", mode: "sources-only", expected: "raw/plain.txt", excerpt: "星期三" },
	{ name: "raw inline alias", query: "Supply Agreement", mode: "sources-only", expected: "raw/alias.md", excerpt: "纸质签名" },
	{ name: "raw scalar tag", query: "供应链", mode: "sources-only", expected: "raw/alias.md" },
	{ name: "raw one hop isolation", query: "SourceseedEcho", mode: "sources-only", expected: "raw/source-seed.md", includes: "raw/source-target.md", excludes: ["wiki/topics/linked.md"] },
	{ name: "raw cannot cite generated overview", query: "九千元", mode: "sources-only", empty: true },
	{ name: "unrelated question has no fallback", query: "unfindable-observatory", empty: true },
	{ name: "specific summary has no irrelevant fallback", query: "总结 unfindable-observatory", empty: true },
	{ name: "explicit follows scope", query: "指定页面", explicitRefs: ["wiki/topics/reliability.md"], mode: "sources-only", empty: true },
	{ name: "explicit obeys page limit", query: "指定页面", explicitRefs: ["raw/plain.txt", "wiki/topics/deep.md"], maxPages: 1, expected: "raw/plain.txt" },
	{ name: "explicit obeys quote budget", query: "指定页面", explicitRefs: ["wiki/topics/deep.md", "raw/plain.txt"], budget: 40, expected: "wiki/topics/deep.md" },
];

test("27 annotated Markdown retrieval evaluations", async (t) => {
	const kb = await mkdtemp(path.join(os.tmpdir(), "markdown-retrieval-eval-"));
	t.after(() => rm(kb, { recursive: true, force: true }));
	for (const [relative, content] of Object.entries(CORPUS)) {
		await mkdir(path.dirname(path.join(kb, relative)), { recursive: true });
		await writeFile(path.join(kb, relative), content);
	}
	for (const evaluation of CASES) {
		await t.test(evaluation.name, async () => {
			const result = await searchKnowledgeBase(kb, evaluation.query, { assertRegistered: false, mode: evaluation.mode, maxPages: evaluation.maxPages, totalBudgetChars: evaluation.budget, explicitRefs: evaluation.explicitRefs });
			if (evaluation.empty) assert.equal(result.evidence?.length, 0);
			if (evaluation.expected) assert.equal(result.evidence?.[0]?.path, evaluation.expected);
			if (evaluation.heading) assert.equal(result.evidence?.[0]?.headingPath.at(-1), evaluation.heading);
			if (evaluation.excerpt) assert.ok(result.evidence?.[0]?.excerpt.includes(evaluation.excerpt), result.evidence?.[0]?.excerpt);
			if (evaluation.includes) assert.ok(result.evidence?.some((citation) => citation.path === evaluation.includes));
			for (const excluded of evaluation.excludes ?? []) assert.ok(!result.evidence?.some((citation) => citation.path === excluded));
			if (evaluation.mode === "sources-only") assert.ok(result.evidence?.every((citation) => citation.kind === "raw" && citation.path.startsWith("raw/")));
			if (evaluation.budget !== undefined) assert.ok(result.totalSnippetChars <= evaluation.budget);
			if (evaluation.maxPages !== undefined) assert.ok(result.results.length <= evaluation.maxPages);
			const context = buildKnowledgeContextMessage({ kb: { name: "合成评测", path: kb }, search: result });
			for (const citation of result.evidence ?? []) {
				assert.ok(context.includes(citation.excerpt));
				assert.ok(context.includes(`](#evidence-${citation.id})`));
				assert.ok(!citation.excerpt.startsWith("---\ntags:"));
			}
		});
	}
	await t.test("changed content is immediately searchable", async () => {
		await writeFile(path.join(kb, "raw/plain.txt"), "freshness-jade 新内容已经更新。\n");
		const result = await searchKnowledgeBase(kb, "freshness-jade", { mode: "sources-only", assertRegistered: false });
		assert.equal(result.evidence?.[0]?.path, "raw/plain.txt");
		assert.ok(result.evidence?.[0]?.excerpt.includes("新内容已经更新"));
		const old = await searchKnowledgeBase(kb, "plaintext-needle", { mode: "sources-only", assertRegistered: false });
		assert.equal(old.results.length, 0);
	});
});

test("many unreadable sources cannot consume the answer context with unbounded warnings", async () => {
	const kb = await mkdtemp(path.join(os.tmpdir(), "wiki-retrieval-warnings-"));
	try {
		await mkdir(path.join(kb, "raw"));
		await Promise.all(Array.from({ length: 12 }, (_, index) =>
			writeFile(path.join(kb, "raw", `invalid-${index}.md`), Buffer.from([0xff, 0xfe]))));
		const result = await searchKnowledgeBase(kb, "missing", { mode: "sources-only", assertRegistered: false });
		assert.equal(result.results.length, 0);
		assert.equal(result.warnings?.length, 11);
		assert.match(result.warnings?.at(-1) ?? "", /另有 2 项读取限制/);
		assert.ok((result.warnings ?? []).every((warning) => warning.length <= 512));
	} finally {
		await rm(kb, { recursive: true, force: true });
	}
});
