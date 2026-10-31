import { z } from "zod";
import { ModelRefSchema } from "./config.js";

export const SourceRevisionIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const HashSchema = z.string().min(1);
const TimestampSchema = z.string().datetime();
export const SourceVersionActionSchema = z.enum(["added", "modified", "regenerated"]);
export const SourceCandidateStatusSchema = z.enum(["pending", "generating", "ready", "adopting", "adopted", "failed", "stale", "cancelled"]);
export const SourceDirectoryViewSchema = z.object({
	id: SourceRevisionIdSchema, kbPath: z.string().min(1), path: z.string().min(1), createdAt: TimestampSchema,
}).strict();
export type SourceDirectoryView = z.infer<typeof SourceDirectoryViewSchema>;
export const SourceViewSchema = z.object({
	id: SourceRevisionIdSchema, kbPath: z.string().min(1), directoryId: SourceRevisionIdSchema.nullable(),
	relativePath: z.string().min(1), name: z.string().min(1), currentVersionId: SourceRevisionIdSchema,
	outputPath: z.string().min(1), updatedAt: TimestampSchema,
}).strict();
export type SourceView = z.infer<typeof SourceViewSchema>;
export const SourceVersionSchema = z.object({
	id: SourceRevisionIdSchema, sourceId: SourceRevisionIdSchema, action: SourceVersionActionSchema,
	rawHash: HashSchema, summaryHash: HashSchema, rawPath: z.string().min(1), summaryPath: z.string().min(1),
	model: ModelRefSchema.nullable(), createdAt: TimestampSchema,
}).strict();
export type SourceVersion = z.infer<typeof SourceVersionSchema>;
export const SourceChangeSchema = z.object({
	id: SourceRevisionIdSchema, sourceId: SourceRevisionIdSchema.nullable(), relativePath: z.string().min(1),
	kind: z.enum(["added", "modified", "deleted", "unchanged"]),
	baseVersionId: SourceRevisionIdSchema.nullable(), contentHash: HashSchema.nullable(),
}).strict();
export type SourceChange = z.infer<typeof SourceChangeSchema>;
export const SourceChangeCheckSchema = z.object({
	id: SourceRevisionIdSchema, kbPath: z.string().min(1), directoryId: SourceRevisionIdSchema,
	directoryPath: z.string().min(1), createdAt: TimestampSchema, complete: z.boolean(),
	warnings: z.array(z.string()), changes: z.array(SourceChangeSchema),
}).strict();
export type SourceChangeCheck = z.infer<typeof SourceChangeCheckSchema>;
export const SourceCandidateSchema = z.object({
	id: SourceRevisionIdSchema, kbPath: z.string().min(1), sourceId: SourceRevisionIdSchema.nullable(),
	name: z.string().min(1), kind: SourceVersionActionSchema, status: SourceCandidateStatusSchema,
	revision: z.number().int().nonnegative(), baseVersionId: SourceRevisionIdSchema.nullable(),
	adoptedVersionId: SourceRevisionIdSchema.nullable(), model: ModelRefSchema.nullable(),
	createdAt: TimestampSchema, updatedAt: TimestampSchema, error: z.string().nullable(),
	progressChars: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(),
}).strict();
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>;
export const SourceRevisionsDataSchema = z.object({
	directories: z.array(SourceDirectoryViewSchema), sources: z.array(SourceViewSchema), candidates: z.array(SourceCandidateSchema),
}).strict();
export type SourceRevisionsData = z.infer<typeof SourceRevisionsDataSchema>;
export const SourceRevisionTextSchema = z.object({ text: z.string(), hash: HashSchema }).strict();
export type SourceRevisionText = z.infer<typeof SourceRevisionTextSchema>;
const ComparisonSchema = z.object({ before: SourceRevisionTextSchema.nullable(), after: SourceRevisionTextSchema.nullable() }).strict();
export const SourceCandidateDetailSchema = z.object({
	candidate: SourceCandidateSchema, original: ComparisonSchema, summary: ComparisonSchema, truncated: z.boolean(),
}).strict();
export type SourceCandidateDetail = z.infer<typeof SourceCandidateDetailSchema>;
export const SourceHistoryDataSchema = z.object({ source: SourceViewSchema, versions: z.array(SourceVersionSchema) }).strict();
export type SourceHistoryData = z.infer<typeof SourceHistoryDataSchema>;
export const SourceVersionDetailSchema = z.object({
	version: SourceVersionSchema, original: SourceRevisionTextSchema, summary: SourceRevisionTextSchema, truncated: z.boolean(),
}).strict();
export type SourceVersionDetail = z.infer<typeof SourceVersionDetailSchema>;
export const SourceChangeCheckBodySchema = z.object({ kbPath: z.string().trim().min(1), sourceScanId: z.string().min(1) }).strict();
export type SourceChangeCheckBody = z.infer<typeof SourceChangeCheckBodySchema>;
const CandidateRequestFields = {
	kbPath: z.string().trim().min(1), requestId: z.string().uuid(), digestModel: ModelRefSchema.nullable().optional(),
	feedback: z.string().trim().max(4000).optional(),
};
export const CreateSourceCandidatesBodySchema = z.discriminatedUnion("type", [
	z.object({ ...CandidateRequestFields, type: z.literal("changes"), checkId: SourceRevisionIdSchema, changeIds: z.array(SourceRevisionIdSchema).min(1).max(500) }).strict(),
	z.object({ ...CandidateRequestFields, type: z.literal("regenerate"), target: z.discriminatedUnion("type", [
		z.object({ type: z.literal("source"), sourceId: SourceRevisionIdSchema, baseVersionId: SourceRevisionIdSchema }).strict(),
		z.object({ type: z.literal("ingest-file"), jobId: z.string().uuid(), fileId: SourceRevisionIdSchema }).strict(),
	]) }).strict(),
]);
export type CreateSourceCandidatesBody = z.infer<typeof CreateSourceCandidatesBodySchema>;
export const SourceCandidatesDataSchema = z.object({ candidates: z.array(SourceCandidateSchema) }).strict();
export const SourceCandidateActionBodySchema = z.object({ kbPath: z.string().trim().min(1), expectedRevision: z.number().int().nonnegative() }).strict();
export type SourceCandidateActionBody = z.infer<typeof SourceCandidateActionBodySchema>;
