/**
 * Runtime adapter — abstracts child-process and filesystem APIs for chant.
 *
 * The `target` parameter (from config) controls what commands get spawned
 * (node/npx/npm), not which adapter class is used.
 */
import { dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { execFile } from "child_process";
// @ts-ignore — picomatch has no types declaration
import picomatch from "picomatch";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RuntimeCommands {
  /** Runtime binary: "node" */
  runner: string;
  /** Package executor: "npx" */
  exec: string;
  /** Pack command: ["npm", "pack"] */
  packCmd: string[];
}

export interface RuntimeAdapter {
  readonly name: "node";
  /** Hash content and return hex string */
  hash(content: string): string;
  /** Algorithm name recorded in integrity.json */
  readonly hashAlgorithm: string;
  /** Test whether filePath matches a glob pattern */
  globMatch(pattern: string, filePath: string): boolean;
  /** Spawn a child process and collect output */
  spawn(cmd: string[], opts?: { cwd?: string }): Promise<SpawnResult>;
  /** Commands to use when spawning package manager / executor */
  readonly commands: RuntimeCommands;
}

// ── Node adapter ─────────────────────────────────────────────────

class NodeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "node" as const;
  readonly hashAlgorithm = "sha256";
  readonly commands: RuntimeCommands;

  constructor() {
    this.commands = { runner: "node", exec: "npx", packCmd: ["npm", "pack"] };
  }

  hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  globMatch(pattern: string, filePath: string): boolean {
    return picomatch(pattern)(filePath);
  }

  async spawn(cmd: string[], opts?: { cwd?: string }): Promise<SpawnResult> {
    return new Promise((resolve) => {
      execFile(cmd[0], cmd.slice(1), { cwd: opts?.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: err ? (err as any).code ?? 1 : 0,
        });
      });
    });
  }
}

// ── Singleton ────────────────────────────────────────────────────

let _runtime: RuntimeAdapter | undefined;

/**
 * Initialize the runtime adapter singleton.
 */
export function initRuntime(): RuntimeAdapter {
  _runtime = new NodeRuntimeAdapter();
  return _runtime;
}

/**
 * Get the runtime adapter. Lazily initializes if not yet set.
 */
export function getRuntime(): RuntimeAdapter {
  if (!_runtime) {
    return initRuntime();
  }
  return _runtime;
}

/**
 * Convert `import.meta.url` to a directory path.
 */
export function moduleDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
