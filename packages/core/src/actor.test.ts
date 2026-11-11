/** #4911: one actor fallback for the lexicons' gated requests and the products' requesters. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { ACTOR_ENV_ORDER, actorFromEnv, actorOf, actorOrder } from "./actor";

test("the forge's actor, then the login, then unknown", () => {
  expect(actorFromEnv({ GITHUB_ACTOR: "octo", GITLAB_USER_LOGIN: "gl", USER: "me" })).toBe("octo");
  expect(actorFromEnv({ GITLAB_USER_LOGIN: "gl", USER: "me" })).toBe("gl");
  expect(actorFromEnv({ GITHUB_ACTOR: " ", USER: "me" })).toBe("me");
  expect(actorFromEnv({ USERNAME: "win" })).toBe("win");
  expect(actorFromEnv({})).toBe("unknown");
  expect(actorFromEnv({}, "chant")).toBe("chant");
});

/** #4966: a product's requester order, with the triggering actor and git's user.name. */
describe("actorOf", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "chant-actor-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Ada Person"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "ada@example.com"]);
  });

  test("with no options it answers as actorFromEnv", () => {
    for (const env of [{ GITHUB_ACTOR: "octo", USER: "me" }, { GITLAB_USER_LOGIN: "gl" }, { USERNAME: "win" }, {}]) {
      expect(actorOf({ env })).toBe(actorFromEnv(env));
    }
    expect(actorOrder()).toEqual([...ACTOR_ENV_ORDER]);
  });

  test("the triggering actor comes ahead of the forge's actor", () => {
    expect(actorOf({ env: { GITHUB_TRIGGERING_ACTOR: "rerunner", GITHUB_ACTOR: "starter" }, triggering: true })).toBe("rerunner");
    expect(actorOf({ env: { GITHUB_TRIGGERING_ACTOR: " ", GITHUB_ACTOR: "starter" }, triggering: true })).toBe("starter");
    expect(actorOf({ env: { GITHUB_TRIGGERING_ACTOR: "rerunner", GITHUB_ACTOR: "starter" } })).toBe("starter");
  });

  test("git's user.name comes after the forge's actor and before the login", () => {
    expect(actorOf({ env: { GITHUB_ACTOR: "octo", USER: "me" }, repo })).toBe("octo");
    expect(actorOf({ env: { USER: "me" }, repo })).toBe("Ada Person");
    expect(actorOf({ env: { USER: "me" }, repo, gitKeys: ["user.email", "user.name"] })).toBe("ada@example.com");
    expect(actorOrder({ triggering: true, repo })).toEqual(["GITHUB_TRIGGERING_ACTOR", "GITHUB_ACTOR", "GITLAB_USER_LOGIN", "git:user.name", "USER", "USERNAME"]);
  });

  /** #5005: git reads the config the given env names, not the process's. */
  test("git config runs with the env it is given", () => {
    const home = mkdtempSync(join(tmpdir(), "chant-actor-home-"));
    const bare = mkdtempSync(join(tmpdir(), "chant-actor-bare-"));
    execFileSync("git", ["init", "-q", bare]);
    const global = join(home, "gitconfig");
    writeFileSync(global, "[user]\n\tname = Job Identity\n");
    const base = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", USER: "me" };
    expect(actorOf({ env: { ...base, GIT_CONFIG_GLOBAL: global }, repo: bare })).toBe("Job Identity");
    expect(actorOf({ env: { ...base, GIT_CONFIG_GLOBAL: join(home, "none") }, repo: bare })).toBe("me");
    expect(actorOf({ env: { ...base, GIT_CONFIG_GLOBAL: global }, repo })).toBe("Ada Person");
  });

  test("the forge and the login can be left out, and the fallback named", () => {
    expect(actorOf({ env: { GITHUB_ACTOR: "octo", USER: "me" }, forge: false, repo })).toBe("Ada Person");
    expect(actorOf({ env: { USER: "me" }, triggering: true, login: false, fallback: "" })).toBe("");
    expect(actorOf({ env: {}, fallback: "terragucci" })).toBe("terragucci");
  });
});

/**
 * #4952: chant's own handlers and records read the fallback from
 * `actorFromEnv`, so none writes the order inline. A cut's actor
 * (`lifecycle/release-workstation.ts`) is another order, with git's
 * `user.email` between the forge and the login, and stays its own.
 */
test("no source under packages/core/src writes the actor fallback inline", () => {
  const root = __dirname;
  const own = new Set(["actor.ts", "lifecycle/release-workstation.ts"]);
  const inline = /GITHUB_ACTOR\s*(?:\?\?|\|\|)\s*(?:process\.)?env\.GITLAB_USER_LOGIN/;
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules" && name !== "__fixtures__") walk(path);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !own.has(relative(root, path))) {
        if (inline.test(readFileSync(path, "utf-8"))) found.push(relative(root, path));
      }
    }
  };
  walk(root);
  expect(found).toEqual([]);
});
