/** Short-lived isolated runs belong to the foreground session that started them. */
const dependents = new WeakMap<object, Set<() => void>>();

export function registerSessionDependent(owner: object, abort: () => void): () => void {
	let callbacks = dependents.get(owner);
	if (!callbacks) {
		callbacks = new Set();
		dependents.set(owner, callbacks);
	}
	callbacks.add(abort);
	return () => {
		callbacks.delete(abort);
		if (callbacks.size === 0) dependents.delete(owner);
	};
}

/** Used by every foreground replacement path, including direct server-side KB selection. */
export function disposeSessionWithDependents(session: { dispose(): void }): void {
	const callbacks = dependents.get(session);
	dependents.delete(session);
	for (const abort of callbacks ?? []) {
		try { abort(); } catch { /* Continue cancelling the other dependent runs. */ }
	}
	session.dispose();
}
