/**
 * Running pulumi for a Pulumi member (#4453): the argv chant passes, the
 * allow-list from the ruling on #4450, and what a failed run becomes. The
 * runner is a fake that returns the fixtures recorded for #4475 (pulumi
 * 3.272.0 and plunge against the plunge corpus on floci); no pulumi binary
 * runs here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { engineEnv, previewPulumiMember, pulumiMemberEngine, pulumiExportStack, pulumiPreviewArgs, refreshPulumiMember, runAllowedPlunge, runAllowedPulumi, type PulumiRunner } from "./run";

const testdata = join(import.meta.dirname, "testdata");
const text = (...path: string[]) => readFileSync(join(testdata, ...path), "utf-8");
const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;

function fake(answer: (args: string[]) => string | Error): { run: PulumiRunner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: PulumiRunner = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const out = answer(args);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { run, calls };
}

function failure(message: string, fields: { code?: string; stdout?: string; stderr?: string }): Error {
  return Object.assign(new Error(message), fields);
}

describe("the allow-list (ruling on #4450)", () => {
  test("only preview and refresh --preview-only reach the runner", async () => {
    const { run, calls } = fake(() => "{}");
    for (const args of [["up", "--yes"], ["destroy"], ["refresh", "--json"], ["stack", "export"], ["import", "aws:s3/bucket:Bucket", "x", "y"]]) {
      await expect(runAllowedPulumi(run, args, "/tmp")).rejects.toThrow(/only pulumi preview and pulumi refresh --preview-only/);
    }
    expect(calls).toEqual([]);
    await runAllowedPulumi(run, ["preview", "--json"], "/tmp");
    await runAllowedPulumi(run, ["refresh", "--preview-only", "--json"], "/tmp");
    expect(calls.map((c) => c.args[0])).toEqual(["preview", "refresh"]);
  });
});

describe("previewPulumiMember", () => {
  const dir = join(testdata, "pulumi-preview");

  test("runs pulumi preview --json --show-sames in the member's directory and reads its export as the last deployment", async () => {
    const { run, calls } = fake(() => text("pulumi-preview", "preview.json"));
    const part = await previewPulumiMember({ member: "site", dir, stack: "floci", run });
    expect(calls).toEqual([{ args: ["preview", "--json", "--show-sames", "--stack", "floci"], cwd: dir }]);
    expect(part.member).toMatchObject({ member: "site", planner: "pulumi", status: "planned", scope: "floci" });
    // --show-sames lists every resource the checked-in export holds, so nothing reads as may-appear.
    expect(part.entries.filter((e) => e.mayAppear === true)).toEqual([]);
    // Without --show-sames the same export would mark every unchanged resource may-appear.
    const doc = JSON.parse(text("pulumi-preview", "preview.json")) as { steps: { op: string; urn: string }[] };
    const sameless = JSON.stringify({ ...doc, steps: doc.steps.filter((s) => s.op !== "same" || s.urn.includes("pulumi:pulumi:Stack")) });
    const without = await previewPulumiMember({ member: "site", dir, run: fake(() => sameless).run });
    expect(without.entries.find((e) => e.address === urn("aws:iam/role:Role", "app-role"))?.mayAppear).toBe(true);
  });

  test("the engine's environment drops PULUMI_SKIP_CONFIRMATIONS, which refresh --preview-only refuses", () => {
    expect(engineEnv({ PATH: "/bin", PULUMI_SKIP_CONFIRMATIONS: "true" })).toEqual({ PATH: "/bin", PULUMI_SKIP_UPDATE_CHECK: "true" });
  });

  test("a targeted preview passes --target per URN and marks nothing it left out", async () => {
    const { run, calls } = fake(() => text("pulumi-preview", "preview.json"));
    const target = urn("aws:sqs/queue:Queue", "events");
    const one = JSON.parse(text("pulumi-preview", "preview.json")) as { steps: { urn: string }[] };
    const { run: targetedRun, calls: targetedCalls } = fake(() => JSON.stringify({ ...one, steps: one.steps.filter((s) => s.urn === target) }));
    const part = await previewPulumiMember({ member: "site", dir, targets: [target], run: targetedRun });
    expect(targetedCalls[0].args).toEqual(pulumiPreviewArgs({ targets: [target] }));
    expect(targetedCalls[0].args).toEqual(["preview", "--json", "--show-sames", "--target", target]);
    expect(part.entries.map((e) => e.address)).toEqual([target]);
    expect(calls).toEqual([]);
  });

  test("no pulumi binary is a failed member that says so", async () => {
    const { run } = fake(() => failure("spawn pulumi ENOENT", { code: "ENOENT" }));
    const part = await previewPulumiMember({ member: "site", dir, run });
    expect(part.member).toMatchObject({ status: "failed", planDigest: null, error: expect.stringMatching(/pulumi binary was not found/) });
    expect(part.entries).toEqual([]);
  });

  test("a preview that fails keeps the error diagnostic and the steps it printed", async () => {
    const printed = JSON.stringify({
      steps: [{ op: "same", urn: urn("corpus:index:Site", "docs"), newState: { urn: urn("corpus:index:Site", "docs"), custom: false, type: "corpus:index:Site" } }],
      diagnostics: [{ severity: "error", message: "error: aws:s3/bucket:Bucket resource 'logs' has a problem: bucket name taken\n" }],
    });
    const { run } = fake(() => failure("Command failed: pulumi preview --json", { stdout: printed, stderr: "" }));
    const part = await previewPulumiMember({ member: "site", dir, run });
    expect(part.member).toMatchObject({ status: "failed", planDigest: null, error: "error: aws:s3/bucket:Bucket resource 'logs' has a problem: bucket name taken" });
    expect(part.entries.map((e) => e.address)).toContain(urn("corpus:index:Site", "docs"));
  });
});

describe("refreshPulumiMember", () => {
  test("one --target'ed refresh per URN, run in order, each read on its own", async () => {
    const assets = urn("aws:s3/bucket:Bucket", "site-bucket");
    const role = urn("aws:iam/role:Role", "app-role");
    const broken = urn("aws:sqs/queue:Queue", "worker-0");
    const { run, calls } = fake((args) => {
      const target = args[args.indexOf("--target") + 1];
      if (target === assets) return text("pulumi-refresh", "bucket-edited.json");
      if (target === role) return text("pulumi-refresh", "role-same.json");
      return failure("Command failed", { stderr: "error: No valid credential sources found for AWS Provider." });
    });
    const records = await refreshPulumiMember({ member: "site", dir: join(testdata, "pulumi-preview"), stack: "floci", urns: [assets, role, broken], observedAt: "2026-10-25T12:00:00Z", run });
    expect(calls.map((c) => c.args)).toEqual([assets, role, broken].map((u) => ["refresh", "--preview-only", "--json", "--stack", "floci", "--target", u]));
    expect(records.map((r) => [r.address, r.status])).toEqual([
      [role, "in-sync"],
      [assets, "drifted"],
      [broken, "not-observed"],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    expect(records.find((r) => r.address === broken)!.unobserved?.reason).toBe("no-credentials");
  });

  test("with no URNs given, the export's resources are read, providers and the stack left out", async () => {
    const dir = join(testdata, "pulumi-member");
    const { run, calls } = fake(() => JSON.stringify({ steps: [] }));
    const records = await refreshPulumiMember({ member: "infra", dir, observedAt: "2026-10-25T12:00:00Z", run });
    const targets = calls.map((c) => c.args[c.args.indexOf("--target") + 1]);
    expect(targets.some((t) => t.includes("pulumi:providers:") || t.includes("pulumi:pulumi:Stack"))).toBe(false);
    expect(targets).toContain("urn:pulumi:dev::app::aws:s3/bucket:Bucket::assets");
    // No stack declared: the one the export's URNs name (#4496).
    expect(calls.every((c) => c.args[c.args.indexOf("--stack") + 1] === "dev")).toBe(true);
    expect(records.every((r) => r.status === "not-observed" && r.unobserved?.reason === "not-reached")).toBe(true);
  });

  test("with no export and no declared stack, the stack the URNs asked for name (#4496)", async () => {
    const asked = "urn:pulumi:qa::site::aws:s3/bucket:Bucket::site-bucket";
    const { run, calls } = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    await refreshPulumiMember({ member: "site", dir: join(testdata, "pulumi-unexported"), urns: [asked], observedAt: "2026-10-25T12:00:00Z", run });
    expect(calls.map((c) => c.args)).toEqual([["refresh", "--preview-only", "--json", "--stack", "qa", "--target", asked]]);
  });

  test("pulumiExportStack names the export's one stack, and none when its URNs disagree (#4496)", () => {
    const exported = (...urns: string[]) => ({ deployment: { resources: urns.map((u) => ({ urn: u, type: "aws:s3/bucket:Bucket" })) } });
    expect(pulumiExportStack(exported("urn:pulumi:dev::app::aws:s3/bucket:Bucket::a"))).toBe("dev");
    expect(pulumiExportStack(exported("urn:pulumi:dev::app::aws:s3/bucket:Bucket::a", "urn:pulumi:prod::app::aws:s3/bucket:Bucket::b"))).toBeUndefined();
    expect(pulumiExportStack(undefined)).toBeUndefined();
  });

  test("with no export, one untargeted refresh", async () => {
    const { run, calls } = fake(() => text("pulumi-refresh", "bucket-edited.json"));
    const records = await refreshPulumiMember({ member: "site", dir: join(testdata, "pulumi-unexported"), observedAt: "2026-10-25T12:00:00Z", run });
    expect(calls.map((c) => c.args)).toEqual([["refresh", "--preview-only", "--json"]]);
    expect(records.map((r) => r.status)).toEqual(["drifted"]);
  });
});

describe("a member on plunge (#4453)", () => {
  const dir = join(testdata, "plunge-member");

  test("the engine: the config first, then a plunge backend URL in Pulumi.yaml, else pulumi", () => {
    expect(pulumiMemberEngine(dir)).toEqual({ engine: "plunge", because: "Pulumi.yaml names the plunge backend plunge+file:///var/lib/plunge/site" });
    expect(pulumiMemberEngine(dir, "pulumi").engine).toBe("pulumi");
    expect(pulumiMemberEngine(join(testdata, "pulumi-member")).engine).toBe("pulumi");
    expect(pulumiMemberEngine(join(testdata, "pulumi-member"), "plunge").engine).toBe("plunge");
  });

  test("only plunge drift --resource <urn> --stream reaches the plunge runner", async () => {
    const { run, calls } = fake(() => "");
    for (const args of [["up"], ["drift", "--resource", "x"], ["state", "delete", "x"]]) {
      await expect(runAllowedPlunge(run, args, dir)).rejects.toThrow(/only plunge drift --resource <urn> --stream/);
    }
    expect(calls).toEqual([]);
  });

  test("refresh reads each resource with plunge drift, never pulumi", async () => {
    const pulumi = fake(() => failure("pulumi must not run for a plunge member", {}));
    const answers: Record<string, string> = {
      [urn("aws:iam/role:Role", "app-role")]: "role-in-sync.ndjson",
      [urn("corpus:index:Site", "docs")]: "component-unsupported.ndjson",
      [urn("corpus:index:Site$aws:s3/bucket:Bucket", "docs-assets")]: "assets-drifted.ndjson",
    };
    const plunge = fake((args) => text("plunge-drift", answers[args[2]]));
    const records = await refreshPulumiMember({ member: "site", dir, stack: "floci", observedAt: "2026-10-25T12:00:00Z", run: pulumi.run, plunge: plunge.run });
    expect(pulumi.calls).toEqual([]);
    expect(plunge.calls.map((c) => c.args)).toEqual(Object.keys(answers).map((u) => ["drift", "--resource", u, "--stream", "--stack", "floci", "--member", "site"]));
    expect(records.map((r) => [r.engine, r.status])).toEqual([
      // Sorted by address: the role, then the component's child ("$" sorts before "::"), then the component.
      ["plunge", "in-sync"],
      ["plunge", "drifted"],
      ["plunge", "not-observed"],
    ]);
  });
});
