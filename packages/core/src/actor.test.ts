/** #4911: one actor fallback for the lexicons' gated requests and the products' requesters. */
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
