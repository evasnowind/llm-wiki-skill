export interface SourceDiffRow {
	kind: "context" | "added" | "removed";
	text: string;
	beforeLine: number | null;
	afterLine: number | null;
}
export type SourceLineDiff = { mode: "diff"; rows: SourceDiffRow[]; added: number; removed: number }
	| { mode: "parallel"; reason: string };
const MAX_CHARACTERS = 120_000;
const MAX_LINES = 400;
const MAX_LINE_LENGTH = 4000;
const MAX_CELLS = 65_536;

/** Display-only bounded LCS. Raw bytes and full hashes remain owned by the backend. */
export function sourceLineDiff(before: string | null, after: string): SourceLineDiff {
	if ((before?.length ?? 0) + after.length > MAX_CHARACTERS) return { mode: "parallel", reason: "内容超过逐行对照长度限制" };
	const lines = (text: string | null) => text === null || text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
	const left = lines(before);
	const right = lines(after);
	if (left.length > MAX_LINES || right.length > MAX_LINES) return { mode: "parallel", reason: "行数超过逐行对照限制" };
	if ([...left, ...right].some((line) => line.length > MAX_LINE_LENGTH)) return { mode: "parallel", reason: "存在过长单行" };
	const cells = (left.length + 1) * (right.length + 1);
	if (cells > MAX_CELLS) return { mode: "parallel", reason: "逐行对照超过计算预算" };
	const width = right.length + 1;
	const lengths = new Uint16Array(cells);
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			lengths[i * width + j] = left[i] === right[j]
				? 1 + lengths[(i + 1) * width + j + 1]
				: Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
		}
	}
	const rows: SourceDiffRow[] = [];
	let i = 0, j = 0, added = 0, removed = 0;
	while (i < left.length || j < right.length) {
		if (i < left.length && j < right.length && left[i] === right[j]) {
			rows.push({ kind: "context", text: left[i], beforeLine: ++i, afterLine: ++j });
		} else if (i < left.length && (j >= right.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
			rows.push({ kind: "removed", text: left[i], beforeLine: ++i, afterLine: null }); removed++;
		} else {
			rows.push({ kind: "added", text: right[j], beforeLine: null, afterLine: ++j }); added++;
		}
	}
	return { mode: "diff", rows, added, removed };
}

/** Bound fallback DOM size as well as diff computation, without changing fixed input. */
export function sourceParallelText(text: string): { text: string; truncated: boolean } {
	const displayed = text.slice(0, MAX_CHARACTERS / 2).split("\n").slice(0, MAX_LINES).join("\n");
	return { text: displayed, truncated: displayed.length < text.length };
}
