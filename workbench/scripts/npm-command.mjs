import { existsSync } from "node:fs";
import path from "node:path";

/** Run npm through Node on Windows: .cmd files are not executables for spawn(). */
export function npmInvocation(args, {
	platform = process.platform,
	environment = process.env,
	execPath = process.execPath,
	exists = existsSync,
} = {}) {
	if (platform !== "win32") return { command: "npm", args: [...args] };
	const value = (key) => Object.entries(environment).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
	const executableDirectory = path.win32.dirname(execPath);
	const searchPath = (value("PATH") ?? "").split(";").map((directory) => directory.replace(/^"|"$/g, "")).filter(Boolean);
	const npmExecPath = value("npm_execpath");
	const candidates = [
		...(npmExecPath && path.win32.basename(npmExecPath).toLowerCase() === "npm-cli.js" ? [npmExecPath] : []),
		...[executableDirectory, ...searchPath].map((directory) => path.win32.join(directory, "node_modules", "npm", "bin", "npm-cli.js")),
	];
	const cli = [...new Set(candidates)].find((candidate) => exists(candidate));
	if (!cli) throw new Error("Cannot locate npm CLI on Windows. Install npm with Node.js or run this entry through npm.");
	return { command: execPath, args: [cli, ...args] };
}
