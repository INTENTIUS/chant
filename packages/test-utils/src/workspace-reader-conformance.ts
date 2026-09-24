/**
 * Workspace reader conformance (#2657, ws-052).
 *
 * A reader of a workspace, such as hud or behold, reads only through the
 * read contract (#2524 D15, ws-017) and writes nothing. This suite holds a
 * reader to that:
 *
 *   1. For each read-contract command (`ls`, `graph`, `check`, `status`,
 *      `records`, `graph --intent`), the reader's `read(command, args)`
 *      returns a document that validates against that command's output
 *      schema, with the contract version this chant writes.
 *   2. Each read makes exactly one chant call, and that call is the contract
 *      command with the suite's arguments and the command's JSON flag, and
 *      nothing else.
 *   3. What the reader returns is the document chant printed, unchanged.
 *   4. The workspace's files are byte for byte the same after every read.
 *
 * How "touched nothing else" is checked: the suite builds the reader by
 * calling `config.reader(chant)`, where `chant` is a recording transport.
 * The reader is never given the workspace's path, so the transport is its
 * only way to the workspace, and every call through it is recorded and
 * compared with the contract command (points 2 and 3). The suite also
 * hashes every file under the workspace before the first read and after the
 * last one (point 4), which catches a write by any route, the transport
 * included.
 *
 * The workspace is this repository's `reference-workspace/` unless
 * `workspaceDir` names another with the same decisions, members and
 * history. `chantCommand` is the chant to run; by default it is this
 * checkout's CLI through tsx.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { READ_CONTRACT_VERSION } from "../../core/src/workspace/reason-codes";

/** The read-contract commands, as a reader names them. */
export const READ_CONTRACT_COMMANDS = ["ls", "graph", "check", "status", "records", "graph --intent"] as const;
export type ReadContractCommand = (typeof READ_CONTRACT_COMMANDS)[number];

/** Each command's output schema, in `packages/core/src/workspace/`. */
export const READ_CONTRACT_SCHEMAS: Record<ReadContractCommand, string> = {
  ls: "ls.schema.json",
  graph: "graph.schema.json",
  check: "check.schema.json",
  status: "status.schema.json",
  records: "records.schema.json",
  "graph --intent": "intent.schema.json",
};

/** The flags that ask each command for its JSON document. A reader adds one of these and nothing else. */
export const READ_CONTRACT_JSON_FLAGS: Record<ReadContractCommand, readonly (readonly string[])[]> = {
  ls: [["--json"]],
  graph: [[], ["--json"]],
  check: [["--format", "json"]],
  status: [["--json"]],
  records: [["--json"]],
  "graph --intent": [["--json"]],
};

/** The arguments the suite passes each read on the reference workspace. */
export const REFERENCE_READS: Record<ReadContractCommand, string[]> = {
  ls: [],
  graph: ["--kind", "decisions/decision.kind.mjs"],
  check: [],
  status: ["dev"],
  records: ["--kind", "decisions/decision.kind.mjs"],
  "graph --intent": ["app/src/server.mjs:19", "--kind", "decisions/decision.kind.mjs"],
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

export interface WorkspaceReaderConformanceConfig {
  /** Short label, used in the suite name. */
  name: string;
  /** Build the reader over the transport the suite gives it. */
  reader: (chant: ChantTransport) => WorkspaceReader;
  /** The workspace to read. Defaults to this repository's reference-workspace. */
  workspaceDir?: string;
  /** The chant to run, as a command and its leading arguments. Defaults to this checkout's CLI through tsx. */
  chantCommand?: string[];
}

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const workspaceSrc = join(repoRoot, "packages", "core", "src", "workspace");

function defaultChant(): string[] {
  return [process.execPath, "--import", pathToFileURL(join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href, join(repoRoot, "packages", "core", "src", "cli", "main.ts")];
}

type Validate = ((d: unknown) => boolean) & { errors?: unknown };
/** A draft 2020-12 validator, from core's own ajv 8. */
function compile2020(schema: object): Validate {
  const mod = createRequire(join(repoRoot, "packages", "core", "package.json"))("ajv/dist/2020") as { default?: unknown };
  const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): Validate };
  return new Ajv({ strict: true, allErrors: true }).compile(schema);
}

/** A digest of every file under `dir`, skipping node_modules. */
export function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else if (e.isFile()) out[rel] = createHash("sha256").update(readFileSync(join(d, e.name))).digest("hex");
    }
  };
  walk(dir, "");
  return out;
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

export function describeWorkspaceReaderConformance(config: WorkspaceReaderConformanceConfig): void {
  const workspaceDir = config.workspaceDir ?? join(repoRoot, "reference-workspace");
  const chantCommand = config.chantCommand ?? defaultChant();
  const calls: string[][] = [];
  const printed: ChantRun[] = [];
  const transport: ChantTransport = {
    async run(argv) {
      calls.push([...argv]);
      const r = spawnSync(chantCommand[0], [...chantCommand.slice(1), ...argv], {
        cwd: workspaceDir,
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, NO_COLOR: "1" },
      });
      const run = { argv: [...argv], status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      printed.push(run);
      return run;
    },
  };

  describe(`workspace reader conformance (#2657): ${config.name}`, () => {
    let before: Record<string, string> | undefined;
    const reader = config.reader(transport);

    for (const command of READ_CONTRACT_COMMANDS) {
      it(
        `${command}: reads through chant workspace ${command} alone, and returns a document that validates against ${READ_CONTRACT_SCHEMAS[command]}`,
        async () => {
          before ??= treeDigest(workspaceDir);
          const args = REFERENCE_READS[command];
          calls.length = 0;
          printed.length = 0;
          const doc = (await reader.read(command, [...args])) as Record<string, unknown>;

          expect(readerCallProblems(command, args, calls)).toEqual([]);
          expect(printed[0].stdout.trim(), `chant ${printed[0].argv.join(" ")} printed nothing; stderr: ${printed[0].stderr}`).not.toBe("");
          expect(doc, "the reader must return the document chant printed, unchanged").toEqual(JSON.parse(printed[0].stdout));

          const schema = JSON.parse(readFileSync(join(workspaceSrc, READ_CONTRACT_SCHEMAS[command]), "utf-8")) as { $id: string };
          const validate = compile2020(schema);
          expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
          expect(doc.$schema).toBe(schema.$id);
          expect(doc.contract).toBe(READ_CONTRACT_VERSION);
        },
        120_000,
      );
    }

    it("leaves every file in the workspace as it was", () => {
      expect(before, "no read ran").toBeDefined();
      expect(treeDigest(workspaceDir)).toEqual(before);
    });
  });
}
