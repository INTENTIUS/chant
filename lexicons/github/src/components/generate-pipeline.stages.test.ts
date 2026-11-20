/**
 * #5324 on github: a folded pipeline's jobs. The first stage's waves render
 * their spec from `chant pipeline spec --stage dev` at the commit the job
 * hands it, and each later stage gets a manual promote job.
 */
import { expect, test } from "vitest";
import { foldPipelineSource } from "@intentius/chant/pipeline";
import { generatePipeline } from "@intentius/chant/pipeline/generate";
import { githubPlugin } from "../plugin";

const FILE = `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "shop",
  defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } },
  release: { bin: ["npx", "--no-install", "plywood"] },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }] }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], gate: { quorum: [{ count: 2 }] } },
  ],
});
`;

test("the pipeline's jobs on github come from the folded spec", async () => {
  const folded = foldPipelineSource(FILE);
  if (!("spec" in folded)) throw new Error(folded.finding.message);
  const out = await generatePipeline(folded.spec, "github", { bin: "npx --no-install plywood" }, githubPlugin);
  expect(out.error).toBeUndefined();
  const files = out.files!;
  expect(files.length).toBe(2);
  expect(files[0]!.yaml).toContain('["npx","--no-install","plywood","pipeline","spec","--stage","dev"]');
  expect(files[0]!.yaml).toContain("--render-spec");
  expect(files[1]!.yaml).toContain("components promote --to prod");
  for (const f of files) await expect(f.yaml).toMatchFileSnapshot(`./__golden__/pipeline-stages.github.${f.name.replace(/\.ya?ml$/, "")}.yml`);
});
