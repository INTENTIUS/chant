/**
 * Workspace reader conformance (#2657, ws-052; published by #2679).
 *
 * A reader of a workspace, such as hud or behold, reads only through the
 * read contract (#2524 D15, ws-017) and writes nothing. This module holds a
 * reader to that, for each read-contract command it lists:
 *
 *   1. The reader's `read(command, args)` returns a document that validates
 *      against that command's output schema, with the contract version this
 *      chant writes.
 *   2. Each read makes exactly one chant call, and that call is the contract
 *      command with the suite's arguments and the command's JSON flag, and
 *      nothing else.
 *   3. What the reader returns is the document chant printed, unchanged.
 *   4. The workspace's files are byte for byte the same after every read.
 *
 * How "touched nothing else" is checked: the reader is built by calling
 * `reader(chant)`, where `chant` is a recording transport. The reader is
 * never given the workspace's path, so the transport is its only way to the
 * workspace, and every call through it is recorded and compared with the
 * contract command (points 2 and 3). Every file under the workspace is
 * hashed before the first read and after the last one (point 4), which
 * catches a write by any route, the transport included.
 *
 * This module ships in `@intentius/chant` as the subpath
 * `@intentius/chant/workspace/conformance` and imports no test runner.
 * {@link runWorkspaceReaderConformance} returns the problems for `node:test`
 * or any runner, {@link checkReaderRead} checks one read, and
 * `@intentius/chant/workspace/conformance/vitest` wraps the same checks in
 * `describe` and `it`.
 *
 * The workspace: inside the chant repository it is `reference-workspace/`.
 * Anywhere else the suite generates one in a temporary directory from the
 * `__fixture__/` this package ships beside this module (a decision kind and record, an
 * app, and a chant member with one composite and one component), declared
 * by `chant workspace init --yes`, so {@link REFERENCE_READS} resolve in
 * both. `workspaceDir` names another workspace with the same files.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { READ_CONTRACT_VERSION } from "../reason-codes";

/** The read-contract commands, as a reader names them. */
export const READ_CONTRACT_COMMANDS = ["ls", "graph", "check", "status", "records", "graph --intent", "graph --composites"] as const;
export type ReadContractCommand = (typeof READ_CONTRACT_COMMANDS)[number];

/**
 * Each command's output schema, beside this module's parent in `src/workspace/`.
 * The write commands' schemas (`records-new`, `records-amend`,
 * `records-review`, #2675) are not here: a reader never runs them.
 */
export const READ_CONTRACT_SCHEMAS: Record<ReadContractCommand, string> = {
  ls: "ls.schema.json",
  graph: "graph.schema.json",
  check: "check.schema.json",
  status: "status.schema.json",
  records: "records.schema.json",
  "graph --intent": "intent.schema.json",
  "graph --composites": "composites.schema.json",
};

/** The flags that ask each command for its JSON document. A reader adds one of these and nothing else. */
export const READ_CONTRACT_JSON_FLAGS: Record<ReadContractCommand, readonly (readonly string[])[]> = {
  ls: [["--json"]],
  graph: [[], ["--json"]],
  check: [["--format", "json"]],
  status: [["--json"]],
  records: [["--json"]],
  "graph --intent": [["--json"]],
  "graph --composites": [[], ["--json"]],
};

/** The arguments the suite passes each read, on the reference workspace or the generated one. */
export const REFERENCE_READS: Record<ReadContractCommand, string[]> = {
  ls: [],
  graph: ["--kind", "decisions/decision.kind.mjs"],
  check: [],
  status: ["dev"],
  records: ["--kind", "decisions/decision.kind.mjs"],
  "graph --intent": ["app/src/server.mjs:19", "--kind", "decisions/decision.kind.mjs"],
  "graph --composites": [],
};

/** One chant run: the arguments after `chant`, and what it printed. */
export interface ChantRun {
  argv: string[];
  status: number | null;
  stdout: string;
  stderr: string;
}

/** How a reader runs chant. It runs in the workspace; the reader never sees the path. */
export interface ChantTransport {
  run(argv: string[]): Promise<ChantRun>;
}

export interface WorkspaceReader {
  /** Run one read-contract command with `args`, and return the parsed JSON document. */
  read(command: ReadContractCommand, args: string[]): Promise<unknown> | unknown;
}

/** Build the reader over the transport the suite gives it. */
export type WorkspaceReaderFactory = (chant: ChantTransport) => WorkspaceReader;

