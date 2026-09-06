import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; stdin?: string; timeoutMs?: number; maxOutputBytes?: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let executable = command;
    let executableArgs = args;
    if (process.platform === "win32" && command === "npm") {
      const bundledNpm = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      const npmCli = process.env.npm_execpath || (fs.existsSync(bundledNpm) ? bundledNpm : "");
      if (npmCli) {
        executable = process.execPath;
        executableArgs = [npmCli, ...args];
      }
    }
    const useShell = process.platform === "win32" && (executable === "npm" || /\.(cmd|bat)$/i.test(executable));
    const child = spawn(executable, executableArgs, {
      cwd: options.cwd,
      env: process.env,
      shell: useShell,
      windowsHide: true,
    });
    const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= maxOutputBytes) return current;
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next) > maxOutputBytes ? next.slice(0, maxOutputBytes) : next;
    };

    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr, timedOut }));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs ?? 30 * 60_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}
