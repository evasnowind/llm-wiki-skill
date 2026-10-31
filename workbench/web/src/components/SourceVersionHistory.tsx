import type { SourceHistoryData, SourceVersionDetail } from "@llm-wiki/workbench-contracts";
import { SourceRevisionCompare } from "./SourceRevisionCompare";

export function SourceVersionHistory({ history, version, comparison, loading, onVersion }: {
	history: SourceHistoryData; version?: SourceVersionDetail; comparison?: SourceVersionDetail;
	loading: boolean; onVersion: (id: string, compare?: boolean) => void;
}) {
	return <section aria-label="素材版本历史">
		<h3 className="text-sm font-semibold">{history.source.name} · 版本历史</h3>
		<p className="ingest-hint">版本仅供阅读与比较。</p>
		{history.versions.map((item) => <div key={item.id} className="my-2 flex flex-wrap items-center gap-2 text-xs">
			<span>{new Date(item.createdAt).toLocaleString()} · {item.action === "regenerated" ? "重新生成" : item.action === "added" ? "首次入库" : "原文更新"}</span>
			{item.id === history.source.currentVersionId && <span>当前采用</span>}
			<button type="button" className="ingest-action" disabled={loading} onClick={() => onVersion(item.id)}>查看版本 {item.id.slice(0, 8)}</button>
			{version && item.id !== version.version.id && <button type="button" className="ingest-action" disabled={loading} onClick={() => onVersion(item.id, true)}>与所选版本比较 {item.id.slice(0, 8)}</button>}
		</div>)}
		{version && <>
			<p className="ingest-hint">所选版本：{version.version.id} · {version.version.model ? `${version.version.model.provider} / ${version.version.model.modelId}` : "未记录模型"}</p>
			{comparison && <p className="ingest-hint">比较版本：{comparison.version.id}</p>}
			<SourceRevisionCompare beforeLabel="比较版本" afterLabel="所选版本" beforeEmpty="未选择比较版本" title="历史原文" before={comparison?.original ?? null} after={version.original} truncated={version.truncated || Boolean(comparison?.truncated)} />
			<SourceRevisionCompare beforeLabel="比较版本" afterLabel="所选版本" beforeEmpty="未选择比较版本" title="历史摘要" before={comparison?.summary ?? null} after={version.summary} truncated={version.truncated || Boolean(comparison?.truncated)} />
		</>}
	</section>;
}
