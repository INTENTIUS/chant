/**
 * Read-only expansion of nested workspaces in `chant workspace graph`
 * (#2551, #2524 D2, ws-007, ws-071).
 *
 * A member of kind `workspace` holds its own `chant.workspace.json`. The outer
 * workspace never runs commands inside it and never writes there. It reads
 * it the way it reads any member: through the nested workspace's own
 * command, `chant workspace graph`, started in the nested root. That command
 * hands itself to the nested workspace's own chant when it has one (ws-021),
 * so the nested side is read under its own toolchain, and the answer is a
 * document of the read contract the outer chant validates before using it.
 *
 * The nested document is folded into the outer one with every id prefixed by
 * the outer member's name, so a node `delivery/web::Bucket` of the nested
 * workspace becomes `reference-workspace/delivery/web::Bucket`: `outer/inner/id`.
 * Each node keeps the nested member it came from in `nested`, and the outer
 * member entry carries the nested workspace's own member list and links.
 *
 * Nothing here writes: the nested read is a read (its per-member cache lives
 * in the user's cache directory, ws-059), and the outer side keeps nothing.
 */

import { spawn } from "node:child_process";
import type { ParsedArgs } from "../cli/registry";
import type { ComposedMember, ComposedNode, WorkspaceGraph } from "./compose-graph";

export type { NestedWorkspace } from "./compose-graph";
import { readerToolchain, type Toolchain } from "./member-commands";

/** What reading one nested workspace gave. */
export type NestedRead =
  | { ok: true; chant: string | null; doc: WorkspaceGraph & { contract: number; chant?: string } }
  | { ok: false; chant: string | null; code: "command-failed" | "output-unreadable" | "ir-version-unsupported"; message: string };

/** The command line of the nested read: the outer command's own read flags, passed on. */
export function nestedArgv(dir: string, args: Partial<ParsedArgs>, at: string | null | undefined): string[] {
  return [
    "workspace",
    "graph",
    dir,
    ...(at ? ["--at", at] : []),
    ...(args.env ? ["--env", args.env] : []),
    ...(args.live ? ["--live"] : []),
    ...(args.overlay ? ["--overlay"] : []),
    ...(args.traffic !== undefined ? ["--traffic", String(args.traffic)] : []),
    ...(args.noCache ? ["--no-cache"] : []),
  ];
}

