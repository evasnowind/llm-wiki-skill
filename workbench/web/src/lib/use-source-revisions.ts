import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	CreateSourceCandidatesBody, SourceCandidate, SourceCandidateDetail, SourceChangeCheck,
	SourceHistoryData, SourceRevisionsData, SourceVersionDetail,
} from "@llm-wiki/workbench-contracts";
import {
	checkSourceChanges, createSourceCandidates, listSourceRevisions, readSourceCandidate,
	readSourceHistory, readSourceVersion, sourceCandidateAction,
} from "./api/source-revisions";
import { chooseDirectory, inspectKnowledgeBasePath } from "./api/knowledge-bases";

export const sourceRevisionsApi = {
	list: listSourceRevisions, check: checkSourceChanges, create: createSourceCandidates,
	detail: readSourceCandidate, history: readSourceHistory, version: readSourceVersion,
	action: sourceCandidateAction, chooseDirectory, inspect: inspectKnowledgeBasePath,
};
export type SourceRevisionsApi = typeof sourceRevisionsApi;
type Reading = { type: "candidate"; id: string; detail: SourceCandidateDetail }
	| { type: "history"; id: string; history: SourceHistoryData; version?: SourceVersionDetail; comparison?: SourceVersionDetail };
interface State {
	selection: object; data: SourceRevisionsData; check: SourceChangeCheck | null;
	reading: Reading | null; readingLoading: boolean; readError: string | null;
	error: string | null; actionError: string | null; loaded: boolean; pending: string[];
}
const emptyData: SourceRevisionsData = { directories: [], sources: [], candidates: [] };
function initial(selection: object): State {
	return { selection, data: emptyData, check: null, reading: null, readingLoading: false, readError: null, error: null, actionError: null, loaded: false, pending: [] };
}

