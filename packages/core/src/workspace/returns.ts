/**
 * Returns: the record an import writes when a copy of the workspace comes
 * back (#2552, #2524 D10, ws-004, ws-073).
 *
 * `chant workspace import` writes `.chant/returns/<id>.json` at the workspace
 * root, beside the lock. It names the export the copy started from, the
 * copy's HEAD when the copy is a git repository of its own, and every path
 * the import wrote or removed. For each written path whose bytes are the
 * copy's own (no host value was switched back into it), it also carries the
 * origin: the raw commit object that last changed the file in the copy, and
 * the raw tree objects from that commit's root tree down to the file. Those
 * objects hash to the ids that name them, so anyone can check offline that
 * the commit, with its original signature, holds exactly the bytes the
 * workspace now has. Nothing is re-signed: the signature is the one the
 * author made where the copy lived.
 *
 * The commit is judged by the attestors of #2547 with the policy at base. A
 * signer the base policy does not list makes it `attested-unverifiable-here`,
 * not `unattested`: there is a signature, and nothing here can say whose key
 * it is. An admin admits the signers by adding them to `.chant/trust.json`
 * under `admitted`, naming the return (`chant workspace admit <id>`). That
 * file is policy, read at base, and changing it is a protected write, so the
 * admission is signed by the admin's own commit. From then on, the returned
 * commits read as `attested`. An admitted key verifies only that return's
 * commits and seals, never a commit made in the workspace's own repository.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fileHash, LockError } from "./lineage-lock";
import type { WorkspaceTree } from "./tree";
import { attestRawCommit, type CommitAttestor } from "./trust/attestor";
import { returnedPolicy, TRUST_CONFIG_PATH, type TrustPolicy } from "./trust/policy";
import type { RecordProvenance } from "./trust/provenance";
import { splitSignedCommit, sshSignatureIntact, sshSignatureKey } from "./trust/ssh-commit";

/** Where return records live, relative to the workspace root. */
export const RETURNS_DIR = ".chant/returns";

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CommitId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const OriginSchema = z
  .object({
    /** The commit in the returned copy that last changed the file. */
    commit: CommitId,
    /** That commit object, raw, in base64: the signed payload and its signature. */
    raw: Base64,
    /** The raw tree objects from the commit's root tree down to the file's directory, in base64. */
    trees: z.array(Base64).min(1),
  })
  .strict();
export type ReturnOrigin = z.infer<typeof OriginSchema>;

const ReturnSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().regex(/^ret-[0-9a-f]{12}$/),
    /** The export the copy started from (`.chant/export.json`). */
    export: z.object({ id: z.string().min(1), workspace: z.string().min(1), revision: CommitId.nullable() }).strict(),
    /** The copy's HEAD, when it was a git repository of its own. */
    head: CommitId.nullable(),
    /** Paths written, relative to the workspace root, with the bytes' hash and, when it can be proved, the commit they come from. */
    paths: z.record(z.string(), z.object({ sha256: Sha256, origin: OriginSchema.optional() }).strict()),
    /** Paths removed. */
    removed: z.array(z.string()),
    /** Paths whose host-bound values the import switched back: their bytes are not the copy's, so they carry no origin. */
    hostValues: z.array(z.string()),
    /** The keys that signed the origin commits, for an admin to admit. `principal` is the committer's email, a suggestion only. */
    signers: z.array(
      z
        .object({
          key: z.string().min(1),
          fingerprint: z.string(),
          principal: z.string().min(1),
          commits: z.array(CommitId),
        })
        .strict(),
    ),
  })
  .strict();
export type ReturnRecord = z.infer<typeof ReturnSchema>;

// ── Git objects ──────────────────────────────────────────────────────────────

/** The id git gives an object: the hash of `<type> <length>\0<data>`, SHA-1 or SHA-256 by the id length in use. */
export function gitObjectId(type: "blob" | "tree" | "commit", data: Buffer, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(`${type} ${data.length}\0`).update(data).digest("hex");
}

/** The entries of a raw tree object: mode, name and id. */
export function parseTree(raw: Buffer, idBytes: number): { mode: string; name: string; id: string }[] {
  const out: { mode: string; name: string; id: string }[] = [];
  let i = 0;
  while (i < raw.length) {
    const sp = raw.indexOf(0x20, i);
    const nul = raw.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 1 + idBytes > raw.length) throw new Error("malformed tree object");
    out.push({ mode: raw.subarray(i, sp).toString("latin1"), name: raw.subarray(sp + 1, nul).toString("utf-8"), id: raw.subarray(nul + 1, nul + 1 + idBytes).toString("hex") });
    i = nul + 1 + idBytes;
  }
  return out;
}

