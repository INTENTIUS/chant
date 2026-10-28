/**
 * Stale marking on GitLab (#4628): the note job's `pr-post --open` passes
 * the target branch pipeline's commit, and a stale-notes job in the push
 * pipeline of the target branch runs `pr-post --stale`. Written for the
 * ci-products post-merge pass.
 */
import { expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

test("the note job carries the tip and a push job marks the notes stale (#4628)", () => {
  const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { staleNotes: true } }).yaml) as Record<string, unknown> & { stages: string[] };
  const note = doc["plan-note"] as { variables: Record<string, string>; script: string[] };
  expect(note.variables.TIP_SHA).toBe("$CI_COMMIT_SHA");
  expect(note.script.at(-1)).toContain('--tip "$TIP_SHA"');
  const stale = doc["stale-notes"] as { stage: string; rules: Array<{ if: string }>; variables: Record<string, string>; script: string[] };
  expect(doc.stages).toContain("stale-notes");
  expect(stale.rules[0]!.if).toContain("$CI_PIPELINE_SOURCE == \"push\"");
  expect(stale.variables).toEqual({ TIP_SHA: "$CI_COMMIT_SHA" });
  expect(stale.script.at(-1)).toBe('chant components pr-post --stale --tip "$TIP_SHA" --env prod --forge gitlab');
});
