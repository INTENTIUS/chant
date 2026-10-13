/**
 * Level 3 of the reference workspace (#2543, #2525): signing. The fixture is
 * policy-free on purpose: it carries no `.chant/allowed_signers`, so a copy
 * made with `chant init --from` has no policy until its owner writes one, and
 * the fixture's records are read under whatever policy the enclosing repo has
 * (#3076). So the level-3 coverage runs on a copy in a throwaway git
 * repository, with ed25519 keys made by ssh-keygen at test time. No key is
 * ever committed.
 *
 * - a verdict sealed with `records review --sign` counts as attested, and an
 *   unsigned one, or one sealed by a key the signers file does not list, does
 *   not (ws-052, #2687);
 * - `workspace verify` fails a change to `.chant/allowed_signers` that is not
 *   signed by a listed signer, and a signed one that carries no rotation;
 * - a signed change with a rotation file made by `workspace signers rotate`
 *   and `signers sign` passes, and reports the version step (ws-069).
 *
 * In the test-e2e job, not the unit shards: each case spawns the real CLI a
 * few times, and the unit shards budget a test at 15s (#2551).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initFromCommand } from "@intentius/chant/workspace/lineage-init";

const repoRoot = resolve(import.meta.dirname, "..");
const fixture = join(repoRoot, "reference-workspace");
const CLI_TIMEOUT_MS = 60_000;
const KIND = "decisions/decision.kind.mjs";

const hasSshKeygen = spawnSync("ssh-keygen", ["-Y"], { stdio: "ignore" }).error === undefined;

let scratch = "";
let home = "";
let ws = "";
let changeHead = "";
const keys: Record<"alice" | "bob" | "mallory", { file: string; pub: string }> = {} as never;

/** A git environment that never sees the developer's own config or signing setup. */
function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.test",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.test",
    NO_COLOR: "1",
  };
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ws, env: env(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Commit everything, signed with `key` when given. */
function commit(message: string, key?: { file: string }): void {
  git("add", "-A");
  if (key) git("-c", "gpg.format=ssh", "-c", `user.signingkey=${key.file}`, "commit", "-q", "-S", "-m", message);
  else git("commit", "-q", "--no-gpg-sign", "-m", message);
}

function chant(...args: string[]) {
  const argv = ["--import", pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href, join(repoRoot, "packages/core/src/cli/main.ts"), ...args];
  return spawnSync(process.execPath, argv, { cwd: ws, encoding: "utf-8", timeout: CLI_TIMEOUT_MS, env: env() });
}

function keygen(name: string): { file: string; pub: string } {
  const file = join(scratch, `key-${name}`);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]);
  return { file, pub: readFileSync(`${file}.pub`, "utf-8").trim().split(" ").slice(0, 2).join(" ") };
}

const principal = (name: string) => `${name}@example.test`;

interface Verdict {
  principal: string;
  attested: boolean;
  attestation: { code?: string };
}
interface RecordsDoc {
  trust: { active: boolean };
  records: { id: string; quorum: { counted: Verdict[]; notCounted: Verdict[] } }[];
}
interface VerifyDoc {
  ok: boolean;
  failures: string[];
  rotation: { code?: string; from?: number; to?: number; signedBy?: string[] } | null;
  protectedWrites: { allowed: boolean; paths: string[] }[];
}

function verifyJson(): VerifyDoc {
  const run = chant("workspace", "verify", "--json");
  expect(run.stdout, run.stderr).not.toBe("");
  return JSON.parse(run.stdout) as VerifyDoc;
}

