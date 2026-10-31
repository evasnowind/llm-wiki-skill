import { useCallback, useState } from "react";
import { SourceRevisionsPanel, type RegenerateTarget } from "./SourceRevisionsPanel";
import { ExternalLink, RotateCcw, X } from "lucide-react";
import type { IngestFileStatus, IngestJob } from "@llm-wiki/workbench-contracts";

import { cn } from "../lib/utils";

interface Props {
	open: boolean;
	kbPath?: string | null;
	knowledgeBaseName: string | null;
	jobs: IngestJob[];
	loading: boolean;
	error: string | null;
	actionError: string | null;
	pendingIds: string[];
	onClose: () => void;
	onCancel: (id: string) => void;
	onRetry: (id: string) => void;
	onRefresh: () => void;
	onOpenOutput: (kbPath: string, outputPath: string) => void;
}

const statusLabels: Record<IngestFileStatus, string> = {
	pending: "等待处理",
	running: "处理中",
	committing: "保存中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

export function IngestQueuePanel({
	open, kbPath, knowledgeBaseName, jobs, loading, error, actionError, pendingIds,
	onClose, onCancel, onRetry, onRefresh, onOpenOutput,
}: Props) {
	const [regenerate, setRegenerate] = useState<(RegenerateTarget & { kbPath: string }) | null>(null);
	const [readingKb, setReadingKb] = useState<string | null>(null);
	const handleReadingChange = useCallback((reading: boolean) => {
		setReadingKb((current) => reading ? kbPath ?? null : current === kbPath ? null : current);
	}, [kbPath]);
	if (!open) return null;
	return (
		<section className={cn("batch-panel ingest-panel", kbPath && readingKb === kbPath && "ingest-panel-reading")} aria-label="入库任务">
			<div className="batch-header">
				<div className="min-w-0">
					<div className="batch-title">入库任务</div>
					<div className="batch-subtitle">{knowledgeBaseName ?? "未选择知识库"}</div>
				</div>
				<button type="button" className="icon-btn" onClick={onRefresh} aria-label="刷新入库状态">
					<RotateCcw className="size-4" />
				</button>
				<button type="button" className="icon-btn" onClick={onClose} aria-label="关闭入库面板">
					<X className="size-4" />
				</button>
			</div>
			<div className="batch-body ingest-body">
				{kbPath && <SourceRevisionsPanel key={kbPath} kbPath={kbPath} regenerateTarget={regenerate?.kbPath === kbPath ? regenerate : null} onClearRegenerate={() => setRegenerate(null)} onReadingChange={handleReadingChange} />}
				<p className="ingest-hint">关闭面板或刷新页面不会取消任务。完成后保留原文并生成素材摘要。</p>
				<p className="ingest-hint">PDF 请先转换为 Markdown 或文本后再入库。</p>
				{loading && <p className="ingest-hint" role="status">正在恢复入库任务…</p>}
				{error && <p className="batch-result batch-result-error" role="status">{error}</p>}
				{actionError && <p className="batch-result batch-result-error" role="alert">{actionError}</p>}
				{!loading && jobs.length === 0 && <p className="ingest-hint">当前知识库还没有入库任务。</p>}
				{jobs.map((job) => {
					const completed = job.files.filter((file) => file.status === "completed").length;
					const failed = job.files.filter((file) => file.status === "failed").length;
					const cancelled = job.files.filter((file) => file.status === "cancelled").length;
					const finished = completed + failed + cancelled;
					const percent = Math.round(finished / Math.max(1, job.files.length) * 100);
					const cancellable = job.files.some((file) => file.status === "pending" || file.status === "running");
					const retryable = failed + cancelled > 0;
					const pending = pendingIds.includes(job.id);
					return (
						<article className="ingest-job" key={job.id} aria-label={`入库批次 ${job.id}`}>
							<div className="ingest-job-heading">
								<span className={cn("batch-status", statusClass(job.status))}>{statusLabels[job.status]}</span>
								<span className="batch-subtitle">{completed} 完成 / {failed} 失败 / {job.files.length} 总数</span>
							</div>
							<div className="batch-progress" aria-label={`入库进度 ${percent}%`}>
								<div className="batch-progress-bar" style={{ width: `${percent}%` }} />
							</div>
							{job.files.map((file) => (
								<div key={file.id} className={cn("batch-file", fileClass(file.status))}>
									<span className={cn("batch-dot", dotClass(file.status))} aria-hidden="true" />
									<div className="min-w-0">
										<div className="batch-file-name" title={file.name}>{file.name}</div>
										<div className="batch-file-detail">
											{statusLabels[file.status]}
											{file.progressChars > 0 && `，约 ${file.progressChars} 字`}
											{file.attempts > 1 && `，第 ${file.attempts} 次处理`}
											{file.error && `：${file.error}`}
										</div>
									</div>
									<div className="flex flex-wrap items-center gap-1">
									{file.status === "completed" && kbPath && <button type="button" className="ingest-action" onClick={() => setRegenerate({ kbPath: job.kbPath, jobId: job.id, fileId: file.id, name: file.name })} aria-label={`重新生成 ${file.name} 的摘要`}>重新生成</button>}
									{file.status === "completed" && file.outputPath ? (
										<button
											type="button" className="batch-output-btn"
											onClick={() => onOpenOutput(job.kbPath, file.outputPath!)}
											aria-label={`打开 ${file.name} 的素材摘要`}
										>
											<ExternalLink className="size-3.5" />
										</button>
									) : <span />}
									</div>
								</div>
							))}
							<div className="ingest-job-actions">
								{job.files.some((file) => file.status === "committing") && <span className="batch-subtitle">保存中的文件会完成写入。</span>}
								{cancelled > 0 && <span className="batch-subtitle">{cancelled} 项已取消</span>}
								{cancellable && <button type="button" className="ingest-action" disabled={pending} onClick={() => onCancel(job.id)}>取消未完成项</button>}
								{retryable && <button type="button" className="ingest-action" disabled={pending} onClick={() => onRetry(job.id)}>重试失败或取消项</button>}
							</div>
						</article>
					);
				})}
			</div>
		</section>
	);
}

function statusClass(status: IngestFileStatus): string {
	if (status === "completed") return "batch-status-done";
	if (status === "failed") return "batch-status-error";
	if (status === "cancelled") return "batch-status-cancelled";
	return "batch-status-running";
}

function fileClass(status: IngestFileStatus): string {
	if (status === "completed") return "batch-file-done";
	if (status === "failed") return "batch-file-error";
	if (status === "running" || status === "committing") return "batch-file-running";
	return "";
}

function dotClass(status: IngestFileStatus): string {
	if (status === "completed") return "batch-dot-done";
	if (status === "failed") return "batch-dot-error";
	if (status === "running" || status === "committing") return "batch-dot-running";
	return "batch-dot-queued";
}
