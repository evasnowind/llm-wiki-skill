import path from "node:path";

import { Hono } from "hono";

import {
	IngestJobActionBodySchema, IngestJobIdSchema, IngestJobRequestBodySchema,
	IngestJobSchema, IngestJobsResponseSchema,
} from "@llm-wiki/workbench-contracts";

import { APP_DIR } from "../config.js";
import { generateIngestSummary } from "../ingest/generator.js";
import { generateSourceRevision, resolveSourceRevisionModelRef } from "../ingest/revision-generator.js";
import type { SourceRevisionsService } from "../ingest/source-revisions.js";
import { resumeGraphWatcher, suspendGraphWatcher } from "../graph.js";
import { mapKnowledgeBaseError, resolveKnowledgeBaseContext } from "../http/knowledge-base-context.js";
import { HttpContractError, parseValidatedBody, parseValidatedInput } from "../http/request.js";
import { jsonOk } from "../http/response.js";
import { assertRegisteredKnowledgeBase, validateInspectedSourceFiles } from "../knowledge-bases.js";
import { createIngestQueue, type IngestQueueService } from "../ingest/queue.js";

export interface IngestJobRouteService extends Omit<IngestQueueService, "sourceRevisions"> {
	sourceRevisions?: SourceRevisionsService;
	assertRegisteredKnowledgeBase(kbPath: string): Promise<string>;
}

function createDefaultQueue(): IngestQueueService {
	return createIngestQueue({
		root: path.join(APP_DIR, "ingest"),
		assertRegisteredKnowledgeBase,
		validateSources: validateInspectedSourceFiles,
		generate: generateIngestSummary,
		generateRevision: generateSourceRevision,
		resolveRevisionModel: resolveSourceRevisionModelRef,
		beforePublish: suspendGraphWatcher,
		afterPublish: (kbPath, trigger) => resumeGraphWatcher(kbPath, { trigger }),
	});
}
let runtimeQueue = createDefaultQueue();
let runtimeClosed = false;
export const defaultIngestJobRouteService: IngestJobRouteService = {
	assertRegisteredKnowledgeBase,
	get sourceRevisions() { return runtimeQueue.sourceRevisions; },
	enqueue: (input) => runtimeQueue.enqueue(input),
	list: (kbPath) => runtimeQueue.list(kbPath),
	cancel: (kbPath, id) => runtimeQueue.cancel(kbPath, id),
	retry: (kbPath, id) => runtimeQueue.retry(kbPath, id),
	recover: async () => {
		if (runtimeClosed) { runtimeQueue = createDefaultQueue(); runtimeClosed = false; }
		await runtimeQueue.recover();
	},
	close: async () => { runtimeClosed = true; await runtimeQueue.close(); },
};

export function createIngestJobRoutes(service: IngestJobRouteService): Hono {
	const router = new Hono();
	const context = (kbPath: string) => resolveKnowledgeBaseContext({ body: { kbPath } }, {
		getActiveKnowledgeBasePath: () => null,
		assertRegisteredKnowledgeBase: service.assertRegisteredKnowledgeBase,
	});

	router.get("/knowledge-bases/ingest-jobs", async (c) => {
		const { kbPath } = parseValidatedInput(IngestJobActionBodySchema, { kbPath: c.req.query("kb") });
		const kb = await context(kbPath);
		try { return jsonOk(c, IngestJobsResponseSchema.parse({ jobs: (await service.list(kb)).map((job) => ({ ...job, kbPath })) })); }
		catch (error) { throw mapIngestError(error); }
	});
	router.post("/knowledge-bases/ingest-jobs", async (c) => {
		const body = await parseValidatedBody(c, IngestJobRequestBodySchema);
		const kbPath = await context(body.kbPath);
		try { return jsonOk(c, IngestJobSchema.parse({ ...await service.enqueue({ ...body, kbPath }), kbPath: body.kbPath })); }
		catch (error) { throw mapIngestError(error); }
	});
	for (const action of ["cancel", "retry"] as const) {
		router.post(`/knowledge-bases/ingest-jobs/:id/${action}`, async (c) => {
			const id = parseValidatedInput(IngestJobIdSchema, c.req.param("id"));
			const body = await parseValidatedBody(c, IngestJobActionBodySchema);
			const kbPath = await context(body.kbPath);
			try { return jsonOk(c, IngestJobSchema.parse({ ...await service[action](kbPath, id), kbPath: body.kbPath })); }
			catch (error) { throw mapIngestError(error); }
		});
	}
	return router;
}

function mapIngestError(error: unknown): HttpContractError {
	if (error instanceof HttpContractError) return error;
	const code = (error as { code?: unknown })?.code;
	if (code === "FORBIDDEN_PATH" || code === "KB_NOT_REGISTERED") return mapKnowledgeBaseError(error);
	if (code === "INVALID_REQUEST") return new HttpContractError("INVALID_REQUEST", error instanceof Error ? error.message : "入库请求无效");
	if (code === "NOT_FOUND") return new HttpContractError("NOT_FOUND", "入库任务不存在");
	if (code === "BUSY") return new HttpContractError("BUSY", "入库任务正在运行或服务正在关闭，请稍后重试");
	if (code === "CONFLICT") return new HttpContractError("CONFLICT", "入库目标发生变化，请检查后重试");
	if (code === "CORRUPT_INGEST_QUEUE") return new HttpContractError("CONFLICT", "入库队列记录损坏，原文件已保留，请先恢复队列记录");
	return new HttpContractError("INTERNAL_ERROR", "入库队列暂时不可用，已有记录已保留");
}
