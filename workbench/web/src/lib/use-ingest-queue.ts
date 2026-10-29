import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IngestJob, IngestJobRequestBody } from "@llm-wiki/workbench-contracts";

import {
	cancelIngestJob,
	createIngestJob,
	listIngestJobs,
	retryIngestJob,
} from "./api/ingest-jobs";

export interface IngestQueueApi {
	list: (kbPath: string, signal?: AbortSignal) => Promise<IngestJob[]>;
	create: (input: IngestJobRequestBody) => Promise<IngestJob>;
	cancel: (kbPath: string, id: string) => Promise<IngestJob>;
	retry: (kbPath: string, id: string) => Promise<IngestJob>;
}

const defaultApi: IngestQueueApi = {
	list: listIngestJobs,
	create: createIngestJob,
	cancel: cancelIngestJob,
	retry: retryIngestJob,
};

interface Snapshot {
	selection: object;
	jobs: IngestJob[];
}

interface ScopedError {
	selection: object;
	message: string;
}

interface PendingActions {
	selection: object;
	ids: string[];
}

/** The backend owns task lifetime. This hook only subscribes to scoped snapshots. */
export function useIngestQueue(
	kbPath: string | null,
	api: IngestQueueApi = defaultApi,
	pollIntervalMs = 1000,
) {
	const selection = useMemo(() => ({ kbPath }), [kbPath]);
	const selectionRef = useRef<object | null>(selection);
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [readFailure, setReadFailure] = useState<ScopedError | null>(null);
	const [actionFailure, setActionFailure] = useState<ScopedError | null>(null);
	const [pending, setPending] = useState<PendingActions | null>(null);
	const requestIdRef = useRef(0);
	const latestSuccessRef = useRef(0);

	useEffect(() => {
		selectionRef.current = selection;
		return () => {
			if (selectionRef.current === selection) selectionRef.current = null;
		};
	}, [selection]);

	const acceptJobs = useCallback((jobs: IngestJob[], requestId: number) => {
		if (selectionRef.current !== selection) return;
		latestSuccessRef.current = Math.max(latestSuccessRef.current, requestId);
		const scoped = jobs.filter((job) => job.kbPath === kbPath);
		setSnapshot((current) => ({
			selection,
			jobs: mergeJobs(current?.selection === selection ? current.jobs : [], scoped),
		}));
		setReadFailure((current) => current?.selection === selection ? null : current);
	}, [kbPath, selection]);

	const refresh = useCallback(async (signal?: AbortSignal) => {
		if (!kbPath) return;
		const requestId = ++requestIdRef.current;
		try {
			const jobs = await api.list(kbPath, signal);
			if (!signal?.aborted) acceptJobs(jobs, requestId);
		} catch {
			if (
				signal?.aborted
				|| selectionRef.current !== selection
				|| latestSuccessRef.current > requestId
			) return;
			setReadFailure({ selection, message: "暂时无法更新任务状态，连接恢复后会自动更新；刷新或断线不会主动取消任务。" });
		}
	}, [acceptJobs, api, kbPath, selection]);

	useEffect(() => {
		if (!kbPath) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		const poll = async () => {
			await refresh(controller.signal);
			if (!stopped) timer = setTimeout(() => void poll(), Math.max(50, pollIntervalMs));
		};
		void Promise.resolve().then(poll);
		return () => {
			stopped = true;
			controller.abort();
			clearTimeout(timer);
		};
	}, [kbPath, pollIntervalMs, refresh]);

	const runAction = useCallback(async (
		key: string,
		path: string,
		operation: () => Promise<IngestJob>,
	) => {
		const requestId = ++requestIdRef.current;
		if (path === kbPath && selectionRef.current === selection) {
			setActionFailure(null);
			setPending((current) => ({
				selection,
				ids: [...(current?.selection === selection ? current.ids : []), key],
			}));
		}
		try {
			const job = await operation();
			if (path === kbPath) acceptJobs([job], requestId);
			return job;
		} catch (cause) {
			if (path === kbPath && selectionRef.current === selection) {
				setActionFailure({
					selection,
					message: cause instanceof Error ? cause.message : "任务操作失败，请刷新状态后再试。",
				});
			}
			throw cause;
		} finally {
			if (selectionRef.current === selection) {
				setPending((current) => {
					if (current?.selection !== selection) return current;
					const ids = [...current.ids];
					const index = ids.indexOf(key);
					if (index >= 0) ids.splice(index, 1);
					return { selection, ids };
				});
			}
		}
	}, [acceptJobs, kbPath, selection]);

	const enqueue = useCallback((input: IngestJobRequestBody) => (
		runAction("enqueue", input.kbPath, () => api.create(input))
	), [api, runAction]);
	const cancel = useCallback((id: string) => {
		if (!kbPath) return Promise.reject(new Error("请先选择知识库"));
		return runAction(id, kbPath, () => api.cancel(kbPath, id));
	}, [api, kbPath, runAction]);
	const retry = useCallback((id: string) => {
		if (!kbPath) return Promise.reject(new Error("请先选择知识库"));
		return runAction(id, kbPath, () => api.retry(kbPath, id));
	}, [api, kbPath, runAction]);

	const jobs = snapshot?.selection === selection ? snapshot.jobs : [];
	return {
		jobs,
		loading: Boolean(kbPath) && snapshot?.selection !== selection && readFailure?.selection !== selection,
		error: readFailure?.selection === selection ? readFailure.message : null,
		actionError: actionFailure?.selection === selection ? actionFailure.message : null,
		pendingIds: pending?.selection === selection ? pending.ids : [],
		activeCount: jobs.reduce((count, job) => count + job.files.filter((file) => (
			file.status === "pending" || file.status === "running" || file.status === "committing"
		)).length, 0),
		enqueue,
		cancel,
		retry,
		refresh,
	};
}

function mergeJobs(current: IngestJob[], incoming: IngestJob[]): IngestJob[] {
	const byId = new Map(current.map((job) => [job.id, job]));
	for (const job of incoming) {
		const existing = byId.get(job.id);
		if (!existing || job.revision >= existing.revision) byId.set(job.id, job);
	}
	return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
