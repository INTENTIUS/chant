/**
 * Runtime adapter — abstracts Bun-specific APIs so chant can run on Bun or Node.js.
 *
 * Auto-detects the host runtime and delegates to the appropriate implementation.
 * The `target` parameter (from config) controls what gets spawned (bun vs node/npx/npm),
 * not which adapter class is used.
 */
import { dirname } from "path";
import { fileURLToPath } from "url";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RuntimeCommands {
  /** Runtime binary: "bun" | "node" */
  runner: string;
  /** Package executor: "bunx" | "npx" */
  exec: string;
  /** Pack command: ["bun", "pm", "pack"] | ["npm", "pack"] */
  packCmd: string[];
}

export interface RuntimeAdapter {
  readonly name: "bun" | "node";
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

// ── Bun adapter ──────────────────────────────────────────────────

class BunRuntimeAdapter implements RuntimeAdapter {
  readonly name = "bun" as const;
  readonly hashAlgorithm = "xxhash64";
  readonly commands: RuntimeCommands;

  constructor(target: "bun" | "node") {
    this.commands =
      target === "node"
        ? { runner: "node", exec: "npx", packCmd: ["npm", "pack"] }
        : { runner: "bun", exec: "bunx", packCmd: ["bun", "pm", "pack"] };
  }

  hash(content: string): string {
    return Bun.hash(content).toString(16);
  }

  globMatch(pattern: string, filePath: string): boolean {
    const glob = new Bun.Glob(pattern);
    return glob.match(filePath);
  }

  async spawn(cmd: string[], opts?: { cwd?: string }): Promise<SpawnResult> {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }
}

// ── Node adapter ─────────────────────────────────────────────────

class NodeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "node" as const;
  readonly hashAlgorithm = "sha256";
  readonly commands: RuntimeCommands;

  constructor(target: "bun" | "node") {
    this.commands =
      target === "bun"
        ? { runner: "bun", exec: "bunx", packCmd: ["bun", "pm", "pack"] }
        : { runner: "node", exec: "npx", packCmd: ["npm", "pack"] };
  }

  hash(content: string): string {
    // Dynamic import to avoid pulling in crypto under Bun
    const { createHash } = require("crypto") as typeof import("crypto");
    return createHash("sha256").update(content).digest("hex");
  }

  globMatch(pattern: string, filePath: string): boolean {
    // picomatch is a regular dependency, only loaded under Node
    const picomatch = require("picomatch") as typeof import("picomatch");
    return picomatch(pattern)(filePath);
  }

  async spawn(cmd: string[], opts?: { cwd?: string }): Promise<SpawnResult> {
    const { execFile } = require("child_process") as typeof import("child_process");
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
 * Detect whether we're running under Bun.
 */
function isBun(): boolean {
  return typeof globalThis.Bun !== "undefined";
}

/**
 * Initialize the runtime adapter singleton.
 *
 * @param target - Which commands to spawn ("bun" or "node"). Defaults to auto-detect.
 *   Controls the `commands` property, not which adapter class is used.
 */
export function initRuntime(target?: "bun" | "node"): RuntimeAdapter {
  const resolvedTarget = target ?? (isBun() ? "bun" : "node");
  _runtime = isBun()
    ? new BunRuntimeAdapter(resolvedTarget)
    : new NodeRuntimeAdapter(resolvedTarget);
  return _runtime;
}

/**
 * Get the runtime adapter. Lazily initializes with auto-detection if not yet set.
 */
export function getRuntime(): RuntimeAdapter {
  if (!_runtime) {
    return initRuntime();
  }
  return _runtime;
}

/**
 * Convert `import.meta.url` to a directory path.
 * Works on both Bun and Node (replaces Bun-only `import.meta.dir`).
 */
export function moduleDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