function spawnRead(command: string[], argv: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [bin, ...pre] = command;
  return new Promise((done) => {
    const child = spawn(bin, [...pre, ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => done({ exitCode: 127, stdout: "", stderr: `could not start ${bin}: ${e.message}\n` }));
    child.on("close", (code) => done({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

/** Check a nested read's output against the read contract this chant knows. */
export function readNestedDocument(stdout: string, exitCode: number, stderr: string, schemaId: string, contract: number): NestedRead {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    const tail = stderr.trim().split("\n").slice(-5).join("\n");
    return { ok: false, chant: null, code: exitCode === 0 ? "output-unreadable" : "command-failed", message: `the nested chant workspace graph exited ${exitCode} and printed no document${tail ? `: ${tail}` : ""}` };
  }
  const doc = raw as Record<string, unknown>;
  const chant = typeof doc.chant === "string" ? doc.chant : null;
  if (doc.$schema !== schemaId || typeof doc.contract !== "number") {
    return { ok: false, chant, code: "output-unreadable", message: "the nested chant workspace graph printed something that is not a workspace graph document" };
  }
  if (doc.contract > contract) {
    return { ok: false, chant, code: "ir-version-unsupported", message: `the nested workspace's chant printed graph contract ${doc.contract}, and this chant reads up to ${contract}` };
  }
  if (doc.error && typeof doc.error === "object") {
    const e = doc.error as { code?: unknown; message?: unknown };
    return { ok: false, chant, code: "command-failed", message: `the nested workspace could not be read: ${String(e.code)}: ${String(e.message)}` };
  }
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges) || !Array.isArray(doc.members)) {
    return { ok: false, chant, code: "output-unreadable", message: "the nested workspace graph has no nodes, edges and members" };
  }
  return { ok: true, chant, doc: doc as unknown as WorkspaceGraph & { contract: number } };
}

/** Run the nested workspace's own `chant workspace graph` in `abs`. */
export async function readNested(
  abs: string,
  args: Partial<ParsedArgs>,
  at: string | null | undefined,
  schemaId: string,
  contract: number,
  toolchain: Toolchain | undefined = undefined,
): Promise<NestedRead & { stderr: string }> {
  const r = await spawnRead((toolchain ?? readerToolchain()).command, nestedArgv(abs, args, at), abs);
  return { ...readNestedDocument(r.stdout, r.exitCode, r.stderr, schemaId, contract), stderr: r.stderr };
}

const prefixed = (outer: string, id: string): string => `${outer}/${id}`;

function prefixRefs(value: unknown, outer: string): unknown {
  if (Array.isArray(value)) return value.map((v) => prefixRefs(v, outer));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = k === "$ref" && typeof v === "string" ? prefixed(outer, v) : prefixRefs(v, outer);
  return out;
}

/**
 * Fold a nested workspace's graph into the outer one, under the outer member
 * `outer`, and fill that member's entry. The outer graph's other sections are
 * left as they are, so links still resolve against the outer declaration.
 */
export function foldNested(graph: WorkspaceGraph, member: ComposedMember, inner: WorkspaceGraph & { contract: number }): void {
  const outer = member.name;
  const dirs = new Map(inner.members.map((m) => [m.name, m.dir]));
  const ids: string[] = [];
  for (const node of inner.nodes) {
    const n: ComposedNode = {
      ...node,
      id: prefixed(outer, node.id),
      member: outer,
      nested: node.member,
      attrs: prefixRefs(node.attrs ?? {}, outer) as Record<string, unknown>,
    };
    if (node.compositeInstance) n.compositeInstance = prefixed(outer, node.compositeInstance);
    if (node.runtimeOwner) n.runtimeOwner = prefixed(outer, node.runtimeOwner);
    if (node.compositeParent) n.compositeParent = node.compositeParent;
    // sourceLoc is relative to the member's directory: the outer member's is the nested root.
    const dir = dirs.get(node.member);
    if (node.sourceLoc && dir && dir !== ".") n.sourceLoc = { ...node.sourceLoc, file: `${dir}/${node.sourceLoc.file}` };
    graph.nodes.push(n);
    ids.push(n.id);
  }
  for (const e of inner.edges) graph.edges.push({ ...e, from: prefixed(outer, e.from), to: prefixed(outer, e.to), member: outer });
  for (const e of inner.exports ?? []) graph.exports.push({ ...e, ...(e.node ? { node: prefixed(outer, e.node) } : {}), member: outer });
  for (const i of inner.imports ?? []) graph.imports.push({ ...i, node: prefixed(outer, i.node), member: outer });
  graph.groups.byMember[outer] = ids.sort();
  const groups = graph.groups as unknown as Record<string, Record<string, string[]> | undefined>;
  const innerGroups = inner.groups as unknown as Record<string, Record<string, string[]> | undefined>;
  for (const key of ["byLexicon", "byComposite"] as const) {
    for (const [k, v] of Object.entries(innerGroups[key] ?? {})) {
      const into = (groups[key] ??= {});
      into[k] = [...(into[k] ?? []), ...v.map((id) => prefixed(outer, id))].sort();
    }
  }
  for (const key of ["byStack", "byContainer", "byWave"] as const) {
    for (const [k, v] of Object.entries(innerGroups[key] ?? {})) {
      const into = (groups[key] ??= {});
      into[prefixed(outer, k)] = v.map((id) => prefixed(outer, id)).sort();
    }
  }
  for (const c of inner.collectors ?? []) graph.collectors.push({ ...c, member: prefixed(outer, c.member) });
  for (const [kind, attrs] of Object.entries(inner.derivedAttrs ?? {})) {
    const all = new Set([...(graph.derivedAttrs?.[kind] ?? []), ...attrs]);
    graph.derivedAttrs = { ...(graph.derivedAttrs ?? {}), [kind]: [...all].sort() };
  }
  graph.nodes.sort((a, b) => a.id.localeCompare(b.id));
  const edgeKey = (e: (typeof graph.edges)[number]) => `${e.from}\u0000${e.to}\u0000${e.viaAttr ?? ""}`;
  graph.edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  member.status = "composed";
  member.reason = null;
  member.nested = { name: inner.workspace.name, contract: inner.contract, members: inner.members, links: inner.links ?? [] };
}
