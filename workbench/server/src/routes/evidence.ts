import { Hono } from "hono";
import {
	EvidenceReadRequestBodySchema,
	EvidenceReadResultSchema,
	type EvidenceCitation,
	type EvidenceReadResult,
} from "@llm-wiki/workbench-contracts";
import { assertRegisteredKnowledgeBase } from "../knowledge-bases.js";
import { readEvidence } from "../evidence-reader.js";
import { mapKnowledgeBaseError } from "../http/knowledge-base-context.js";
import { HttpContractError, parseValidatedBody } from "../http/request.js";
import { jsonOk } from "../http/response.js";

export interface EvidenceRouteService {
	assertRegisteredKnowledgeBase(kbPath: string): Promise<string>;
	readEvidence(kbPath: string, citation: EvidenceCitation): Promise<EvidenceReadResult>;
}

export const defaultEvidenceRouteService: EvidenceRouteService = {
	assertRegisteredKnowledgeBase,
	readEvidence,
};

export function createEvidenceRoutes(service: EvidenceRouteService): Hono {
	const router = new Hono();
	router.post("/evidence/read", async (c) => {
		const body = await parseValidatedBody(c, EvidenceReadRequestBodySchema);
		let kbPath: string;
		try {
			kbPath = await service.assertRegisteredKnowledgeBase(body.kbPath);
		} catch (error) {
			throw mapKnowledgeBaseError(error);
		}
		try {
			return jsonOk(c, EvidenceReadResultSchema.parse(await service.readEvidence(kbPath, body.citation)));
		} catch (error) {
			const source = error as { code?: unknown; statusCode?: unknown };
			if (source.code === "ENOENT") throw new HttpContractError("NOT_FOUND", "证据文件不存在");
			if (source.code === "FORBIDDEN_PATH" || source.statusCode === 403) throw mapKnowledgeBaseError(error);
			throw new HttpContractError("INTERNAL_ERROR", "无法读取证据文件");
		}
	});
	return router;
}
