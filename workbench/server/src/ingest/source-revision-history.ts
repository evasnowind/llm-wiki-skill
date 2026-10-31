import path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { APP_DIR } from "../config.js";
import { readOptional } from "./storage.js";

/** An exact path+hash allowlist: unknown or externally edited files stay visible. */
export async function managedHistoricalHashes(kbPath: string, stateRoot = path.join(APP_DIR, "ingest")): Promise<Map<string, string>> {
	try {
		const canonicalKbPath = await realpath(kbPath);
		const directory = createHash("sha256").update(canonicalKbPath).digest("hex");
		const raw = await readOptional(stateRoot, path.join(stateRoot, directory, "revisions.json"));
		if (!raw) return new Map();
		const store = JSON.parse(raw) as { version: number; kbPath: string; sources: Array<{ currentVersionId: string; outputPath: string }>; versions: Array<{ id: string; rawPath: string; rawHash: string; summaryPath: string; summaryHash: string }> };
		if (store.version !== 1 || store.kbPath !== canonicalKbPath || !Array.isArray(store.sources) || !Array.isArray(store.versions)) return new Map();
		const current = new Set<string>();
		for (const source of store.sources) {
			const version = store.versions.find((item) => item.id === source.currentVersionId);
			if (version) { current.add(version.rawPath); current.add(source.outputPath); }
		}
		const result = new Map<string, string>();
		for (const version of store.versions) for (const [relative, hash] of [[version.rawPath, version.rawHash], [version.summaryPath, version.summaryHash]]) {
			if (typeof relative === "string" && /^(?:raw\/notes\/[a-f0-9]{64}\.(?:md|txt)|wiki\/sources\/[a-f0-9]{64}\.md)$/.test(relative) && /^[a-f0-9]{64}$/.test(hash!) && !current.has(relative)) result.set(relative, hash!);
		}
		return result;
	} catch { return new Map(); }
}