describe.skipIf(!hasSshKeygen)("the reference workspace at level 3: signing", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "chant-2543-signing-"));
    home = join(scratch, "home");
    mkdirSync(home);
    ws = join(scratch, "ws");
    for (const name of ["alice", "bob", "mallory"] as const) keys[name] = keygen(name);

    // The fixture carries no policy, so neither does a copy of it.
    expect(existsSync(join(fixture, ".chant", "allowed_signers"))).toBe(false);
    const made = await initFromCommand({ from: `${repoRoot}@HEAD#reference-workspace`, path: ws });
    expect(made.success, made.error).toBe(true);
    expect(existsSync(join(ws, ".chant", "allowed_signers"))).toBe(false);

    // The base branch holds the policy: alice and bob are signers, mallory is not.
    git("init", "-q", "-b", "main");
    writeFileSync(join(ws, ".chant", "allowed_signers"), `${principal("alice")} ${keys.alice.pub}\n${principal("bob")} ${keys.bob.pub}\n`);
    commit("the reference workspace, with a signers file");
    git("checkout", "-q", "-b", "change");
    changeHead = git("rev-parse", "HEAD").trim();
  }, 120_000);

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** Back to the base commit, with a clean tree. */
  function reset(): void {
    git("reset", "-q", "--hard", changeHead);
  }

  test("a verdict sealed by a listed signer counts as attested, and an unsigned or unlisted one does not", () => {
    reset();
    const review = (by: string, ...sign: string[]) => {
      const run = chant("workspace", "records", "review", "ref-001", "--kind", KIND, "--verdict", "agree", "--by", principal(by), ...sign);
      expect(run.status, run.stderr).toBe(0);
    };
    review("alice", "--sign", keys.alice.file);
    review("bob");
    review("mallory", "--sign", keys.mallory.file);

    const run = chant("workspace", "records", "--kind", KIND, "--json");
    expect(run.status, run.stderr).toBe(0);
    const doc = JSON.parse(run.stdout) as RecordsDoc;
    expect(doc.trust.active).toBe(true);
    const quorum = doc.records.find((r) => r.id === "ref-001")!.quorum;
    expect(quorum.counted.map((v) => [v.principal, v.attested])).toEqual([[principal("alice"), true]]);
    const notCounted = Object.fromEntries(quorum.notCounted.map((v) => [v.principal, v.attestation.code]));
    expect(notCounted).toEqual({
      [principal("bob")]: "seal-missing",
      [principal("mallory")]: "seal-signer-unlisted",
    });
    reset();
  }, 60_000);

  test("verify passes a change signed by a listed signer", () => {
    reset();
    appendFileSync(join(ws, "app", "README-change.md"), "a change\n");
    commit("a change", keys.alice);
    const doc = verifyJson();
    expect(doc.failures).toEqual([]);
    expect(doc.ok).toBe(true);
    reset();
  });

  test("verify fails a policy change that is unsigned, and one that is signed but has no rotation", () => {
    reset();
    appendFileSync(join(ws, ".chant", "allowed_signers"), `${principal("mallory")} ${keys.mallory.pub}\n`);
    commit("add mallory, unsigned");
    const unsigned = verifyJson();
    expect(unsigned.ok).toBe(false);
    expect(unsigned.protectedWrites.map((w) => [w.paths, w.allowed])).toEqual([[[".chant/allowed_signers"], false]]);

    reset();
    appendFileSync(join(ws, ".chant", "allowed_signers"), `${principal("mallory")} ${keys.mallory.pub}\n`);
    commit("add mallory, signed", keys.alice);
    const signed = verifyJson();
    expect(signed.ok).toBe(false);
    expect(signed.protectedWrites.every((w) => w.allowed)).toBe(true);
    expect(signed.rotation?.code).toBe("rotation-missing");
    reset();
  });

  test("a signer rotation signed by the set before passes and reports the version step (ws-069)", () => {
    reset();
    appendFileSync(join(ws, ".chant", "allowed_signers"), `${principal("mallory")} ${keys.mallory.pub}\n`);
    const rotate = chant("workspace", "signers", "rotate");
    expect(rotate.status, rotate.stderr).toBe(0);
    const sign = chant("workspace", "signers", "sign", "--key", keys.alice.file);
    expect(sign.status, sign.stderr).toBe(0);
    commit("add mallory, rotated", keys.alice);
    const doc = verifyJson();
    expect(doc.failures).toEqual([]);
    expect(doc.ok).toBe(true);
    expect(doc.rotation).toEqual({ from: 1, to: 2, signedBy: [principal("alice")] });
    reset();
  });
});
