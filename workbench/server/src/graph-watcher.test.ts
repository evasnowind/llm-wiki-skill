import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GraphData, GraphLayoutFile } from "@llm-wiki/graph-engine";
import { BashUnavailableError, BASH_UNAVAILABLE_MESSAGE } from "./platform/bash.js";

import {
	graphRebuildFailureMessage,
	GRAPH_REBUILD_FAILURE_LOG_MESSAGE,
	GRAPH_WATCH_STARTED_LOG_MESSAGE,
	GraphRebuildQueue,
	KnowledgeBaseGraphWatcher,
	migrateGraphLayoutPinsForIdentity,
	publishGraphRebuildResult,
	shouldIgnoreGraphWatchPath,
} from "./graph.js";

test("first path-ID refresh migrates legacy pin keys and preserves existing path pins", () => {
	const previous = graphWithNodes([
		{ id: "foo", source_path: "wiki/entities/foo.md" },
		{ id: "already-path", source_path: "wiki/topics/already-path.md" },
	]);
	const next = graphWithNodes([
		{ id: "wiki/entities/foo.md", source_path: "wiki/entities/foo.md" },
		{ id: "wiki/topics/already-path.md", source_path: "wiki/topics/already-path.md" },
	]);
	const layout: GraphLayoutFile = {
		version: 2,
		pins: {
			foo: { x: 10, y: 20, coordinateSpace: "world" },
			"wiki/topics/already-path.md": { x: 30, y: 40, coordinateSpace: "world" },
		},
		updatedAt: "before",
	};

	const result = migrateGraphLayoutPinsForIdentity(previous, next, layout);
	assert.equal(result.changed, true);
	assert.deepEqual(result.migrationWarnings, []);
	assert.deepEqual(result.layout.pins, {
		"wiki/entities/foo.md": { x: 10, y: 20, coordinateSpace: "world" },
		"wiki/topics/already-path.md": { x: 30, y: 40, coordinateSpace: "world" },
	});
	assert.equal("foo" in result.layout.pins, false);

	const targetWins = migrateGraphLayoutPinsForIdentity(previous, next, {
		...layout,
		pins: {
			...layout.pins,
			"wiki/entities/foo.md": { x: 99, y: 88, coordinateSpace: "world" },
		},
	});
	assert.deepEqual(targetWins.layout.pins["wiki/entities/foo.md"], { x: 99, y: 88, coordinateSpace: "world" });
});

test("ambiguous source-path alignment retains legacy pins and reports migration warnings", () => {
	const previous = graphWithNodes([
		{ id: "foo-a", source_path: "wiki/entities/foo.md" },
		{ id: "foo-b", source_path: "wiki/entities/foo.md" },
	]);
	const next = graphWithNodes([{ id: "wiki/entities/foo.md", source_path: "wiki/entities/foo.md" }]);
	const layout: GraphLayoutFile = {
		version: 2,
		pins: { "foo-a": { x: 10, y: 20, coordinateSpace: "world" } },
		updatedAt: "before",
	};

	const result = migrateGraphLayoutPinsForIdentity(previous, next, layout);
	assert.equal(result.changed, false);
	assert.deepEqual(result.layout, layout);
	assert.equal(result.migrationWarnings[0]?.code, "identity_alignment_ambiguous");
});

test("one rebuild writes migrated layout before publishing a warning-aware no-growth event", async () => {
	const kbPath = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-pin-migration-"));
	try {
		const layoutPath = path.join(kbPath, ".wiki-graph-layout.json");
		await mkdir(kbPath, { recursive: true });
		await writeFile(layoutPath, JSON.stringify({
			version: 2,
			pins: {
				foo: { x: 10, y: 20, coordinateSpace: "world" },
				"wiki/topics/already-path.md": { x: 30, y: 40, coordinateSpace: "world" },
			},
			updatedAt: "before",
		}), "utf8");
		const previous = graphWithNodes([
			{ id: "foo", source_path: "wiki/entities/foo.md" },
			{ id: "already-path", source_path: "wiki/topics/already-path.md" },
		]);
		const next = graphWithNodes([
			{ id: "wiki/entities/foo.md", source_path: "wiki/entities/foo.md" },
			{ id: "wiki/topics/already-path.md", source_path: "wiki/topics/already-path.md" },
		]);
		const events: any[] = [];
		await publishGraphRebuildResult({
			kbPath,
			previous,
			next,
			rebuiltAt: "2026-07-20T12:00:00.000Z",
			warningState: {
				summary: null,
				details_status: "unavailable",
				details_unavailable_reason: "legacy_without_summary",
				engine_groups: [],
			},
			publish(event) {
				events.push(event);
			},
		});

		const stored = JSON.parse(await readFile(layoutPath, "utf8"));
		assert.deepEqual(stored.pins, {
			"wiki/entities/foo.md": { x: 10, y: 20, coordinateSpace: "world" },
			"wiki/topics/already-path.md": { x: 30, y: 40, coordinateSpace: "world" },
		});
		assert.equal(events.length, 1);
		assert.deepEqual(events[0].diff.addedNodes, []);
		assert.deepEqual(events[0].diff.removedNodes, []);
		assert.deepEqual(events[0].diff.addedEdges, []);
		assert.deepEqual(events[0].diff.newCommunities, []);
		assert.deepEqual(events[0].diff.migrationWarnings, []);
		assert.equal(events[0].warning_summary, null);
		assert.equal(events[0].warning_details_status, "unavailable");
		assert.deepEqual(await readdir(kbPath), [".wiki-graph-layout.json"]);
	} finally {
		await rm(kbPath, { recursive: true, force: true });
	}
});

