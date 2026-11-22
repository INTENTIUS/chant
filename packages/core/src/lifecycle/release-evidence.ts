/**
 * `chant release evidence` (#5465): the records of one release, or of every
 * release and change in a period, written into a directory with an index by
 * control id.
 *
 * The records are evidence toward the controls the index names, from
 * `SECURITY_CONTROLS` (../workspace/security-controls.ts): each row names the
 * kinds of record that bear on its control (`records`) and what they do not
 * show (`notShown`). An assessor decides whether a control is met; nothing
 * here says one is.
 *
 * What it writes, under the directory it is given:
 *
 *   index.json            the index, chant's own JSON (release-evidence.schema.json)
 *   SHA256SUMS            every file's SHA-256, in sha256sum's format
 *   SHA256SUMS.sig        with a key: an ssh signature in the chant-evidence namespace
 *   lifecycle/<path>      chant/lifecycle files, byte for byte, at their paths on the branch
 *   commits/<sha>/<path>  the trust files and the declaration at a commit
 *   verify/<digest>.json  `release verify --json` for each release, and `.sigstore.json` with sigstore
 *   referrers/<digest>/   with `referrers`: each image referrer's manifest and blobs, by digest
 *   assets/<digest>/      with `assetsDir`: the forge assets the publish record names
 *
 * It reads the local repository: `chant/lifecycle` at its tip in this clone,
 * pinned once so every file comes from one commit, and the trust files from
 * git at each commit. It fetches nothing and writes nothing but the
 * directory. `referrers` reads each image's registry, and `sigstore` runs
 * cosign, which reads the registry and the transparency log; both are
 * opt-in. {@link checkEvidence} reads only the directory.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { NEXT_RELEASE } from "../release-floors";
import { EVIDENCE_KIND_SHOWS, type EvidenceKind } from "../workspace/evidence-kinds";
import { CONTROLS_OUTSIDE_BOTH_BASELINES, SECURITY_CONTROLS, type BaselineMark } from "../workspace/security-controls";
import type { SecurityProfile } from "../workspace/security-profiles";
import type { PublishFetch } from "./release-publish";
import type { SigstoreVerifier } from "./publish-signing";

/**
 * The first chant with `chant release evidence` (#5465): the records of a release or a period written into a directory with an `index.json` by control id, `SHA256SUMS` and an optional ssh signature, the `release-evidence` schema, and `--check`.
 */
export const RELEASE_EVIDENCE_FLOOR = NEXT_RELEASE;

/** `$id` of the index's JSON Schema, shipped as `workspace/release-evidence.schema.json`. */
export const RELEASE_EVIDENCE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/release-evidence/v1/release-evidence.schema.json";

/** The version of the index this chant writes. */
export const RELEASE_EVIDENCE_CONTRACT = 1;

/** The ssh signature namespace `SHA256SUMS.sig` is made in. */
export const EVIDENCE_SIGNATURE_NAMESPACE = "chant-evidence";

export const INDEX_FILE = "index.json";
export const SUMS_FILE = "SHA256SUMS";
export const SUMS_SIGNATURE_FILE = "SHA256SUMS.sig";

/** What the index says it is, at its top. */
export const EVIDENCE_STATEMENT =
  "These records are evidence toward the controls listed under each one, gathered by chant from its own records. Each control says what the records do not show. Whether a control is implemented and met is for the system owner to show and an assessor to decide; this export does not say that it is.";

const LIFECYCLE_REF = "refs/heads/chant/lifecycle";

/** Which records an export takes: one release, or a period. */
export type EvidenceScope = { kind: "release"; ref: string } | { kind: "period"; since: string; until: string };

/** One kind of record a file holds, and the lines that carry it (1-based, for a `.jsonl` file). */
export interface FileRecords {
  kind: EvidenceKind;
  lines?: number[];
}

/** Where a file in the export came from. */
export type EvidenceSource =
  | { lifecycle: { path: string; blob: string } }
  | { commit: string; path: string }
  | { registry: string; digest: string }
  | { assets: string; name: string }
  | { produced: string };

/** One file of the export, as the index lists it. */
export interface EvidenceFile {
  path: string;
  sha256: string;
  bytes: number;
  source: EvidenceSource;
  records: FileRecords[];
}

/** One record in the export that bears on a control. */
export interface ControlRecord {
  path: string;
  kind: EvidenceKind;
  lines?: number[];
  shows: string;
}

/** One control's entry in the index. */
export interface ControlEntry {
  id: string;
  title: string;
  cccsTitle?: string;
  baselines: Readonly<Record<SecurityProfile, BaselineMark>>;
  fedrampParameter?: string;
  /** True when a record in this export bears on the control. */
  found: boolean;
  records: ControlRecord[];
  /** With nothing found: a sentence that says so, and where the mapping says the control's evidence lives. */
  absent?: string;
  notShown: string;
  /** The `workspace check` codes, refusal codes and doctor checks that bear on the control, which this export does not run. */
  checks: { codes: string[]; doctor: string[] };
}

/** One release in scope. */
export interface EvidenceRelease {
  releaseDigest: string;
  label: string | null;
  commit: string;
  cutAt: string | null;
  /** `release verify`'s status at export time, or `error` when it could not check. */
  verify: "verified" | "unsigned" | "unverified" | "error";
  verifyFile: string;
  sigstore?: "verified" | "failed" | "none";
  sigstoreFile?: string;
}

/** The index, `index.json`. */
export interface EvidenceIndex {
  $schema: typeof RELEASE_EVIDENCE_SCHEMA_ID;
  contract: typeof RELEASE_EVIDENCE_CONTRACT;
  statement: string;
  generatedAt: string;
  chant: string;
  member: string | null;
  scope: EvidenceScope;
  lifecycle: { ref: string; commit: string | null; prefix: string };
  releases: EvidenceRelease[];
  /** With no release in scope: a sentence that says so. */
  noReleases?: string;
  files: EvidenceFile[];
  controls: ControlEntry[];
  outsideBothBaselines: Array<{ id: string; title: string; note: string; found: boolean; records: ControlRecord[] }>;
  /** What the export does not hold, and how to get it. */
  notIncluded: Array<{ what: string; why: string; run?: string }>;
  /** What could not be read or fetched, each in a sentence. */
  problems: string[];
}

