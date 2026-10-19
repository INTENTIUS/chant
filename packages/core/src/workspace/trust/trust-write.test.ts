/**
 * #3510: a runner entry of `.chant/trust.json` written through chant, with
 * `--by` and `--expect` as the other working-tree writes take them, and read
 * back by the readers that use runners: `readTrustPolicy`, `ciTagSigner` and
 * `ci tick --source runs`.
 *
 * Each test works in its own temp repository (a bare origin where it pushes),
 * and every key is a throwaway one. Nothing is written in process.cwd().
 */

import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseArgs } from "../../cli/parse-args";
import { cleanScratch, contract, declaration, git, scratchDir, writeFiles } from "../__fixtures__/contract-repo";
import { ciTagSigner, ciTick, opRunSigner } from "../ci-green";
import { workingTreeSource } from "../record-source";
import schema from "../trust-write.schema.json";
import { runOpLocally } from "../../op/local-executor";
import type { ActivityFn } from "../../op/activity-registry";
import { sshFromEd25519 } from "./dsse";
import { readTrustPolicy } from "./policy";
import { trustDigest, trustWrite, type TrustWriteDocument, type TrustWriteRequest } from "./trust-write";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

function runnerKey(): { pem: string; ssh: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ssh: sshFromEd25519(Buffer.from(jwk.x, "base64url")) };
}

function emptyRepo(files: Record<string, string> = {}): string {
  const root = scratchDir("chant-trust-write-");
  git(root, "init", "-q");
  writeFiles(root, files);
  return root;
}

function run(root: string, req: Omit<TrustWriteRequest, "cwd">): TrustWriteDocument {
  const doc = trustWrite({ ...req, cwd: root });
  expectValid(doc);
  return doc;
}

const code = (doc: TrustWriteDocument) => ("error" in doc ? doc.error.code : null);
const trustOf = (root: string) => JSON.parse(readFileSync(join(root, ".chant/trust.json"), "utf-8")) as Record<string, unknown>;
const ok = (doc: TrustWriteDocument) => {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
};

describe("trust runner add and remove (#3510)", () => {
  test("add writes the entry and the runner role, remove takes both away, and a stale --expect is refused", () => {
    const root = emptyRepo();
    const bot = runnerKey();
    writeFiles(root, { "keys/bot.pub": `${bot.ssh} bot@host\n` });

    const added = ok(run(root, { action: "runner add", name: "ci:acme/app", key: "keys/bot.pub", by: "github:alex" }));
    expect(added).toMatchObject({ action: "runner add", changed: true, previous: null, entry: { principal: "ci:acme/app", class: "runner", key: bot.ssh }, runnerRole: true, paths: [".chant/trust.json"] });
    expect(added.previousDigest).toBe(trustDigest(null));
    expect(added.digest).toBe(trustDigest(readFileSync(join(root, ".chant/trust.json"), "utf-8")));
    expect(trustOf(root)).toEqual({ schema: 1, runners: [{ principal: "ci:acme/app", class: "runner", key: bot.ssh }], roles: { runner: ["ci:acme/app"] } });

    // The same entry again changes nothing, and says so.
    const again = ok(run(root, { action: "runner add", name: "ci:acme/app", key: bot.ssh, expect: added.digest }));
    expect(again).toMatchObject({ changed: false, paths: [], digest: added.digest });

    // A second runner, from a PEM private key, as a lobby holds it.
    const lobby = runnerKey();
    writeFileSync(join(root, "lobby.pem"), lobby.pem);
    const second = ok(run(root, { action: "runner add", name: "studio:lobby", key: "lobby.pem", runnerClass: "service", expect: added.digest }));
    expect(second).toMatchObject({ entry: { principal: "studio:lobby", class: "service", key: lobby.ssh }, runnerRole: false });

    // The policy reads both, with the role for the runner only.
    const policy = readTrustPolicy(workingTreeSource(root), null);
    expect(policy.problems).toEqual([]);
    expect(policy.runners.map((r) => r.principal)).toEqual(["ci:acme/app", "studio:lobby"]);
    expect(policy.roles.runner).toEqual(["ci:acme/app"]);

    const removed = ok(run(root, { action: "runner remove", name: "ci:acme/app", by: "github:alex", expect: second.digest }));
    expect(removed).toMatchObject({ changed: true, previous: { principal: "ci:acme/app" }, entry: null, runnerRole: false });
    expect(trustOf(root)).toEqual({ schema: 1, runners: [{ principal: "studio:lobby", class: "service", key: lobby.ssh }], roles: { runner: [] } });

    // The digest the caller read is the one before the remove: refused, naming the last write.
    const stale = run(root, { action: "runner remove", name: "studio:lobby", expect: second.digest });
    expect(code(stale)).toBe("trust-conflict");
    expect("conflict" in stale && stale.conflict).toMatchObject({ expected: second.digest, digest: removed.digest, lastWrite: { verb: "trust runner remove", by: "github:alex" } });
    expect(trustOf(root).runners).toHaveLength(1);

    expect(code(run(root, { action: "runner remove", name: "ci:acme/app" }))).toBe("runner-unknown");
  });

  test("an existing file is edited in place, keeping its other keys and layout", () => {
    const text = `{\n  "schema": 1,\n  "roles": {\n    "admin": ["alex"]\n  },\n  "adopted": []\n}\n`;
    const root = emptyRepo({ ".chant/trust.json": text });
    const bot = runnerKey();
    const doc = ok(run(root, { action: "runner add", name: "ci-bot", key: bot.ssh, expect: trustDigest(text) }));
    const after = readFileSync(join(root, ".chant/trust.json"), "utf-8");
    expect(after.startsWith(`{\n  "schema": 1,\n  "roles": {\n    "admin": ["alex"],`)).toBe(true);
    expect(JSON.parse(after)).toEqual({ schema: 1, roles: { admin: ["alex"], runner: ["ci-bot"] }, adopted: [], runners: [{ principal: "ci-bot", class: "runner", key: bot.ssh }] });
    expect(doc.digest).toBe(trustDigest(after));
    // --dry-run reports the same and writes nothing.
    const dry = ok(run(root, { action: "runner remove", name: "ci-bot", dryRun: true }));
    expect(dry.changed).toBe(true);
    expect(readFileSync(join(root, ".chant/trust.json"), "utf-8")).toBe(after);
  });

  test("refusals: a key that is not ssh-ed25519, a person's key, a taken key or principal, a broken file", () => {
    const bot = runnerKey();
    const person = runnerKey();
    const root = emptyRepo({ ".chant/allowed_signers": `alex ${person.ssh}\n` });
    expect(code(run(root, { action: "runner add", name: "x", key: "ssh-rsa AAAAB3NzaC1yc2E=" }))).toBe("runner-key-invalid");
    expect(code(run(root, { action: "runner add", name: "x", key: "ssh-ed25519 AAAA" }))).toBe("runner-key-invalid");
    expect(code(run(root, { action: "runner add", name: "x", key: "no-such-file.pub" }))).toBe("runner-key-invalid");
    expect(code(run(root, { action: "runner add", name: "x", key: person.ssh }))).toBe("runner-key-is-signer");
    expect(code(run(root, { action: "runner add", name: "alex", key: bot.ssh }))).toBe("runner-key-is-signer");
    expect(code(run(root, { action: "runner add", name: "x" }))).toBe("write-usage-invalid");
    expect(code(run(root, { action: "runner add", name: "x", key: bot.ssh, runnerClass: "person" }))).toBe("write-usage-invalid");
    expect(code(run(root, { action: "runner add", name: "x", key: bot.ssh, expect: "abc" }))).toBe("write-usage-invalid");
    expect(code(run(root, { action: "runner remove", name: "x", key: bot.ssh }))).toBe("write-usage-invalid");

    ok(run(root, { action: "runner add", name: "ci-bot", key: bot.ssh }));
    expect(code(run(root, { action: "runner add", name: "other", key: bot.ssh }))).toBe("runner-exists");
    expect(code(run(root, { action: "runner add", name: "ci-bot", key: runnerKey().ssh }))).toBe("runner-exists");
    expect(code(run(root, { action: "runner add", name: "ci-bot", key: bot.ssh, runnerClass: "service" }))).toBe("runner-exists");

    writeFileSync(join(root, ".chant/trust.json"), `{ "schema": 2 }`);
    expect(code(run(root, { action: "runner add", name: "y", key: runnerKey().ssh }))).toBe("trust-config-invalid");
    expect(code(trustWrite({ cwd: scratchDir("chant-trust-nogit-"), action: "runner add", name: "y", key: bot.ssh }))).toBe("not-a-git-repository");
  });

  test("the command line takes --class, --key, --by and --expect", () => {
    const args = parseArgs(["workspace", "trust", "runner", "add", "ci-bot", "--key", "k.pub", "--class", "service", "--by", "github:alex", "--expect", "a".repeat(64)]);
    expect(args).toMatchObject({ key: "k.pub", runnerClass: "service", by: "github:alex", expect: "a".repeat(64) });
  });
});

