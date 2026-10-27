/**
 * The `pulumi-up` capability (#4541): plan and apply a Pulumi or plunge
 * stack as a component step, under the 2026-10-27 rulings (A: a stock apply
 * compares its event stream with the approved shape; B: same and read steps
 * leave the digest on the resource grain; C: the preview streams, and
 * CrossGuard's events feed the gate; D: no approved plan means preview and
 * up in one go).
 *
 * The runners are fakes answering with `testdata/pulumi-stream` (the
 * recorded corpus preview in stream form; see its README) and the recorded
 * `stack output`. No pulumi or plunge binary runs here, and nothing reaches
 * a backend.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isPlanMovedError, type DeployContext } from "@intentius/chant/components/capability";
import { PlanShapeMovedError } from "@intentius/chant/components/covered-round";
import { pulumiPreviewDigest } from "./change-set";
import { pulumiStreamPreview, PULUMI_STREAMING_PREVIEW_ENV } from "./engine-events";
import {
  createPulumiUpCapability,
  pulumiReleaseInputs,
  pulumiScratchConfig,
  pulumiUpMember,
  PulumiAppliedShapeError,
  PulumiPlanMovedError,
  PulumiPolicyDeniedError,
  PulumiResourceGrainRefusedError,
  type PulumiUpArtifact,
  type PulumiUpStepInput,
} from "./pulumi-up";
import type { PulumiRunner } from "./run";

const testdata = join(import.meta.dirname, "testdata");
const dir = join(testdata, "pulumi-preview");
const stream = readFileSync(join(testdata, "pulumi-stream", "preview-stream.ndjson"), "utf-8");
const upStream = stream.replaceAll(',"planning":true', "");
const stackOutput = readFileSync(join(testdata, "pulumi-outputs", "stack-output.json"), "utf-8");
const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;
const ctx: DeployContext = { env: "prod", component: "site" };
const member = "corpus-aws-ts/floci";

interface Call {
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** A runner that answers by command; `up` may be overridden per test. */
function engine(answers: { preview?: () => string | Error; up?: () => string | Error } = {}): { run: PulumiRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: PulumiRunner = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) });
    // plunge writes the saved plan where --save-plan says; the fake does too, so run finds it.
    const save = args.indexOf("--save-plan");
    if (save >= 0) writeFileSync(args[save + 1], "{}\n");
    const out = args[0] === "preview" ? (answers.preview ?? (() => stream))() : args[0] === "up" ? (answers.up ?? (() => upStream))() : stackOutput;
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { run, calls };
}

const exit = (code: number, stdout = "", message = `exit ${code}`): Error => Object.assign(new Error(message), { code, stdout });
const tmp = (): string => mkdtempSync(join(tmpdir(), "pulumi-up-test-"));
const step = (extra: Partial<PulumiUpStepInput> = {}): PulumiUpStepInput => ({ dir, stack: "floci", ...extra });

describe("the step", () => {
  test("its member is <Pulumi.yaml name>/<stack>, or the member given", () => {
    expect(pulumiUpMember(step())).toBe(member);
    expect(pulumiUpMember(step({ member: "site" }))).toBe("site/floci");
  });

  test("a step with no dir or stack is refused", async () => {
    const cap = createPulumiUpCapability({ run: engine().run, env: {}, snapshots: null });
    await expect(cap.plan!(ctx, { dir: "", stack: "floci" })).rejects.toThrow(/needs "dir"/);
    await expect(cap.plan!(ctx, { dir, stack: "" })).rejects.toThrow(/needs "stack"/);
  });

  test("a stock member on the resource grain is refused by name (#4552)", async () => {
    const cap = createPulumiUpCapability({ run: engine().run, env: {}, snapshots: null });
    await expect(cap.plan!(ctx, step({ engine: "pulumi", lockGrain: "resource" }))).rejects.toBeInstanceOf(PulumiResourceGrainRefusedError);
  });
});