/** Polling reads persisted metadata. Scanning and publishing are explicit user actions. */
export function useSourceRevisions(kbPath: string, api: SourceRevisionsApi = sourceRevisionsApi, pollMs = 1500) {
	const selection = useMemo(() => ({ kbPath }), [kbPath]);
	const selectionRef = useRef<object | null>(selection);
	const [stored, setStored] = useState<State>(() => initial(selection));
	const state = stored.selection === selection ? stored : initial(selection);
	const serial = useRef(0);
	const latestList = useRef(0);
	const readingSerial = useRef(0);
	const pendingRef = useRef(new Map<string, { selection: object; promise: Promise<unknown> }>());
	useEffect(() => {
		selectionRef.current = selection;
		return () => { if (selectionRef.current === selection) selectionRef.current = null; };
	}, [selection]);
	const update = useCallback((change: (current: State) => State) => {
		if (selectionRef.current !== selection) return;
		setStored((current) => change(current.selection === selection ? current : initial(selection)));
	}, [selection]);
	const merge = useCallback((incoming: SourceCandidate[]) => {
		update((current) => {
			const candidates = new Map(current.data.candidates.map((candidate) => [candidate.id, candidate]));
			for (const candidate of incoming) {
				if (candidate.kbPath !== kbPath) continue;
				if (!candidates.has(candidate.id) || candidates.get(candidate.id)!.revision <= candidate.revision) candidates.set(candidate.id, candidate);
			}
			return { ...current, data: { ...current.data, candidates: [...candidates.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) } };
		});
	}, [kbPath, update]);
	const refresh = useCallback(async (signal?: AbortSignal) => {
		const request = ++serial.current;
		try {
			const data = await api.list(kbPath, signal);
			if (signal?.aborted || selectionRef.current !== selection || request < latestList.current) return;
			latestList.current = request;
			update((current) => ({ ...current, loaded: true, error: null, data: {
				...current.data, directories: data.directories.filter((directory) => directory.kbPath === kbPath), sources: data.sources.filter((source) => source.kbPath === kbPath),
			} }));
			merge(data.candidates);
		} catch {
			if (!signal?.aborted && request >= latestList.current) update((current) => ({ ...current, loaded: true, error: "连接暂时中断，已保留最后状态；恢复连接后继续更新。" }));
		}
	}, [api, kbPath, merge, selection, update]);
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let stopped = false;
		const poll = async () => {
			await refresh(controller.signal);
			if (!stopped) timer = setTimeout(() => void poll(), Math.max(50, pollMs));
		};
		void poll();
		return () => { stopped = true; controller.abort(); clearTimeout(timer); };
	}, [pollMs, refresh]);
	const run = useCallback(<T,>(key: string, operation: () => Promise<T>): Promise<T> => {
		const operationKey = `${kbPath}:${key}`;
		const existing = pendingRef.current.get(operationKey);
		if (existing?.selection === selection) return existing.promise as Promise<T>;
		update((current) => ({ ...current, pending: [...current.pending, key], actionError: null }));
		const promise = Promise.resolve().then(operation).catch((cause: unknown) => {
			update((current) => ({ ...current, actionError: cause instanceof Error ? cause.message : "操作失败，请刷新状态后再试。" }));
			throw cause;
		}).finally(() => {
			if (pendingRef.current.get(operationKey)?.promise === promise) pendingRef.current.delete(operationKey);
			update((current) => ({ ...current, pending: current.pending.filter((id) => id !== key) }));
		});
		pendingRef.current.set(operationKey, { selection, promise });
		return promise;
	}, [kbPath, selection, update]);
	const checkDirectory = useCallback((confirmedPath?: string) => run("check", async () => {
		const path = confirmedPath ?? await api.chooseDirectory();
		if (!path || selectionRef.current !== selection) return;
		const inspected = await api.inspect(path);
		if (selectionRef.current !== selection) return;
		if (!inspected.isDirectory || !inspected.ingestibleFiles?.scanId) throw new Error("目录无法检查，请重新选择素材目录。 ");
		const result = await api.check({ kbPath, sourceScanId: inspected.ingestibleFiles.scanId });
		if (result.kbPath === kbPath) update((current) => ({ ...current, check: result }));
		await refresh();
	}), [api, kbPath, refresh, run, selection, update]);
	const create = useCallback((body: CreateSourceCandidatesBody) => run("create", async () => {
		if (body.kbPath !== kbPath) throw new Error("知识库已切换，请重新选择素材。");
		const candidates = await api.create(body);
		latestList.current = ++serial.current;
		merge(candidates);
		return candidates;
	}), [api, kbPath, merge, run]);
	const closeReading = useCallback(() => {
		readingSerial.current++;
		update((current) => ({ ...current, reading: null, readingLoading: false, readError: null }));
	}, [update]);
	const openReading = useCallback(async (type: "candidate" | "history", id: string) => {
		const request = ++readingSerial.current;
		update((current) => ({ ...current, reading: null, readingLoading: true, readError: null }));
		try {
			const reading: Reading = type === "candidate"
				? { type, id, detail: await api.detail(kbPath, id) }
				: { type, id, history: await api.history(kbPath, id) };
			if (request !== readingSerial.current || selectionRef.current !== selection) return;
			const entity = reading.type === "candidate" ? reading.detail.candidate : reading.history.source;
			if (entity.kbPath !== kbPath || entity.id !== id) throw new Error("读取结果与当前素材身份不一致，请重新打开。");
			update((current) => ({ ...current, reading, readingLoading: false }));
		} catch (cause) {
			if (request === readingSerial.current) update((current) => ({ ...current, readingLoading: false, readError: cause instanceof Error ? cause.message : "暂时无法读取对照，请重试。" }));
		}
	}, [api, kbPath, selection, update]);
	const openVersion = useCallback(async (versionId: string, compare = false) => {
		const currentReading = state.reading;
		if (currentReading?.type !== "history") return;
		const request = ++readingSerial.current;
		update((current) => ({ ...current, readingLoading: true, readError: null }));
		try {
			const version = await api.version(kbPath, versionId);
			if (request !== readingSerial.current || selectionRef.current !== selection) return;
			if (version.version.sourceId !== currentReading.id || version.version.id !== versionId) throw new Error("版本不属于当前来源。");
			update((current) => ({ ...current, readingLoading: false, reading: { ...currentReading, [compare ? "comparison" : "version"]: version } }));
		} catch (cause) {
			if (request === readingSerial.current) update((current) => ({ ...current, readingLoading: false, readError: cause instanceof Error ? cause.message : "版本读取失败。" }));
		}
	}, [api, kbPath, selection, state.reading, update]);
	const action = useCallback((candidate: SourceCandidate, action: "adopt" | "cancel" | "retry") => run(candidate.id, async () => {
		if (candidate.kbPath !== kbPath) throw new Error("知识库已切换，请重新打开候选。");
		const result = await api.action(action, candidate.id, { kbPath, expectedRevision: candidate.revision });
		if (result.kbPath !== kbPath || result.id !== candidate.id) throw new Error("操作结果与当前候选身份不一致，请刷新状态。");
		latestList.current = ++serial.current;
		merge([result]);
		update((current) => ({ ...current, reading: current.reading?.type === "candidate" && current.reading.id === result.id
			? { ...current.reading, detail: { ...current.reading.detail, candidate: result } } : current.reading }));
		await refresh();
		return result;
	}), [api, kbPath, merge, refresh, run, update]);
	return { ...state, loading: !state.loaded, refresh, checkDirectory, create, action, openReading, closeReading, openVersion };
}
