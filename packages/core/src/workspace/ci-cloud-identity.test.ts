/**
 * #4296: `chant build --pr-loop` reads `ci.identity.cloud` from the working
 * tree of the workspace that holds the project, and resolves it for the
 * pipeline's environment and member.
 */

import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { declaredCloudIdentity } from "./ci-cloud-identity";

afterEach(() => cleanScratch());

const MEMBERS = [
  { name: "net", dir: "net", kind: "other", because: "the network" },
  { name: "app", dir: "app", kind: "other", because: "the app" },
];

function workspace(ci?: Record<string, unknown>): string {
  const root = scratchDir("chant-cloud-identity-");
  git(root, "init", "-q");
  writeFiles(root, { "chant.workspace.json": declaration(MEMBERS, ci ? { ci } : {}), "net/a.txt": "a\n", "app/a.txt": "a\n" });
  return root;
}

describe("declaredCloudIdentity (#4296)", () => {
  test("each member's pipeline takes the first rule for its environment and member", async () => {
    const root = workspace({
      identity: {
        cloud: {
          aws: {
            rules: [
              { members: ["net"], plan: "arn:aws:iam::1:role/net-plan", apply: "arn:aws:iam::1:role/net-apply" },
              { plan: "arn:aws:iam::1:role/plan", apply: "arn:aws:iam::1:role/apply" },
            ],
          },
        },
      },
    });
    expect((await declaredCloudIdentity(join(root, "net"), "production", "net"))!.apply.aws!.role).toBe("arn:aws:iam::1:role/net-apply");
    expect((await declaredCloudIdentity(join(root, "app"), "production", "app"))!.apply.aws!.role).toBe("arn:aws:iam::1:role/apply");
  });

  test("a workspace with no block, and a directory outside any workspace, read nothing", async () => {
    expect(await declaredCloudIdentity(workspace(), "production", "net")).toBeUndefined();
    expect(await declaredCloudIdentity(scratchDir("chant-cloud-identity-none-"), "production")).toBeUndefined();
  });

  test("a declaration that plans as an apply identity is an error naming its code", async () => {
    const root = workspace({ identity: { cloud: { aws: { rules: [{ plan: "r", apply: "r" }] } } } });
    await expect(declaredCloudIdentity(root, "production")).rejects.toThrow(/plans and applies as r.*\[declaration-invalid\]/);
  });

  test("rules with targets and a name read from the declaration, and a target glob list may not be empty (#4332)", async () => {
    const root = workspace({
      identity: {
        cloud: {
          aws: {
            rules: [
              { members: ["net"], targets: ["envs/prod/**"], name: "prod", plan: "arn:aws:iam::1:role/prod-plan", apply: "arn:aws:iam::1:role/prod-apply" },
              { plan: "arn:aws:iam::1:role/plan", apply: "arn:aws:iam::1:role/apply" },
            ],
          },
        },
      },
    });
    const net = (await declaredCloudIdentity(join(root, "net"), "production", "net"))!;
    expect(net.plan.aws).toMatchObject({ role: "arn:aws:iam::1:role/plan", targets: [{ targets: ["envs/prod/**"], role: "arn:aws:iam::1:role/prod-plan" }] });
    expect((await declaredCloudIdentity(join(root, "app"), "production", "app"))!.plan.aws!.targets).toBeUndefined();
    const empty = workspace({ identity: { cloud: { aws: { rules: [{ targets: [], plan: "p", apply: "a" }] } } } });
    await expect(declaredCloudIdentity(empty, "production")).rejects.toThrow(/\[declaration-invalid\]/);
  });
});
