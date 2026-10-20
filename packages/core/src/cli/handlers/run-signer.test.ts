/**
 * #4156: `chant run`'s runner key is opt-in hardening. A `CHANT_RUNNER_KEY`
 * that `.chant/trust.json` does not list leaves the run unsigned with no
 * warning, unless the declaration sets `ci.green.signedSince`. A key that is
 * not an Ed25519 PEM is an error either way.
 */

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "../../workspace/__fixtures__/contract-repo";
import { sshFromEd25519 } from "../../workspace/trust/dsse";
import type { CommandContext } from "../registry";
import { runSignerFor } from "./run";

const home = process.cwd();
const saved = process.env.CHANT_RUNNER_KEY;
afterEach(() => {
  process.chdir(home);
  if (saved === undefined) delete process.env.CHANT_RUNNER_KEY;
  else process.env.CHANT_RUNNER_KEY = saved;
  vi.restoreAllMocks();
  cleanScratch();
});

function key(): { pem: string; ssh: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ssh: sshFromEd25519(Buffer.from(jwk.x, "base64url")) };
}

function repo(green?: Record<string, unknown>): string {
  const root = scratchDir("chant-run-signer-");
  git(root, "init", "-q");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) git(root, "config", k!, v!);
  writeFiles(root, {
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], green ? { ci: { green } } : {}),
    ".chant/trust.json": JSON.stringify({ schema: 1, runners: [{ principal: "ci-bot", class: "runner", key: key().ssh }], roles: { runner: ["ci-bot"] } }),
    "app/a.txt": "a\n",
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

async function signer(root: string, pem: string, verbose = false) {
  process.chdir(root);
  process.env.CHANT_RUNNER_KEY = pem;
  const err: string[] = [];
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
  const result = await runSignerFor({ args: { verbose } } as unknown as CommandContext);
  return { result, err: err.join("\n") };
}

describe("chant run's runner key from the environment (#4156)", () => {
  test("a key trust.json does not list leaves the run unsigned and quiet, with one line under --verbose", async () => {
    const root = repo();
    const quiet = await signer(root, key().pem);
    expect(quiet.result).toBeUndefined();
    expect(quiet.err).toBe("");
    const verbose = await signer(root, key().pem, true);
    expect(verbose.result).toBeUndefined();
    expect(verbose.err).toContain("CHANT_RUNNER_KEY is set, and the run is not signed");
  });

  test("with ci.green.signedSince the same key warns", async () => {
    const root = repo();
    const head = git(root, "rev-parse", "HEAD");
    writeFiles(root, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"], signedSince: head } } }) });
    const r = await signer(root, key().pem);
    expect(r.result).toBeUndefined();
    expect(r.err).toContain(`ci.green.signedSince (${head}) will not count it`);
  });

  test("a key that is not an Ed25519 PEM is an error", async () => {
    const r = await signer(repo(), "not a key");
    expect(r.result).toBeNull();
    expect(r.err).toContain("CHANT_RUNNER_KEY is not an Ed25519 private key in PEM");
  });
});
