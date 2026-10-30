import type { EvidenceCitation } from "@llm-wiki/workbench-contracts";

export const citation: EvidenceCitation = {
	id: "E1", kind: "raw", path: "raw/guide.md", title: "资料手册", headingPath: ["手册", "支付流程"], startLine: 5, endLine: 5,
	fileHash: "a".repeat(64), excerptHash: "b".repeat(64), excerpt: "原始段落。",
};

export const sourceContent = "# 手册\n\n## 支付流程\n\n原始段落。\n\n另一段。\n";
