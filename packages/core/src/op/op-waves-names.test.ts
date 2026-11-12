/**
 * #5022: a product's own names in an Op waves pipeline: the job names and
 * their needs, the dispatch inputs and artifact names, the follow-on
 * dispatch under the product's workflow and inputs, and the product
 * pipeline's before-merge workflow and inputs.
 */
import { describe, expect, test } from "vitest";
import { opWaveJobs, type OpWavesSpec } from "./op-waves";
import { opWaveSplitJobs } from "./op-waves-split";
import { opWavesArtifacts, opWavesDispatchInputs, opWavesInputsRenamed, opWavesNamer, opWavesWorkflowFile, type OpWavesJobRef } from "./op-waves-names";
import { parseFollowOnTarget, startFollowOn } from "./op-waves-follow-on";
import { productPipelineJobs } from "../components/product-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true, shares: 2 },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

const terragucci = (j: OpWavesJobRef): string | undefined => {
  const w = j.rest ? "apply-rest" : `apply-wave-${j.wave}`;
  if (j.role === "wave" || j.role === "decide") return w;
  if (j.role === "share") return `${w}-share-${j.share}`;
  if (j.role === "plan" || j.role === "gate" || j.role === "record") return `${w}-${j.role}`;
  if (j.role === "apply") return j.share !== undefined ? `${w}-share-${j.share}` : w;
  return undefined;
};

describe("the job names (#5022)", () => {
  test("each job takes the product's name, and its needs follow", () => {
    const jobs = opWavesNamer(spec, "github", terragucci).jobs(opWaveJobs(spec, "s.json"));
    expect(jobs.map((j) => [j.jobName, j.needs])).toEqual([
      ["apply-wave-1", []],
      ["apply-wave-2", ["apply-wave-1"]],
      ["apply-wave-2-share-1", ["apply-wave-2"]],
      ["apply-wave-2-share-2", ["apply-wave-2"]],
      ["apply-rest", ["apply-wave-2-share-1", "apply-wave-2-share-2"]],
    ]);
  });

  test("a split pipeline's jobs, and the rest wave's, take theirs", () => {
    const split = opWavesNamer(spec, "github", terragucci).jobs(opWaveSplitJobs(spec, opWaveJobs(spec, "s.json", { beforeMerge: true })));
    expect(split.filter((j) => j.wave === 3).map((j) => [j.jobName, j.needs])).toEqual([
      ["apply-rest-plan", ["apply-wave-2-record"]],
      ["apply-rest-gate", ["apply-rest-plan"]],
      ["apply-rest", ["apply-rest-gate"]],
      ["apply-rest-record", ["apply-rest", "apply-rest-gate"]],
    ]);
  });

  test("without names, chant's; the same job asked twice keeps its name", () => {
    const namer = opWavesNamer(spec, "gitlab", undefined);
    expect(namer.jobs(opWaveJobs(spec, "s.json")).map((j) => j.jobName)).toEqual(["wave-1-canary", "wave-2-wide-decide", "wave-2-wide-share-1", "wave-2-wide-share-2", "wave-3-rest"]);
    expect(namer.name({ role: "control", name: "control-dispatch" })).toBe("control-dispatch");
    expect(namer.name({ role: "control", name: "control-dispatch" })).toBe("control-dispatch");
  });

  test("refuses a name the forge cannot take, and two jobs that share one", () => {
    const jobs = opWaveJobs(spec, "s.json");
    expect(() => opWavesNamer(spec, "github", () => "1-apply").jobs(jobs)).toThrow(/not a job name/);
    expect(() => opWavesNamer(spec, "gitlab", (j) => (j.role === "wave" ? "stages" : undefined)).jobs(jobs)).toThrow(/no GitLab keyword/);
    expect(() => opWavesNamer(spec, "github", (j) => (j.role === "share" ? "apply" : undefined)).jobs(jobs)).toThrow(/names two jobs apply: wave-2-wide-share-1 and wave-2-wide-share-2/);
    const namer = opWavesNamer(spec, "github", (j) => (j.role === "apply-status" ? "control-dispatch" : undefined));
    namer.name({ role: "control", name: "control-dispatch" });
    expect(() => namer.name({ role: "apply-status", name: "apply-status-1", wave: 1 })).toThrow(/names two jobs control-dispatch/);
  });
});

