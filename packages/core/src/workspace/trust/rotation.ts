/**
 * Signer rotation, verified from history (#2553, #2524 D5, ws-001).
 *
 * A signer set is the signers file plus a threshold. A new set is valid only
 * when a threshold of the previous set signed it, as in TUF's root rotation.
 * The signatures live beside the signers file, in `<signers>.rotation.json`:
 *
 * ```json
 * { "schema": 1, "version": 2, "previous": "sha256:…", "threshold": 1,
 *   "signatures": [{ "principal": "alice@example.com", "signature": "-----BEGIN SSH SIGNATURE-----…" }] }
 * ```
 *
 * Each signature is `ssh-keygen -Y sign -n chant-signers` over the statement
 * {@link rotationStatement} returns: the new version, the digest of the
 * previous signers file, the digest of the new one and the new threshold. The
 * version number and the previous digest together stop an old, once-valid set
 * from being replayed, and the namespace stops a commit signature from
 * standing in for a rotation signature.
 *
 * ## Revocation by position
 *
 * Dates prove nothing: whoever makes a commit sets its date. So a commit is
 * judged by where it sits in the base's history. Walking the base's
 * first-parent line from the oldest commit, each commit that changes the
 * signer set starts a version, and each version must be signed by a threshold
 * of the one before. A commit already in the base's history is judged by the
 * version in effect just before the first-parent commit that brought it in. A
 * key removed at version N therefore still vouches for what was merged before
 * N, and for nothing merged after, however the later commit is dated. A commit
 * not yet in the base's history is judged by the latest version.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../effect-receipt";
import { parseAllowedSigners, type ExcludedSigner, type Signer } from "./policy";
import { verifySshSignature } from "./ssh-commit";

/** The ssh-keygen namespace rotation signatures are made in. Never `git`. */
export const ROTATION_NAMESPACE = "chant-signers";

/** The rotation file for a signers file. */
export function rotationPath(signersPath: string): string {
  return posix.join(posix.dirname(signersPath), `${posix.basename(signersPath)}.rotation.json`);
}

/** `sha256:<hex>` of a signers file's bytes, line endings normalised. */
export function signersDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex")}`;
}

export const rotationFileSchema = z
  .object({
    schema: z.literal(1),
    version: z.number().int().min(1),
    previous: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
    threshold: z.number().int().min(1),
    signatures: z.array(z.object({ principal: z.string().min(1), signature: z.string().min(1) }).strict()),
  })
  .strict();
export type RotationFile = z.infer<typeof rotationFileSchema>;

/** The bytes each rotation signature covers. */
export function rotationStatement(r: { version: number; previous: string | null; threshold: number }, signers: string): Buffer {
  return Buffer.from(
    canonicalJson({ type: "chant-signer-set", version: r.version, previous: r.previous, signers, threshold: r.threshold }),
    "utf8",
  );
}

/** One version of the signer set, as history established it. */
export interface SignerVersion {
  /** 1 and up; 0 marks where the signers file was removed and nothing was in effect. */
  version: number;
  /** The first-parent commit that made this version, or null for a set not yet merged. */
  commit: string | null;
  digest: string;
  threshold: number;
  signers: Signer[];
  excluded: ExcludedSigner[];
  /** The principals whose signatures made this version valid; empty for the first version. */
  signedBy: string[];
}

export interface SignerHistory {
  versions: SignerVersion[];
  /** Where the chain broke, when it did. Nothing verifies then. */
  broken?: { commit: string | null; reason: string };
}

/** The state of the signer files at one point, as text. */
export interface SignerFiles {
  signers?: string;
  rotation?: string;
}

/**
 * Check `next` against the version before it. Returns the new version, or
 * the reason it is not valid. `prev` undefined means there was no signer set,
 * so `next` is a first version and needs no signatures.
 */
