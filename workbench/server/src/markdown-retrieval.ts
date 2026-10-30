export interface MarkdownBlock {
	text: string;
	startLine: number;
	endLine: number;
	headingPath: string[];
}

export interface MarkdownDocument {
	title: string;
	metadata: string[];
	blocks: MarkdownBlock[];
}

/** Small, bounded frontmatter vocabulary: metadata ranks a document, never becomes factual evidence. */
function frontmatterMetadata(lines: string[]): { end: number; values: string[] } {
	if (lines[0]?.replace(/^\uFEFF/u, "") !== "---") return { end: 0, values: [] };
	const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/u.test(line));
	if (close < 0 || close > 200) return { end: 0, values: [] };
	const values: string[] = [];
	let readingList = false;
	for (const line of lines.slice(1, close)) {
		const field = line.match(/^(tags?|aliases?)\s*:\s*(.*)$/iu);
		if (field) {
			readingList = true;
			values.push(field[2]!.replace(/[\[\]"']/gu, " "));
		} else if (readingList && /^\s+-\s+/u.test(line)) values.push(line.replace(/^\s+-\s+/u, "").replace(/["']/gu, ""));
		else if (/^\S/u.test(line)) readingList = false;
	}
	return { end: close + 1, values: values.filter(Boolean) };
}

/** Physical lines are retained; fenced code cannot invent headings. Long sections split at paragraphs. */
export function parseMarkdownDocument(content: string, fallbackTitle: string): MarkdownDocument {
	const lines = content.split("\n");
	const frontmatter = frontmatterMetadata(lines);
	const sections: Array<{ start: number; end: number; headingPath: string[] }> = [];
	const stack: Array<{ depth: number; text: string }> = [];
	let sectionStart = frontmatter.end;
	let title = "";
	let fence: { marker: string; length: number } | null = null;
	for (let index = frontmatter.end; index < lines.length; index += 1) {
		const line = lines[index]!;
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
		if (fence) {
			if (fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length && !fenceMatch[2]?.trim()) fence = null;
			continue;
		}
		if (fenceMatch && !(fenceMatch[1]!.startsWith("`") && fenceMatch[2]!.includes("`"))) {
			fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
			continue;
		}
		const atx = line.match(/^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/u);
		const setext = index + 1 < lines.length && line.trim() && !/^\s*(?:>|[-*+]\s)/u.test(line)
			? lines[index + 1]!.match(/^ {0,3}(=+|-+)\s*$/u) : null;
		if (!atx && !setext) continue;
		const depth = atx ? atx[1]!.length : setext![1]![0] === "=" ? 1 : 2;
		const text = (atx ? atx[2]!.replace(/\s+#+\s*$/u, "") : line).trim();
		sections.push({ start: sectionStart, end: index, headingPath: stack.map((item) => item.text) });
		while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
		stack.push({ depth, text });
		if (!title) title = text;
		sectionStart = index;
		if (setext) index += 1;
	}
	sections.push({ start: sectionStart, end: lines.length, headingPath: stack.map((item) => item.text) });
	const blocks: MarkdownBlock[] = [];
	for (const section of sections) {
		let start = section.start;
		while (start < section.end && !lines[start]!.trim()) start += 1;
		let length = 0;
		for (let index = start; index < section.end; index += 1) {
			length += lines[index]!.length + 1;
			if (length >= 1000 && !lines[index]!.trim()) {
				pushBlock(start, index);
				start = index + 1;
				length = 0;
			}
		}
		pushBlock(start, section.end);
		function pushBlock(from: number, to: number): void {
			while (from < to && !lines[from]!.trim()) from += 1;
			while (to > from && !lines[to - 1]!.trim()) to -= 1;
			if (from < to) blocks.push({ text: lines.slice(from, to).join("\n"), startLine: from + 1, endLine: to, headingPath: section.headingPath });
		}
	}
	return { title: title || fallbackTitle, metadata: frontmatter.values, blocks };
}

const STOP_WORDS = new Set(["the", "is", "are", "what", "how", "does", "about", "please", "and", "for", "with", "哪些", "什么", "如何", "这个", "一下", "请问", "介绍", "可以", "是否"]);

export function retrievalTokens(query: string): string[] {
	const stripped = query.replace(/\[\[[^\]]+\]\]/gu, " ").toLowerCase();
	const tokens = new Set<string>();
	for (const match of stripped.matchAll(/[\p{Script=Han}]+|[\p{Letter}\p{Number}_-]+/gu)) {
		const value = match[0];
		if (/\p{Script=Han}/u.test(value)) {
			const chars = [...value];
			if (chars.length >= 2 && chars.length <= 12 && !STOP_WORDS.has(value)) tokens.add(value);
			for (let i = 0; i + 1 < chars.length; i += 1) {
				const pair = chars.slice(i, i + 2).join("");
				if (!STOP_WORDS.has(pair)) tokens.add(pair);
			}
		} else if (value.length >= 2 && !STOP_WORDS.has(value)) tokens.add(value);
	}
	return [...tokens].slice(0, 64);
}

/** A literal substring of a block, with its physical line range (no synthetic ellipses). */
export function excerptBlock(block: MarkdownBlock, tokens: string[], maxChars: number): MarkdownBlock {
	if (block.text.length <= maxChars) return block;
	const lower = block.text.toLowerCase();
	const matches = tokens.map((token) => ({ index: lower.indexOf(token), length: token.length })).filter((item) => item.index >= 0);
	matches.sort((a, b) => b.length - a.length || a.index - b.index);
	const matchAt = matches[0]?.index ?? 0;
	let start = Math.max(0, matchAt - Math.floor(maxChars / 3));
	let end = Math.min(block.text.length, start + maxChars);
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(block.text[start]!)) start += 1;
	if (end < block.text.length && /[\uD800-\uDBFF]/u.test(block.text[end - 1]!)) end -= 1;
	const text = block.text.slice(start, end);
	const startLine = block.startLine + (block.text.slice(0, start).match(/\n/gu)?.length ?? 0);
	return { text, startLine, endLine: startLine + (text.match(/\n/gu)?.length ?? 0), headingPath: block.headingPath };
}
