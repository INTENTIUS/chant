/**
 * `chant build` refuses `onVerifyFail: "rollback"` on a stage whose steps an
 * earlier release does not restore (#5328), naming each step and why.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRollbackBuildProblems } from "./build";
import { asPipelineSpec } from "../../pipeline/spec";

const wave = (name: string) => ({ name, runs: [{ target: name }] });
const rollback = asPipelineSpec({ name: "shop", defaults: { step: { kind: "sql-migrate", environment: "{target}" } }, stages: [{ name: "dev", waves: [wave("dev")] }, { name: "prod", waves: [wave("prod")], onVerifyFail: "rollback" }] });
const hold = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: [wave("dev")] }, { name: "prod", waves: [wave("prod")] }] });

describe("the build's onVerifyFail refusal", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-verify-rollback-build-"));
    writeFileSync(
      join(dir, "app.component.ts"),
      `export const app = {
        name: "app",
        dependsOn: [],
        deploy: [
          { phase: "deploy", steps: [{ kind: "gate", name: "deploy" }, { kind: "ensure-secret", name: "db-password", noRollback: "a secret stays" }] },
          { phase: "verify", steps: [{ kind: "member-outputs", members: ["db"] }] },
        ],
      };\n`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a stage on hold reads nothing", async () => {
    expect(await verifyRollbackBuildProblems(dir, hold)).toEqual([]);
  });

  test("a sql-migrate step and a step whose kind answers no releaseInputs are refused; a step that changes nothing passes", async () => {
    const problems = await verifyRollbackBuildProblems(dir, rollback);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('stage "prod" sets onVerifyFail: "rollback", and defaults.step cannot be rolled back that way: it runs migrations');
    expect(problems[1]).toContain('component "app" step deploy/ensure-secret cannot be rolled back that way: its kind "ensure-secret" answers no releaseInputs');
  });
});
