/**
 * #3780: a `gh` call that names no host is told the forge's.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ghEnvForHost, ghHostEnv, remoteHost } from "./gh-host";
import { withGhHost, type GhRunner } from "./lexicon-upgrade";

describe("remoteHost", () => {
  test.each([
    ["https://github.com/acme/infra.git", "github.com"],
    ["https://ghe.acme.internal/acme/infra", "ghe.acme.internal"],
    ["http://forgejo.local:3000/acme/infra.git", "forgejo.local:3000"],
    ["https://x-access-token:abc@GHE.Acme.Internal/acme/infra", "ghe.acme.internal"],
    ["git@ghe.acme.internal:acme/infra.git", "ghe.acme.internal"],
    ["ssh://git@forgejo.local:2222/acme/infra.git", "forgejo.local"],
    ["https://github.com\n", "github.com"],
  ])("%s is on %s", (url, host) => {
    expect(remoteHost(url)).toBe(host);
  });

  test("nothing, or a path, names no host", () => {
    expect(remoteHost(undefined)).toBeUndefined();
    expect(remoteHost("")).toBeUndefined();
    expect(remoteHost("/srv/git/infra.git")).toBeUndefined();
  });
});

describe("ghEnvForHost", () => {
  test("a GHES or Forgejo host becomes GH_HOST, and the job's token its enterprise token", () => {
    expect(ghEnvForHost({ GH_TOKEN: "t" }, "ghe.acme.internal")).toEqual({
      GH_TOKEN: "t",
      GH_HOST: "ghe.acme.internal",
      GH_ENTERPRISE_TOKEN: "t",
    });
    expect(ghEnvForHost({ GITHUB_TOKEN: "j" }, "forgejo.local:3000")).toMatchObject({
      GH_HOST: "forgejo.local:3000",
      GH_ENTERPRISE_TOKEN: "j",
    });
  });

  test("github.com, or no host, leaves the environment as it was", () => {
    const env = { GH_TOKEN: "t" };
    expect(ghEnvForHost(env, "github.com")).toBe(env);
    expect(ghEnvForHost(env, undefined)).toBe(env);
  });

  test("a GH_HOST or an enterprise token the caller set is kept", () => {
    const env = { GH_HOST: "elsewhere", GH_TOKEN: "t" };
    expect(ghEnvForHost(env, "ghe.acme.internal")).toBe(env);
    expect(ghEnvForHost({ GH_TOKEN: "t", GH_ENTERPRISE_TOKEN: "e" }, "ghe.acme.internal").GH_ENTERPRISE_TOKEN).toBe("e");
    expect(ghEnvForHost({ GH_TOKEN: "t", GITHUB_ENTERPRISE_TOKEN: "e" }, "ghe.acme.internal")).not.toHaveProperty("GH_ENTERPRISE_TOKEN");
  });

  test("with no token in the environment, gh's own login is left to answer", () => {
    expect(ghEnvForHost({}, "ghe.acme.internal")).toEqual({ GH_HOST: "ghe.acme.internal" });
  });
});

describe("ghHostEnv", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repoWithOrigin(url: string): string {
    const dir = mkdtempSync(join(tmpdir(), "chant-gh-host-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
    return dir;
  }

  test("a GitHub Actions job on GHES names its server", async () => {
    const env = await ghHostEnv({ GITHUB_SERVER_URL: "https://ghe.acme.internal", GH_TOKEN: "t" });
    expect(env.GH_HOST).toBe("ghe.acme.internal");
    expect(env.GH_ENTERPRISE_TOKEN).toBe("t");
  });

  test("a Forgejo Actions job's FORGEJO_SERVER_URL comes first", async () => {
    const env = await ghHostEnv({ FORGEJO_SERVER_URL: "https://code.acme.org", GITHUB_SERVER_URL: "https://other.example" });
    expect(env.GH_HOST).toBe("code.acme.org");
  });

  test("a github.com job is unchanged", async () => {
    const base = { GITHUB_SERVER_URL: "https://github.com", GH_TOKEN: "t" };
    expect(await ghHostEnv(base)).toBe(base);
  });

  test("outside a CI job, origin's host", async () => {
    const dir = repoWithOrigin("git@ghe.acme.internal:acme/infra.git");
    expect((await ghHostEnv({ PATH: process.env.PATH }, dir)).GH_HOST).toBe("ghe.acme.internal");
    const gh = repoWithOrigin("https://github.com/acme/infra.git");
    expect(await ghHostEnv({ PATH: process.env.PATH }, gh)).not.toHaveProperty("GH_HOST");
  });

  test("no origin, no host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-gh-host-"));
    dirs.push(dir);
    expect(await ghHostEnv({ PATH: process.env.PATH }, dir)).not.toHaveProperty("GH_HOST");
  });
});

describe("lexiconUpgrade's gh runner (withGhHost)", () => {
  test("gh calls get the forge's host, git calls and calls with their own env do not", async () => {
    const seen: Array<{ cmd: string; env?: NodeJS.ProcessEnv }> = [];
    const run: GhRunner = async (cmd, opts) => {
      seen.push({ cmd, ...(opts?.env ? { env: opts.env } : {}) });
      return { stdout: "", stderr: "" };
    };
    let resolved = 0;
    const gh = withGhHost(run, async () => {
      resolved++;
      return { GH_HOST: "ghe.acme.internal" };
    });
    await gh("git fetch origin main");
    await gh("gh pr view 'lexicon-upgrade/aws' --json url,state");
    await gh("gh label create 'minor' --color 'aaaaaa' --force");
    await gh("gh api https://ghe.acme.internal/api/v3/repos/a/b/issues", { env: { GH_TOKEN: "x" } });
    expect(seen[0]).toEqual({ cmd: "git fetch origin main" });
    expect(seen[1].env?.GH_HOST).toBe("ghe.acme.internal");
    expect(seen[2].env?.GH_HOST).toBe("ghe.acme.internal");
    expect(seen[3].env).toEqual({ GH_TOKEN: "x" });
    expect(resolved).toBe(1);
  });
});
