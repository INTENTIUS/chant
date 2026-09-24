/**
 * A workspace member's pipeline on Forgejo (#2542): the github shape, with
 * the member's path filter and working directory carried across the dialect.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";

const components: DriverComponent[] = [{ name: "api", dependsOn: [], deploy: [] }];

describe("generateForgejoPipeline for a workspace member", () => {
  test("working directory and name survive the dialect, and the triggers stay the plain pipeline's", () => {
    const member = { name: "api", dir: "services/api", file: ".forgejo/workflows/chant-api-staging.yml" };
    const doc = parseYAML(generateForgejoPipeline(components, { env: "staging", member }).yaml) as Record<string, unknown>;
    expect(doc.name).toBe("chant-components-api-staging");
    expect(Object.keys(doc.on as Record<string, unknown>)).toEqual(["workflow_dispatch"]);
    expect(doc.defaults).toEqual({ run: { "working-directory": "services/api" } });
  });

  test("an Op's file and job carry the member", () => {
    const result = generateForgejoOpPipeline([{ name: "plan", trigger: { kind: "pull_request" } }], {
      member: { name: "api", dir: "services/api", fileDir: ".forgejo/workflows" },
    });
    expect(result.files[0].name).toBe("api-plan.yml");
    const doc = parseYAML(result.files[0].yaml) as { on: Record<string, unknown>; jobs: Record<string, { defaults?: unknown }> };
    expect(doc.on.pull_request).toEqual({ paths: ["services/api/**", ".forgejo/workflows/api-plan.yml"] });
    expect(doc.jobs["plan"].defaults).toEqual({ run: { "working-directory": "services/api" } });
  });
});
