import {
	CreateSourceCandidatesBodySchema, SourceCandidateActionBodySchema, SourceCandidateDetailSchema,
	SourceCandidateSchema, SourceCandidatesDataSchema, SourceChangeCheckBodySchema, SourceChangeCheckSchema,
	SourceHistoryDataSchema, SourceRevisionIdSchema, SourceRevisionsDataSchema, SourceVersionDetailSchema,
	type CreateSourceCandidatesBody, type SourceCandidateActionBody, type SourceChangeCheckBody,
} from "@llm-wiki/workbench-contracts";
import { request } from "./client";

export function listSourceRevisions(kbPath: string, signal?: AbortSignal) {
	return request({ method: "GET", path: "/api/knowledge-bases/source-revisions" }, {
		query: { kb: kbPath }, responseSchema: SourceRevisionsDataSchema, signal,
	});
}
export function checkSourceChanges(input: SourceChangeCheckBody) {
	return request({ method: "POST", path: "/api/knowledge-bases/source-revisions/check" }, {
		body: SourceChangeCheckBodySchema.parse(input), responseSchema: SourceChangeCheckSchema,
	});
}
export async function createSourceCandidates(input: CreateSourceCandidatesBody) {
	const result = await request({ method: "POST", path: "/api/knowledge-bases/source-revisions/candidates" }, {
		body: CreateSourceCandidatesBodySchema.parse(input), responseSchema: SourceCandidatesDataSchema,
	});
	return result.candidates;
}
export function readSourceCandidate(kbPath: string, id: string) {
	return request({ method: "GET", path: "/api/knowledge-bases/source-revisions/candidates/:id/detail" }, {
		query: { kb: kbPath }, pathParams: { id: SourceRevisionIdSchema.parse(id) }, responseSchema: SourceCandidateDetailSchema,
	});
}
export function sourceCandidateAction(action: "adopt" | "cancel" | "retry", id: string, body: SourceCandidateActionBody) {
	const paths = {
		adopt: "/api/knowledge-bases/source-revisions/candidates/:id/adopt",
		cancel: "/api/knowledge-bases/source-revisions/candidates/:id/cancel",
		retry: "/api/knowledge-bases/source-revisions/candidates/:id/retry",
	} as const;
	return request({ method: "POST", path: paths[action] }, {
		body: SourceCandidateActionBodySchema.parse(body), pathParams: { id: SourceRevisionIdSchema.parse(id) }, responseSchema: SourceCandidateSchema,
	});
}
export function readSourceHistory(kbPath: string, sourceId: string) {
	return request({ method: "GET", path: "/api/knowledge-bases/source-revisions/sources/:sourceId" }, {
		query: { kb: kbPath }, pathParams: { sourceId: SourceRevisionIdSchema.parse(sourceId) }, responseSchema: SourceHistoryDataSchema,
	});
}
export function readSourceVersion(kbPath: string, versionId: string) {
	return request({ method: "GET", path: "/api/knowledge-bases/source-revisions/versions/:versionId" }, {
		query: { kb: kbPath }, pathParams: { versionId: SourceRevisionIdSchema.parse(versionId) }, responseSchema: SourceVersionDetailSchema,
	});
}
