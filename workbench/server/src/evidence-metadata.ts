import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { EvidenceCitationsSchema, RetrievalModeSchema, type EvidenceCitation, type RetrievalMode } from "@llm-wiki/workbench-contracts";

export const TURN_EVIDENCE_CUSTOM_TYPE = "llm-wiki-turn-evidence-v1";
export interface TurnEvidence {
	userEntryId: string;
	runId: string;
	mode: RetrievalMode;
	evidence: EvidenceCitation[];
}

export function branchEntryIds(manager: Pick<SessionManager, "getBranch"> | undefined): Set<string> {
	return new Set(manager?.getBranch().map((entry) => entry.id) ?? []);
}

/** Only an actual user entry created by this run can own its evidence. */
export function persistTurnEvidence(
	manager: Pick<SessionManager, "getBranch" | "appendCustomEntry"> | undefined,
	before: ReadonlySet<string>,
	input: Omit<TurnEvidence, "userEntryId">,
): string | null {
	if (!manager) return null;
	const userEntry = manager.getBranch().find((entry) => !before.has(entry.id) && entry.type === "message" && entry.message.role === "user");
	if (!userEntry) return null;
	manager.appendCustomEntry(TURN_EVIDENCE_CUSTOM_TYPE, { ...input, userEntryId: userEntry.id });
	return userEntry.id;
}

export function readTurnEvidence(branch: readonly SessionEntry[]): Map<string, TurnEvidence> {
	const users = new Set(branch.filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => entry.id));
	const result = new Map<string, TurnEvidence>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== TURN_EVIDENCE_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<TurnEvidence> | undefined;
		if (!data || typeof data.userEntryId !== "string" || !users.has(data.userEntryId) || typeof data.runId !== "string") continue;
		const mode = RetrievalModeSchema.safeParse(data.mode);
		const evidence = EvidenceCitationsSchema.safeParse(data.evidence);
		if (mode.success && evidence.success) result.set(data.userEntryId, { userEntryId: data.userEntryId, runId: data.runId, mode: mode.data, evidence: evidence.data });
	}
	return result;
}

/** Match from the leaf backwards, so compacted identical questions cannot steal a newer turn. */
export function userEntryIdsForMessages(messages: AgentMessage[], branch: readonly SessionEntry[]): Map<number, string> {
	const result = new Map<number, string>();
	const users = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
	let cursor = users.length - 1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		for (; cursor >= 0; cursor--) {
			const entry = users[cursor];
			if (entry?.type === "message" && (entry.message === message || JSON.stringify(entry.message) === JSON.stringify(message))) {
				result.set(index, entry.id);
				cursor--;
				break;
			}
		}
	}
	return result;
}
