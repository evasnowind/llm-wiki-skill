import assert from "node:assert/strict";
import test from "node:test";

import { generateIngestSummary, validateIngestSourceBytes } from "./ingest/generator.js";

test("production intake refuses PDF before reading it or calling a model", async () => {
	await assert.rejects(generateIngestSummary({ kbPath: "/fictional/kb", filePath: "/fictional/nonexistent.pdf", purpose: "", model: null }, () => undefined, new AbortController().signal), { code: "PDF_EXTRACTION_REQUIRED" });
});

test("production text validation rejects binary, NUL and whitespace without exposing source bytes", () => {
	for (const bytes of [Buffer.from([0xff, 0xfe, 0]), Buffer.from("secret\0bytes"), Buffer.from(" \n\t")]) {
		assert.throws(() => validateIngestSourceBytes(bytes, ".md"), { code: "SOURCE_TEXT_REQUIRED" });
	}
	validateIngestSourceBytes(Buffer.from("# 中文与 emoji 🧭\n内容"), ".md");
	validateIngestSourceBytes(Buffer.from("<html><p>Evidence</p></html>"), ".html");
});
