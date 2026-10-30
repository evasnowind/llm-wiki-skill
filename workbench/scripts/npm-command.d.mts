export interface NpmCommandInvocation {
	command: string;
	args: string[];
}

export interface NpmCommandOptions {
	platform?: NodeJS.Platform;
	environment?: Readonly<NodeJS.ProcessEnv>;
	execPath?: string;
	exists?: (candidate: string) => boolean;
}

/** Resolve npm's executable and literal argv without creating a shell. */
export function npmInvocation(args: readonly string[], options?: NpmCommandOptions): NpmCommandInvocation;