export interface WorkspaceReaderConformanceOptions {
  /**
   * The commands the reader reads. Only these are exercised; any other is
   * not applicable and is reported as skipped. Defaults to every command in
   * {@link READ_CONTRACT_COMMANDS}.
   */
  commands?: readonly ReadContractCommand[];
  /**
   * The workspace to read. Defaults to the chant repository's
   * reference-workspace inside that repository, and to a workspace generated
   * from this package's conformance fixture anywhere else.
   */
  workspaceDir?: string;
  /**
   * The chant to run, as a command and its leading arguments. Defaults to the
   * checkout's CLI through tsx inside the chant repository, and anywhere else
   * to the first `node_modules/.bin/chant` above the current directory, then
   * this package's own `bin/chant`, then `chant` on PATH.
   */
  chantCommand?: string[];
  /** How long one chant run may take, in milliseconds. Default 120000. */
  timeoutMs?: number;
  /**
   * How the reader's chant calls reach chant (#2707). `cli`, the default,
   * runs the command. `mcp` answers each call with the matching tool of one
   * `chant serve mcp` session started in the workspace, and also runs the
   * command, so the suite holds the tool's document to the command's: they
   * must be equal. `check` has no tool and is not applicable over MCP.
   */
  over?: "cli" | "mcp";
}

export interface WorkspaceReaderConformanceConfig extends WorkspaceReaderConformanceOptions {
  /** Short label, used in the suite name. */
  name: string;
  reader: WorkspaceReaderFactory;
}

/** What one read found. */
export interface ReaderReadResult {
  command: ReadContractCommand;
  args: string[];
  problems: string[];
}

/** What {@link runWorkspaceReaderConformance} found. The reader conforms when `problems` is empty. */
export interface WorkspaceReaderConformanceReport {
  /** Every problem, each starting with the command it concerns, or `workspace:` for a changed file. */
  problems: string[];
  /** The commands read, in contract order. */
  checked: ReadContractCommand[];
  /** The commands not in `commands`, so not applicable to this reader. */
  skipped: ReadContractCommand[];
  results: ReaderReadResult[];
  /** The workspace that was read. A generated one is removed before the report is returned. */
  workspaceDir: string;
}

const here = dirname(fileURLToPath(import.meta.url));
/** The package this module ships in: `packages/core` in the repository, `node_modules/@intentius/chant` when installed. */
const packageRoot = resolve(here, "..", "..", "..");
const workspaceSrc = resolve(here, "..");
/**
 * The fixture the generated workspace is copied from, shipped under `src/`.
 * Its `__fixture__` name keeps `chant workspace init` on the chant repository
 * from proposing its projects as members.
 */
export const CONFORMANCE_FIXTURE_DIR = join(here, "__fixture__");

/** The chant repository this module is part of, when it is not an installed copy. */
function chantCheckout(): string | undefined {
  const root = resolve(packageRoot, "..", "..");
  const inCheckout =
    existsSync(join(root, "reference-workspace", "chant.workspace.json")) &&
    existsSync(join(packageRoot, "src", "cli", "main.ts")) &&
    existsSync(join(root, "node_modules", "tsx", "dist", "loader.mjs"));
  return inCheckout ? root : undefined;
}

/** The chant the suite runs when `chantCommand` is not given. */
export function defaultChantCommand(cwd: string = process.cwd()): string[] {
  const checkout = chantCheckout();
  if (checkout) {
    return [process.execPath, "--import", pathToFileURL(join(checkout, "node_modules", "tsx", "dist", "loader.mjs")).href, join(packageRoot, "src", "cli", "main.ts")];
  }
  for (let at = resolve(cwd); ; at = dirname(at)) {
    const bin = join(at, "node_modules", ".bin", "chant");
    if (existsSync(bin)) return [bin];
    if (dirname(at) === at) break;
  }
  // The chant this module shipped with, so the suite and the chant agree on the contract.
  const own = join(packageRoot, "bin", "chant");
  return [existsSync(own) ? own : "chant"];
}

/** The reference workspace in the chant repository, or undefined in an installed copy. */
export function referenceWorkspaceDir(): string | undefined {
  const checkout = chantCheckout();
  return checkout ? join(checkout, "reference-workspace") : undefined;
}

type Validate = ((d: unknown) => boolean) & { errors?: unknown };
const validators = new Map<ReadContractCommand, { validate: Validate; id: string }>();