test("graph watcher debounces rebuild triggers", async () => {
	const clock = new FakeClock();
	const events = new FakeWatchSource();
	const triggered: string[] = [];
	const watcher = new KnowledgeBaseGraphWatcher({
		createWatcher: (_kbPath, onEvent) => events.create(onEvent),
		triggerRebuild: (kbPath) => {
			triggered.push(kbPath);
			return { ok: true, status: "started" };
		},
		debounceMs: 50,
	});
	using _timers = clock.install();

	watcher.start("/kb");
	events.emit("wiki/a.md");
	events.emit("wiki/b.md");
	assert.deepEqual(triggered, []);
	await clock.advance(49);
	assert.deepEqual(triggered, []);
	await clock.advance(1);
	assert.deepEqual(triggered, ["/kb"]);
	watcher.stop();
});

test("graph watcher ignores external noise and generated graph artifacts", async () => {
	const clock = new FakeClock();
	const events = new FakeWatchSource();
	const triggered: string[] = [];
	const watcher = new KnowledgeBaseGraphWatcher({
		createWatcher: (_kbPath, onEvent) => events.create(onEvent),
		triggerRebuild: (kbPath) => {
			triggered.push(kbPath);
			return { ok: true, status: "started" };
		},
		debounceMs: 10,
	});
	using _timers = clock.install();

	watcher.start("/kb");
	for (const filename of [
		".wiki-tmp/run.json",
		".git/index",
		".obsidian/workspace.json",
		"node_modules/pkg/index.js",
		".DS_Store",
		"wiki/graph-data.json",
		"wiki/graph-warnings.json",
		"generated/custom/graph-data.json",
		"generated/custom/graph-warnings.json",
		"wiki/knowledge-graph.html",
		"wiki/knowledge-graph-dark.html",
		".wiki-graph-layout.json",
	]) {
		assert.equal(shouldIgnoreGraphWatchPath(filename), true, filename);
		events.emit(filename);
	}
	assert.equal(shouldIgnoreGraphWatchPath("generated/custom/not-graph-data.json"), false);
	await clock.advance(20);
	assert.deepEqual(triggered, []);

	events.emit("wiki/topics/new-page.md");
	await clock.advance(10);
	assert.deepEqual(triggered, ["/kb"]);
	watcher.stop();
});

test("graph watcher suspends during batch digest and resumes with one immediate rebuild", async () => {
	const events = new FakeWatchSource();
	const triggered: string[] = [];
	const watcher = new KnowledgeBaseGraphWatcher({
		createWatcher: (_kbPath, onEvent) => events.create(onEvent),
		triggerRebuild: (kbPath) => {
			triggered.push(kbPath);
			return { ok: true, status: "started" };
		},
		debounceMs: 10,
	});

	watcher.start("/kb");
	watcher.suspend("/kb");
	events.emit("wiki/synthesis/sessions/a.md");
	events.emit("wiki/synthesis/sessions/b.md");
	assert.deepEqual(triggered, []);
	watcher.resume("/kb", { trigger: true });
	assert.deepEqual(triggered, ["/kb"]);
	watcher.stop();
});

test("graph rebuild queue merges triggers into one pending rebuild while running", async () => {
	const gates = [deferred<void>(), deferred<void>()];
	const calls: string[] = [];
	let rebuildIndex = 0;
	const queue = new GraphRebuildQueue({
		run: async () => {
			const gate = gates[rebuildIndex++];
			assert.ok(gate);
			calls.push("run");
			await gate.promise;
		},
		onError: (err) => {
			throw err;
		},
	});

	assert.equal(queue.trigger().status, "started");
	assert.equal(queue.trigger().status, "queued");
	assert.equal(queue.trigger().status, "queued");
	await Promise.resolve();
	assert.deepEqual(calls, ["run"]);
	gates[0]?.resolve();
	await waitFor(() => calls.length >= 2);
	assert.deepEqual(calls, ["run", "run"]);
	gates[1]?.resolve();
	await queue.waitForIdle();
	assert.deepEqual(calls, ["run", "run"]);
});

