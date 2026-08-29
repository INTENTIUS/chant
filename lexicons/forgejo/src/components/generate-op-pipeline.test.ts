/**
 * Tests for generate mode's scheduled Op → Forgejo Actions workflow YAML
 * synthesis (#927). Mirrors `./generate-pipeline.test.ts`'s style: same
 * trigger/job SHAPE as the github Op generator, plus proof the Forgejo
 * dialect is applied (runner label remapped) and that `permissions:` — a key
 * the Forgejo runner ignores — is dropped rather than emitted.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";
import { generateGithubOpPipeline } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

interface ParsedJob {
  "runs-on"?: string;
  steps: Array<{ uses?: string; run?: string }>;
}
interface ParsedDoc {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, ParsedJob>;
}
function parseFile(yaml: string): ParsedDoc {
  return parseYAML(yaml) as ParsedDoc;
}

describe("generateForgejoOpPipeline: structure (github-shaped)", () => {
  test("one file per scheduled Op, each a valid workflow with one job", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "actions-audit", schedule: "0 6 * * *" },
      { name: "prod-reconcile", schedule: "0 * * * *", findingMode: "issue" },
    ];
    const result = generateForgejoOpPipeline(specs);

    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.name)).toEqual(["actions-audit.yml", "prod-reconcile.yml"]);

    const doc = parseFile(result.files[0].yaml);
    expect(doc.on).toEqual({ schedule: [{ cron: "0 6 * * *" }], workflow_dispatch: {} });
    expect(Object.keys(doc.jobs!)).toEqual(["actions-audit"]);
  });

  test("jobs/schedule/findingMode parity with the github generator (same input, same job list)", () => {
    const specs: ScheduledOpSpec[] = [{ name: "actions-audit", schedule: "0 6 * * *", findingMode: "pull-request" }];
    const fj = generateForgejoOpPipeline(specs);
    const gh = generateGithubOpPipeline(specs);
    expect(fj.jobs).toEqual(gh.jobs);
  });
});

describe("generateForgejoOpPipeline: dialect applied", () => {
  test("runner label ubuntu-latest is remapped to the Forgejo default (docker)", () => {
    const specs: ScheduledOpSpec[] = [{ name: "actions-audit", schedule: "0 6 * * *" }];
    const fjJob = parseFile(generateForgejoOpPipeline(specs).files[0].yaml).jobs!["actions-audit"];
    const ghJob = parseFile(generateGithubOpPipeline(specs).files[0].yaml).jobs!["actions-audit"];

    expect(fjJob["runs-on"]).toBe("docker");
    expect(ghJob["runs-on"]).toBe("ubuntu-latest");
  });

  test("permissions: is dropped — the Forgejo runner ignores it", () => {
    const specs: ScheduledOpSpec[] = [{ name: "prod-reconcile", schedule: "0 * * * *", findingMode: "pull-request" }];
    const fjYaml = generateForgejoOpPipeline(specs).files[0].yaml;
    const ghYaml = generateGithubOpPipeline(specs).files[0].yaml;

    expect(fjYaml).not.toMatch(/^permissions:/m);
    // The github counterpart, generated from the same spec, does declare it —
    // proving the omission is the dialect, not an accident of the spec.
    expect(ghYaml).toMatch(/^permissions:/m);
  });
});
