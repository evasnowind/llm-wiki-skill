import { useMemo } from "react";
import type { SourceRevisionText } from "@llm-wiki/workbench-contracts";
import { sourceLineDiff, sourceParallelText } from "../lib/source-revision-diff";

export function SourceRevisionCompare({ title, before, after, truncated, beforeLabel = "采用前", afterLabel = "候选版本", beforeEmpty = "无旧版本" }: {
	title: string; before: SourceRevisionText | null; after: SourceRevisionText | null; truncated: boolean;
	beforeLabel?: string; afterLabel?: string; beforeEmpty?: string;
}) {
	const diff = useMemo(() => after ? sourceLineDiff(before?.text ?? null, after.text) : null, [before, after]);
	return <section aria-label={`${title}对照`} className="my-3">
		<h4 className="text-xs font-semibold">{title}</h4>
		{truncated && <p className="ingest-hint" role="status">内容较长，对照已截断；采用时使用完整固定内容。</p>}
		{diff?.mode === "diff" && <>
			<p className="ingest-hint">新增 {diff.added} 行 · 删除 {diff.removed} 行{diff.added === 0 && diff.removed === 0 ? " · 内容相同" : ""}。换行差异仅作阅读归一化。</p>
			{before === null && <p className="ingest-hint">{beforeEmpty}</p>}
			<div className="max-h-80 overflow-auto rounded border" tabIndex={0} aria-label={`${title}逐行变化`}>
				<table className="w-full border-collapse text-left font-mono text-xs"><thead><tr className="sr-only"><th>{beforeLabel}行号</th><th>{afterLabel}行号</th><th>变化</th><th>内容</th></tr></thead><tbody>
					{diff.rows.map((row, index) => <tr key={index} className={row.kind === "added" ? "bg-green-500/10" : row.kind === "removed" ? "bg-red-500/10" : ""}>
						<td className="select-none px-1 align-top opacity-50">{row.beforeLine}</td><td className="select-none px-1 align-top opacity-50">{row.afterLine}</td>
						<td className="px-1 align-top" aria-label={row.kind === "added" ? "新增行" : row.kind === "removed" ? "删除行" : "未变化行"}>{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</td>
						<td className="whitespace-pre-wrap break-words py-0.5 pr-2">{row.text || "\u00a0"}</td>
					</tr>)}
				</tbody></table>
			</div>
		</>}
		{diff?.mode === "parallel" && <p className="ingest-hint" role="status">{diff.reason}，显示受限并列对照。</p>}
		{diff?.mode !== "diff" && <div className="grid grid-cols-2 gap-2">
			<RevisionText label={beforeLabel} value={before} empty={beforeEmpty} />
			<RevisionText label={afterLabel} value={after} empty="尚无生成内容" />
		</div>}
		{diff?.mode === "diff" && <p className="mt-2 break-all text-[10px] opacity-60">内容校验：{before?.hash ?? beforeEmpty} → {after?.hash}</p>}
	</section>;
}
function RevisionText({ label, value, empty }: { label: string; value: SourceRevisionText | null; empty: string }) {
	const display = value ? sourceParallelText(value.text) : null;
	return <div className="min-w-0 rounded border p-2">
		<p className="ingest-hint">{label}</p>
		{value ? <>
			<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs" tabIndex={0}>{display?.text}</pre>
			{display?.truncated && <p className="ingest-hint" role="status">并列阅读已截断。</p>}
			<p className="mt-2 truncate text-[10px] opacity-60" title={value.hash}>内容校验：{value.hash}</p>
		</> : <p className="ingest-hint">{empty}</p>}
	</div>;
}
