import { z } from "zod";

import { ModelRefSchema } from "./config.js";

export const IngestFileStatusSchema = z.enum([
	"pending", "running", "committing", "completed", "failed", "cancelled",
]);
export type IngestFileStatus = z.infer<typeof IngestFileStatusSchema>;

export const IngestFileSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	status: IngestFileStatusSchema,
	attempts: z.number().int().nonnegative(),
	progressChars: z.number().int().nonnegative(),
	outputPath: z.string().min(1).nullable(),
	error: z.string().min(1).nullable(),
}).strict();
export type IngestFile = z.infer<typeof IngestFileSchema>;

export const IngestJobSchema = z.object({
	id: z.string().uuid(),
	kbPath: z.string().min(1),
	revision: z.number().int().nonnegative(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	concurrency: z.union([z.literal(1), z.literal(3), z.literal(5)]),
	status: IngestFileStatusSchema,
	files: z.array(IngestFileSchema).min(1),
}).strict();
export type IngestJob = z.infer<typeof IngestJobSchema>;

export const IngestJobsResponseSchema = z.object({ jobs: z.array(IngestJobSchema) }).strict();
export const IngestJobRequestBodySchema = z.object({
	kbPath: z.string().trim().min(1),
	filePaths: z.array(z.string().min(1)).min(1).max(500),
	concurrency: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
	sourceScanId: z.string().min(1).optional(),
	digestModel: ModelRefSchema.nullable().optional(),
}).strict();
export type IngestJobRequestBody = z.infer<typeof IngestJobRequestBodySchema>;
export const IngestJobActionBodySchema = z.object({ kbPath: z.string().trim().min(1) }).strict();
export const IngestJobIdSchema = z.string().uuid();