/** A command's output schema and a draft 2020-12 validator for it, from this package's own ajv 8. */
export function readContractSchema(command: ReadContractCommand): { schema: { $id: string }; validate: Validate } {
  const schema = JSON.parse(readFileSync(join(workspaceSrc, READ_CONTRACT_SCHEMAS[command]), "utf-8")) as { $id: string };
  let v = validators.get(command);
  if (!v) {
    const mod = createRequire(import.meta.url)("ajv/dist/2020") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): Validate };
    v = { validate: new Ajv({ strict: true, allErrors: true }).compile(schema), id: schema.$id };
    validators.set(command, v);
  }
  return { schema, validate: v.validate };
}

/** A digest of every file under `dir`, skipping node_modules. */
export function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(at, e.name), rel);
      else if (e.isFile()) out[rel] = createHash("sha256").update(readFileSync(join(at, e.name))).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

/** The files that differ between two {@link treeDigest}s: added, removed or changed. */
export function treeChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [f, h] of Object.entries(after)) if (before[f] === undefined) out.push(`${f} (added)`);
  else if (before[f] !== h) out.push(`${f} (changed)`);
  for (const f of Object.keys(before)) if (after[f] === undefined) out.push(`${f} (removed)`);
  return out.sort();
}

/**
 * What is wrong with the chant calls one read made: anything but exactly one
 * call, of `workspace <command>` with `args` in order and the command's JSON
 * flag, and nothing else. Empty when the calls conform.
 */
export function readerCallProblems(command: ReadContractCommand, args: string[], calls: string[][]): string[] {
  if (calls.length !== 1) return [`${command}: made ${calls.length} chant calls (${calls.map((c) => c.join(" ")).join("; ")}), expected exactly one`];
  const argv = calls[0];
  const prefix = ["workspace", ...command.split(" ")];
  if (prefix.some((t, i) => argv[i] !== t)) return [`${command}: ran chant ${argv.join(" ")}, which is not workspace ${command}`];
  const rest = argv.slice(prefix.length);
  const at = rest.findIndex((_, i) => args.every((a, j) => rest[i + j] === a));
  if (args.length > 0 && at === -1) return [`${command}: ran chant ${argv.join(" ")}, which does not pass ${args.join(" ")} in order`];
  const extra = args.length > 0 ? [...rest.slice(0, at), ...rest.slice(at + args.length)] : rest;
  const allowed = READ_CONTRACT_JSON_FLAGS[command];
  if (!allowed.some((flags) => flags.length === extra.length && flags.every((f, i) => extra[i] === f))) {
    return [`${command}: ran chant ${argv.join(" ")}; beyond the command and its arguments it may add only ${allowed.map((f) => (f.length ? f.join(" ") : "nothing")).join(" or ")}, and it added ${extra.join(" ") || "nothing"}`];
  }
  return [];
}

/**
 * Everything wrong with one read: the chant calls it made (`calls`, and
 * `printed`, what each printed), and the document the reader returned
 * (`doc`). Checks points 1 to 3 of the suite; empty when the read conforms.
 */