describe("a runner added through the write is trusted by the readers (#3510)", () => {
  test("ci tick --source runs tags a commit from a run signed by a runner the write listed", async () => {
    const bot = runnerKey();
    const origin = scratchDir("chant-trust-write-origin-");
    git(origin, "init", "-q", "--bare");
    const root = scratchDir("chant-trust-write-ci-");
    git(root, "init", "-q");
    git(root, "symbolic-ref", "HEAD", "refs/heads/main");
    git(root, "remote", "add", "origin", origin);
    const green = { branch: "main", phases: { test: ["test"] }, require: ["test"], source: "runs" };
    writeFiles(root, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green } }), "app/a.txt": "a\n", "runner.pem": bot.pem });
    writeFiles(root, { ".gitignore": "runner.pem\n" });

    // Before the write, the key is refused.
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    expect(() => ciTagSigner(root, git(root, "rev-parse", "HEAD"), bot.pem)).toThrow(/lists no runner with this key/);

    ok(run(root, { action: "runner add", name: "ci-bot", key: "runner.pem", by: "t" }));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "trust the ci-bot runner");
    const head = git(root, "rev-parse", "HEAD");
    expect(ciTagSigner(root, head, bot.pem).principal).toBe("ci-bot");

    const pass = new Map<string, ActivityFn>([["step", async () => ({})]]);
    const op = { name: "test", overview: "run test", labels: { Env: "ci" }, phases: [{ name: "Run", steps: [{ kind: "activity" as const, fn: "step", args: {} }] }] };
    const { record } = await runOpLocally(op, pass, {}, undefined, { cwd: root, ledger: { cwd: root }, signRecord: opRunSigner(root, bot.pem) });
    expect(record.gitSha).toBe(head);
    git(root, "push", "-q", "origin", "main");
    git(root, "push", "-q", "origin", "chant/lifecycle");

    const tick = await ciTick({ cwd: root, runnerKey: bot.pem, now: new Date() });
    expect(tick.made).toEqual([`ci/green/${head}`]);
    expect(tick.signer).toBe("ci-bot");
    expect(execFileSync("git", ["ls-remote", "--tags", origin], { encoding: "utf-8" })).toContain(`refs/tags/ci/green/${head}`);
  });
});
