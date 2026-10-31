import { useEffect, useRef, useState } from "react";
import type { AvailableModelInfo, CreateSourceCandidatesBody, ModelRef, SourceCandidate } from "@llm-wiki/workbench-contracts";
import { fetchAvailableModels, getConfig } from "../lib/api/config";
import { useSourceRevisions, type SourceRevisionsApi } from "../lib/use-source-revisions";
import { SourceRevisionCompare } from "./SourceRevisionCompare";
import { SourceVersionHistory } from "./SourceVersionHistory";

export interface RegenerateTarget { jobId: string; fileId: string; name: string }
interface Props {
	onReadingChange?: (reading: boolean) => void;
	kbPath: string; regenerateTarget?: RegenerateTarget | null; onClearRegenerate?: () => void; api?: SourceRevisionsApi;
}
const labels: Record<SourceCandidate["status"], string> = {
	pending: "等待生成", generating: "生成中", ready: "待确认", adopting: "保存中", adopted: "已采用", failed: "失败", stale: "已过期", cancelled: "已取消",
};
const changeLabels = { added: "新增", modified: "修改", deleted: "删除", unchanged: "未变化" };

export function SourceRevisionsPanel({ kbPath, regenerateTarget, onClearRegenerate, onReadingChange, api }: Props) {
	const revisions = useSourceRevisions(kbPath, api);
	const [filter, setFilter] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [model, setModel] = useState<ModelRef | null>(null);
	const [models, setModels] = useState<AvailableModelInfo[]>([]);
	const [modelError, setModelError] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [sourceTarget, setSourceTarget] = useState<{ sourceId: string; baseVersionId: string; name: string } | null>(null);
	const regeneration = sourceTarget ?? regenerateTarget;
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const lastRequest = useRef<{ key: string; id: string } | null>(null);
	const checkId = revisions.check?.id;
	const busy = revisions.pending.includes("create");
	const reading = Boolean(revisions.reading || revisions.readingLoading || revisions.readError);
	useEffect(() => {
		onReadingChange?.(reading);
		return () => { onReadingChange?.(false); };
	}, [reading, onReadingChange]);
	useEffect(() => {
		let stopped = false;
		void Promise.all([fetchAvailableModels(), getConfig()]).then(([available, config]) => {
			if (!stopped) { setModels(available); setModel(config.modelRoles?.digest ?? null); }
		}).catch(() => { if (!stopped) setModelError(true); });
		return () => { stopped = true; };
	}, []);
	const requestId = (key: string) => {
		if (lastRequest.current?.key !== key) lastRequest.current = { key, id: crypto.randomUUID() };
		return lastRequest.current.id;
	};
	const generate = (input: Omit<Extract<CreateSourceCandidatesBody, { type: "changes" }>, "requestId"> | Omit<Extract<CreateSourceCandidatesBody, { type: "regenerate" }>, "requestId">) => {
		const body = { ...input, requestId: requestId(JSON.stringify(input)) } as CreateSourceCandidatesBody;
		void revisions.create(body).then(() => { setSelected([]); setSourceTarget(null); lastRequest.current = null; onClearRegenerate?.(); }).catch(() => {});
	};
	const modelFields = <>
		<label className="my-2 block text-xs">摘要模型
			<select className="mt-1 block w-full rounded border bg-transparent p-2" aria-label="摘要模型" value={model ? JSON.stringify(model) : ""} disabled={busy} onChange={(event) => setModel(event.target.value ? JSON.parse(event.target.value) as ModelRef : null)}>
				<option value="">使用已配置的摘要模型</option>
				{models.map((item) => <option disabled={!item.hasAuth} key={`${item.provider}:${item.modelId}`} value={JSON.stringify({ provider: item.provider, modelId: item.modelId })}>{item.provider} / {item.name}{item.hasAuth ? "" : "（未配置）"}</option>)}
			</select>
		</label>
		{modelError && <p className="ingest-hint">模型列表暂不可用，将使用已配置的摘要模型。</p>}
		<label className="my-2 block text-xs">摘要改进要求（可选）
			<textarea aria-label="摘要改进要求" className="mt-1 w-full rounded border p-2" maxLength={4000} rows={2} value={feedback} disabled={busy} onChange={(event) => setFeedback(event.target.value)} placeholder="例如：保留关键结论与反例" />
		</label>
	</>;
	const detail = revisions.reading?.type === "candidate" ? revisions.reading.detail : null;
	const latest = detail ? revisions.data.candidates.find((item) => item.id === detail.candidate.id) ?? detail.candidate : null;
	return <section aria-label="素材更新与摘要候选" className="mb-4 border-b pb-4">
		<div className="ingest-job-heading">
			<h3 className="text-sm font-semibold">素材更新与摘要候选</h3>
			<button type="button" className="ingest-action" disabled={revisions.pending.includes("check")} onClick={() => { setSelected([]); void revisions.checkDirectory().catch(() => {}); }}>检查 Markdown 变化</button>
		</div>
		<p className="ingest-hint">选择目录后才检查；关闭或刷新只恢复状态。候选生成后需核对并确认采用。</p>
		{revisions.data.directories.map((directory) => <button key={directory.id} type="button" className="ingest-action mb-2 max-w-full break-all" disabled={revisions.pending.includes("check")} onClick={() => { setSelected([]); void revisions.checkDirectory(directory.path).catch(() => {}); }}>确认并检查目录：{directory.path}</button>)}
		{revisions.loading && <p className="ingest-hint" role="status">正在恢复素材更新状态…</p>}
		{revisions.pending.includes("check") && <p role="status" className="ingest-hint">正在检查已确认目录…</p>}
		{revisions.error && <p className="batch-result batch-result-error" role="status">{revisions.error}</p>}
		{revisions.actionError && <p className="batch-result batch-result-error" role="alert">{revisions.actionError}</p>}
		{revisions.check && <section aria-label="Markdown 变化清单">
			<p className="ingest-hint break-all">{revisions.check.directoryPath}</p>
			{!revisions.check.complete && <p role="status" className="ingest-hint">检查不完整，未读取的文件不会判定为删除。</p>}
			{revisions.check.warnings.map((warning, index) => <p role="status" className="ingest-hint" key={index}>{warning}</p>)}
			<p className="ingest-hint">{Object.entries(changeLabels).map(([kind, label]) => `${label} ${revisions.check!.changes.filter((change) => change.kind === kind).length}`).join(" · ")}</p>
			<label className="block text-xs">筛选路径<input className="my-2 w-full rounded border p-2" aria-label="筛选素材路径" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
			{revisions.check.changes.filter((change) => change.relativePath.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((change) => <label key={change.id} className="my-2 flex gap-2 break-all text-xs">
				<input type="checkbox" aria-label={`选择 ${change.relativePath}`} disabled={busy || revisions.pending.includes("check") || (change.kind !== "added" && change.kind !== "modified")} checked={selected.includes(change.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, change.id] : current.filter((id) => id !== change.id))} />
				<span>{changeLabels[change.kind]} · {change.relativePath}{change.kind === "deleted" && "（仅提示，保留已入库内容）"}</span>
			</label>)}
			{modelFields}
			<button type="button" className="ingest-action" disabled={busy || revisions.pending.includes("check") || selected.length === 0} onClick={() => {
				if (checkId) generate({ type: "changes", kbPath, checkId, changeIds: selected, digestModel: model, feedback });
			}}>为选中变化生成候选（{selected.length}）</button>
		</section>}
		{regeneration && <section aria-label="重新生成素材摘要" className="my-3 rounded border p-3">
			<h4 className="text-xs font-semibold">重新生成：{regeneration.name}</h4>
			<p className="ingest-hint">基于已保留原文生成新候选。现有摘要在确认采用前保持原样。</p>
			{modelFields}
			<button type="button" className="ingest-action" disabled={busy} onClick={() => generate({ type: "regenerate", kbPath, target: sourceTarget ? { type: "source", sourceId: sourceTarget.sourceId, baseVersionId: sourceTarget.baseVersionId } : { type: "ingest-file", jobId: regenerateTarget!.jobId, fileId: regenerateTarget!.fileId }, digestModel: model, feedback })}>生成摘要候选</button>
			<button type="button" className="ingest-action ml-2" disabled={busy} onClick={() => { setSourceTarget(null); onClearRegenerate?.(); }}>关闭重新生成</button>
		</section>}
		{revisions.data.candidates.map((candidate) => <article key={candidate.id} className="my-3 rounded border p-2" aria-label={`摘要候选 ${candidate.name}`}>
			<div className="text-xs break-all">{candidate.name} · <strong>{labels[candidate.status]}</strong></div>
			<p className="ingest-hint">{new Date(candidate.createdAt).toLocaleString()} · {candidate.model ? `${candidate.model.provider} / ${candidate.model.modelId}` : "默认摘要模型"}{candidate.progressChars > 0 && ` · 约 ${candidate.progressChars} 字`}</p>
			{candidate.error && <p className="ingest-hint">{candidate.error}</p>}
			{candidate.status === "adopting" && <p className="ingest-hint">正在保存，无法承诺取消；完成后更新状态。</p>}
			<div className="flex flex-wrap gap-2">
				<button type="button" className="ingest-action" onClick={() => { setConfirmId(null); void revisions.openReading("candidate", candidate.id); }}>查看对照</button>
				{["pending", "generating", "ready"].includes(candidate.status) && <button type="button" className="ingest-action" disabled={revisions.pending.includes(candidate.id)} onClick={() => { void revisions.action(candidate, "cancel").catch(() => {}); }}>取消候选</button>}
				{["failed", "cancelled"].includes(candidate.status) && <button type="button" className="ingest-action" disabled={revisions.pending.includes(candidate.id)} onClick={() => { void revisions.action(candidate, "retry").catch(() => {}); }}>重试候选</button>}
				{candidate.sourceId && <button type="button" className="ingest-action" onClick={() => { setConfirmId(null); void revisions.openReading("history", candidate.sourceId!); }}>版本历史</button>}
			</div>
		</article>)}
		{revisions.data.sources.length > 0 && <details className="my-3 text-xs"><summary>已采用素材与版本历史</summary>{revisions.data.sources.map((source) => <div key={source.id} className="my-2 flex flex-wrap gap-2"><span className="break-all">{source.relativePath}</span><button type="button" className="ingest-action" onClick={() => setSourceTarget({ sourceId: source.id, baseVersionId: source.currentVersionId, name: source.name })}>重新生成当前版本摘要</button><button type="button" className="ingest-action" onClick={() => { setConfirmId(null); void revisions.openReading("history", source.id); }}>查看 {source.name} 的版本历史</button></div>)}</details>}
		{(revisions.reading || revisions.readingLoading || revisions.readError) && <section className="my-3 rounded border p-2" aria-label="素材版本详情">
			<button type="button" className="ingest-action" onClick={() => { setConfirmId(null); revisions.closeReading(); }}>关闭版本详情</button>
			{revisions.readingLoading && <p role="status" className="ingest-hint">正在读取版本详情…</p>}
			{revisions.readError && <p role="alert" className="ingest-hint">{revisions.readError}</p>}
			{detail && latest && <>
				<h4 className="mt-3 text-xs font-semibold">{latest.name} · {labels[latest.status]}</h4>
				<p className="ingest-hint">候选版本：{latest.id} · 基础版本：{latest.baseVersionId ?? "无旧版本"}</p>
				<SourceRevisionCompare title="原文" before={detail.original.before ?? null} after={detail.original.after ?? null} truncated={detail.truncated} />
				<SourceRevisionCompare title="摘要" before={detail.summary.before ?? null} after={detail.summary.after ?? null} truncated={detail.truncated} />
				{latest.status === "ready" && detail.candidate.revision !== latest.revision && <p className="ingest-hint">候选已更新，请重新打开对照后确认。</p>}
				{latest.status === "ready" && detail.candidate.revision === latest.revision && <>
					<label className="my-2 flex gap-2 text-xs"><input type="checkbox" aria-label="已核对原文与摘要对照" checked={confirmId === latest.id} onChange={(event) => setConfirmId(event.target.checked ? latest.id : null)} />已核对原文与摘要对照</label>
					<button type="button" className="ingest-action" disabled={confirmId !== latest.id || revisions.pending.includes(latest.id)} onClick={() => { setConfirmId(null); void revisions.action(latest, "adopt").catch(() => {}); }}>确认采用此候选</button>
				</>}
			</>}
			{revisions.reading?.type === "history" && <SourceVersionHistory {...revisions.reading} loading={revisions.readingLoading} onVersion={(id, compare) => { void revisions.openVersion(id, compare); }} />}
		</section>}
	</section>;
}
