/** #4723: the commit job asks the forge which branch a pull request merges into, outside pr-forge.ts's bundle. */
import { describe, expect, test } from "vitest";
import { pullRequestBaseFromEnv } from "./pr-forge-base";

function fake(body: unknown, ok = true) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const f = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return { ok, json: async () => body };
  };
  return { f, calls };
}

describe("pullRequestBaseFromEnv (#4723)", () => {
  test("GitHub: the pull request's base.ref, with the job's token", async () => {
    const { f, calls } = fake({ base: { ref: "main" } });
    const base = pullRequestBaseFromEnv("github", { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "ghs_x" }, f)!;
    expect(await base(7)).toBe("main");
    expect(calls[0]).toEqual({ url: "https://api.github.com/repos/acme/infra/pulls/7", headers: { authorization: "Bearer ghs_x", accept: "application/vnd.github+json", "user-agent": "chant" } });
  });

  test("Forgejo needs its API root; GitLab reads target_branch", async () => {
    expect(pullRequestBaseFromEnv("forgejo", { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t" })).toBeUndefined();
    const fj = fake({ base: { ref: "develop" } });
    expect(await pullRequestBaseFromEnv("forgejo", { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t", GITHUB_API_URL: "https://fj.test/api/v1/" }, fj.f)!(3)).toBe("develop");
    expect(fj.calls[0]!.url).toBe("https://fj.test/api/v1/repos/acme/infra/pulls/3");
    const gl = fake({ target_branch: "main" });
    expect(await pullRequestBaseFromEnv("gitlab", { CI_API_V4_URL: "https://gl.test/api/v4", CI_PROJECT_ID: "12", CHANT_FORGE_TOKEN: "glpat" }, gl.f)!(9)).toBe("main");
    expect(gl.calls[0]).toEqual({ url: "https://gl.test/api/v4/projects/12/merge_requests/9", headers: { "private-token": "glpat" } });
  });

  test("no token, a refused read or a body without a base is undefined", async () => {
    expect(pullRequestBaseFromEnv("github", { GITHUB_REPOSITORY: "acme/infra" })).toBeUndefined();
    expect(await pullRequestBaseFromEnv("github", { GITHUB_REPOSITORY: "a/b", GITHUB_TOKEN: "t" }, fake({}, false).f)!(1)).toBeUndefined();
    expect(await pullRequestBaseFromEnv("github", { GITHUB_REPOSITORY: "a/b", GITHUB_TOKEN: "t" }, fake({ base: {} }).f)!(1)).toBeUndefined();
  });
});
