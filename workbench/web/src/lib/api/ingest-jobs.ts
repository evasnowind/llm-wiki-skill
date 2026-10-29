import {
	IngestJobActionBodySchema,
	IngestJobRequestBodySchema,
	IngestJobIdSchema,
	IngestJobSchema,
	IngestJobsResponseSchema,
	type IngestJob,
	type IngestJobRequestBody,
} from "@llm-wiki/workbench-contracts";

import { request } from "./client";

export async function listIngestJobs(kbPath: string, signal?: AbortSignal): Promise<IngestJob[]> {
	const data = await request({ method: "GET", path: "/api/knowledge-bases/ingest-jobs" }, {
		query: { kb: kbPath },
		responseSchema: IngestJobsResponseSchema,
		signal,
	});
	return data.jobs;
}

export async function createIngestJob(input: IngestJobRequestBody): Promise<IngestJob> {
	return request({ method: "POST", path: "/api/knowledge-bases/ingest-jobs" }, {
		body: IngestJobRequestBodySchema.parse(input),
		responseSchema: IngestJobSchema,
	});
}

export async function cancelIngestJob(kbPath: string, id: string): Promise<IngestJob> {
	return request({ method: "POST", path: "/api/knowledge-bases/ingest-jobs/:id/cancel" }, {
		pathParams: { id: IngestJobIdSchema.parse(id) },
		body: IngestJobActionBodySchema.parse({ kbPath }),
		responseSchema: IngestJobSchema,
	});
}

export async function retryIngestJob(kbPath: string, id: string): Promise<IngestJob> {
	return request({ method: "POST", path: "/api/knowledge-bases/ingest-jobs/:id/retry" }, {
		pathParams: { id: IngestJobIdSchema.parse(id) },
		body: IngestJobActionBodySchema.parse({ kbPath }),
		responseSchema: IngestJobSchema,
	});
}
