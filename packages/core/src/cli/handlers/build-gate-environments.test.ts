/**
 * `chant build` refuses a gate step that names an environment the member
 * does not declare (#5401), since that gate would be skipped where it was
 * meant to apply. A member whose components name no environments loads none.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateEnvironmentBuildProblems } from "./build";

const component = (gate: string) => `export const network = {
  name: "network",
  dependsOn: [],
  deploy: [{ phase: "Apply", steps: [${gate}, { kind: "terraform-apply", root: "envs/network" }] }],
};\n`;

describe("the build's refusal of a gate naming an undeclared environment (#5401)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-gate-environments-build-"));
    writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: [], environments: ["dev", "staging", "prod", "pr-*"] };\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a gate naming declared environments passes, and one with none is not read", async () => {
    writeFileSync(join(dir, "network.component.ts"), component(`{ kind: "gate", gate: "release", environments: ["staging", "prod"] }`));
    expect(await gateEnvironmentBuildProblems(dir)).toEqual([]);
    writeFileSync(join(dir, "network.component.ts"), component(`{ kind: "gate", gate: "release" }`));
    expect(await gateEnvironmentBuildProblems(dir)).toEqual([]);
  });

  test("a misspelt environment is refused, naming the ones the member declares", async () => {
    writeFileSync(join(dir, "network.component.ts"), component(`{ kind: "gate", gate: "release", environments: { staging: {}, prdo: {} } }`));
    expect(await gateEnvironmentBuildProblems(dir)).toEqual([
      'component "network": gate "release" in phase "Apply" names prdo in `environments`, and the member declares dev, prod, staging',
    ]);
  });

  test("a component's own environments count as declared", async () => {
    writeFileSync(
      join(dir, "network.component.ts"),
      component(`{ kind: "gate", gate: "release", environments: ["qa"] }`).replace(`dependsOn: [],`, `dependsOn: [], environments: [{ name: "qa" }],`),
    );
    expect(await gateEnvironmentBuildProblems(dir)).toEqual([]);
  });
});