/** Why an export could not start. */
export class EvidenceExportError extends Error {
  constructor(
    readonly code: "evidence-not-a-repository" | "evidence-no-lifecycle" | "evidence-release-not-found" | "evidence-out-not-empty" | "evidence-period-invalid" | "evidence-sign-failed",
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "EvidenceExportError";
  }
}

export interface ExportEvidenceRequest {
  cwd: string;
  scope: EvidenceScope;
  outDir: string;
  /** An ssh key file to sign `SHA256SUMS` with, or true for git's `user.signingkey`. */
  sign?: string | true;
  /** Fetch each image's referrers from its registry. */
  referrers?: boolean;
  /** Run `release verify --sigstore` for each release. */
  sigstore?: boolean;
  /** Where the forge release assets were downloaded: copied in when their digests match, and handed to the Sigstore check. */
  assetsDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: PublishFetch;
  verifier?: SigstoreVerifier;
  now?: () => Date;
}

export interface ExportEvidenceResult {
  outDir: string;
  index: EvidenceIndex;
  /** The signing key's fingerprint, with `sign`. */
  signedBy: string | null;
}

// ── git reads, byte for byte ─────────────────────────────────────────────

function git(cwd: string, args: string[]): { ok: boolean; out: Buffer; err: string } {
  const r = spawnSync("git", args, { cwd, maxBuffer: 1 << 30, env: { ...process.env, LC_ALL: "C" } });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? Buffer.alloc(0)).toString("utf-8") };
}

const text = (b: Buffer) => b.toString("utf-8");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const safe = (digest: string) => digest.replace(/:/g, "_");

/** Every file under `prefix` at `tip`, by path relative to the prefix, with its blob id. The flat layout leaves other members' `_members/` out. */
function listLedger(cwd: string, tip: string, prefix: string): Map<string, string> {
  const r = git(cwd, ["ls-tree", "-r", "--full-tree", tip, ...(prefix ? ["--", prefix.replace(/\/$/, "")] : [])]);
  const out = new Map<string, string>();
  if (!r.ok) return out;
  for (const line of text(r.out).split("\n")) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (!m) continue;
    const rel = m[2]!.slice(prefix.length);
    if (prefix === "" && rel.startsWith("_members/")) continue;
    out.set(rel, m[1]!);
  }
  return out;
}

function isAncestor(cwd: string, a: string, b: string): boolean | null {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/** The JSON of each line of a `.jsonl` text, with its 1-based line number; a line that is not JSON is skipped. */
function jsonLines(body: string): Array<{ line: number; value: Record<string, unknown> }> {
  const out: Array<{ line: number; value: Record<string, unknown> }> = [];
  body.split("\n").forEach((l, i) => {
    if (l.trim() === "") return;
    try {
      const v = JSON.parse(l) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) out.push({ line: i + 1, value: v as Record<string, unknown> });
    } catch {
      // A line that is not JSON is copied with the file and bears on nothing.
    }
  });
  return out;
}

