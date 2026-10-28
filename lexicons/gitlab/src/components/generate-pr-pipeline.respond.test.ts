/**
 * The pull request loop's responses and description check on GitLab
 * (#4629), as `chant build --pr-loop --respond --decide-backend
 * --decide-model` sets them: `pr-post --open` asks the decide service, and
 * the apply before merge carries CHANT_RESPOND and the merge (#4636).
 */
import { expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

type Job = { variables?: Record<string, string>; script?: string[] };

test("the note and apply jobs carry the responses, the decide service and the merge (#4629, #4636)", () => {
  const doc = parseYAML(generateGitlabPipeline(ESTATE, {
    env: "prod",
    prLoop: { applyBeforeMerge: true, applyMerge: { tokenEnv: "CHANT_MERGE_TOKEN" }, respond: { description: "check" }, decide: { backend: "review", model: "m-1" } },
  }).yaml) as Record<string, Job>;
  const note = doc["plan-note"]!;
  expect(note.script!.at(-1)).toMatch(/pr-post --open .* --decide-backend "review" --decide-model "m-1"$/);
  expect(note.variables!.CHANT_RESPOND).toBe("description=check");
  const apply = Object.values(doc).find((j) => typeof j === "object" && j?.script?.some((l) => l.includes("--apply-before-merge")))!;
  expect(apply.script!.join("\n")).toContain("--merge auto --merge-token-env CHANT_MERGE_TOKEN");
  expect(apply.variables!.CHANT_RESPOND).toBe("description=check");
});
