/**
 * Store the change set a gate binds (#4022), mapped onto the member's graph.
 *
 * {@link storeGateChangeSet} is what a gate that binds a change-set document's
 * digest calls before it decides the gate: `components pr-apply` today, and a
 * release gate and an `empty` resolution with #4045. It reads the member's
 * graph the way `chant workspace graph` reads it, from the member's own
 * `chant graph --format ir`, maps each entry onto a node
 * (`../change-set-graph.ts`), and stores the document under its digest
 * (`./change-set-store.ts`).
 *
 * The graph is read only when the digest is not stored yet. A graph that
 * can't be read never stops the gate: the document is stored with `graph:
 * null` and every `node` null, and the caller gets a warning to print.
 */

import { spawn } from "node:child_process";
import { mapChangeSetToGraph, type ChangeSetGraphNodes } from "../change-set-graph";
import type { ChangeSetDocument, ChangeSetGraph } from "../change-set";
import { persistChangeSet, readStoredChangeSet } from "./change-set-store";
import { resolveMemberLedger } from "./member-ledger";

/** Reads the node ids of the graph of the project at `projectDir`. */
export type GraphIdReader = (projectDir: string) => Promise<{ ids: string[] } | { error: string }>;

const GRAPH_TIMEOUT_MS = 300_000;

/**
 * The node ids of `chant graph --format ir` in `projectDir`, run under the
 * chant that directory resolves (its own `node_modules/.bin/chant`, else this
 * one), as `chant workspace graph` runs each member. `args` are passed after
 * `graph --format ir`, such as the run's `--param` flags.
 */
export async function readGraphIds(projectDir: string, args: readonly string[] = []): Promise<{ ids: string[] } | { error: string }> {
  const { readerToolchain, resolveToolchain } = await import("../workspace/member-commands");
  const { readMemberIr } = await import("../workspace/compose-graph");
  const { findWorkspaceRoot } = await import("../project-root");
  const root = findWorkspaceRoot(projectDir)?.dir ?? projectDir;
  const toolchain = resolveToolchain(projectDir, root, readerToolchain());
  const [command, ...pre] = toolchain.command;
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(command, [...pre, "graph", "--format", "ir", ...args], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GRAPH_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
  if (out.code !== 0) {
    const line = out.stderr.split("\n").map((l) => l.trim()).find(Boolean);
    return { error: `chant graph --format ir exited ${out.code ?? "on a signal"}${line ? `: ${line}` : ""}` };
  }
  const read = readMemberIr(out.stdout);
  if ("reason" in read) return { error: read.reason.message };
  return { ids: read.ir.nodes.map((n) => n.id) };
}

let graphReaderOverride: GraphIdReader | undefined;

/**
 * Replace how a gate reads the graph wherever the default is taken, such as
 * in `components pr-apply`; `undefined` restores {@link readGraphIds}. For
 * tests that drive a gate and read node ids in process, so they don't start a
 * `chant graph` child process (`gate-change-set.e2e.test.ts` covers that one).
 */
export function setGraphIdReader(reader: GraphIdReader | undefined): void {
  graphReaderOverride = reader;
}

/** The graph reader a gate uses: the one {@link setGraphIdReader} set, else {@link readGraphIds} with `args`. */
export function gateGraphReader(args: readonly string[] = []): GraphIdReader {
  return graphReaderOverride ?? ((dir) => readGraphIds(dir, args));
}

export interface StoreGateChangeSetInput {
  /** The document whose `digest` the gate binds. */
  doc: ChangeSetDocument;
  /** The member's directory: where the graph is read and whose ledger it is stored in. */
  cwd: string;
  /** The commit the document was planned at, recorded as the graph's `at`. */
  at?: string | null;
  /** How to read the graph. Defaults to {@link gateGraphReader}. */
  readGraph?: GraphIdReader;
}

export interface StoreGateChangeSetResult {
  digest: string;
  /** True when this call wrote the document; false when it was stored already. */
  written: boolean;
  /** The graph the stored document's nodes come from, null when none could be read. Absent when it was stored already. */
  graph?: ChangeSetGraph | null;
  /** Why no graph was read, when none was. */
  warning?: string;
}

/**
 * Store `doc` under its digest in the member's ledger at `cwd`, mapped onto
 * the member's graph, unless it is stored already. Does not push; the gate's
 * pending fact or resolution pushes the branch after it.
 */
export async function storeGateChangeSet(input: StoreGateChangeSetInput): Promise<StoreGateChangeSetResult> {
  const { doc, cwd } = input;
  const loc = { cwd };
  if ((await readStoredChangeSet(doc.digest, loc)).status !== "missing") return { digest: doc.digest, written: false };
  const ledger = await resolveMemberLedger(cwd);
  const member = ledger.members.length > 0 ? ledger.members.join("/") : null;
  let nodes: ChangeSetGraphNodes | null = null;
  let warning: string | undefined;
  try {
    const read = await (input.readGraph ?? gateGraphReader())(cwd);
    if ("error" in read) warning = read.error;
    else nodes = { member, at: input.at ?? null, ids: read.ids };
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
  }
  const mapped = mapChangeSetToGraph(doc, nodes);
  const { written } = await persistChangeSet(mapped, loc);
  return {
    digest: doc.digest,
    written,
    graph: mapped.graph ?? null,
    ...(warning ? { warning: `the change set is stored without graph nodes: ${warning}` } : {}),
  };
}
