/** #4911: one actor fallback for the lexicons' gated requests and the products' requesters. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { actorFromEnv } from "./actor";

test("the forge's actor, then the login, then unknown", () => {
  expect(actorFromEnv({ GITHUB_ACTOR: "octo", GITLAB_USER_LOGIN: "gl", USER: "me" })).toBe("octo");
  expect(actorFromEnv({ GITLAB_USER_LOGIN: "gl", USER: "me" })).toBe("gl");
  expect(actorFromEnv({ GITHUB_ACTOR: " ", USER: "me" })).toBe("me");
  expect(actorFromEnv({ USERNAME: "win" })).toBe("win");
  expect(actorFromEnv({})).toBe("unknown");
  expect(actorFromEnv({}, "chant")).toBe("chant");
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
