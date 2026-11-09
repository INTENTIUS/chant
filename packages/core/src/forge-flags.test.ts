/**
 * #4800 — the forge target from a product's flags: the overrides
 * `forgeTargetFromEnv` takes, and `forgeTargetFromFlags` checking the flags
 * SQL Yodeler, terragucci and plywood each checked themselves.
 */

import { describe, expect, test } from "vitest";
import { apiBaseOf, ForgeFlagError, forgeFlagHints, forgeTargetFromFlags, forgeTargetOptionsFromFlags, forgeTargetWith } from "./forge-flags";
import { ForgeEnvironmentError } from "./pr-forge";

const SHA = "a".repeat(40);

describe("forgeTargetWith (#4800)", () => {
  const job = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "acme/infra",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_RUN_ID: "77",
    GITHUB_SHA: SHA,
    GITHUB_EVENT_PATH: "/event.json",
    GITHUB_TOKEN: "t",
  };
  const readFile = () => JSON.stringify({ pull_request: { number: 12, head: { sha: "b".repeat(40) } } });

  test("--repo and --pr over the job's, the event left unread, the run still the job's", () => {
    const t = forgeTargetWith(job, { repo: "acme/db", pr: 3, readFile });
    expect(t).toMatchObject({ kind: "github", repo: "acme/db", pr: 3, sha: SHA, apiBase: "https://api.github.com", host: "github.com", runUrl: "https://github.com/acme/infra/actions/runs/77" });
  });

  test("--url gives the host and the REST base on each forge", () => {
    const env = { GITHUB_TOKEN: "t", GITLAB_TOKEN: "g", FORGEJO_TOKEN: "f" };
    expect(forgeTargetWith(env, { kind: "github", repo: "a/b", url: "https://github.com/" })).toMatchObject({ apiBase: "https://api.github.com", host: "github.com" });
    expect(forgeTargetWith(env, { kind: "github", repo: "a/b", url: "https://ghe.example" })).toMatchObject({ apiBase: "https://ghe.example/api/v3", host: "ghe.example" });
    expect(forgeTargetWith(env, { kind: "forgejo", repo: "a/b", url: "http://forgejo:3000" })).toMatchObject({ apiBase: "http://forgejo:3000/api/v1", host: "forgejo:3000" });
    expect(forgeTargetWith(env, { kind: "gitlab", repo: "g/p", url: "https://gl.example" })).toMatchObject({ apiBase: "https://gl.example/api/v4", host: "gl.example", tokenSource: "GITLAB_TOKEN" });
  });

  test("--url replaces the job's API, which belongs to the job's own forge", () => {
    const t = forgeTargetWith({ ...job, GITHUB_API_URL: "https://api.github.com" }, { url: "https://ghe.example", readFile });
    expect(t).toMatchObject({ apiBase: "https://ghe.example/api/v3", host: "ghe.example" });
  });

  test("--api-url alone gives the host too", () => {
    expect(forgeTargetWith({ GITHUB_TOKEN: "t" }, { kind: "github", repo: "a/b", apiUrl: "https://ghe.example/api/v3/" })).toMatchObject({ apiBase: "https://ghe.example/api/v3", host: "ghe.example" });
    expect(forgeTargetWith({ GITHUB_TOKEN: "t" }, { kind: "github", repo: "a/b", apiUrl: "https://api.github.com" }).host).toBe("github.com");
  });

  test("GitLab: --repo, --pr and --api-url over a merge request pipeline's", () => {
    const t = forgeTargetWith(
      { GITLAB_CI: "true", CI_API_V4_URL: "https://gitlab.com/api/v4", CI_SERVER_HOST: "gitlab.com", CI_MERGE_REQUEST_PROJECT_ID: "1", CI_MERGE_REQUEST_IID: "2", GITLAB_TOKEN: "g" },
      { repo: "99", pr: 7, apiUrl: "https://gl.example/api/v4" },
    );
    expect(t).toMatchObject({ repo: "99", pr: 7, apiBase: "https://gl.example/api/v4", host: "gl.example" });
  });

  test("tokenOptional: a target with an empty token reads a public repository", () => {
    expect(() => forgeTargetWith({}, { kind: "github", repo: "a/b" })).toThrow(ForgeEnvironmentError);
    expect(forgeTargetWith({}, { kind: "github", repo: "a/b", tokenOptional: true })).toMatchObject({ token: "", tokenSource: "" });
  });

  test("apiBaseOf, terragucci's apiBase", () => {
    expect(apiBaseOf("github", "https://github.com")).toBe("https://api.github.com");
    expect(apiBaseOf("github", "https://ghe.example/")).toBe("https://ghe.example/api/v3");
    expect(apiBaseOf("gitlab", "https://gitlab.com")).toBe("https://gitlab.com/api/v4");
    expect(apiBaseOf("forgejo", "https://codeberg.org")).toBe("https://codeberg.org/api/v1");
  });

  test("with no overrides the target is as before", () => {
    expect(forgeTargetWith(job, { readFile })).toMatchObject({ repo: "acme/infra", pr: 12, sha: "b".repeat(40) });
  });
});