/** When a ledger line happened: the first of the fields chant's ledgers stamp. */
function timeOf(v: Record<string, unknown>): number {
  for (const key of ["timestamp", "recordedAt", "started", "resolvedAt", "ended"]) {
    const t = v[key];
    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return Number.NaN;
}

// ── the export ───────────────────────────────────────────────────────────

/** Write the evidence of `req.scope` into `req.outDir`. Throws an {@link EvidenceExportError} when it can't start. */
export async function exportEvidence(req: ExportEvidenceRequest): Promise<ExportEvidenceResult> {
  const now = (req.now ?? (() => new Date()))();
  const env = req.env ?? process.env;
  const { gitRoot } = await import("../workspace/record-source");
  const top = gitRoot(req.cwd);
  if (!top) throw new EvidenceExportError("evidence-not-a-repository", "release evidence reads chant/lifecycle and the trust files at each commit, and this directory is not in a git repository");
  const outDir = resolve(req.outDir);
  if (existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) {
    throw new EvidenceExportError("evidence-out-not-empty", `${req.outDir} is not an empty directory, and an export writes only into a directory of its own`, "Name a directory that does not exist yet, or an empty one.");
  }
  let since = Number.NaN;
  let until = Number.NaN;
  if (req.scope.kind === "period") {
    since = Date.parse(req.scope.since);
    until = Date.parse(req.scope.until);
    if (Number.isNaN(since) || Number.isNaN(until) || since >= until) {
      throw new EvidenceExportError("evidence-period-invalid", `the period ${req.scope.since} to ${req.scope.until} is not two dates with the first before the second`, "Give dates such as --since 2026-10-01 --until 2026-11-01.");
    }
  }
  const tipRead = git(req.cwd, ["rev-parse", "--verify", LIFECYCLE_REF]);
  if (!tipRead.ok) {
    throw new EvidenceExportError("evidence-no-lifecycle", "this clone has no chant/lifecycle branch, so there are no records to export", "Fetch it: git fetch origin chant/lifecycle:chant/lifecycle");
  }
  const tip = text(tipRead.out).trim();
  const { resolveMemberLedger } = await import("./member-ledger");
  const ledger = await resolveMemberLedger(req.cwd);
  const prefix = ledger.prefix;
  const tree = listLedger(req.cwd, tip, prefix);
  const blobs = new Map<string, Buffer>();
  const read = (rel: string): Buffer | null => {
    const blob = tree.get(rel);
    if (!blob) return null;
    if (!blobs.has(rel)) {
      const r = git(req.cwd, ["cat-file", "blob", blob]);
      if (!r.ok) return null;
      blobs.set(rel, r.out);
    }
    return blobs.get(rel)!;
  };

  const problems: string[] = [];
  const notIncluded: EvidenceIndex["notIncluded"] = [];
  const files = new Map<string, EvidenceFile>();
  const pending = new Map<string, Uint8Array>();
  const add = (path: string, bytes: Uint8Array, source: EvidenceSource, kinds: FileRecords[]) => {
    const existing = files.get(path);
    if (existing) {
      for (const k of kinds) mergeKind(existing.records, k);
      return;
    }
    const records: FileRecords[] = [];
    for (const k of kinds) mergeKind(records, k);
    files.set(path, { path, sha256: sha256(bytes), bytes: bytes.length, source, records });
    pending.set(path, bytes);
  };
  const addLedger = (rel: string, kinds: FileRecords[]) => {
    const bytes = read(rel);
    if (!bytes) return;
    add(`lifecycle/${prefix}${rel}`, bytes, { lifecycle: { path: `${prefix}${rel}`, blob: tree.get(rel)! } }, kinds);
  };
  const inPeriod = (v: Record<string, unknown>) => req.scope.kind === "period" && timeOf(v) >= since && timeOf(v) < until;

  // The releases in scope, from the cuts.
  const { parseCuts, parseRelease, verifyReleaseDigest, RELEASES_DIR, CUTS_FILE } = await import("./release-store");
  const cutsText = read(`${RELEASES_DIR}/${CUTS_FILE}`);
  const cuts = parseCuts(cutsText ? text(cutsText) : null).cuts;
  const releaseFile = (digest: string) => `${RELEASES_DIR}/${safe(digest)}.json`;
  const wanted: string[] = [];
  if (req.scope.kind === "release") {
    const ref = req.scope.ref;
    const byLabel = cuts.find((c) => c.label === ref)?.releaseDigest;
    const digest = ref.includes(":") ? ref : byLabel;
    if (!digest || !tree.has(releaseFile(digest))) {
      throw new EvidenceExportError("evidence-release-not-found", `no release is labelled or digested "${ref}" in this member's chant/lifecycle`, "Fetch chant/lifecycle (git fetch origin chant/lifecycle:chant/lifecycle), then list them with: chant release list");
    }
    wanted.push(digest);
  } else {
    for (const c of cuts) {
      const t = Date.parse(c.timestamp);
      if (t >= since && t < until && !wanted.includes(c.releaseDigest)) wanted.push(c.releaseDigest);
    }
  }
  const releases: Array<{ digest: string; label: string | null; commit: string; cutAt: string | null }> = [];
  for (const digest of wanted) {
    const bytes = read(releaseFile(digest));
    const release = bytes ? parseRelease(text(bytes)) : null;
    if (!release) {
      problems.push(`the release file of ${digest} is missing or not a release, so the release is listed from its cut only`);
      continue;
    }
    if (!verifyReleaseDigest(release)) problems.push(`the release file of ${digest} does not hash to its digest, so it was changed after the cut`);
    addLedger(releaseFile(digest), [{ kind: "release" }]);
    const own = cuts.filter((c) => c.releaseDigest === digest);
    releases.push({ digest, label: own.find((c) => c.label !== null)?.label ?? null, commit: release.commit, cutAt: own[0]?.timestamp ?? null });
  }
  const releaseDigests = new Set(releases.map((r) => r.digest));
  const releaseCommits = new Set(releases.map((r) => r.commit));

  // _releases/*.jsonl: cuts, publishes and status lines, copied whole.
  const publishLines: Array<{ value: Record<string, unknown> }> = [];
  for (const rel of [...tree.keys()].filter((p) => p.startsWith(`${RELEASES_DIR}/`) && p.endsWith(".jsonl") && !p.slice(RELEASES_DIR.length + 1).includes("/"))) {
    const body = text(read(rel)!);
    const kinds = new Map<EvidenceKind, number[]>();
    const mark = (kind: EvidenceKind, line: number) => kinds.set(kind, [...(kinds.get(kind) ?? []), line]);
    for (const { line, value } of jsonLines(body)) {
      if (typeof value.releaseDigest !== "string" || !releaseDigests.has(value.releaseDigest)) continue;
      if (rel.endsWith(`/${CUTS_FILE}`)) {
        mark("cut", line);
        continue;
      }
      if (!rel.endsWith("/publishes.jsonl")) {
        mark("publish", line);
        continue;
      }
      publishLines.push({ value });
      const step = value.step;
      if (step === "scanned" || step === "scan-failed") mark("scan", line);
      else if (step === "rescanned") mark("rescan", line);
      else mark("publish", line);
      const items = Array.isArray(value.items) ? (value.items as Array<Record<string, unknown>>) : [];
      if (items.some((i) => i.attachment === "signature" || i.attachment === "attestation")) mark("signature-record", line);
      if (items.some((i) => i.attachment === "sbom" || typeof i.sbom === "string")) mark("sbom-record", line);
      if (value.crypto !== undefined) mark("crypto", line);
      if (typeof value.runnerKey === "string") mark("runner-key", line);
    }
    if (kinds.size > 0) addLedger(rel, [...kinds].map(([kind, lines]) => ({ kind, lines })));
  }

  // The merge records a release carries since the one before it, or every merge recorded in the period.
  const { MERGES_DIR } = await import("./merge-record");
  const merges: Array<{ rel: string; commit: string; base: string | null; op: string | null; digests: string[] }> = [];
  const releaseOrder = cuts.map((c) => c.releaseDigest);
  for (const rel of [...tree.keys()].filter((p) => p.startsWith(`${MERGES_DIR}/`) && p.endsWith(".json"))) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text(read(rel)!)) as Record<string, unknown>;
    } catch {
      problems.push(`${prefix}${rel} is not JSON`);
      continue;
    }
    if (typeof m.commit !== "string") continue;
    let carried = inPeriod(m);
    for (const r of releases) {
      if (carried) break;
      if (m.commit === r.commit) {
        carried = true;
        break;
      }
      if (isAncestor(req.cwd, m.commit, r.commit) !== true) continue;
      // The release before this one in the cuts, whose commit is an ancestor: what it carried is its own.
      const before = releaseOrder.slice(0, releaseOrder.indexOf(r.digest)).reverse();
      let prior: string | null = null;
      for (const d of before) {
        const b = read(releaseFile(d));
        const c = b ? parseRelease(text(b))?.commit : undefined;
        if (c && c !== r.commit && isAncestor(req.cwd, c, r.commit) === true) {
          prior = c;
          break;
        }
      }
      carried = prior === null || isAncestor(req.cwd, m.commit, prior) === false;
    }
    if (!carried) continue;
    const digests = [m.digest, m.approvedDigest].filter((d): d is string => typeof d === "string");
    merges.push({ rel, commit: m.commit, base: typeof m.base === "string" ? m.base : null, op: typeof m.op === "string" ? m.op : null, digests });
    addLedger(rel, [{ kind: "merge" }]);
  }
  for (const r of releases) {
    if (!git(req.cwd, ["cat-file", "-e", `${r.commit}^{commit}`]).ok) {
      problems.push(`the commit ${r.commit} of ${r.label ?? r.digest} is not in this clone, so the merges it carries could not be told apart from earlier ones`);
    }
  }

  // The change sets those merges planned and approved.
  const { CHANGE_SETS_DIR, changeSetFile } = await import("./change-set-store");
  for (const d of new Set(merges.flatMap((m) => m.digests))) {
    const rel = `${CHANGE_SETS_DIR}/${changeSetFile(d)}`;
    if (tree.has(rel)) addLedger(rel, [{ kind: "change-set" }]);
    else problems.push(`the change set ${d} a merge record names is not on chant/lifecycle`);
  }

  // Gate ledgers: the ops of those merges, release gate facts that name a release in scope, and in a period every line in it. Overrides likewise.
  const { GATES_DIR } = await import("./gate-ledger");
  const ops = new Set(merges.map((m) => m.op).filter((o): o is string => o !== null));
  for (const rel of [...tree.keys()].filter((p) => p.startsWith(`${GATES_DIR}/`) && p.endsWith(".jsonl"))) {
    const override = rel.startsWith(`${GATES_DIR}/policy-override`);
    const kinds = new Map<EvidenceKind, number[]>();
    const mark = (kind: EvidenceKind, line: number) => kinds.set(kind, [...(kinds.get(kind) ?? []), line]);
    for (const { line, value } of jsonLines(text(read(rel)!))) {
      // A merge's gate, a release gate's fact naming a release in scope, or any line of the period.
      const ours = (typeof value.op === "string" && ops.has(value.op)) || (typeof value.releaseDigest === "string" && releaseDigests.has(value.releaseDigest));
      if (!(ours || inPeriod(value))) continue;
      if (override) {
        mark("override", line);
        continue;
      }
      mark("gate", line);
      if ((value.kind === undefined || value.kind === "resolution") && value.seal !== undefined && value.seal !== null) mark("sealed-approval", line);
    }
    if (kinds.size > 0) addLedger(rel, [...kinds].map(([kind, lines]) => ({ kind, lines })));
  }

  // Each environment's deploy lines and Op run lines.
  for (const rel of [...tree.keys()].filter((p) => !p.startsWith("_") && p.split("/").length === 2)) {
    const name = rel.split("/")[1]!;
    const deploys = name === "releases.jsonl";
    const runs = name.startsWith("runs__") && name.endsWith(".jsonl");
    if (!deploys && !runs) continue;
    const lines: number[] = [];
    for (const { line, value } of jsonLines(text(read(rel)!))) {
      const ours = deploys ? typeof value.releaseDigest === "string" && releaseDigests.has(value.releaseDigest) : typeof value.gitSha === "string" && releaseCommits.has(value.gitSha);
      if (ours || inPeriod(value)) lines.push(line);
    }
    if (lines.length > 0) addLedger(rel, [{ kind: deploys ? "deploy" : "run", lines }]);
  }

  // The trust files and the declaration at each release's commit and each merge's base.
  const commits = [...new Set([...releases.map((r) => r.commit), ...merges.map((m) => m.base).filter((b): b is string => b !== null)])];
  const trustAt = new Map<string, string>();
  for (const commit of commits) {
    const show = (path: string) => git(top, ["cat-file", "blob", `${commit}:${path}`]);
    if (!git(top, ["cat-file", "-e", `${commit}^{commit}`]).ok) {
      problems.push(`the commit ${commit} is not in this clone, so its trust files are not in the export`);
      continue;
    }
    let signersPath = ".chant/allowed_signers";
    const trust = show(".chant/trust.json");
    if (trust.ok) {
      add(`commits/${commit}/.chant/trust.json`, trust.out, { commit, path: ".chant/trust.json" }, [{ kind: "trust" }]);
      try {
        const named = (JSON.parse(text(trust.out)) as { signers?: unknown }).signers;
        if (typeof named === "string" && named !== "") signersPath = named;
      } catch {
        problems.push(`.chant/trust.json at ${commit} is not JSON`);
      }
    }
    const signers = show(signersPath);
    if (signers.ok) add(`commits/${commit}/${signersPath}`, signers.out, { commit, path: signersPath }, [{ kind: "signers" }]);
    else problems.push(`${commit} has no ${signersPath}, so no cut or approval signature can be checked against it`);
    const declaration = show("chant.workspace.json");
    if (declaration.ok) add(`commits/${commit}/chant.workspace.json`, declaration.out, { commit, path: "chant.workspace.json" }, [{ kind: "declaration" }]);
    trustAt.set(commit, signersPath);
  }

  // release verify, offline, and with sigstore the Sigstore check.
  const { verifyRelease, verifySigstore } = await import("./release-verify");
  const outReleases: EvidenceRelease[] = [];
  for (const r of releases) {
    const v = await verifyRelease({ cwd: req.cwd, ref: r.digest });
    const verifyFile = `verify/${safe(r.digest)}.json`;
    add(verifyFile, json(v), { produced: `chant release verify ${r.digest} --json` }, [{ kind: "verify" }]);
    const entry: EvidenceRelease = { releaseDigest: r.digest, label: r.label, commit: r.commit, cutAt: r.cutAt, verify: "error" in v ? "error" : v.status, verifyFile };
    if ("error" in v) problems.push(`release verify could not check ${r.label ?? r.digest}: ${v.error.message}`);
    if (req.sigstore) {
      const s = await verifySigstore({ cwd: req.cwd, releaseDigest: r.digest, env, ...(req.assetsDir ? { assetsDir: req.assetsDir } : {}), ...(req.verifier ? { verifier: req.verifier } : {}) });
      const sigstoreFile = `verify/${safe(r.digest)}.sigstore.json`;
      add(sigstoreFile, json(s), { produced: `chant release verify ${r.digest} --sigstore --json` }, [{ kind: "sigstore-verify" }]);
      entry.sigstore = s.status;
      entry.sigstoreFile = sigstoreFile;
    }
    outReleases.push(entry);
  }

  // The newest revealed line of each target of each release, for referrers and assets.
  const revealed = new Map<string, Record<string, unknown>>();
  for (const { value } of publishLines) if (value.step === "revealed") revealed.set(`${String(value.releaseDigest)} ${String(value.target)}`, value);
  if (req.referrers) {
    for (const line of revealed.values()) if (line.kind === "oci") await fetchReferrers(line, { cwd: req.cwd, env, add, problems, ...(req.fetch ? { fetch: req.fetch } : {}) });
  }
  if (req.assetsDir) {
    for (const line of revealed.values()) if (line.kind === "forge") copyAssets(line, resolve(req.cwd, req.assetsDir), { add, problems });
  }

  if (!req.referrers && [...revealed.values()].some((l) => l.kind === "oci")) {
    notIncluded.push({ what: "image referrers (the layer SBOM, scan.json, attestations and signatures)", why: "they are in the image's registry, and the export reads no registry unless asked", run: "chant release evidence ... --referrers" });
  }
  if (!req.assetsDir && [...revealed.values()].some((l) => l.kind === "forge")) {
    notIncluded.push({ what: "forge release assets (Sigstore bundles, SBOMs, the provenance statement)", why: "they are on the forge, and the export downloads nothing", run: "download them (gh release download <tag> -D <dir>), then chant release evidence ... --assets <dir>" });
  }
  if (!req.sigstore && releases.length > 0) {
    notIncluded.push({ what: "the Sigstore check of each release", why: "it runs cosign, which reads the registry and the transparency log", run: "chant release evidence ... --sigstore" });
  }
  notIncluded.push(
    { what: "chant release doctor results", why: "the doctor reads the forge and the scanner, and the export runs offline", run: "chant release doctor --json" },
    { what: "chant workspace check findings, including WSP166 and WSP167", why: "they describe the working tree today, not the records of a release", run: "chant workspace check --json" },
    { what: "chant workspace state", why: "it reads each member's state backend", run: "chant workspace state --json" },
  );

  const fileList = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const recordsOf = (kinds: readonly EvidenceKind[]): ControlRecord[] =>
    fileList.flatMap((f) => f.records.filter((r) => kinds.includes(r.kind)).map((r) => ({ path: f.path, kind: r.kind, ...(r.lines ? { lines: r.lines } : {}), shows: EVIDENCE_KIND_SHOWS[r.kind] })));
  const controls: ControlEntry[] = SECURITY_CONTROLS.map((c) => {
    const records = recordsOf(c.records);
    const entry: ControlEntry = {
      id: c.id,
      title: c.title,
      ...(c.cccsTitle ? { cccsTitle: c.cccsTitle } : {}),
      baselines: c.baselines,
      ...(c.fedrampParameter ? { fedrampParameter: c.fedrampParameter } : {}),
      found: records.length > 0,
      records,
      notShown: c.notShown,
      checks: { codes: [...c.codes], doctor: [...c.doctor] },
    };
    if (records.length === 0) entry.absent = absentSentence(c.id, c.records, c.evidence);
    return entry;
  });
  const outside = CONTROLS_OUTSIDE_BOTH_BASELINES.map((c) => {
    const records = recordsOf(c.records);
    return { id: c.id, title: c.title, note: c.note, found: records.length > 0, records };
  });

  const scopeWords = req.scope.kind === "period" ? `between ${req.scope.since} and ${req.scope.until}` : "";
  const index: EvidenceIndex = {
    $schema: RELEASE_EVIDENCE_SCHEMA_ID,
    contract: RELEASE_EVIDENCE_CONTRACT,
    statement: EVIDENCE_STATEMENT,
    generatedAt: now.toISOString(),
    chant: await chantVersion(),
    member: ledger.members.length > 0 ? ledger.members.join("/") : null,
    scope: req.scope,
    lifecycle: { ref: "chant/lifecycle", commit: tip, prefix },
    releases: outReleases,
    ...(outReleases.length === 0 ? { noReleases: `No release of this member was cut ${scopeWords || "in scope"}. The export holds only the other records of the period, and every control below says what it found.` } : {}),
    files: fileList,
    controls,
    outsideBothBaselines: outside,
    notIncluded,
    problems,
  };

  // Write: the files, the index, the sums, and the signature.
  mkdirSync(outDir, { recursive: true });
  for (const [path, bytes] of pending) {
    const target = join(outDir, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const indexBytes = json(index);
  writeFileSync(join(outDir, INDEX_FILE), indexBytes);
  const sums = sumsText([...fileList.map((f) => ({ path: f.path, sha256: f.sha256 })), { path: INDEX_FILE, sha256: sha256(indexBytes) }]);
  writeFileSync(join(outDir, SUMS_FILE), sums);
  let signedBy: string | null = null;
  if (req.sign !== undefined) signedBy = await signSums(join(outDir, SUMS_FILE), req.sign, req.cwd);
  return { outDir, index, signedBy };
}

function mergeKind(into: FileRecords[], k: FileRecords): void {
  const have = into.find((r) => r.kind === k.kind);
  if (!have) {
    into.push(k.lines ? { kind: k.kind, lines: [...k.lines] } : { kind: k.kind });
    return;
  }
  if (k.lines && have.lines) have.lines = [...new Set([...have.lines, ...k.lines])].sort((a, b) => a - b);
}

function absentSentence(id: string, kinds: readonly EvidenceKind[], evidence: readonly string[]): string {
  if (kinds.length > 0) {
    return `This export holds no record that bears on ${id}. The kinds that would are ${kinds.join(", ")}, and none was found in scope. That is the absence of a record, not a finding about the control.`;
  }
  return `This export holds no record that bears on ${id}: its evidence lives outside the records chant keeps per release (${evidence.join("; ")}). Gather that separately.`;
}

const json = (v: unknown): Buffer => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, "utf-8");

