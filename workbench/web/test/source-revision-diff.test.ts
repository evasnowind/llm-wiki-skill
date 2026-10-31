import assert from "node:assert/strict";
import test from "node:test";
import { sourceLineDiff, sourceParallelText } from "../src/lib/source-revision-diff";
test("line review identifies separate inserted and deleted regions without rewriting inputs", () => {
	const before = "标题\r\n保留\r\n旧定义\r\n共同结论\r\n删除尾注";
	const after = "标题\n新增导言\n保留\n新定义\n共同结论\n新增尾注";
	const result = sourceLineDiff(before, after);
	assert.equal(result.mode, "diff");
	if (result.mode !== "diff") return;
	assert.equal(result.added, 3); assert.equal(result.removed, 2);
	assert.deepEqual(result.rows.filter((row) => row.kind === "removed").map((row) => row.text), ["旧定义", "删除尾注"]);
	assert.deepEqual(result.rows.filter((row) => row.kind === "added").map((row) => row.text), ["新增导言", "新定义", "新增尾注"]);
	assert.deepEqual(result.rows.filter((row) => row.beforeLine !== null).map((row) => row.text).join("\r\n"), before);
	assert.deepEqual(result.rows.filter((row) => row.afterLine !== null).map((row) => row.text).join("\n"), after);
});
test("first versions, empty text and display-only CRLF normalization retain precise line identity", () => {
	assert.deepEqual(sourceLineDiff("甲\r\n乙", "甲\n乙"), { mode: "diff", rows: [{ kind: "context", text: "甲", beforeLine: 1, afterLine: 1 }, { kind: "context", text: "乙", beforeLine: 2, afterLine: 2 }], added: 0, removed: 0 });
	const first = sourceLineDiff(null, "新内容");
	assert.equal(first.mode === "diff" && first.added, 1);
	assert.deepEqual(sourceLineDiff("", ""), { mode: "diff", rows: [], added: 0, removed: 0 });
});
test("long single lines and large/high-difference documents fall back before costly comparison", () => {
	assert.deepEqual(sourceLineDiff("x".repeat(5000), "y"), { mode: "parallel", reason: "存在过长单行" });
	assert.equal(sourceLineDiff("a".repeat(120_001), "").mode, "parallel");
	const left = Array.from({ length: 300 }, (_, index) => `旧行 ${index}`).join("\n");
	const right = Array.from({ length: 300 }, (_, index) => `新行 ${index}`).join("\n");
	assert.deepEqual(sourceLineDiff(left, right), { mode: "parallel", reason: "逐行对照超过计算预算" });
	assert.equal(sourceLineDiff(Array(402).fill("x").join("\n"), "y").mode, "parallel");
});

test("fallback bounds rendered text while keeping the full input untouched", () => {
 const original = "原".repeat(120_000);
 const displayed = sourceParallelText(original);
 assert.equal(displayed.truncated, true); assert.equal(displayed.text.length, 60_000);
 assert.equal(original.length, 120_000);
 assert.equal(sourceParallelText(Array(500).fill("行").join("\n")).text.split("\n").length, 400);
});
