/** Stale marking on Forgejo (#4628): the GitHub generator's stale-notes job, posting on forgejo. Written for the ci-products post-merge pass. */
import { expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

test("a stale-notes job runs pr-post --stale on forgejo (#4628)", () => {
  const doc = parseYAML(generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { staleNotes: true } }).yaml) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
  expect(doc.jobs["stale-notes"]!.steps.at(-1)!.run).toBe('chant components pr-post --stale --tip "$TIP_SHA" --env prod --forge forgejo');
});