test("graph rebuild failure message is stable and does not expose build paths", () => {
	assert.equal(graphRebuildFailureMessage(new BashUnavailableError()), BASH_UNAVAILABLE_MESSAGE);
	assert.equal(
		graphRebuildFailureMessage(new Error("spawn failed /Users/private/build.sh")),
		"图谱重建失败",
	);
	assert.equal(
		GRAPH_REBUILD_FAILURE_LOG_MESSAGE,
		"[graph] rebuild failed",
	);
	assert.equal(
		GRAPH_WATCH_STARTED_LOG_MESSAGE,
		"[graph] watching knowledge base for graph rebuilds",
	);
});
test("graph rebuild queue recovers to started after a failed run", async () => {
	let attempts = 0;
	const errors: unknown[] = [];
	const queue = new GraphRebuildQueue({
		run: async () => {
			attempts++;
			if (attempts === 1) throw new Error("build failed");
		},
		onError: (err) => errors.push(err),
	});

	assert.equal(queue.trigger().status, "started");
	await queue.waitForIdle();
	assert.equal(errors.length, 1);
	assert.equal(queue.trigger().status, "started");
	await queue.waitForIdle();
	assert.equal(attempts, 2);
});

test("graph rebuild queue runs a queued request after failure and then becomes idle", async () => {
	const firstRun = deferred<void>();
	let attempts = 0;
	const errors: unknown[] = [];
	const queue = new GraphRebuildQueue({
		run: async () => {
			attempts++;
			if (attempts === 1) {
				await firstRun.promise;
				throw new Error("first build failed");
			}
		},
		onError: (err) => errors.push(err),
	});

	assert.equal(queue.trigger().status, "started");
	assert.equal(queue.trigger().status, "queued");
	firstRun.resolve();
	await queue.waitForIdle();
	assert.equal(attempts, 2);
	assert.equal(errors.length, 1);
	assert.equal(queue.trigger().status, "started");
	await queue.waitForIdle();
});

test("graph rebuild queue aborts preparation and drops pending work when stopped", async () => {
	const preparationStarted = deferred<void>();
	const finishPreparation = deferred<void>();
	const signals: AbortSignal[] = [];
	let spawned = 0;
	const errors: unknown[] = [];
	const queue = new GraphRebuildQueue({
		run: async (...args: unknown[]) => {
			const signal = args[0];
			preparationStarted.resolve();
			assert.ok(signal instanceof AbortSignal);
			signals.push(signal);
			await finishPreparation.promise;
			if (signal.aborted) return;
			spawned++;
		},
		onError: (err) => errors.push(err),
	});

	assert.equal(queue.trigger().status, "started");
	assert.equal(queue.trigger().status, "queued");
	await preparationStarted.promise;
	queue.stop();
	finishPreparation.resolve();
	await queue.waitForIdle();

	assert.equal(signals.length, 1);
	assert.equal(signals[0]?.aborted, true);
	assert.equal(spawned, 0);
	assert.deepEqual(errors, []);
});

class FakeWatchSource {
	private onEvent: ((event: { eventType: string; filename: string | null }) => void) | null = null;

	create(onEvent: (event: { eventType: string; filename: string | null }) => void) {
		this.onEvent = onEvent;
		return {
			close: () => {
				this.onEvent = null;
			},
		};
	}

	emit(filename: string): void {
		this.onEvent?.({ eventType: "rename", filename });
	}
}

class FakeClock {
	private now = 0;
	private nextId = 1;
	private tasks = new Map<number, { due: number; callback: () => void }>();
	private originalSetTimeout = globalThis.setTimeout;
	private originalClearTimeout = globalThis.clearTimeout;

	install() {
		const self = this;
		globalThis.setTimeout = ((callback: () => void, ms?: number) => {
			const id = self.nextId++;
			self.tasks.set(id, { due: self.now + Number(ms ?? 0), callback });
			return id as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
			self.tasks.delete(Number(id));
		}) as typeof clearTimeout;
		return {
			[Symbol.dispose]: () => this.restore(),
		};
	}

	async advance(ms: number): Promise<void> {
		this.now += ms;
		const due = Array.from(this.tasks.entries())
			.filter(([, task]) => task.due <= this.now)
			.sort((a, b) => a[1].due - b[1].due);
		for (const [id, task] of due) {
			if (!this.tasks.delete(id)) continue;
			task.callback();
		}
		await Promise.resolve();
	}

	private restore(): void {
		globalThis.setTimeout = this.originalSetTimeout;
		globalThis.clearTimeout = this.originalClearTimeout;
		this.tasks.clear();
	}
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	assert.equal(predicate(), true);
}

function graphWithNodes(nodes: Array<{ id: string; source_path: string }>): GraphData {
	return {
		meta: {
			build_date: "2026-07-20T00:00:00.000Z",
			wiki_title: "Migration",
			total_nodes: nodes.length,
			total_edges: 0,
		},
		nodes: nodes.map((node) => ({ ...node, label: node.id, type: "topic" })),
		edges: [],
	};
}
