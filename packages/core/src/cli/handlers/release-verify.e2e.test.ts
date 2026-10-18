/**
 * `chant release verify` and the publish's signature check, end to end
 * (#4049), in a temp repo with a temp bare remote and throwaway ssh keys. A
 * release cut signed with a key `.chant/allowed_signers` lists verifies, and a
 * publish takes it; an unsigned one and one signed by a key the file does not
 * list fail `release verify`, and a publish refuses them unless
 * `--allow-unsigned`. Nothing is published: the member declares no target.
 */

import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";
import { hasSshKeygen } from "../../workspace/trust/test-repo";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const CI_VARS = ["CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_ACTOR", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITLAB_CI", "CI_PIPELINE_ID", "GITLAB_USER_LOGIN", "CHANT_ENV"];

function chant(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "tester" };
  for (const k of CI_VARS) delete env[k];
  const r = spawnSync(CHANT[0]!, [...CHANT.slice(1), ...args], { cwd, encoding: "utf-8", env, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function key(root: string, name: string): { file: string; pub: string } {
  const file = join(root, `key-${name}`);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]);
  return { file, pub: readFileSync(`${file}.pub`, "utf-8").trim().split(" ").slice(0, 2).join(" ") };
}

const BUILD = `mkdir -p dist && printf '{"env":"%s"}' "$CHANT_ENV" > dist/api.template.json`;

describe("chant release verify", () => {
  test.skipIf(!hasSshKeygen)(
    "passes for a signed release, fails for an unsigned one and for one signed by an unlisted key; a publish refuses both unless --allow-unsigned",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-verify-"));
      try {
        const alice = key(root, "alice");
        const mallory = key(root, "mallory");
        const dir = join(root, "work");
        const remote = join(root, "origin.git");
        git(root, "init", "-q", "--bare", "-b", "main", remote);
        git(root, "init", "-q", "-b", "main", dir);
        git(dir, "config", "user.email", "t@chant.dev");
        git(dir, "config", "user.name", "T");
        writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev"] };\n`);
        writeFileSync(join(dir, "api.component.ts"), `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`);
        writeFileSync(join(dir, ".gitignore"), "dist/\n");
        mkdirSync(join(dir, ".chant"));
        writeFileSync(join(dir, ".chant", "allowed_signers"), `alice ${alice.pub}\n`);
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "init");
        git(dir, "remote", "add", "origin", remote);
        // A green commit pushed to trunk, ready to cut.
        const next = (message?: string) => {
          if (message) git(dir, "commit", "-q", "--allow-empty", "-m", message);
          git(dir, "push", "-q", "origin", "main");
          git(dir, "fetch", "-q", "origin");
          git(dir, "tag", `ci/green/${git(dir, "rev-parse", "HEAD")}`);
        };
        next();

        // v1: signed with alice's key, which the signers file lists.
        const signed = chant(dir, ["release", "cut", "v1", "--build", BUILD, "--sign", alice.file, "--yes"]);
        expect(signed.code, signed.stderr).toBe(0);
        const ok = chant(dir, ["release", "verify", "v1"]);
        expect(ok.code, ok.stderr).toBe(0);
        expect(ok.stderr).toMatch(/Verified .*v1.*: signed by alice, checked against \.chant\/allowed_signers at [0-9a-f]{12}/);
        expect(JSON.parse(chant(dir, ["release", "verify", "v1", "--json"]).stdout)).toMatchObject({ label: "v1", status: "verified", digestMatches: true, verifiedBy: { actor: "alice" } });
        const pubSigned = chant(dir, ["release", "publish", "v1"]);
        expect(pubSigned.code, pubSigned.stderr).toBe(0);
        expect(pubSigned.stderr).toContain("signed by alice");

        // v2: not signed.
        next("v2");
        expect(chant(dir, ["release", "cut", "v2", "--build", BUILD, "--yes"]).code).toBe(0);
        const unsigned = chant(dir, ["release", "verify", "v2"]);
        expect(unsigned.code).toBe(1);
        expect(unsigned.stderr).toMatch(/v2.* does not verify: no cut of the release carries a signature \[release-unsigned\]/);
        expect(JSON.parse(chant(dir, ["release", "verify", "v2", "--json"]).stdout)).toMatchObject({ status: "unsigned", error: { code: "release-unsigned" } });
        const pubUnsigned = chant(dir, ["release", "publish", "v2"]);
        expect(pubUnsigned.code).toBe(1);
        expect(pubUnsigned.stderr).toMatch(/\[release-unsigned\]/);
        expect(chant(dir, ["release", "publish", "v2", "--allow-unsigned"]).code).toBe(0);

        // v3: signed by mallory, whom the signers file does not list.
        next("v3");
        const cut3 = chant(dir, ["release", "cut", "v3", "--build", BUILD, "--sign", mallory.file, "--actor", "mallory", "--yes"]);
        expect(cut3.code, cut3.stderr).toBe(0);
        const unlisted = chant(dir, ["release", "verify", "v3"]);
        expect(unlisted.code).toBe(1);
        expect(unlisted.stderr).toMatch(/mallory has no key in \.chant\/allowed_signers at [0-9a-f]{12}.*\[release-signature-unverified\]/);
        const pubUnlisted = chant(dir, ["release", "publish", "v3"]);
        expect(pubUnlisted.code).toBe(1);
        expect(pubUnlisted.stderr).toMatch(/\[release-signature-unverified\]/);

        const missing = chant(dir, ["release", "verify", "v9"]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toMatch(/\[release-not-found\]/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
