import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EvidenceCitation } from "@llm-wiki/workbench-contracts";

import { emitWikiLinkSeen, extractWikiPageRefs, normalizeWikiLinks } from "../lib/wiki-links";

interface Props {
	content: string;
	onOpenPage?: (path: string) => void;
	onWikiLinkSeen?: (path: string) => void;
	autoEmitWikiLinks?: boolean;
	evidence?: EvidenceCitation[];
	onOpenEvidence?: (citation: EvidenceCitation) => void;
	highlightLines?: { startLine: number; endLine: number };
}

export function MarkdownView({ content, onOpenPage, onWikiLinkSeen, autoEmitWikiLinks = true, evidence = [], onOpenEvidence, highlightLines }: Props) {
	useEffect(() => {
		if (!autoEmitWikiLinks || !onWikiLinkSeen) return;
		for (const path of extractWikiPageRefs(content)) {
			onWikiLinkSeen(path);
			emitWikiLinkSeen(path);
		}
	}, [autoEmitWikiLinks, content, onWikiLinkSeen]);

	return (
		<div className="prose prose-invert max-w-none prose-pre:bg-background prose-pre:text-foreground prose-code:text-foreground">
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkPaperHighlight, [remarkSourceLocation, highlightLines]]}
				components={{
					a: ({ href, children }) => {
						if (href?.startsWith("#evidence-")) {
							const citation = evidence.find((item) => href === `#evidence-${item.id}`);
							return citation && onOpenEvidence ? (
								<button type="button" className="evidence-citation" title={`${citation.title} · ${citation.headingPath.join(" › ") || "正文"} · 第 ${citation.startLine}–${citation.endLine} 行`} aria-label={`查看出处 ${String(children)}：${citation.title}`} onClick={() => onOpenEvidence(citation)}>{children}</button>
							) : <span className="evidence-unavailable" title="这条出处暂不可用">{children}</span>;
						}
						if (href?.startsWith("wiki/")) {
							return (
								<a
									href={href}
									onClick={(e) => {
										e.preventDefault();
										onWikiLinkSeen?.(href);
										emitWikiLinkSeen(href);
										onOpenPage?.(href);
									}}
									className="at"
								>
									{children}
								</a>
							);
						}
						return (
							<a href={href} target="_blank" rel="noopener noreferrer">
								{children}
							</a>
						);
					},
				}}
			>
				{normalizeWikiLinks(content)}
			</ReactMarkdown>
		</div>
	);
}

/** Preserve source line numbers from Markdown, so evidence never relies on rendered text matching. */
function remarkSourceLocation(range?: { startLine: number; endLine: number }) {
	return (tree: MarkdownNode) => {
		const visit = (node: MarkdownNode) => {
			const start = node.position?.start.line;
			const end = node.position?.end.line;
			if (["paragraph", "heading", "code", "table", "thematicBreak"].includes(node.type ?? "") && start && end) {
				const highlighted = Boolean(range && start <= range.endLine && end >= range.startLine);
				node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-source-start": start, "data-source-end": end, ...(highlighted ? { "data-evidence-highlight": "true", className: "evidence-highlight", tabIndex: -1 } : {}) } };
			}
			node.children?.forEach(visit);
		};
		visit(tree);
	};
}

type MarkdownNode = {
	position?: { start: { line: number }; end: { line: number } };
	type?: string;
	value?: string;
	children?: MarkdownNode[];
	data?: { hProperties?: Record<string, unknown>; [key: string]: unknown };
};

function remarkPaperHighlight() {
	return (tree: MarkdownNode) => {
		visitTextParents(tree);
	};
}

function visitTextParents(node: MarkdownNode): void {
	if (!node.children) return;
	const nextChildren: MarkdownNode[] = [];
	let changed = false;
	for (const child of node.children) {
		if (child.type === "text" && typeof child.value === "string") {
			const split = splitHighlightText(child.value);
			if (split.length > 1 || split[0] !== child) changed = true;
			nextChildren.push(...split);
			continue;
		}
		visitTextParents(child);
		nextChildren.push(child);
	}
	if (changed) node.children = nextChildren;
}

function splitHighlightText(value: string): MarkdownNode[] {
	const nodes: MarkdownNode[] = [];
	const pattern = /==([^=\n][^\n]*?[^=\n])==/g;
	let lastIndex = 0;
	for (const match of value.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > lastIndex) nodes.push({ type: "text", value: value.slice(lastIndex, index) });
		nodes.push({
			type: "emphasis",
			data: { hName: "mark", hProperties: { className: "hl" } },
			children: [{ type: "text", value: match[1] }],
		});
		lastIndex = index + match[0].length;
	}
	if (lastIndex === 0) return [{ type: "text", value }];
	if (lastIndex < value.length) nodes.push({ type: "text", value: value.slice(lastIndex) });
	return nodes;
}
