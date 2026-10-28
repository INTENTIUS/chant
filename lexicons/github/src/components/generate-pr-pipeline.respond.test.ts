/**
 * The pull request loop's responses, description check and merge on GitHub
 * (#4629, #4636), as `chant build --pr-loop --respond --decide-backend
 * --decide-model --merge auto` sets them: the note job asks the decide
 * service, and the apply job carries CHANT_RESPOND and the merge.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Doc = { jobs: Record<string, { steps: Step[] }> };
const gen = (prLoop: Record<string, unknown>) => parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop }).yaml) as Doc;

describe("responses and the merge on GitHub (#4629, #4636)", () => {
  const doc = gen({
    applyBeforeMerge: true,
    applyMerge: { tokenEnv: "CHANT_MERGE_TOKEN", method: "squash" },
    respond: { "wave-refused": "off", description: "check" },
    decide: { backend: "review", model: "m-1" },
  });

  test("the note job carries the responses and asks the decide service", () => {
    const post = doc.jobs["plan-note"]!.steps.at(-1)!;
    expect(post.run).toMatch(/--decide-backend "review" --decide-model "m-1"$/);
    expect(post.env!.CHANT_RESPOND).toBe("wave-refused=off,description=check");
  });

  test("the apply job carries the responses and the merge", () => {
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps);
    const apply = steps.find((s) => s.run?.includes("--apply-before-merge"))!;
    expect(apply.run).toContain("--merge auto --merge-token-env CHANT_MERGE_TOKEN --merge-method squash");
    expect(apply.env!.CHANT_RESPOND).toBe("wave-refused=off,description=check");
    expect(apply.env!.CHANT_MERGE_TOKEN).toBe("${{ secrets.CHANT_MERGE_TOKEN }}");
  });

  test("without them, neither job changes", () => {
    const plain = gen({ applyBeforeMerge: true });
    const post = plain.jobs["plan-note"]!.steps.at(-1)!;
    expect(post.run).not.toContain("--decide-backend");
    expect(post.env!.CHANT_RESPOND).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain("--merge auto");
  });
});
