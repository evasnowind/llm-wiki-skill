import { mkdirSync } from "node:fs";
import path from "node:path";

/** A test HOME must also be the real Windows profile and SDK config root. */
export function isolateTestHome(home: string, agentDirectory = path.join(home, ".pi", "agent")): () => void {
	const values: Record<string, string> = {
		HOME: home,
		USERPROFILE: home,
		APPDATA: path.join(home, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: path.join(home, ".config"),
		PI_CODING_AGENT_DIR: agentDirectory,
	};
	for (const directory of [values.APPDATA!, values.LOCALAPPDATA!, values.XDG_CONFIG_HOME!, agentDirectory]) mkdirSync(directory, { recursive: true });
	const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}