export function checkReaderRead(command: ReadContractCommand, args: string[], calls: string[][], printed: ChantRun[], doc: unknown): string[] {
  const problems = readerCallProblems(command, args, calls);
  if (problems.length > 0) return problems;
  const run = printed[0];
  if (!run || run.stdout.trim() === "") return [`${command}: chant ${calls[0].join(" ")} printed nothing${run?.stderr ? `; stderr: ${run.stderr.trim()}` : ""}`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (e) {
    return [`${command}: chant ${calls[0].join(" ")} printed something that is not JSON (${(e as Error).message}); stderr: ${run.stderr.trim()}`];
  }
  if (!isDeepStrictEqual(doc, parsed)) problems.push(`${command}: the reader must return the document chant printed, unchanged, and it returned something else`);
  const { schema, validate } = readContractSchema(command);
  if (!validate(doc)) problems.push(`${command}: the document does not validate against ${READ_CONTRACT_SCHEMAS[command]}: ${JSON.stringify(validate.errors)}`);
  const head = (doc ?? {}) as { $schema?: unknown; contract?: unknown };
  if (head.$schema !== schema.$id) problems.push(`${command}: $schema is ${JSON.stringify(head.$schema)}, expected ${schema.$id}`);
  if (head.contract !== READ_CONTRACT_VERSION) problems.push(`${command}: contract is ${JSON.stringify(head.contract)}, expected ${READ_CONTRACT_VERSION}`);
  return problems;
}

/** The commands to exercise and the ones skipped, from `commands`. Throws on a name that is not a contract command. */
export function selectCommands(commands?: readonly ReadContractCommand[], over: "cli" | "mcp" = "cli"): { checked: ReadContractCommand[]; skipped: ReadContractCommand[] } {
  const served = over === "mcp" ? READ_CONTRACT_COMMANDS.filter((c) => MCP_READ_TOOLS[c] !== undefined) : [...READ_CONTRACT_COMMANDS];
  if (commands === undefined) return { checked: served, skipped: READ_CONTRACT_COMMANDS.filter((c) => !served.includes(c)) };
  const unknown = commands.filter((c) => !(READ_CONTRACT_COMMANDS as readonly string[]).includes(c));
  if (unknown.length > 0) throw new Error(`not read-contract commands: ${unknown.join(", ")}; the commands are ${READ_CONTRACT_COMMANDS.join(", ")}`);
  if (commands.length === 0) throw new Error("commands is empty; list at least one read-contract command");
  const toolless = commands.filter((c) => !served.includes(c));
  if (toolless.length > 0) throw new Error(`chant serve mcp has no tool for ${toolless.join(", ")}; over MCP the commands are ${served.join(", ")}`);
  return { checked: READ_CONTRACT_COMMANDS.filter((c) => commands.includes(c)), skipped: READ_CONTRACT_COMMANDS.filter((c) => !commands.includes(c)) };
}

// ── Over MCP (#2707) ─────────────────────────────────────────────────────────

/** The `chant serve mcp` tool that answers each read-contract command. `check` has none. */
export const MCP_READ_TOOLS: Partial<Record<ReadContractCommand, string>> = {
  ls: "workspace-ls",
  graph: "workspace-graph",
  status: "workspace-status",
  records: "workspace-records",
  "graph --intent": "workspace-graph",
  "graph --composites": "workspace-graph",
};

/**
 * The tool call that answers `chant <argv>`, a read-contract command with its
 * arguments and JSON flag, or undefined when no tool does. Flags map to the
 * tool's arguments of the same meaning; the JSON flag is dropped, since a tool
 * always returns the document.
 */
export function mcpToolCall(argv: readonly string[]): { name: string; arguments: Record<string, unknown> } | undefined {
  if (argv[0] !== "workspace") return undefined;
  const verb = argv[1];
  const rest = argv.slice(2);
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  const kinds: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = (): string | undefined => rest[++i];
    if (a === "--json") continue;
    if (a === "--format" && rest[i + 1] === "json") {
      i++;
      continue;
    }
    if (a === "--kind") kinds.push(value() ?? "");
    else if (a === "--at") args.at = value();
    else if (a === "--since") args.since = value();
    else if (a === "--compare-to") args.compareTo = value();
    else if (a === "--intent") args.intent = value();
    else if (a === "--current") args.current = true;
    else if (a === "--composites") args.composites = true;
    else if (a.startsWith("-")) return undefined;
    else positional.push(a);
  }
  switch (verb) {
    case "ls":
      return positional.length === 0 && kinds.length === 0 ? { name: "workspace-ls", arguments: args } : undefined;
    case "status":
      return positional.length === 1 && kinds.length === 0 ? { name: "workspace-status", arguments: { ...args, env: positional[0] } } : undefined;
    case "records":
      return positional.length === 0 && kinds.length <= 1 ? { name: "workspace-records", arguments: { ...args, ...(kinds.length ? { kind: kinds[0] } : {}) } } : undefined;
    case "graph":
      return positional.length === 0 ? { name: "workspace-graph", arguments: { ...args, ...(kinds.length ? { kind: kinds } : {}) } } : undefined;
    default:
      return undefined;
  }
}

