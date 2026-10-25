/**
 * Running pulumi for a Pulumi member (#4453): the argv chant passes, the
 * allow-list from the ruling on #4450, and what a failed run becomes. The
 * runner is a fake that returns the hand-written fixtures; no pulumi binary
 * runs here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { previewPulumiMember, pulumiMemberEngine, pulumiPreviewArgs, refreshPulumiMember, runAllowedPlunge, runAllowedPulumi, type PulumiRunner } from "./run";

const testdata = join(import.meta.dirname, "testdata");
const text = (...path: string[]) => readFileSync(join(testdata, ...path), "utf-8");
const urn = (type: string, name: string) => `urn:pulumi:dev::site::${type}::${name}`;

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

  test("runs pulumi preview --json in the member's directory and reads its export as the last deployment", async () => {
    const { run, calls } = fake(() => text("pulumi-preview", "preview.json"));
    const part = await previewPulumiMember({ member: "site", dir, stack: "dev", run });
    expect(calls).toEqual([{ args: ["preview", "--json", "--stack", "dev"], cwd: dir }]);
    expect(part.member).toMatchObject({ member: "site", planner: "pulumi", status: "planned", scope: "dev" });
    // The checked-in stack-export.json holds a record the preview never lists: it may appear.
    expect(part.entries.find((e) => e.address === urn("my:web:Site$aws:route53/record:Record", "site-alias"))?.mayAppear).toBe(true);
  });

  test("a targeted preview passes --target per URN and marks nothing it left out", async () => {
    const { run, calls } = fake(() => text("pulumi-preview", "preview.json"));
    const target = urn("aws:s3/bucket:Bucket", "logs");
    const part = await previewPulumiMember({ member: "site", dir, targets: [target], run });
    expect(calls[0].args).toEqual(pulumiPreviewArgs({ targets: [target] }));
    expect(calls[0].args).toEqual(["preview", "--json", "--target", target]);
    expect(part.entries.some((e) => e.address === urn("my:web:Site$aws:route53/record:Record", "site-alias"))).toBe(false);
  });

  test("no pulumi binary is a failed member that says so", async () => {
    const { run } = fake(() => failure("spawn pulumi ENOENT", { code: "ENOENT" }));
    const part = await previewPulumiMember({ member: "site", dir, run });
    expect(part.member).toMatchObject({ status: "failed", planDigest: null, error: expect.stringMatching(/pulumi binary was not found/) });
    expect(part.entries).toEqual([]);
  });

  test("a preview that fails keeps the error diagnostic and the steps it printed", async () => {
    const printed = JSON.stringify({
      steps: [{ op: "same", urn: urn("my:web:Site", "site"), newState: { urn: urn("my:web:Site", "site"), custom: false, type: "my:web:Site" } }],
      diagnostics: [{ severity: "error", message: "error: aws:s3/bucket:Bucket resource 'logs' has a problem: bucket name taken\n" }],
    });
    const { run } = fake(() => failure("Command failed: pulumi preview --json", { stdout: printed, stderr: "" }));
    const part = await previewPulumiMember({ member: "site", dir, run });
    expect(part.member).toMatchObject({ status: "failed", planDigest: null, error: "error: aws:s3/bucket:Bucket resource 'logs' has a problem: bucket name taken" });
    expect(part.entries.map((e) => e.address)).toContain(urn("my:web:Site", "site"));
  });
});

describe("refreshPulumiMember", () => {
  test("one --target'ed refresh per URN, run in order, each read on its own", async () => {
    const assets = urn("aws:s3/bucket:Bucket", "assets");
    const role = urn("aws:iam/role:Role", "web");
    const broken = urn("aws:iam/rolePolicy:RolePolicy", "webReadsAssets");
    const { run, calls } = fake((args) => {
      const target = args[args.indexOf("--target") + 1];
      if (target === assets) return text("pulumi-refresh", "bucket-edited.json");
      if (target === role) return text("pulumi-refresh", "role-same.json");
      return failure("Command failed", { stderr: "error: No valid credential sources found for AWS Provider." });
    });
    const records = await refreshPulumiMember({ member: "site", dir: join(testdata, "pulumi-preview"), stack: "dev", urns: [assets, role, broken], observedAt: "2026-10-25T12:00:00Z", run });
    expect(calls.map((c) => c.args)).toEqual([assets, role, broken].map((u) => ["refresh", "--preview-only", "--json", "--stack", "dev", "--target", u]));
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
    expect(records.every((r) => r.status === "not-observed" && r.unobserved?.reason === "not-reached")).toBe(true);
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
    const plunge = fake((args) => text("plunge-drift", args[2].endsWith("::assets") ? "assets-drifted.ndjson" : "role-in-sync.ndjson"));
    const records = await refreshPulumiMember({ member: "site", dir, stack: "dev", observedAt: "2026-10-25T12:00:00Z", run: pulumi.run, plunge: plunge.run });
    expect(pulumi.calls).toEqual([]);
    expect(plunge.calls.map((c) => c.args)).toEqual(
      ["urn:pulumi:dev::site::aws:s3/bucket:Bucket::assets", "urn:pulumi:dev::site::aws:iam/role:Role::web"].map((u) => ["drift", "--resource", u, "--stream", "--stack", "dev", "--member", "site"]),
    );
    expect(records.map((r) => [r.engine, r.status])).toEqual([
      ["plunge", "in-sync"],
      ["plunge", "drifted"],
    ]);
  });
});
