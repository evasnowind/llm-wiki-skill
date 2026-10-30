import { execFile, type ExecFileOptions } from "node:child_process";
import path from "node:path";

export const DIRECTORY_PICKER_TIMEOUT_MS = 5 * 60_000;
export const DIRECTORY_PICKER_FAILURE_MESSAGE = "无法打开文件夹选择器，请重试或手动输入路径";
export const DIRECTORY_PICKER_TIMEOUT_MESSAGE = "文件夹选择超时，请重试";

export interface DirectoryPickerCommand {
	file: string;
	args: string[];
	options: ExecFileOptions & { encoding: "utf8" };
}

export type DirectoryPickerRunner = (command: DirectoryPickerCommand) => Promise<string>;

export interface DirectoryPickerOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	run?: DirectoryPickerRunner;
}

// The script is constant: no paths or other user input are interpolated into PowerShell.
const WINDOWS_DIRECTORY_PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
    $dialog.Description = '选择知识库文件夹'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Out.Write($dialog.SelectedPath)
    }
} finally {
    $dialog.Dispose()
}
`.trim();

/** Selects a directory in the current desktop; validation/registration stay with the caller. */
export async function chooseSystemDirectory(input: DirectoryPickerOptions = {}): Promise<string | null> {
	const platform = input.platform ?? process.platform;
	if (platform !== "darwin" && platform !== "win32") {
		throw pickerError("ENOTSUP", "当前系统暂不支持文件夹选择器");
	}
	if (input.signal?.aborted) return null;

	const env = input.env ?? process.env;
	const systemRoot = [env.SystemRoot, env.SYSTEMROOT, env.WINDIR].find((value) => value && path.win32.isAbsolute(value)) ?? "C:\\Windows";
	const options: DirectoryPickerCommand["options"] = {
		encoding: "utf8",
		env: { ...env },
		shell: false,
		windowsHide: true,
		timeout: DIRECTORY_PICKER_TIMEOUT_MS,
		killSignal: "SIGTERM",
		maxBuffer: 128 * 1024,
		...(input.signal ? { signal: input.signal } : {}),
	};
	const command: DirectoryPickerCommand = platform === "win32"
		? {
			file: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_DIRECTORY_PICKER_SCRIPT, "utf16le").toString("base64")],
			options,
		}
		: {
			file: "/usr/bin/osascript",
			args: ["-e", 'POSIX path of (choose folder with prompt "选择知识库文件夹")'],
			options,
		};

	try {
		const output = await (input.run ?? runDirectoryPicker)(command);
		if (input.signal?.aborted) return null;
		const selectedPath = output.replace(/^\uFEFF/u, "").trim();
		if (!selectedPath) {
			if (platform === "win32") return null;
			throw pickerError("EMPTY_SELECTION", "没有选择文件夹");
		}
		const isAbsolute = platform === "win32" ? path.win32.isAbsolute(selectedPath) : path.posix.isAbsolute(selectedPath);
		if (!isAbsolute || selectedPath.includes("\0")) {
			throw pickerError("DIRECTORY_PICKER_FAILED", "无法读取所选文件夹");
		}
		return selectedPath;
	} catch (error) {
		if (input.signal?.aborted || errorCode(error) === "ABORT_ERR" || (platform === "darwin" && isDirectoryPickerCancellation(error))) return null;
		if (errorCode(error) === "EMPTY_SELECTION") throw error;
		if (errorCode(error) !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && error && typeof error === "object" && "killed" in error && error.killed === true) {
			throw pickerError("DIRECTORY_PICKER_TIMEOUT", DIRECTORY_PICKER_TIMEOUT_MESSAGE);
		}
		throw pickerError("DIRECTORY_PICKER_FAILED", DIRECTORY_PICKER_FAILURE_MESSAGE);
	}
}

/** Keep the dialog in this directly owned process, so timeout/abort also dismisses its UI. */
function runDirectoryPicker(command: DirectoryPickerCommand): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command.file, command.args, command.options, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

export function isDirectoryPickerCancellation(error: unknown): boolean {
	if (errorCode(error) === "ABORT_ERR") return true;
	const message = error instanceof Error ? error.message : "";
	return message.includes("-128") || message.toLowerCase().includes("user canceled");
}

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function pickerError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}
