import {
	PageReadDataSchema,
	PageRefsDataSchema,
	EvidenceReadRequestBodySchema,
	EvidenceReadResultSchema,
	type EvidenceCitation,
	type RetrievalMode,
	type PageRef,
} from "@llm-wiki/workbench-contracts";

import { request } from "./client";

export async function listRefs(
	kbPath: string,
	query: string,
	limit = 20,
	retrievalMode?: RetrievalMode,
): Promise<PageRef[]> {
	return request({ method: "GET", path: "/api/refs" }, {
		responseSchema: PageRefsDataSchema,
		query: { kb: kbPath, q: query, limit, retrievalMode },
	});
}

export async function readEvidence(kbPath: string, citation: EvidenceCitation, signal?: AbortSignal) {
	return request({ method: "POST", path: "/api/evidence/read" }, {
		body: EvidenceReadRequestBodySchema.parse({ kbPath, citation }),
		responseSchema: EvidenceReadResultSchema,
		signal,
	});
}

export async function readPage(
	kbPath: string,
	relPath: string,
): Promise<string> {
	const data = await request({ method: "GET", path: "/api/page" }, {
		responseSchema: PageReadDataSchema,
		query: { kb: kbPath, path: relPath },
	});
	return data.content;
}
