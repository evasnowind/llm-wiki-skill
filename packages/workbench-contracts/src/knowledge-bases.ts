import { z } from "zod";
import { EvidenceCitationsSchema, RetrievalModeSchema } from "./evidence.js";

export const KnowledgeBaseInfoSchema = z.object({
	path: z.string(),
	name: z.string(),
	origin: z.enum(["default", "external"]),
	valid: z.boolean(),
	reason: z.string().optional(),
});
export type KnowledgeBaseInfo = z.infer<typeof KnowledgeBaseInfoSchema>;

export const KnowledgeBaseListDataSchema = z.array(KnowledgeBaseInfoSchema);
export type KnowledgeBaseListData = z.infer<typeof KnowledgeBaseListDataSchema>;

/** 管理候选目录（登记、检查、取消登记）的请求字段。 */
export const KnowledgeBasePathBodySchema = z
	.object({
		path: z.string().trim().min(1),
	})
	.strict();
export type KnowledgeBasePathBody = z.infer<typeof KnowledgeBasePathBodySchema>;

/** 在默认根目录创建知识库。空研究方向仍由服务端回退为知识库名称。 */
export const CreateKnowledgeBaseBodySchema = z
	.object({
		name: z.string(),
		purpose: z.string(),
	})
	.strict();
export type CreateKnowledgeBaseBody = z.infer<typeof CreateKnowledgeBaseBodySchema>;

export const CreateKnowledgeBaseDataSchema = z.object({
	info: KnowledgeBaseInfoSchema,
});
export type CreateKnowledgeBaseData = z.infer<typeof CreateKnowledgeBaseDataSchema>;

/** 初始化尚未登记的候选目录，因此保持 `path` 而不是 active context 的 `kbPath`。 */
export const InitExistingKnowledgeBaseBodySchema = z
	.object({
		path: z.string().trim().min(1),
		purpose: z.string(),
		overwrite: z.boolean().optional(),
	})
	.strict();
export type InitExistingKnowledgeBaseBody = z.infer<
	typeof InitExistingKnowledgeBaseBodySchema
>;

export const InitExistingKnowledgeBaseDataSchema = z.object({
	info: KnowledgeBaseInfoSchema,
});
export type InitExistingKnowledgeBaseData = z.infer<
	typeof InitExistingKnowledgeBaseDataSchema
>;

/** 目录选择器取消是成功结果的一种，不应转换成失败请求。 */
export const ChooseDirectoryDataSchema = z.object({
	path: z.string().nullable(),
});
export type ChooseDirectoryData = z.infer<typeof ChooseDirectoryDataSchema>;

/**
 * 后续 pages / graph / conversations / prompt / rebuild 统一复用的知识库上下文输入。
 * JSON body 固定使用 `kbPath`；GET query 固定使用 `kb`，两者不再各自兼容别名。
 */
export const KnowledgeBaseContextBodySchema = z
	.object({
		kbPath: z.string().trim().min(1),
	})
	.strict();
export type KnowledgeBaseContextBody = z.infer<
	typeof KnowledgeBaseContextBodySchema
>;

export const KnowledgeBaseContextQuerySchema = z
	.object({
		kb: z.string().trim().min(1).optional(),
	})
	.strict();
export type KnowledgeBaseContextQuery = z.infer<
	typeof KnowledgeBaseContextQuerySchema
>;

export const RegisterExternalKnowledgeBaseDataSchema = z.object({
	registered: z.boolean(),
	path: z.string(),
	info: KnowledgeBaseInfoSchema,
});
export type RegisterExternalKnowledgeBaseData = z.infer<
	typeof RegisterExternalKnowledgeBaseDataSchema
>;

export const UnregisterExternalKnowledgeBaseDataSchema = z.object({
	removed: z.boolean(),
	path: z.string(),
});
export type UnregisterExternalKnowledgeBaseData = z.infer<
	typeof UnregisterExternalKnowledgeBaseDataSchema
>;

export const InspectKnowledgeBasePathDataSchema = z.object({
	exists: z.boolean(),
	isDirectory: z.boolean(),
	hasWikiSchema: z.boolean(),
	resolvedPath: z.string().optional(),
	ingestibleFiles: z
		.object({
			scanId: z.string(),
			count: z.number().int().nonnegative(),
			samples: z.array(z.string()),
			paths: z.array(z.string()),
			truncated: z.boolean(),
		})
		.optional(),
});
export type InspectKnowledgeBasePathData = z.infer<
	typeof InspectKnowledgeBasePathDataSchema
>;

export const CurrentKnowledgeBaseSchema = z.object({
	path: z.string(),
	name: z.string(),
});
export type CurrentKnowledgeBase = z.infer<typeof CurrentKnowledgeBaseSchema>;

export const UIMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant"]),
	content: z.string(),
	evidence: EvidenceCitationsSchema.optional(),
	retrievalMode: RetrievalModeSchema.optional(),
	tools: z.array(
		z.object({
			name: z.string(),
			status: z.literal("done"),
		}),
	),
});
export type UIMessage = z.infer<typeof UIMessageSchema>;

export const ActiveContextSchema = z.object({
	kb: CurrentKnowledgeBaseSchema,
	conversation: z.object({
		id: z.string(),
		isNew: z.boolean().optional(),
		messages: z.array(UIMessageSchema),
	}),
	model: z
		.object({
			provider: z.string(),
			id: z.string(),
		})
		.nullable(),
});
export type ActiveContext = z.infer<typeof ActiveContextSchema>;

export const ActiveKnowledgeBaseDataSchema = z.object({
	active: ActiveContextSchema.nullable(),
});
export type ActiveKnowledgeBaseData = z.infer<
	typeof ActiveKnowledgeBaseDataSchema
>;
