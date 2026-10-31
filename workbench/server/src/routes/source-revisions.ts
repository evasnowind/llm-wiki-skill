import { Hono } from "hono";
import {
	CreateSourceCandidatesBodySchema, SourceCandidateActionBodySchema, SourceCandidateDetailSchema, SourceCandidateSchema,
	SourceCandidatesDataSchema, SourceChangeCheckBodySchema, SourceChangeCheckSchema, SourceHistoryDataSchema,
	SourceRevisionsDataSchema, SourceRevisionIdSchema, SourceVersionDetailSchema,
} from "@llm-wiki/workbench-contracts";
import { mapKnowledgeBaseError, resolveKnowledgeBaseContext } from "../http/knowledge-base-context.js";
import { HttpContractError, parseValidatedBody, parseValidatedInput } from "../http/request.js";
import { jsonOk } from "../http/response.js";
import type { IngestJobRouteService } from "./ingest-jobs.js";

export function createSourceRevisionRoutes(service: IngestJobRouteService): Hono {
	const router = new Hono();
	const context = (kbPath: string) => resolveKnowledgeBaseContext({ body: { kbPath } }, {
		getActiveKnowledgeBasePath: () => null, assertRegisteredKnowledgeBase: service.assertRegisteredKnowledgeBase,
	});
	const revisions = () => {
		if (!service.sourceRevisions) throw new HttpContractError("INTERNAL_ERROR", "素材版本服务暂时不可用");
		return service.sourceRevisions;
	};
	const query = async (c: import("hono").Context) => {
		const kb = c.req.query("kb");
		if (!kb) throw new HttpContractError("INVALID_REQUEST", "缺少知识库上下文");
		return { requested: kb, canonical: await context(kb) };
	};
	router.post("/knowledge-bases/source-revisions/check", async (c) => {
		const body = await parseValidatedBody(c, SourceChangeCheckBodySchema);
		const kb = await context(body.kbPath);
		try { return jsonOk(c, SourceChangeCheckSchema.parse({ ...await revisions().check(kb, body.sourceScanId), kbPath: body.kbPath })); }
		catch (error) { throw mapRevisionError(error); }
	});
	router.get("/knowledge-bases/source-revisions", async (c) => {
		const kb = await query(c);
		try {
			const data = await revisions().list(kb.canonical);
			return jsonOk(c, SourceRevisionsDataSchema.parse({ directories: data.directories.map((item) => ({ ...item, kbPath: kb.requested })), sources: data.sources.map((item) => ({ ...item, kbPath: kb.requested })), candidates: data.candidates.map((item) => ({ ...item, kbPath: kb.requested })) }));
		} catch (error) { throw mapRevisionError(error); }
	});
	router.post("/knowledge-bases/source-revisions/candidates", async (c) => {
		const body = await parseValidatedBody(c, CreateSourceCandidatesBodySchema);
		const kb = await context(body.kbPath);
		try { return jsonOk(c, SourceCandidatesDataSchema.parse({ candidates: (await revisions().create({ ...body, kbPath: kb })).candidates.map((item) => ({ ...item, kbPath: body.kbPath })) })); }
		catch (error) { throw mapRevisionError(error); }
	});
	router.get("/knowledge-bases/source-revisions/candidates/:id/detail", async (c) => {
		const id = parseValidatedInput(SourceRevisionIdSchema, c.req.param("id"));
		const kb = await query(c);
		try { const data = await revisions().detail(kb.canonical, id); return jsonOk(c, SourceCandidateDetailSchema.parse({ ...data, candidate: { ...data.candidate, kbPath: kb.requested } })); }
		catch (error) { throw mapRevisionError(error); }
	});
	for (const action of ["adopt", "cancel", "retry"] as const) router.post(`/knowledge-bases/source-revisions/candidates/:id/${action}`, async (c) => {
		const id = parseValidatedInput(SourceRevisionIdSchema, c.req.param("id"));
		const body = await parseValidatedBody(c, SourceCandidateActionBodySchema);
		const kb = await context(body.kbPath);
		try { return jsonOk(c, SourceCandidateSchema.parse({ ...await revisions()[action](kb, id, body.expectedRevision), kbPath: body.kbPath })); }
		catch (error) { throw mapRevisionError(error); }
	});
	router.get("/knowledge-bases/source-revisions/sources/:sourceId", async (c) => {
		const id = parseValidatedInput(SourceRevisionIdSchema, c.req.param("sourceId"));
		const kb = await query(c);
		try { const data = await revisions().history(kb.canonical, id); return jsonOk(c, SourceHistoryDataSchema.parse({ ...data, source: { ...data.source, kbPath: kb.requested } })); }
		catch (error) { throw mapRevisionError(error); }
	});
	router.get("/knowledge-bases/source-revisions/versions/:versionId", async (c) => {
		const versionId = parseValidatedInput(SourceRevisionIdSchema, c.req.param("versionId"));
		const kb = await query(c);
		try { return jsonOk(c, SourceVersionDetailSchema.parse(await revisions().version(kb.canonical, versionId))); }
		catch (error) { throw mapRevisionError(error); }
	});
	return router;
}
function mapRevisionError(error: unknown): HttpContractError {
	if (error instanceof HttpContractError) return error;
	const code = (error as { code?: unknown })?.code;
	if (code === "FORBIDDEN_PATH" || code === "KB_NOT_REGISTERED") return mapKnowledgeBaseError(error);
	if (code === "INVALID_REQUEST") return new HttpContractError("INVALID_REQUEST", "素材版本请求无效，请重新选择来源或候选");
	if (code === "NOT_FOUND") return new HttpContractError("NOT_FOUND", "素材版本或候选不存在");
	if (code === "BUSY") return new HttpContractError("BUSY", "素材版本服务正在关闭，请稍后重试");
	if (code === "CONFLICT") return new HttpContractError("CONFLICT", "素材来源、版本或正式内容已变化，请刷新并核对后重试");
	return new HttpContractError("INTERNAL_ERROR", "素材版本服务暂时不可用，已有内容已保留");
}
