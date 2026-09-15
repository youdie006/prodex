import type { ExecFileOptions } from "node:child_process";

export interface NpmCliResolutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}

export function resolveNpmCliPath(options?: NpmCliResolutionOptions): string;

export function execNpm(
  args: readonly string[],
  options?: ExecFileOptions
): Promise<{ stdout: string; stderr: string }>;
