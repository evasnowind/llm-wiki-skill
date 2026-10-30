import { useEffect, useRef } from "react";
import type { DrawerState } from "../lib/drawer-state";
import { MarkdownView } from "./MarkdownView";

export function EvidenceReader({ drawer, onOpenPage }: { drawer: Extract<DrawerState, { mode: "evidence" }>; onOpenPage?: (path: string) => void }) {
	const container = useRef<HTMLDivElement>(null);
	const { citation } = drawer.selection;
	const { result } = drawer;
	const source = splitSourceFrontmatter(result?.content ?? "");
	const located = result && result.locationStatus !== "changed" && result.startLine !== null && result.endLine !== null;
	useEffect(() => {
		if (!located) return;
		const target = container.current?.querySelector<HTMLElement>("[data-evidence-highlight]");
		target?.scrollIntoView?.({ block: "center", behavior: "auto" });
		target?.focus({ preventScroll: true });
	}, [drawer.requestKey, located, result]);
	return <div className="evidence-reader" ref={container}>
		<div className="evidence-location"><span>{citation.kind === "raw" ? "原始资料" : "知识页面"}</span><code>{citation.path}</code><span>{citation.headingPath.join(" › ") || "正文"}</span></div>
		{drawer.loading && <p role="status">正在打开出处…</p>}
		{drawer.error && <p role="alert" className="text-destructive">{drawer.error}</p>}
		{result && <>
			{result.locationStatus === "changed" ? <div className="evidence-notice" role="status"><strong>原文已变化</strong><p>无法在当前原文中可靠定位。下面保留回答时的引用片段，供你核对。</p><blockquote>{citation.excerpt}</blockquote></div> : <p className="evidence-position" role="status">{result.locationStatus === "relocated" ? "已在当前原文中重新定位" : "已定位引用段落"} · 第 {result.startLine}–{result.endLine} 行</p>}
			{citation.path.toLowerCase().endsWith(".txt") ? <div className="evidence-plain">{result.content.split(/\r?\n/).map((line, i) => <div key={i} data-source-start={i + 1} data-evidence-highlight={located && i + 1 >= result.startLine! && i + 1 <= result.endLine! ? "true" : undefined} className={located && i + 1 >= result.startLine! && i + 1 <= result.endLine! ? "evidence-highlight" : undefined} tabIndex={located && i + 1 === result.startLine ? -1 : undefined}>{line || "\u00a0"}</div>)}</div> : <>
				{source.frontmatter && <details className="evidence-frontmatter"><summary>资料属性</summary><pre>{source.frontmatter}</pre></details>}
				<MarkdownView content={source.body} onOpenPage={onOpenPage} highlightLines={located ? { startLine: result.startLine!, endLine: result.endLine! } : undefined} autoEmitWikiLinks={false} />
			</>}
		</>}
	</div>;
}

/** Keep metadata readable without shifting the body's original source positions. */
function splitSourceFrontmatter(content: string): { frontmatter: string | null; body: string } {
	const lines = content.split("\n");
	if (lines[0]?.replace(/^\uFEFF/u, "") !== "---") return { frontmatter: null, body: content };
	const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/u.test(line));
	if (end < 0 || end > 200) return { frontmatter: null, body: content };
	return {
		frontmatter: lines.slice(0, end + 1).join("\n"),
		body: [...Array<string>(end + 1).fill(""), ...lines.slice(end + 1)].join("\n"),
	};
}