/** `SHA256SUMS` in sha256sum's format, sorted by path. */
export function sumsText(entries: ReadonlyArray<{ path: string; sha256: string }>): string {
  return [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.sha256}  ${e.path}\n`)
    .join("");
}

async function chantVersion(): Promise<string> {
  try {
    const { readChantPackageVersion } = await import("../package-version");
    return readChantPackageVersion();
  } catch {
    return "unknown";
  }
}

/** Sign `SHA256SUMS` with ssh-keygen in the chant-evidence namespace, writing `SHA256SUMS.sig`. Returns the key's fingerprint. */
async function signSums(file: string, sign: string | true, cwd: string): Promise<string> {
  const { resolveSigningKey } = await import("../workspace/trust/seal");
  const { sshSignatureKey, sshKeyFingerprint } = await import("./gate-seal");
  let key: { file: string; cleanup: () => void };
  try {
    key = resolveSigningKey(sign, cwd);
  } catch (err) {
    throw new EvidenceExportError("evidence-sign-failed", err instanceof Error ? err.message : String(err));
  }
  try {
    const r = spawnSync("ssh-keygen", ["-q", "-Y", "sign", "-n", EVIDENCE_SIGNATURE_NAMESPACE, "-f", key.file], { input: readFileSync(file), encoding: "utf-8" });
    if (r.error) throw new EvidenceExportError("evidence-sign-failed", "signing the export needs ssh-keygen, and it is not installed here");
    if (r.status !== 0 || !r.stdout.startsWith("-----BEGIN SSH SIGNATURE-----")) {
      throw new EvidenceExportError("evidence-sign-failed", `ssh-keygen could not sign with ${key.file}: ${r.stderr.trim() || `exit ${r.status}`}`);
    }
    writeFileSync(`${file}.sig`, r.stdout);
    const blob = sshSignatureKey(r.stdout);
    return blob ? sshKeyFingerprint(blob) : "unknown";
  } finally {
    key.cleanup();
  }
}

// ── referrers and assets ─────────────────────────────────────────────────

const REFERRER_KIND: Record<string, EvidenceKind> = { sbom: "referrer-sbom", scan: "referrer-scan", attestation: "referrer-attestation", provenance: "referrer-attestation", signature: "referrer-signature" };

type Add = (path: string, bytes: Uint8Array, source: EvidenceSource, kinds: FileRecords[]) => void;

/** Fetch each referrer a revealed image line names, by digest, checked against its digest and its subject. */
async function fetchReferrers(line: Record<string, unknown>, ctx: { cwd: string; env: NodeJS.ProcessEnv; add: Add; problems: string[]; fetch?: PublishFetch }): Promise<void> {
  const { createRedactor } = await import("./publish-credentials");
  const { ociCredential, parseRepository, Registry } = await import("./publish-oci");
  const { bytesDigest } = await import("./publish-targets");
  const items = (Array.isArray(line.items) ? line.items : []) as Array<{ name: string; destination: string; digest?: string; attachment?: string }>;
  const image = items.find((i) => i.attachment === undefined && i.digest);
  if (!image?.digest) return;
  const repository = image.destination.split("@")[0]!;
  const redactor = createRedactor(ctx.env);
  const repo = parseRepository(repository);
  const cred = ociCredential({}, repo, { env: ctx.env, redactor });
  const fetchImpl: PublishFetch = ctx.fetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<PublishFetch>);
  const registry = new Registry(repo, fetchImpl, cred, { cwd: ctx.cwd, env: ctx.env, redactor, log: () => undefined, provenance: { oidc: false, ci: null, reason: "" }, tag: null });
  registry.actions = "pull";
  const release = safe(String(line.releaseDigest));
  for (const item of items) {
    const kind = item.attachment ? REFERRER_KIND[item.attachment] : undefined;
    if (!kind) continue;
    const why = (reason: string) => ctx.problems.push(`${item.name} of ${repository}@${image.digest}: ${reason}`);
    if (!item.digest) {
      why("the publish record names no digest for it, so it was not fetched");
      continue;
    }
    try {
      const manifest = await registry.getManifest(item.digest);
      if (!manifest) {
        why(`${repository} holds no manifest ${item.digest}`);
        continue;
      }
      if (bytesDigest(manifest.bytes) !== item.digest) {
        why(`${repository} served a manifest that is not ${item.digest}`);
        continue;
      }
      const parsed = JSON.parse(Buffer.from(manifest.bytes).toString("utf-8")) as { subject?: { digest?: string }; layers?: Array<{ digest: string }> };
      if (parsed.subject?.digest !== undefined && parsed.subject.digest !== image.digest) {
        why(`${item.digest} is a referrer of ${parsed.subject.digest}, not of ${image.digest}`);
        continue;
      }
      const dir = `referrers/${release}/${safe(item.digest)}`;
      ctx.add(`${dir}/manifest.json`, manifest.bytes, { registry: repository, digest: item.digest }, [{ kind }]);
      for (const layer of parsed.layers ?? []) {
        const bytes = await registry.getBlob(layer.digest);
        if (!bytes) {
          why(`${repository} holds no blob ${layer.digest}`);
          continue;
        }
        if (bytesDigest(bytes) !== layer.digest) {
          why(`${repository} served a blob that is not ${layer.digest}`);
          continue;
        }
        ctx.add(`${dir}/${safe(layer.digest)}`, bytes, { registry: repository, digest: layer.digest }, [{ kind }]);
      }
    } catch (err) {
      why(redactor.redact(err instanceof Error ? err.message : String(err)));
    }
  }
}

/** Copy the forge assets a revealed forge line names from `dir`, each only when its digest matches the record. */
function copyAssets(line: Record<string, unknown>, dir: string, ctx: { add: Add; problems: string[] }): void {
  const items = (Array.isArray(line.items) ? line.items : []) as Array<{ name: string; digest?: string; attachment?: string }>;
  const release = safe(String(line.releaseDigest));
  for (const item of items.filter((i) => i.attachment !== undefined)) {
    const file = join(dir, item.name);
    if (!existsSync(file)) {
      ctx.problems.push(`${item.name} is not in the assets directory, so it is not in the export`);
      continue;
    }
    const bytes = readFileSync(file);
    if (item.digest && `sha256:${sha256(bytes)}` !== item.digest) {
      ctx.problems.push(`${item.name} in the assets directory is sha256:${sha256(bytes)}, and the publish uploaded ${item.digest}, so it is not in the export`);
      continue;
    }
    ctx.add(`assets/${release}/${item.name}`, bytes, { assets: dir, name: item.name }, [{ kind: "forge-asset" }]);
  }
}

// ── checking an export ───────────────────────────────────────────────────

/** One cut or approval signature checked from the export alone. */
export interface SignatureFinding {
  path: string;
  line: number;
  who: string;
  status: "verified" | "unsigned" | "unverified" | "unchecked";
  reason: string;
}

/** What {@link checkEvidence} found. */
export interface EvidenceCheck {
  ok: boolean;
  /** How many files `SHA256SUMS` lists. */
  files: number;
  /** Digest mismatches, missing files and files no list names. */
  problems: string[];
  /** Each release file, whether it hashes to its digest. */
  releases: Array<{ path: string; releaseDigest: string; digestMatches: boolean }>;
  cuts: SignatureFinding[];
  approvals: SignatureFinding[];
  /** The signature on `SHA256SUMS`: absent, or whether it verifies, its key, and which exported signers files list that key. */
  signature: { present: false } | { present: true; verified: boolean; key: string | null; listedIn: string[]; reason: string };
}

/**
 * Check an export from the directory alone: every file against `SHA256SUMS`
 * and the index, no file unlisted, each release file against its digest,
 * each cut's signature against the signers file exported at the release's
 * commit, each sealed approval against the trust files exported at the base
 * of the merge whose gate it is, and the signature on `SHA256SUMS`.
 */
export async function checkEvidence(dirIn: string): Promise<EvidenceCheck> {
  const dir = resolve(dirIn);
  const problems: string[] = [];
  const out: EvidenceCheck = { ok: false, files: 0, problems, releases: [], cuts: [], approvals: [], signature: { present: false } };
  const sumsPath = join(dir, SUMS_FILE);
  if (!existsSync(sumsPath)) {
    problems.push(`${SUMS_FILE} is missing, so nothing can be checked`);
    return out;
  }
  const sumsBytes = readFileSync(sumsPath);
  const listed = new Map<string, string>();
  for (const line of text(sumsBytes).split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) {
      problems.push(`${SUMS_FILE} has a line that is not a digest and a path: ${line}`);
      continue;
    }
    listed.set(m[2]!, m[1]!);
  }
  out.files = listed.size;
  for (const [path, digest] of listed) {
    const file = join(dir, ...path.split("/"));
    if (!file.startsWith(dir + sep) || !existsSync(file)) {
      problems.push(`${path} is listed in ${SUMS_FILE} and is not in the export`);
      continue;
    }
    const got = sha256(readFileSync(file));
    if (got !== digest) problems.push(`${path} is ${got}, and ${SUMS_FILE} lists ${digest}`);
  }
  for (const path of walk(dir)) {
    if (path === SUMS_FILE || path === SUMS_SIGNATURE_FILE) continue;
    if (!listed.has(path)) problems.push(`${path} is in the export and ${SUMS_FILE} does not list it`);
  }
  let index: EvidenceIndex | null = null;
  try {
    index = JSON.parse(readFileSync(join(dir, INDEX_FILE), "utf-8")) as EvidenceIndex;
  } catch {
    problems.push(`${INDEX_FILE} is missing or not JSON`);
  }
  if (index) {
    for (const f of index.files) {
      if (listed.get(f.path) !== f.sha256) problems.push(`${INDEX_FILE} lists ${f.path} as ${f.sha256}, and ${SUMS_FILE} as ${listed.get(f.path) ?? "nothing"}`);
    }
    await checkSignatures(dir, index, out);
  }

  // The signature on the sums, intact whoever's key it is, and whether an exported signers file lists the key.
  const sigPath = join(dir, SUMS_SIGNATURE_FILE);
  if (existsSync(sigPath)) {
    const { sshSignatureKey, sshKeyFingerprint, verifySshSignatureWith } = await import("./gate-seal");
    const armored = readFileSync(sigPath, "utf-8");
    const blob = sshSignatureKey(armored);
    const check = blob ? verifySshSignatureWith(armored, sumsBytes, EVIDENCE_SIGNATURE_NAMESPACE, [blob]) : ({ ok: false, reason: "it is not an armored ssh signature" } as const);
    const key = blob ? sshKeyFingerprint(blob) : null;
    const listedIn: string[] = [];
    if (index && key) {
      for (const f of index.files.filter((x) => x.records.some((r) => r.kind === "signers"))) {
        const { parseAllowedSigners } = await import("../workspace/trust/trust-files");
        const keys = parseAllowedSigners(readFileSync(join(dir, ...f.path.split("/")), "utf-8")).signers.map((s) => fingerprintOfLine(s.key, sshKeyFingerprint));
        if (keys.includes(key)) listedIn.push(f.path);
      }
    }
    out.signature = { present: true, verified: check.ok, key, listedIn, reason: check.ok ? `${SUMS_FILE} is signed by ${key}${listedIn.length > 0 ? `, which ${listedIn.join(", ")} lists` : ", a key no exported signers file lists"}` : `the signature on ${SUMS_FILE} does not verify: ${check.reason}` };
    if (!check.ok) problems.push(out.signature.reason);
  }
  out.ok = problems.length === 0;
  return out;
}

function fingerprintOfLine(key: string, fingerprint: (blob: Buffer) => string): string {
  const b64 = key.split(/\s+/)[1];
  return b64 ? fingerprint(Buffer.from(b64, "base64")) : "";
}

/** Every file under `dir`, as a `/`-separated path relative to it. */
function walk(dir: string, at = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, at))) {
    const rel = at ? `${at}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

/** The cut and approval signatures, checked against the trust files the export holds. */
async function checkSignatures(dir: string, index: EvidenceIndex, out: EvidenceCheck): Promise<void> {
  const { readTrustPolicy } = await import("../workspace/trust/policy");
  const { workingTreeSource } = await import("../workspace/record-source");
  const { checkReleaseSignature } = await import("../workspace/identity-gate-rule");
  const { checkGateSeal } = await import("../workspace/trust/seal");
  const { parseCuts, parseRelease, verifyReleaseDigest } = await import("./release-store");
  const policyAt = (commit: string) => {
    const root = join(dir, "commits", commit);
    return existsSync(root) ? readTrustPolicy(workingTreeSource(root), commit) : null;
  };
  const pathOf = (f: EvidenceFile) => join(dir, ...f.path.split("/"));

  for (const f of index.files.filter((x) => x.records.some((r) => r.kind === "release"))) {
    const release = parseRelease(readFileSync(pathOf(f), "utf-8"));
    if (!release) {
      out.problems.push(`${f.path} is not a release file`);
      continue;
    }
    const matches = verifyReleaseDigest(release);
    out.releases.push({ path: f.path, releaseDigest: release.releaseDigest, digestMatches: matches });
    if (!matches) out.problems.push(`${f.path} does not hash to its digest ${release.releaseDigest}`);
  }

  const commitOf = new Map(index.releases.map((r) => [r.releaseDigest, r.commit]));
  for (const f of index.files.filter((x) => x.records.some((r) => r.kind === "cut"))) {
    const lines = new Set(f.records.find((r) => r.kind === "cut")?.lines ?? []);
    const body = readFileSync(pathOf(f), "utf-8").split("\n");
    for (const n of lines) {
      const cut = parseCuts(body[n - 1] ?? "").cuts[0];
      if (!cut) continue;
      const commit = commitOf.get(cut.releaseDigest);
      const policy = commit ? policyAt(commit) : null;
      if (!policy) {
        out.cuts.push({ path: f.path, line: n, who: cut.actor, status: "unchecked", reason: "the export holds no trust files at the release's commit" });
        continue;
      }
      const check = checkReleaseSignature({ gate: "release", class: null, signers: policy, roles: policy.roles, classes: [] }, cut);
      out.cuts.push({ path: f.path, line: n, who: cut.actor, status: check.status, reason: `${check.reason}, against ${policy.signersPath} at ${commit!.slice(0, 12)}` });
      if (check.status === "unverified") out.problems.push(`the cut on line ${n} of ${f.path} does not verify: ${check.reason}`);
    }
  }

  // An approval is judged by the trust at the base of the merge whose gate it is.
  const baseOfOp = new Map<string, string>();
  for (const f of index.files.filter((x) => x.records.some((r) => r.kind === "merge"))) {
    try {
      const m = JSON.parse(readFileSync(pathOf(f), "utf-8")) as { op?: unknown; base?: unknown };
      if (typeof m.op === "string" && typeof m.base === "string") baseOfOp.set(m.op, m.base);
    } catch {
      // A merge record that is not JSON was reported by the export.
    }
  }
  for (const f of index.files.filter((x) => x.records.some((r) => r.kind === "sealed-approval"))) {
    const lines = f.records.find((r) => r.kind === "sealed-approval")?.lines ?? [];
    const body = readFileSync(pathOf(f), "utf-8").split("\n");
    for (const n of lines) {
      let a: Record<string, unknown>;
      try {
        a = JSON.parse(body[n - 1] ?? "") as Record<string, unknown>;
      } catch {
        continue;
      }
      const who = String(a.resolvedBy ?? "");
      const base = typeof a.op === "string" ? baseOfOp.get(a.op) : undefined;
      const policy = base ? policyAt(base) : null;
      if (!policy) {
        out.approvals.push({ path: f.path, line: n, who, status: "unchecked", reason: "the export holds no merge record naming this op with trust files at its base" });
        continue;
      }
      const check = checkGateSeal(policy, a as never);
      const status = check.attested === true ? "verified" : check.code === "seal-missing" ? "unsigned" : "unverified";
      out.approvals.push({ path: f.path, line: n, who, status, reason: `${check.attested === true ? `sealed by ${who}` : check.message}, against ${policy.signersPath} at ${base!.slice(0, 12)}` });
      if (status === "unverified") out.problems.push(`the approval on line ${n} of ${f.path} does not verify: ${check.message}`);
    }
  }
}
