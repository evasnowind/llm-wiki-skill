/** Accept filesystem paths exposed by a drag, independently of the browser host OS. */
export function parseDroppedPath(dataTransfer: Pick<DataTransfer, "getData">): string | null {
	for (const type of ["text/uri-list", "text/plain"]) {
		const first = dataTransfer.getData(type).split(/\r?\n/u)
			.map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
		if (!first) continue;
		if (/^file:\/\//iu.test(first)) {
			try {
				const url = new URL(first);
				const pathname = decodeURIComponent(url.pathname);
				if (url.hostname) return `//${url.hostname}${pathname}`;
				// file:///C:/... is a drive path; /C:/... is not an absolute Windows path.
				return pathname.replace(/^\/(?=[a-z]:\/)/iu, "");
			} catch { continue; }
		}
		if (/^(?:\/|~\/|[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/iu.test(first)) return first;
	}
	return null;
}