/** One `chant serve mcp` session over stdio: JSON-RPC lines in, one response line per request out. */
export interface McpSession {
  /** Call a tool and return its structured result, or reject with the error the server gave. */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/**
 * Start `chant serve mcp` in `cwd` and initialize it as `clientInfo`. The
 * server speaks over stdio only (ws-052): nothing here opens a port.
 */
export async function startMcpSession(
  command: string[],
  cwd: string,
  options: { clientInfo?: { name: string; version?: string }; timeoutMs?: number } = {},
): Promise<McpSession> {
  const child = spawn(command[0], [...command.slice(1), "serve", "mcp"], { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { settle: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let stderr = "";
  let buffered = "";
  let next = 1;
  const failAll = (e: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.fail(e);
    }
    pending.clear();
  };
  child.stderr.setEncoding("utf-8").on("data", (s: string) => (stderr += s));
  child.stdout.setEncoding("utf-8").on("data", (s: string) => {
    buffered += s;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) continue;
      pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.error) p.fail(new Error(msg.error.message));
      else p.settle(msg.result);
    }
  });
  child.on("error", (e) => failAll(new Error(`could not start chant serve mcp: ${e.message}`)));
  child.on("close", (code) => failAll(new Error(`chant serve mcp exited (${code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    new Promise((settle, fail) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`chant serve mcp did not answer ${method} in time`));
      }, options.timeoutMs ?? 120_000);
      pending.set(id, { settle, fail, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: options.clientInfo ?? { name: "chant-reader-conformance" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    async call(name, args) {
      const result = (await request("tools/call", { name, arguments: args })) as { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };
      if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
      return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "null");
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=chant", "-c", "user.email=chant@localhost", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A workspace generated for a conformance run, and how to remove it. */
export interface ConformanceWorkspace {
  dir: string;
  dispose(): void;
}

/**
 * Generate the conformance workspace in a temporary directory: copy
 * `__fixture__/`, link this package in as `node_modules/@intentius/chant`
 * so the chant member resolves it, declare the workspace with
 * `chant workspace init --yes --name conformance` and commit it all to a new
 * git repository on `main`.
 */
export function createConformanceWorkspace(options: { chantCommand?: string[]; timeoutMs?: number } = {}): ConformanceWorkspace {
  const chant = options.chantCommand ?? defaultChantCommand();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "chant-reader-conformance-")));
  const dispose = () => rmSync(scratch, { recursive: true, force: true });
  try {
    const dir = join(scratch, "ws");
    cpSync(CONFORMANCE_FIXTURE_DIR, dir, { recursive: true });
    // npm leaves .gitignore out of a package, so it is written here.
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    mkdirSync(join(dir, "node_modules", "@intentius"), { recursive: true });
    symlinkSync(packageRoot, join(dir, "node_modules", "@intentius", "chant"), "junction");
    git(dir, "init", "--quiet", "--initial-branch=main");
    execFileSync(chant[0], [...chant.slice(1), "workspace", "init", "--yes", "--name", "conformance"], {
      cwd: dir,
      env: { ...process.env, ...GIT_ENV, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 120_000,
    });
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "the reader conformance workspace");
    return { dir, dispose };
  } catch (e) {
    dispose();
    const err = e as Error & { stderr?: Buffer | string };
    throw new Error(`could not generate the reader conformance workspace: ${err.message}${err.stderr ? `\n${String(err.stderr)}` : ""}`);
  }
}

/** The workspace and chant a run uses, from its options. `dispose` removes a generated workspace. */
export function conformanceTarget(options: WorkspaceReaderConformanceOptions = {}): { workspaceDir: string; chantCommand: string[]; dispose(): void } {
  const chantCommand = options.chantCommand ?? defaultChantCommand();
  const given = options.workspaceDir ?? referenceWorkspaceDir();
  if (given) return { workspaceDir: given, chantCommand, dispose: () => {} };
  const ws = createConformanceWorkspace({ chantCommand, timeoutMs: options.timeoutMs });
  return { workspaceDir: ws.dir, chantCommand, dispose: ws.dispose };
}

/** Run `command` in `cwd`, collecting what it printed. Resolves, never rejects. */
function runChant(command: string[], argv: string[], cwd: string, timeoutMs: number): Promise<ChantRun> {
  return new Promise((settle) => {
    const child = spawn(command[0], [...command.slice(1), ...argv], { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (s: string) => (stdout += s));
    child.stderr.setEncoding("utf-8").on("data", (s: string) => (stderr += s));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      settle({ argv: [...argv], status: null, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      settle({ argv: [...argv], status, stdout, stderr });
    });
  });
}

/**
 * A transport that runs chant in the workspace `target()` names and records
 * every call and what it printed. `reset()` clears the record before a read.
 */
export function recordingTransport(target: () => { workspaceDir: string; chantCommand: string[] }, timeoutMs = 120_000, over: "cli" | "mcp" = "cli") {
  const calls: string[][] = [];
  const printed: ChantRun[] = [];
  /** Over MCP: where a tool's document and the command's differ. */
  const problems: string[] = [];
  let session: Promise<McpSession> | undefined;
  const viaMcp = async (argv: string[]): Promise<ChantRun> => {
    const t = target();
    const call = mcpToolCall(argv);
    if (!call) return { argv: [...argv], status: null, stdout: "", stderr: `no chant serve mcp tool answers chant ${argv.join(" ")}` };
    session ??= startMcpSession(t.chantCommand, t.workspaceDir, { timeoutMs });
    let doc: unknown;
    try {
      doc = await (await session).call(call.name, call.arguments);
    } catch (e) {
      return { argv: [...argv], status: 1, stdout: "", stderr: `${call.name}: ${(e as Error).message}` };
    }
    // The command the tool stands for, run directly: the two documents must be equal.
    const cli = await runChant(t.chantCommand, argv, t.workspaceDir, timeoutMs);
    let printedDoc: unknown;
    try {
      printedDoc = JSON.parse(cli.stdout);
    } catch {
      printedDoc = undefined;
    }
    if (!isDeepStrictEqual(doc, printedDoc)) problems.push(`${argv.slice(1).join(" ")}: the MCP tool ${call.name} returned a document other than chant ${argv.join(" ")} printed`);
    return { argv: [...argv], status: 0, stdout: JSON.stringify(doc), stderr: "" };
  };
  const transport: ChantTransport = {
    async run(argv) {
      calls.push([...argv]);
      const t = target();
      const run = over === "mcp" ? await viaMcp(argv) : await runChant(t.chantCommand, argv, t.workspaceDir, timeoutMs);
      printed.push(run);
      return run;
    },
  };
  return {
    transport,
    calls,
    printed,
    problems,
    reset() {
      calls.length = 0;
      printed.length = 0;
      problems.length = 0;
    },
    /** Stop the MCP session, when one was started. */
    async close() {
      if (session) (await session.catch(() => undefined))?.close();
      session = undefined;
    },
  };
}

/** Make one read through a recording transport and check it. A reader that throws is a problem, not an error. */
export async function readAndCheck(reader: WorkspaceReader, recorder: ReturnType<typeof recordingTransport>, command: ReadContractCommand): Promise<ReaderReadResult> {
  const args = [...REFERENCE_READS[command]];
  recorder.reset();
  let doc: unknown;
  try {
    doc = await reader.read(command, [...args]);
  } catch (e) {
    const stderr = recorder.printed[0]?.stderr.trim();
    return { command, args, problems: [`${command}: the reader threw: ${(e as Error).message}${stderr ? `; chant's stderr: ${stderr}` : ""}`] };
  }
  return { command, args, problems: [...checkReaderRead(command, args, recorder.calls, recorder.printed, doc), ...recorder.problems] };
}

/**
 * Hold a reader to the read contract, with no test runner: read each listed
 * command once through a recording transport, check the four points, and
 * return what is wrong. The reader conforms when `problems` is empty.
 *
 * ```js
 * import { test } from "node:test";
 * import assert from "node:assert/strict";
 * import { runWorkspaceReaderConformance } from "@intentius/chant/workspace/conformance";
 *
 * test("my reader reads only through the contract", { timeout: 600_000 }, async () => {
 *   const report = await runWorkspaceReaderConformance(myReader, { commands: ["ls", "status"] });
 *   assert.deepEqual(report.problems, []);
 * });
 * ```
 */
export async function runWorkspaceReaderConformance(reader: WorkspaceReaderFactory, options: WorkspaceReaderConformanceOptions = {}): Promise<WorkspaceReaderConformanceReport> {
  const { checked, skipped } = selectCommands(options.commands, options.over);
  const target = conformanceTarget(options);
  const recorder = recordingTransport(() => target, options.timeoutMs, options.over);
  try {
    const built = reader(recorder.transport);
    const before = treeDigest(target.workspaceDir);
    const results: ReaderReadResult[] = [];
    for (const command of checked) results.push(await readAndCheck(built, recorder, command));
    const changed = treeChanges(before, treeDigest(target.workspaceDir));
    const problems = results.flatMap((r) => r.problems);
    if (changed.length > 0) problems.push(`workspace: the reads changed files: ${changed.join(", ")}`);
    return { problems, checked, skipped, results, workspaceDir: target.workspaceDir };
  } finally {
    await recorder.close();
    target.dispose();
  }
}