function gitBuf(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The origin of `path` (relative to the copy's root) in the copy's own
 * repository at `dir`: the last commit that changed it, and the tree objects
 * down to it. Undefined when the file at that commit is not `content`, such
 * as a file with uncommitted changes.
 */
export function buildOrigin(dir: string, path: string, content: Buffer): ReturnOrigin | undefined {
  let commit: string;
  try {
    commit = gitBuf(dir, ["log", "-1", "--format=%H", "HEAD", "--", path]).toString("utf-8").trim();
  } catch {
    return undefined;
  }
  if (!commit) return undefined;
  const raw = gitBuf(dir, ["cat-file", "commit", commit]);
  const proof: ReturnOrigin = { commit, raw: raw.toString("base64"), trees: [] };
  let tree = /^tree ([0-9a-f]+)$/m.exec(raw.toString("latin1"))?.[1];
  const parts = path.split("/");
  for (let i = 0; i < parts.length && tree; i++) {
    const t = gitBuf(dir, ["cat-file", "tree", tree]);
    proof.trees.push(t.toString("base64"));
    tree = parseTree(t, tree.length / 2).find((e) => e.name === parts[i])?.id;
  }
  return verifyOrigin(proof, path, content).ok ? proof : undefined;
}

/** Check that `origin`'s objects hash to their ids and lead from the commit to `content` at `path`. */
export function verifyOrigin(origin: ReturnOrigin, path: string, content: Buffer): { ok: true } | { ok: false; reason: string } {
  const algorithm = origin.commit.length === 64 ? "sha256" : "sha1";
  const raw = Buffer.from(origin.raw, "base64");
  if (gitObjectId("commit", raw, algorithm) !== origin.commit) return { ok: false, reason: `the commit object does not hash to ${origin.commit.slice(0, 12)}` };
  let id = /^tree ([0-9a-f]+)$/m.exec(raw.toString("latin1"))?.[1];
  const parts = path.split("/");
  if (origin.trees.length !== parts.length) return { ok: false, reason: `the proof has ${origin.trees.length} tree(s) for a path ${parts.length} deep` };
  for (let i = 0; i < parts.length; i++) {
    const t = Buffer.from(origin.trees[i], "base64");
    if (!id || gitObjectId("tree", t, algorithm) !== id) return { ok: false, reason: `the tree for ${parts.slice(0, i).join("/") || "the root"} does not hash to its id` };
    let entries;
    try {
      entries = parseTree(t, id.length / 2);
    } catch {
      return { ok: false, reason: "a tree object in the proof is malformed" };
    }
    id = entries.find((e) => e.name === parts[i])?.id;
  }
  if (!id || gitObjectId("blob", content, algorithm) !== id) return { ok: false, reason: `the commit holds other bytes at ${path}` };
  return { ok: true };
}

// ── Signers ──────────────────────────────────────────────────────────────────

/** The committer's email in a raw commit object. */
function committerEmail(raw: Buffer): string | undefined {
  return /^committer [^<]*<([^>]+)>/m.exec(raw.toString("utf-8"))?.[1];
}

function signatureHeader(origin: ReturnOrigin): string {
  return origin.commit.length === 64 ? "gpgsig-sha256" : "gpgsig";
}

/** The keys that signed the origins, grouped by key, for an admin to admit. */
export function originSigners(origins: readonly ReturnOrigin[]): ReturnRecord["signers"] {
  const byKey = new Map<string, ReturnRecord["signers"][number]>();
  const seen = new Set<string>();
  for (const o of origins) {
    if (seen.has(o.commit)) continue;
    seen.add(o.commit);
    const raw = Buffer.from(o.raw, "base64");
    const { payload, signature } = splitSignedCommit(raw, signatureHeader(o));
    if (!signature) continue;
    const key = sshSignatureKey(signature);
    if (!key) continue;
    const entry = byKey.get(key);
    if (entry) {
      entry.commits.push(o.commit);
      continue;
    }
    const fingerprint = sshSignatureIntact(payload, signature, "git");
    if (fingerprint === false) continue;
    byKey.set(key, { key, fingerprint: fingerprint ?? "", principal: committerEmail(raw) ?? "unknown", commits: [o.commit] });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ── Reading and writing ──────────────────────────────────────────────────────

export function parseReturn(text: string, label: string): ReturnRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new LockError(`${label} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ReturnSchema.safeParse(raw);
  if (!parsed.success) throw new LockError(`${label} is not a return record: ${parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function renderReturn(r: ReturnRecord): string {
  const paths: ReturnRecord["paths"] = {};
  for (const p of Object.keys(r.paths).sort()) paths[p] = r.paths[p];
  return JSON.stringify(ReturnSchema.parse({ ...r, paths, removed: [...r.removed].sort(), hostValues: [...r.hostValues].sort() }), null, 2) + "\n";
}

export function writeReturn(root: string, r: ReturnRecord): string {
  const rel = `${RETURNS_DIR}/${r.id}.json`;
  mkdirSync(join(root, RETURNS_DIR), { recursive: true });
  writeFileSync(join(root, rel), renderReturn(r));
  return rel;
}

/** The return records in `tree` (the workspace root's), sorted by id. Unreadable ones are skipped and named in `problems`. */
export function readReturns(tree: WorkspaceTree): { returns: ReturnRecord[]; problems: string[] } {
  const returns: ReturnRecord[] = [];
  const problems: string[] = [];
  for (const e of (tree.list(RETURNS_DIR) ?? []).filter((x) => x.type === "file" && x.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${RETURNS_DIR}/${e.name}`;
    try {
      const r = parseReturn(tree.read(path), path);
      if (`${r.id}.json` !== e.name) throw new LockError(`${path} holds return ${r.id}`);
      returns.push(r);
    } catch (err) {
      if (!(err instanceof LockError)) throw err;
      problems.push(err.message);
    }
  }
  return { returns, problems };
}

// ── Provenance ───────────────────────────────────────────────────────────────

/**
 * The provenance of a returned file: its origin commit judged by the
 * attestors with the policy at base plus the signers admitted for the
 * return. Undefined when the return holds no origin for the path, or the
 * workspace's bytes are not the ones returned, so the commit that holds the
 * file here is what counts.
 */
export function returnedProvenance(
  policy: TrustPolicy,
  attestors: readonly CommitAttestor[],
  ret: ReturnRecord,
  path: string,
  content: Buffer,
  host: RecordProvenance,
): RecordProvenance | undefined {
  const entry = ret.paths[path];
  if (!entry || entry.sha256 !== fileHash(content)) return undefined;
  const returned = { id: ret.id, importedIn: host.commit };
  if (!entry.origin) return undefined;
  const proof = verifyOrigin(entry.origin, path, content);
  if (!proof.ok) {
    return { level: "unattested", commit: host.commit, reason: `returned in ${ret.id}, and its origin does not check: ${proof.reason}`, returned: { ...returned, commit: entry.origin.commit } };
  }
  const raw = Buffer.from(entry.origin.raw, "base64");
  const judged = returnedPolicy(policy, ret.id);
  const a = attestRawCommit({ repo: "", policy: judged }, raw, attestors);
  const at = `returned in ${ret.id} from commit ${entry.origin.commit.slice(0, 12)}`;
  const base = { commit: host.commit, attestor: a.attestor, returned: { ...returned, commit: entry.origin.commit } };
  if (a.level === "attested") {
    const admitted = (policy.admitted[ret.id] ?? []).some((s) => s.principal === a.principal) && !policy.signers.some((s) => s.principal === a.principal);
    return { ...base, level: "attested", ...(a.principal ? { principal: a.principal } : {}), ...(a.key ? { key: a.key } : {}), reason: `${at}, ${a.reason}${admitted ? `, a signer admitted for ${ret.id} at base` : ""}` };
  }
  if (a.level === "unattested") {
    const { payload, signature } = splitSignedCommit(raw, signatureHeader(entry.origin));
    const intact = signature?.startsWith("-----BEGIN SSH SIGNATURE-----") ? sshSignatureIntact(payload, signature, "git") : false;
    if (intact) {
      return {
        ...base,
        level: "attested-unverifiable-here",
        key: intact,
        reason: `${at}, signed with ${intact}, a key neither the signers nor an admission at base lists; it reads as attested once an admin admits the signer (chant workspace admit ${ret.id})`,
      };
    }
  }
  return { ...base, level: a.level, ...(a.key ? { key: a.key } : {}), reason: `${at}: ${a.reason}` };
}

// ── Admission ────────────────────────────────────────────────────────────────

export interface AdmitResult {
  id: string;
  /** Repository-relative path of the trust config. */
  path: string;
  /** The signers added. Empty when every one was already admitted. */
  added: { principal: string; key: string }[];
  written: boolean;
}

/**
 * Add the signers of return `ret` to the `admitted` list of
 * `.chant/trust.json` at the repository root `repo`, keeping everything else
 * in it. The admission counts once an admin's signed commit merges it: the
 * file is policy, read at base, and a protected write.
 */
export function admitReturn(repo: string, ret: ReturnRecord, opts: { note?: string; dryRun?: boolean } = {}): AdmitResult {
  if (ret.signers.length === 0) throw new LockError(`return ${ret.id} names no signer: none of its origin commits carries an ssh signature`);
  const abs = join(repo, TRUST_CONFIG_PATH);
  let config: Record<string, unknown> = { schema: 1 };
  if (existsSync(abs)) {
    try {
      config = JSON.parse(readFileSync(abs, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      throw new LockError(`${TRUST_CONFIG_PATH} is not valid JSON, so the admission cannot be added to it: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const admitted = Array.isArray(config.admitted) ? (config.admitted as Array<{ return?: unknown; signers?: Array<{ key?: unknown }> }>) : [];
  const have = new Set(admitted.filter((a) => a.return === ret.id).flatMap((a) => (a.signers ?? []).map((s) => s.key)));
  const added = ret.signers.filter((s) => !have.has(s.key)).map((s) => ({ principal: s.principal, key: s.key }));
  if (added.length > 0 && !opts.dryRun) {
    config.admitted = [...admitted, { return: ret.id, signers: added, ...(opts.note ? { note: opts.note } : {}) }];
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(config, null, 2) + "\n");
  }
  return { id: ret.id, path: TRUST_CONFIG_PATH, added, written: added.length > 0 && !opts.dryRun };
}
