/** #5037: Forgejo has no environments, so it refuses the merge job's. */
import { expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { buildForgejoOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = { name: "tf-apply", op: "tf-apply", apply: ["a", "{target}"], plan: ["p", "{target}", "{plan}"], waves: [{ name: "wave-1", runs: [{ target: "network" }] }] } as unknown as OpWavesSpec;

test("beforeMerge.environment is refused on Forgejo (#5037)", () => {
  expect(() => buildForgejoOpWavesDoc(spec, { specFile: "w.json", beforeMerge: { merge: "auto", mergeTokenSecret: "MERGE_TOKEN", environment: "terragucci-merge" } })).toThrow(/Forgejo Actions has none/);
});
