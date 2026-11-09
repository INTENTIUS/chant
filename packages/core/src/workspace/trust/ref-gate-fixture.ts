/**
 * Test support for the ref gate (#4867): a checkout and a bare remote, a
 * runner key, fake runner evidence signed with it, and override lines on
 * `chant/lifecycle`. Isolated from the user's git config. The temporary
 * directories are left in the system's temp directory.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRunnerKey } from "./dsse";
import { buildStatement, signEvidence } from "./evidence";
import { attachEvidence, EVIDENCE_NOTES_REF, refGateSubject } from "./ref-gate";
import { OVERRIDE_OP, overrideDigest } from "../../override-gate";

export interface RunnerKeyPair {
  pem: string;
  pub: string;
}

export function runnerKey(): RunnerKeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { pem, pub: loadRunnerKey(pem).publicKey };
}

export const RUNNER = "ci@example.test";

export class GateRepos {
  readonly root: string;
  readonly work: string;
  readonly origin: string;
  readonly home: string;

  constructor(label: string) {
    this.root = mkdtempSync(join(tmpdir(), `chant-4867-${label}-`));
    this.work = join(this.root, "work");
    this.origin = join(this.root, "origin.git");
    this.home = join(this.root, "home");
    mkdirSync(this.home);
    this.run(this.root, ["init", "-q", "--bare", "-b", "main", this.origin]);
    this.run(this.root, ["init", "-q", "-b", "main", this.work]);
    this.git(["remote", "add", "origin", this.origin]);
  }

  env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "",
      HOME: this.home,
      GIT_CONFIG_GLOBAL: join(this.home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    };
  }

  run(cwd: string, args: string[], input?: string): string {
    return execFileSync("git", args, { cwd, env: this.env(), input, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  }

  git(args: string[], input?: string): string {
    return this.run(this.work, args, input);
  }

  write(path: string, text: string): void {
    mkdirSync(dirname(join(this.work, path)), { recursive: true });
    writeFileSync(join(this.work, path), text);
  }

  commit(message: string): string {
    this.git(["add", "-A"]);
    this.git(["commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", message]);
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  /** Push `refspecs` to the bare remote with no hook in the way, and return git's output. */
  push(...refspecs: string[]): string {
    return this.run(this.work, ["push", "-q", "origin", ...refspecs]);
  }

  /** Sign evidence for `check` at `at` over `paths`, with `key`, and attach it to `to` (default `at`). */
  sign(key: RunnerKeyPair, check: string, at: string, paths: string[], to = at): unknown {
    const statement = buildStatement({ repo: this.work, commit: at, paths, runner: RUNNER, check });
    const { key: k, publicKey } = loadRunnerKey(key.pem);
    const envelope = signEvidence(statement, k, publicKey);
    attachEvidence(this.work, to, envelope);
    return envelope;
  }

  notesTip(): string {
    return this.git(["rev-parse", EVIDENCE_NOTES_REF]).trim();
  }

  /** Write `chant/lifecycle` holding a request for an override of `check` on `commit` and `by`'s override of it. */
  override(commit: string, check: string, by: string, reason: string, at = "2026-11-09T10:00:00.000Z"): string {
    const subject = refGateSubject(commit, check);
    const digest = overrideDigest(subject, commit, [check]);
    const pending = { version: 1, kind: "pending", op: OVERRIDE_OP, gate: subject, timestamp: "2026-11-09T09:00:00.000Z", expiresAt: "2026-11-12T09:00:00.000Z", planDigest: digest, plan: commit, rules: [check] };
    const resolution = { version: 1, kind: "resolution", op: OVERRIDE_OP, gate: subject, resolvedBy: by, timestamp: at, note: reason, planDigest: digest };
    const blob = this.git(["hash-object", "-w", "--stdin"], `${JSON.stringify(pending)}\n${JSON.stringify(resolution)}\n`).trim();
    const gates = this.git(["mktree"], `100644 blob ${blob}\t${OVERRIDE_OP}.jsonl\n`).trim();
    const tree = this.git(["mktree"], `040000 tree ${gates}\t_gates\n`).trim();
    const c = this.git(["commit-tree", tree, "-m", "ledger"]).trim();
    this.git(["update-ref", "refs/heads/chant/lifecycle", c]);
    return c;
  }
}

/** `.chant/trust.json` with one runner and a ref rule for `refs/heads/main` and `refs/heads/release/*`. */
export function trustJson(runner: RunnerKeyPair, checks: Array<{ check: string; action?: "block" | "warn"; command: string }>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      schema: 1,
      runners: [{ principal: RUNNER, class: "runner", key: runner.pub }],
      refs: [{ ref: "refs/heads/main", checks }, { ref: "refs/heads/release/*", checks }],
      ...extra,
    },
    null,
    2,
  );
}