describe("forgeTargetFromFlags (#4800)", () => {
  test("checks the flags as a command line gives them", () => {
    expect(() => forgeTargetOptionsFromFlags({ forge: "bitbucket" })).toThrow('--forge must be one of github, gitlab, forgejo, got "bitbucket"');
    expect(() => forgeTargetOptionsFromFlags({ pr: "0" })).toThrow('--pr must be a pull request number, got "0"');
    expect(() => forgeTargetOptionsFromFlags({ url: "gitlab.example" })).toThrow(ForgeFlagError);
    expect(forgeTargetOptionsFromFlags({ forge: "gitlab", repo: " g/p ", pr: "4", apiUrl: "https://gl/api/v4", tokenEnv: "MY", url: "" })).toEqual({ kind: "gitlab", repo: "g/p", pr: 4, apiUrl: "https://gl/api/v4", tokenEnv: "MY" });
  });

  test("outside CI, the flags are the whole target", () => {
    const t = forgeTargetFromFlags({ forge: "forgejo", repo: "a/b", pr: "9", url: "https://codeberg.org" }, { FORGEJO_TOKEN: "f" }, { requirePr: true });
    expect(t).toMatchObject({ kind: "forgejo", repo: "a/b", pr: 9, apiBase: "https://codeberg.org/api/v1", host: "codeberg.org", tokenSource: "FORGEJO_TOKEN" });
  });

  test("a token the product holds, from its own config", () => {
    const t = forgeTargetFromFlags({ forge: "gitlab", repo: "g/p", url: "https://gitlab.com", token: "tg" }, {});
    expect(t).toMatchObject({ token: "tg", tokenSource: "the token given", tokenHeader: "PRIVATE-TOKEN" });
  });

  test("an unknown forge, and the hints for what is missing", () => {
    let unknown: unknown;
    try {
      forgeTargetFromFlags({}, {});
    } catch (e) {
      unknown = e;
    }
    expect(unknown).toBeInstanceOf(ForgeEnvironmentError);
    expect(forgeFlagHints(unknown as ForgeEnvironmentError, { requirePr: true })).toEqual(["outside CI pass --forge github|gitlab|forgejo, --repo, --pr and --api-url"]);
    let missing: unknown;
    try {
      forgeTargetFromFlags({ forge: "github" }, {}, { requirePr: true });
    } catch (e) {
      missing = e;
    }
    expect((missing as ForgeEnvironmentError).missing).toEqual(["GITHUB_REPOSITORY", "a pull request (a pull_request event, or refs/pull/<n>/ in GITHUB_REF)", "a token (CHANT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN)"]);
    expect(forgeFlagHints(missing as ForgeEnvironmentError, { requirePr: true })).toEqual(["outside CI pass --repo, --pr and --api-url", "name another token variable with --token-env"]);
  });
});