describe("the dispatch inputs, artifacts and workflow file (#5022)", () => {
  test("the inputs are chant's unless renamed, each a name and none twice", () => {
    expect(opWavesDispatchInputs(undefined)).toEqual({ pr: "pr", head: "head", digest: "digest", wave: "wave", commit: "commit" });
    expect(opWavesInputsRenamed(opWavesDispatchInputs({ pr: "pr" }))).toBe(false);
    expect(opWavesDispatchInputs({ pr: "apply_pr", head: "apply_head" })).toMatchObject({ pr: "apply_pr", head: "apply_head", digest: "digest" });
    expect(() => opWavesDispatchInputs({ pr: "head" })).toThrow(/names two inputs head: pr and head/);
    expect(() => opWavesDispatchInputs({ pr: "a b" })).toThrow(/not an input name/);
    expect(() => opWavesDispatchInputs({ root: "r" } as never)).toThrow(/none of pr, head, digest, wave and commit/);
  });

  test("the artifacts are chant's unless named, each template holding its mark", () => {
    const chant = opWavesArtifacts(spec, undefined);
    expect([chant.outcome("wave-1-canary"), chant.decision(2), chant.plan(2), chant.checks("j"), chant.earlier]).toEqual(["tf-apply-wave-1-canary-outcome", "tf-apply-wave-2-decision", "tf-apply-wave-2-plan", "tf-apply-j-checks", undefined]);
    const tg = opWavesArtifacts(spec, { outcome: "terragucci-report-{job}-outcome", decision: "terragucci-wave-{wave}", earlier: "terragucci-report-apply-wave-*" });
    expect([tg.outcome("apply-wave-1"), tg.decision(2), tg.earlier]).toEqual(["terragucci-report-apply-wave-1-outcome", "terragucci-wave-2", "terragucci-report-apply-wave-*"]);
    expect(() => opWavesArtifacts(spec, { outcome: "outcome" })).toThrow(/artifactNames\.outcome "outcome" holds \{job\}/);
    expect(() => opWavesArtifacts(spec, { decision: "d/{wave}" })).toThrow(/artifactNames\.decision/);
    expect(() => opWavesArtifacts(spec, { decision: "w-{wave}", plan: "w-{wave}" })).toThrow(/the decision and the saved plan one name/);
    expect(() => opWavesArtifacts(spec, { earlier: "a/b" })).toThrow(/artifactNames\.earlier/);
    expect(opWavesWorkflowFile(spec, undefined)).toBe("tf-apply.yml");
    expect(opWavesWorkflowFile(spec, "terragucci.yml")).toBe("terragucci.yml");
    expect(() => opWavesWorkflowFile(spec, ".github/workflows/terragucci.yml")).toThrow(/workflow file's name/);
  });
});

describe("the follow-on under the product's workflow and inputs (#5022)", () => {
  test("the record job dispatches the product's workflow with its input names", async () => {
    const target = parseFollowOnTarget(JSON.stringify({ forge: "github", workflow: "terragucci.yml", inputs: opWavesDispatchInputs({ pr: "apply_pr", head: "apply_head", digest: "apply_digest", wave: "apply_wave", commit: "apply_commit" }) }))!;
    const posts: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (url: string, init: { body: string }) => (posts.push({ url, body: JSON.parse(init.body) }), new Response(null, { status: 204 }))) as unknown as typeof fetch;
    const HEAD = "a".repeat(40);
    const env = { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://api.github.com", GITHUB_REF_NAME: "main", CHANT_WAVES_FOLLOW_ON_TOKEN: "t" };
    await startFollowOn(target, 4, { ...env, CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: `sha256:${"e".repeat(64)}` }, fetchFn);
    expect(posts.at(-1)).toEqual({ url: "https://api.github.com/repos/acme/infra/actions/workflows/terragucci.yml/dispatches", body: { ref: "main", inputs: { apply_pr: "7", apply_head: HEAD, apply_digest: `sha256:${"e".repeat(64)}`, apply_wave: "4" } } });
    await startFollowOn(target, 4, { ...env, CHANT_WAVES_COMMIT: "d".repeat(40) }, fetchFn);
    expect(posts.at(-1)!.body).toEqual({ ref: "main", inputs: { apply_wave: "4", apply_commit: "d".repeat(40) } });
    expect(() => parseFollowOnTarget(JSON.stringify({ forge: "github", workflow: "x.yml", inputs: { root: "r" } }))).toThrow(/inputs names the dispatch inputs/);
  });
});

describe("the product pipeline's waves before merge in a product's workflow (#5022)", () => {
  const words = { product: "terragucci", noun: ["root", "roots"] as [string, string], commands: { plan: "plan" as const, apply: "apply" as const }, approval: "per-wave" as const, op: "tf-apply", bin: "terragucci" };
  const waves = { name: "tf-apply", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "dev", runs: [{ target: "envs/dev" }] }] } as OpWavesSpec;
  const productPlan = { command: "terragucci plan --out {output}" };

  test("the comment job dispatches the product's workflow by its input names, and the generator is handed both", () => {
    const dispatchInputs = { pr: "apply_pr", head: "apply_head", digest: "apply_digest" };
    const jobs = productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: true, wavesBeforeMerge: { workflowFile: "terragucci.yml", dispatchInputs } });
    expect(jobs.comment!.jobs.wavesBeforeMerge).toMatchObject({ workflow: "terragucci.yml", inputs: dispatchInputs });
    expect(jobs.waves!.pipeline).toMatchObject({ workflowFile: "terragucci.yml", dispatchInputs });
    const chant = productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: true, wavesBeforeMerge: {} });
    expect(chant.comment!.jobs.wavesBeforeMerge!.workflow).toBe("tf-apply.yml");
    expect(chant.comment!.jobs.wavesBeforeMerge!.inputs).toBeUndefined();
    expect(chant.waves!.pipeline.workflowFile).toBeUndefined();
    expect(() => productPipelineJobs("gitlab", "default", { words, waves, productPlan: { ...productPlan, replan: true }, noteCommands: true, wavesBeforeMerge: { workflowFile: "terragucci.yml" } })).toThrow(/GitLab's note poll starts a pipeline with variables/);
  });
});