describe("plan on plunge", () => {
  test("streams the preview, saves the plan in a scratch dir and answers digest, part, shape and outputs", async () => {
    const plunge = engine();
    const scratch = tmp();
    const cap = createPulumiUpCapability({ plunge: plunge.run, env: {}, tmp: scratch, snapshots: null });
    const planned = await cap.plan!(ctx, step({ engine: "plunge" }));
    const artifact = planned.artifact as PulumiUpArtifact;
    expect(plunge.calls).toHaveLength(1);
    const call = plunge.calls[0];
    expect(call.cwd).toBe(dir);
    expect(call.env).toEqual({ [PULUMI_STREAMING_PREVIEW_ENV]: "true" });
    expect(call.args).toEqual(["preview", "--json", "--show-sames", "--stack", "floci", "--save-plan", artifact.planFile]);
    expect(artifact.planFile!.startsWith(scratch)).toBe(true);
    expect(artifact).toMatchObject({ kind: "pulumi-up", member, stack: "floci", engine: "plunge", engineSource: "member-config" });
    expect(planned.member).toBe(member);
    // Ruling B: plunge defaults to the resource grain, so same and read steps leave the digest.
    expect(planned.planDigest).toBe(pulumiPreviewDigest(pulumiStreamPreview(stream), { changedOnly: true }));
    expect(planned.changeSet?.member.planDigest).toBe(planned.planDigest);
    expect(planned.shape?.entries.map((e) => e.action).sort()).toEqual(["delete", "delete", "replace", "replace", "update", "update"]);
    expect(planned.outputs).toBeDefined();
    expect(artifact.policy.warnings).toHaveLength(1);
  });

  test("the target grain keeps every step in the digest", async () => {
    const cap = createPulumiUpCapability({ plunge: engine().run, env: {}, tmp: tmp(), snapshots: null });
    const planned = await cap.plan!(ctx, step({ engine: "plunge", lockGrain: "target" }));
    expect(planned.planDigest).toBe(pulumiPreviewDigest(pulumiStreamPreview(stream)));
  });

  test("config goes into a scratch copy of the stack's file, passed as --config-file, never --config", async () => {
    const plunge = engine();
    const cap = createPulumiUpCapability({ plunge: plunge.run, env: {}, tmp: tmp(), snapshots: null });
    const planned = await cap.plan!(ctx, step({ engine: "plunge", config: { vpcId: "vpc-1", "aws:region": "us-east-1", later: undefined } }));
    const artifact = planned.artifact as PulumiUpArtifact;
    const args = plunge.calls[0].args;
    expect(args).toContain("--config-file");
    expect(args).not.toContain("--config");
    expect(args[args.indexOf("--config-file") + 1]).toBe(artifact.configFile);
    expect(JSON.parse(readFileSync(artifact.configFile!, "utf-8"))).toEqual({ config: { "corpus-aws-ts:vpcId": "vpc-1", "aws:region": "us-east-1" } });
  });

  test("targets and policy packs pass to the preview in the fixed order", async () => {
    const plunge = engine();
    const cap = createPulumiUpCapability({ plunge: plunge.run, env: {}, tmp: tmp(), snapshots: null });
    const target = urn("aws:sqs/queue:Queue", "events");
    const planned = await cap.plan!({ ...ctx, targets: [target] }, step({ engine: "plunge", policyPacks: [{ dir: "/packs/org", config: "/packs/org.json" }] }));
    const args = plunge.calls[0].args;
    expect(args.slice(7)).toEqual(["--target", target, "--policy-pack", "/packs/org", "--policy-pack-config", "/packs/org.json"]);
    expect(planned.targets).toEqual([target]);
  });

  test("a mandatory CrossGuard violation denies the plan, whatever the exit", async () => {
    const violation = JSON.stringify({ policyEvent: { message: "no public buckets", policyName: "s3-private", policyPackName: "org", policyPackVersion: "1", enforcementLevel: "mandatory" } });
    const failing = createPulumiUpCapability({ plunge: engine({ preview: () => exit(1, `${stream}${violation}\n`) }).run, env: {}, tmp: tmp(), snapshots: null });
    const err = await failing.plan!(ctx, step({ engine: "plunge" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PulumiPolicyDeniedError);
    expect((err as PulumiPolicyDeniedError).findings.denials.map((d) => d.rule)).toEqual(["crossguard.org.s3-private"]);
    expect((err as PulumiPolicyDeniedError).exitCode).toBe(7);
    const passing = createPulumiUpCapability({ plunge: engine({ preview: () => `${stream}${violation}\n` }).run, env: {}, tmp: tmp(), snapshots: null });
    await expect(passing.plan!(ctx, step({ engine: "plunge" }))).rejects.toBeInstanceOf(PulumiPolicyDeniedError);
  });

  test("Pulumi's policy exit denies too (#4553: policy is 7)", async () => {
    const cap = createPulumiUpCapability({ plunge: engine({ preview: () => exit(5, stream) }).run, env: {}, tmp: tmp(), snapshots: null });
    await expect(cap.plan!(ctx, step({ engine: "plunge" }))).rejects.toBeInstanceOf(PulumiPolicyDeniedError);
  });

  test("a failed preview throws with the engine's error, and a missing binary says so", async () => {
    const diag = JSON.stringify({ diagnosticEvent: { message: "error: stack floci not found", severity: "error" } });
    const failed = createPulumiUpCapability({ plunge: engine({ preview: () => exit(6, `${diag}\n`) }).run, env: {}, tmp: tmp(), snapshots: null });
    await expect(failed.plan!(ctx, step({ engine: "plunge" }))).rejects.toThrow(/plunge preview failed: error: stack floci not found/);
    const missing = createPulumiUpCapability({ plunge: engine({ preview: () => Object.assign(new Error("spawn plunge ENOENT"), { code: "ENOENT" }) }).run, env: {}, tmp: tmp(), snapshots: null });
    await expect(missing.plan!(ctx, step({ engine: "plunge" }))).rejects.toThrow(/plunge binary was not found/);
  });

  test("a stack whose config reads an output not known yet is a hole naming it", async () => {
    const plunge = engine();
    const cap = createPulumiUpCapability({ plunge: plunge.run, env: {}, tmp: tmp(), snapshots: null });
    const planned = await cap.plan!({ ...ctx, unresolvedInputs: ["network.vpcId"] }, step({ engine: "plunge", config: { vpcId: undefined } }));
    expect(plunge.calls).toEqual([]);
    expect(planned.artifact).toBeUndefined();
    expect(planned.changeSet?.member.holes[0].reason).toMatch(/network\.vpcId/);
  });
});

describe("run on plunge", () => {
  test("applies the saved plan with plunge up --plan <file> --yes --json --stack, then reads the outputs", async () => {
    const plunge = engine();
    const cap = createPulumiUpCapability({ plunge: plunge.run, env: {}, tmp: tmp(), snapshots: null });
    const planned = await cap.plan!(ctx, step({ engine: "plunge" }));
    const artifact = planned.artifact as PulumiUpArtifact;
    const out = await cap.run({ ...ctx, plans: { [member]: artifact } }, step({ engine: "plunge" }));
    expect(plunge.calls.map((c) => c.args)).toEqual([
      ["preview", "--json", "--show-sames", "--stack", "floci", "--save-plan", artifact.planFile],
      ["up", "--plan", artifact.planFile, "--yes", "--json", "--stack", "floci"],
      ["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"],
    ]);
    expect(out).toMatchObject({ member, stack: "floci", engine: "plunge", planDigest: planned.planDigest, fromWavePlan: true });
    expect(out.outputs.dbPasswordValue).toBe("[secret]");
    expect(out.summary?.resourceChanges).toEqual({ delete: 2, replace: 2, same: 11, update: 2 });
    // The scratch dir with the plan file is gone once the apply is done.
    expect(existsSync(artifact.scratch)).toBe(false);
  });

  test("plunge's exit 40 is a moved plan: core's mark, the table's 4", async () => {
    const plunge = engine({ up: () => exit(40, "", "error: the saved plan is stale") });
    const cap = createPulumiUpCapability({ plunge: plunge.run, env: {}, tmp: tmp(), snapshots: null });
    const artifact = (await cap.plan!(ctx, step({ engine: "plunge" }))).artifact;
    const err = await cap.run({ ...ctx, plans: { [member]: artifact } }, step({ engine: "plunge" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PulumiPlanMovedError);
    expect(isPlanMovedError(err)).toBe(true);
    expect((err as Error).message).toMatch(/refusing to apply/);
  });

  test("any other exit fails, naming what landed", async () => {
    const partial = upStream.split("\n").slice(0, 10).join("\n");
    const plunge = engine({ up: () => exit(4, partial, "error: RecordConflictError") });
    const cap = createPulumiUpCapability({ plunge: plunge.run, env: {}, tmp: tmp(), snapshots: null });
    const artifact = (await cap.plan!(ctx, step({ engine: "plunge" }))).artifact;
    const err = await cap.run({ ...ctx, plans: { [member]: artifact } }, step({ engine: "plunge" })).catch((e: unknown) => e);
    expect(isPlanMovedError(err)).toBe(false);
    expect((err as Error).message).toMatch(/plunge up failed \(exit 4\)/);
  });

  test("ruling D: with no approved plan it previews and applies in one go", async () => {
    const plunge = engine();
    const cap = createPulumiUpCapability({ plunge: plunge.run, env: {}, tmp: tmp(), snapshots: null });
    const out = await cap.run(ctx, step({ engine: "plunge" }));
    expect(plunge.calls.map((c) => c.args[0])).toEqual(["preview", "up", "stack"]);
    expect(out.fromWavePlan).toBe(false);
  });
});

describe("run on stock Pulumi (ruling A)", () => {
  const stock = (extra: Partial<PulumiUpStepInput> = {}) => step({ engine: "pulumi", ...extra });

  test("previews again, applies with pulumi up --yes --json --stack, and compares the stream with the approved shape", async () => {
    const pulumi = engine();
    const cap = createPulumiUpCapability({ run: pulumi.run, env: {}, tmp: tmp(), snapshots: null });
    const planned = await cap.plan!(ctx, stock());
    expect(planned.planDigest).toBe(pulumiPreviewDigest(pulumiStreamPreview(stream)));
    const out = await cap.run({ ...ctx, plans: { [member]: planned.artifact } }, stock());
    expect(pulumi.calls.map((c) => c.args)).toEqual([
      ["preview", "--json", "--show-sames", "--stack", "floci"],
      ["preview", "--json", "--show-sames", "--stack", "floci"],
      ["up", "--yes", "--json", "--stack", "floci"],
      ["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"],
    ]);
    expect(pulumi.calls[2].env).toBeUndefined();
    expect(out).toMatchObject({ engine: "pulumi", fromWavePlan: true });
  });

  test("a fresh preview beyond the approved shape refuses before up: moved", async () => {
    const extra = JSON.stringify({ resourcePreEvent: { metadata: { op: "create", urn: urn("aws:s3/bucket:Bucket", "extra"), type: "aws:s3/bucket:Bucket", new: { type: "aws:s3/bucket:Bucket", inputs: { bucket: "extra" } }, logical: true }, planning: true } });
    let previews = 0;
    const pulumi = engine({ preview: () => (++previews === 1 ? stream : `${stream}${extra}\n`) });
    const cap = createPulumiUpCapability({ run: pulumi.run, env: {}, tmp: tmp(), snapshots: null });
    const artifact = (await cap.plan!(ctx, stock())).artifact;
    const err = await cap.run({ ...ctx, plans: { [member]: artifact } }, stock()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanShapeMovedError);
    expect(isPlanMovedError(err)).toBe(true);
    expect(pulumi.calls.some((c) => c.args[0] === "up")).toBe(false);
  });

  test("an up whose stream ran a step the approval did not hold fails the step, not moved", async () => {
    const extra = JSON.stringify({ resourcePreEvent: { metadata: { op: "create", urn: urn("aws:s3/bucket:Bucket", "drifted"), type: "aws:s3/bucket:Bucket", new: { type: "aws:s3/bucket:Bucket", inputs: { bucket: "drifted" } }, logical: true } } });
    const pulumi = engine({ up: () => `${upStream}${extra}\n` });
    const cap = createPulumiUpCapability({ run: pulumi.run, env: {}, tmp: tmp(), snapshots: null });
    const artifact = (await cap.plan!(ctx, stock())).artifact;
    const err = await cap.run({ ...ctx, plans: { [member]: artifact } }, stock()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PulumiAppliedShapeError);
    expect(isPlanMovedError(err)).toBe(false);
    expect((err as PulumiAppliedShapeError).differences[0]).toMatch(/drifted/);
  });

  test("ruling D on stock: one preview, then up", async () => {
    const pulumi = engine();
    const cap = createPulumiUpCapability({ run: pulumi.run, env: {}, tmp: tmp(), snapshots: null });
    await cap.run(ctx, stock());
    expect(pulumi.calls.map((c) => c.args[0])).toEqual(["preview", "up", "stack"]);
  });

  test("outputs reads the blind stack output", async () => {
    const pulumi = engine();
    const cap = createPulumiUpCapability({ run: pulumi.run, env: {}, snapshots: null });
    expect((await cap.outputs!(ctx, stock())).vpcId).toBe("vpc-05097b38");
    expect(pulumi.calls.map((c) => c.args)).toEqual([["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"]]);
  });
});

describe("the scratch config", () => {
  test("a key with no colon is the project's own, and a null value is not written", () => {
    expect(JSON.parse(pulumiScratchConfig(dir, "floci", { a: "1", "aws:region": "x", b: null }))).toEqual({ config: { "corpus-aws-ts:a": "1", "aws:region": "x" } });
  });
});

describe("releaseInputs (#4542)", () => {
  test("answers the stack's directory, relative to the member", () => {
    expect(pulumiReleaseInputs({ dir: "pulumi-preview", stack: "floci" }, { memberDir: testdata })).toEqual({ field: "dir", dir: "pulumi-preview", paths: ["pulumi-preview"] });
  });

  test("a directory with no Pulumi.yaml deploys nothing local", () => {
    expect(pulumiReleaseInputs({ dir: "pulumi-stream", stack: "floci" }, { memberDir: testdata })).toBeNull();
  });

  test("an absolute plunge file backend is bound", () => {
    // testdata/plunge-member names plunge+file:///var/lib/plunge/site.
    expect(pulumiReleaseInputs({ dir: "plunge-member", stack: "floci" }, { memberDir: testdata })).toMatchObject({ field: "dir", dir: "plunge-member" });
  });
});