export function nextVersion(prev: SignerVersion | undefined, next: SignerFiles, commit: string | null): SignerVersion | { reason: string } {
  if (next.signers === undefined) return { reason: "the signers file was removed" };
  const digest = signersDigest(next.signers);
  let rotation: RotationFile | undefined;
  if (next.rotation !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(next.rotation);
    } catch (err) {
      return { reason: `the rotation file is not JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const parsed = rotationFileSchema.safeParse(raw);
    if (!parsed.success) return { reason: `the rotation file is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ")}` };
    rotation = parsed.data;
  }
  const set = parseAllowedSigners(next.signers);
  const threshold = rotation?.threshold ?? 1;

  if (!prev) {
    if (rotation && (rotation.version !== 1 || rotation.previous !== null)) {
      return { reason: `a first signer set must be version 1 with no previous digest, not version ${rotation.version}` };
    }
    return { version: 1, commit, digest, threshold, signers: set.signers, excluded: set.excluded, signedBy: [] };
  }
  if (digest === prev.digest && threshold === prev.threshold) return prev;
  if (!rotation) return { reason: `the signer set changed from version ${prev.version} with no rotation file signed by the set before it` };
  if (rotation.version !== prev.version + 1) return { reason: `the rotation says version ${rotation.version}; the next version is ${prev.version + 1}` };
  if (rotation.previous !== prev.digest) return { reason: `the rotation names previous ${rotation.previous}, but version ${prev.version} is ${prev.digest}` };

  const statement = rotationStatement(rotation, digest);
  const keys = new Set<string>();
  const signedBy: string[] = [];
  for (const s of rotation.signatures) {
    const mine = prev.signers.filter((x) => x.principal === s.principal);
    const r = verifySshSignature(mine, statement, s.signature, ROTATION_NAMESPACE);
    if (!r.ok) continue;
    const key = mine.find((x) => x.principal === r.principal)?.key ?? r.principal;
    if (keys.has(key)) continue;
    keys.add(key);
    signedBy.push(r.principal);
  }
  if (keys.size < prev.threshold) {
    return {
      reason: `version ${rotation.version} is signed by ${keys.size} of the ${prev.threshold} signers of version ${prev.version} it needs${
        signedBy.length ? ` (${signedBy.join(", ")})` : ""
      }`,
    };
  }
  return { version: rotation.version, commit, digest, threshold, signers: set.signers, excluded: set.excluded, signedBy };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

/** A file's text at `commit`, or undefined when it is not there. */
export function fileAt(repo: string, commit: string, path: string): string | undefined {
  try {
    return git(repo, ["cat-file", "blob", `${commit}:${path}`]);
  } catch {
    return undefined;
  }
}

/**
 * Walk the signer set's history along the first-parent line of `base`,
 * oldest first. A removal ends the chain; a later signers file starts a new
 * one, which only the protected-write check in CI could have admitted.
 */
export function signerHistory(repo: string, base: string, signersPath: string): SignerHistory {
  const paths = [signersPath, rotationPath(signersPath)];
  const commits = git(repo, ["--literal-pathspecs", "log", "--first-parent", "--reverse", "--format=%H", base, "--", ...paths])
    .split("\n")
    .filter(Boolean);
  const versions: SignerVersion[] = [];
  let prev: SignerVersion | undefined;
  for (const commit of commits) {
    const files = { signers: fileAt(repo, commit, paths[0]), rotation: fileAt(repo, commit, paths[1]) };
    if (files.signers === undefined) {
      // Earlier versions still judge what was merged under them; from here on, nothing verifies.
      if (prev) versions.push({ version: 0, commit, digest: "", threshold: 0, signers: [], excluded: [], signedBy: [] });
      prev = undefined;
      continue;
    }
    const next = nextVersion(prev, files, commit);
    if ("reason" in next) return { versions, broken: { commit, reason: next.reason } };
    if (next !== prev) versions.push(next);
    prev = next;
  }
  return { versions };
}

/**
 * Finds the signer set in effect for a commit, by its position in the base's
 * history. Built once per base; the first-parent line is read once and
 * each lookup is a binary search.
 */
export class SignerPositions {
  private line: string[] | undefined;
  private index = new Map<string, number>();
  private memo = new Map<string, SignerVersion | null>();

  constructor(
    private readonly repo: string,
    private readonly base: string,
    private readonly history: SignerHistory,
  ) {}

  private isAncestor(a: string, b: string): boolean {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: this.repo, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** The base's first-parent line, newest first. */
  private firstParents(): string[] {
    if (!this.line) {
      this.line = git(this.repo, ["rev-list", "--first-parent", this.base]).split("\n").filter(Boolean);
      this.line.forEach((c, i) => this.index.set(c, i));
    }
    return this.line;
  }

  /**
   * The version that judges `commit`, or null when no signer set was in
   * effect there (before the first one, or the chain is broken).
   */
  versionFor(commit: string): SignerVersion | null {
    const hit = this.memo.get(commit);
    if (hit !== undefined) return hit;
    const answer = this.lookup(commit);
    this.memo.set(commit, answer);
    return answer;
  }

  private lookup(commit: string): SignerVersion | null {
    if (this.history.broken) return null;
    const latest = this.history.versions.at(-1) ?? null;
    if (!this.isAncestor(commit, this.base)) return latest;
    const line = this.firstParents();
    // The oldest first-parent commit that contains `commit` is where it came in.
    let lo = 0;
    let hi = line.length - 1;
    let at = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.isAncestor(commit, line[mid])) {
        at = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // The newest version made strictly before that commit.
    let best: SignerVersion | null = null;
    let bestIndex = Infinity;
    for (const v of this.history.versions) {
      const i = v.commit ? this.index.get(v.commit) : undefined;
      if (i === undefined || i <= at) continue;
      if (i < bestIndex) {
        best = v;
        bestIndex = i;
      }
    }
    return best;
  }
}
