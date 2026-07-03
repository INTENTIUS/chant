/**
 * `SingleHostComposeComponent` (#566): schema validity, and equivalence with
 * the hand-written `__fixtures__/single-host-compose.json` reference
 * document — the fixture is the authoritative hand-composed form for this
 * shape (no `*.pilot.ts` TypeScript authoring form exists for it yet, unlike
 * the ALB/ECS and Lambda shapes), matching how `../pilots/pilots.test.ts`
 * compares a pilot's projection against its `__fixtures__/*.json` sibling.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import componentSchema from "../component.schema.json";
import { projectToJson } from "../component";
import { SingleHostComposeComponent } from "./single-host-compose";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(componentSchema);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, "..", "__fixtures__", name), "utf-8"));
}

describe("SingleHostComposeComponent preset", () => {
  it("expands to a component that projects to schema-valid JSON", () => {
    const component = SingleHostComposeComponent({
      name: "monitoring-host",
      healthPath: "/-/healthy",
      healthPort: 9090,
    });
    const projected = projectToJson(component);
    const valid = validate(projected);
    if (!valid) throw new Error(ajv.errorsText(validate.errors));
    expect(valid).toBe(true);
  });

  it("re-derives the hand-written single-host-compose.json fixture (as data, ignoring document-level $schema/contractVersion provenance fields)", () => {
    const fromPreset = SingleHostComposeComponent({
      name: "monitoring-host",
      // The fixture's on-host path is "/opt/monitoring/..." rather than this
      // preset's "<name>"-derived default ("/opt/monitoring-host/...") — pass
      // it explicitly to match the pre-existing hand-written fixture exactly.
      hostComposePath: "/opt/monitoring/compose.yaml",
      healthPath: "/-/healthy",
      healthPort: 9090,
    });

    const fixture = loadFixture("single-host-compose.json") as Record<string, unknown>;
    const { $schema: _s, contractVersion: _v, ...fixtureContent } = fixture;
    expect(projectToJson(fromPreset)).toEqual(fixtureContent);
  });

  it("defaults host and the on-host compose path when omitted", () => {
    const component = SingleHostComposeComponent({
      name: "monitoring-host",
      healthPath: "/-/healthy",
      healthPort: 9090,
    });
    const applyPhase = component.deploy.find((p) => p.phase === "Apply")!;
    const copyStep = applyPhase.steps[0] as unknown as { host: string; to: string };
    expect(copyStep.host).toBe("$env.host");
    expect(copyStep.to).toBe("/opt/monitoring-host/compose.yaml");
  });
});
