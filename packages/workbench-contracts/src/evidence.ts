import { z } from "zod";

export const RetrievalModeSchema = z.enum(["knowledge", "sources-only"]);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

/** Knowledge-base relative, visible Markdown/text files only. */
export const EvidencePathSchema = z.string().min(1).max(1024).refine((path) => {
	if (path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path) || path.startsWith("/")) return false;
	if (path.split("/").some((part) => !part || part.startsWith(".") || part.includes(":"))) return false;
	return /^(?:wiki\/.+\.md|raw\/.+\.(?:md|txt)|purpose\.md|index\.md)$/u.test(path);
}, "Invalid evidence path");

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const EvidenceLocationSchema = z.object({
	kind: z.enum(["wiki", "raw"]),
	path: EvidencePathSchema,
});

export const EvidenceCitationSchema = EvidenceLocationSchema.extend({
	id: z.string().regex(/^E[1-9]\d{0,3}$/u),
	title: z.string().min(1).max(512),
	headingPath: z.array(z.string().max(512)).max(32),
	startLine: z.number().int().min(1).max(10_000_000),
	endLine: z.number().int().min(1).max(10_000_000),
	fileHash: Sha256Schema,
	excerptHash: Sha256Schema,
	excerpt: z.string().min(1).max(64_000),
}).strict().superRefine((value, ctx) => {
	if (value.endLine < value.startLine || value.endLine - value.startLine > 2000) {
		ctx.addIssue({ code: "custom", path: ["endLine"], message: "Invalid evidence line range" });
	}
	if ((value.kind === "raw") !== value.path.startsWith("raw/")) {
		ctx.addIssue({ code: "custom", path: ["path"], message: "Evidence kind and path differ" });
	}
});
export type EvidenceCitation = z.infer<typeof EvidenceCitationSchema>;
export const EvidenceCitationsSchema = z.array(EvidenceCitationSchema).max(50).refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Evidence ids must be unique");

export const EvidenceReadRequestBodySchema = z.object({
	kbPath: z.string().trim().min(1).max(4096),
	citation: EvidenceCitationSchema,
}).strict();
export type EvidenceReadRequestBody = z.infer<typeof EvidenceReadRequestBodySchema>;

export const EvidenceReadResultSchema = EvidenceLocationSchema.extend({
	content: z.string().max(2_000_000),
	locationStatus: z.enum(["exact", "relocated", "changed"]),
	startLine: z.number().int().positive().max(10_000_000).nullable(),
	endLine: z.number().int().positive().max(10_000_000).nullable(),
	fileHash: Sha256Schema,
}).strict().superRefine((value, ctx) => {
	if ((value.kind === "raw") !== value.path.startsWith("raw/")) ctx.addIssue({ code: "custom", path: ["path"], message: "Evidence kind and path differ" });
	if (value.locationStatus === "changed") {
		if (value.startLine !== null || value.endLine !== null) ctx.addIssue({ code: "custom", message: "Changed evidence has no location" });
	} else if (value.startLine === null || value.endLine === null || value.endLine < value.startLine || value.endLine - value.startLine > 2000) {
		ctx.addIssue({ code: "custom", message: "Invalid evidence location" });
	}
});
export type EvidenceReadResult = z.infer<typeof EvidenceReadResultSchema>;
