/**
 * The first attestor: ssh-signed commits, checked against the signers the
 * base policy lists (#2524 D5, ws-001).
 *
 * It does not ask `git verify-commit`. That would read `gpg.ssh.program`,
 * `gpg.ssh.allowedSignersFile` and the rest from git config, which whoever
 * controls the machine can set, and it passes the commit's own date to
 * ssh-keygen as the verification time. Instead it takes the signature and the
 * signed payload out of the commit object itself and hands them to
 * `ssh-keygen -Y verify` with a signers file built from the base policy, in
 * the `git` namespace.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttestorContext, CommitAttestation, CommitAttestor } from "./attestor";
import { renderAllowedSigners, type Signer } from "./policy";

const NAME = "ssh-commit";

/** A commit object split into its signed payload and its signature. */
export interface SignedCommit {
  /** The bytes the signature covers: the commit object without its signature header. */
  payload: Buffer;
  /** The armored signature, or undefined when the commit is unsigned. */
  signature?: string;
}

/**
 * Split a raw commit object. `header` is `gpgsig` in a SHA-1 repository and
 * `gpgsig-sha256` in a SHA-256 one; git removes exactly that header, with its
 * continuation lines, to get the bytes it signed.
 */
export function splitSignedCommit(raw: Buffer, header = "gpgsig"): SignedCommit {
  const end = raw.indexOf("\n\n");
  const headEnd = end < 0 ? raw.length : end;
  const head = raw.subarray(0, headEnd).toString("latin1").split("\n");
  const kept: string[] = [];
  const sig: string[] = [];
  let inSig = false;
  for (const line of head) {
    if (inSig && line.startsWith(" ")) {
      sig.push(line.slice(1));
      continue;
    }
    inSig = false;
    if (sig.length === 0 && line.startsWith(`${header} `)) {
      inSig = true;
      sig.push(line.slice(header.length + 1));
      continue;
    }
    kept.push(line);
  }
  const payload = Buffer.concat([Buffer.from(kept.join("\n"), "latin1"), raw.subarray(headEnd)]);
  return { payload, signature: sig.length > 0 ? sig.join("\n") + "\n" : undefined };
}

function objectFormat(repo: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-object-format"], { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "sha1";
  }
}

/** Run ssh-keygen; `missing` is true when it is not installed. Shared with the verdict seals (./seal.ts). */
export function sshKeygen(args: string[], input?: Buffer): { status: number | null; stdout: string; stderr: string; missing: boolean } {
  const r = spawnSync("ssh-keygen", args, { input, encoding: "buffer", timeout: 30_000 });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { status: r.status, stdout: r.stdout?.toString("utf-8") ?? "", stderr: r.stderr?.toString("utf-8") ?? "", missing };
}

const cache = new Map<string, CommitAttestation>();

/**
 * Check a detached ssh signature over `payload` in `namespace` against
 * `signers`. Shared with the rotation check (#2553), which signs signer sets
 * in their own namespace so a commit signature can never stand in for one.
 */
export function verifySshSignature(
  signers: Signer[],
  payload: Buffer,
  signature: string,
  namespace: string,
): { ok: true; principal: string; key?: string } | { ok: false; missing: boolean; reason: string } {
  if (signers.length === 0) return { ok: false, missing: false, reason: "the policy lists no usable signer" };
  const dir = mkdtempSync(join(tmpdir(), "chant-trust-"));
  try {
    const allowed = join(dir, "allowed_signers");
    const sigFile = join(dir, "signature");
    writeFileSync(allowed, renderAllowedSigners(signers));
    writeFileSync(sigFile, signature);
    const found = sshKeygen(["-Y", "find-principals", "-f", allowed, "-s", sigFile]);
    if (found.missing) return { ok: false, missing: true, reason: "ssh-keygen is not installed here" };
    const principals = found.status === 0 ? found.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    if (principals.length === 0) return { ok: false, missing: false, reason: "signed by a key the policy at base does not list" };
    for (const principal of principals) {
      const v = sshKeygen(["-Y", "verify", "-f", allowed, "-I", principal, "-n", namespace, "-s", sigFile], payload);
      if (v.status === 0) {
        const key = /key (SHA256:[A-Za-z0-9+/=]+)/.exec(v.stdout + v.stderr)?.[1];
        return { ok: true, principal, ...(key ? { key } : {}) };
      }
    }
    return { ok: false, missing: false, reason: `the signature does not verify in the ${namespace} namespace for a key the policy lists` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const sshCommitAttestor: CommitAttestor = {
  name: NAME,
  attestCommit(ctx: AttestorContext, commit: string): CommitAttestation {
    const signers = ctx.policy.signers;
    const memo = `${ctx.repo}\0${commit}\0${renderAllowedSigners(signers)}`;
    const hit = cache.get(memo);
    if (hit) return hit;
    const answer = attest(ctx.repo, commit, signers);
    cache.set(memo, answer);
    return answer;
  },
};

function attest(repo: string, commit: string, signers: Signer[]): CommitAttestation {
  const raw = execFileSync("git", ["cat-file", "commit", commit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const header = objectFormat(repo) === "sha256" ? "gpgsig-sha256" : "gpgsig";
  const { payload, signature } = splitSignedCommit(raw, header);
  if (!signature) return { level: "unattested", attestor: NAME, reason: "the commit is not signed" };
  if (!signature.startsWith("-----BEGIN SSH SIGNATURE-----")) {
    const format = signature.startsWith("-----BEGIN PGP SIGNATURE-----") ? "an OpenPGP" : "a non-ssh";
    return { level: "attested-unverifiable-here", attestor: NAME, reason: `the commit carries ${format} signature, which this attestor does not check` };
  }
  const r = verifySshSignature(signers, payload, signature, "git");
  if (r.ok) return { level: "attested", attestor: NAME, principal: r.principal, ...(r.key ? { key: r.key } : {}), reason: `signed by ${r.principal}` };
  if (r.missing) return { level: "attested-unverifiable-here", attestor: NAME, reason: r.reason };
  return { level: "unattested", attestor: NAME, reason: r.reason };
}
