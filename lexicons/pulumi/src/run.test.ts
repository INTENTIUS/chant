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
import {
  engineEnv,
  PLUNGE_GRAPH_COMMANDS,
  plungeAdoptArgs,
  plungeGraphArgs,
  plungeMoveArgs,
  pulumiCancelArgs,
  pulumiStateMoveArgs,
  runGatedPlunge,
  runGatedPulumi,
  plungeMemberGraph,
  previewPulumiMember,
  PULUMI_ALLOWED_COMMANDS,
  pulumiMemberEngine,
  pulumiExportStack,
  pulumiPreviewArgs,
  refreshPulumiMember,
  runAdoptPlunge,
  runAllowedPlunge,
  runAllowedPulumi,
  runApplyPlunge,
  runApplyPulumi,
  plungeUpArgs,
  pulumiUpArgs,
  pulumiUpPreviewArgs,
  PULUMI_APPLY_COMMANDS,
  type PulumiRunner,
} from "./run";

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

describe("gated stack operations (#4578)", () => {
  const u = "urn:pulumi:net::shop::aws:s3/bucketV2:BucketV2::logs";
  test("each fixed form reaches its runner", async () => {
    const { run, calls } = fake(() => "{}");
    await runGatedPulumi(run, pulumiCancelArgs({ stack: "dev" }), "/tmp");
    await runGatedPulumi(run, pulumiStateMoveArgs({ source: "net", dest: "app", urns: [u] }), "/tmp");
    await runAllowedPlunge(run, plungeMoveArgs({ source: "net", dest: "app", urns: [u] }), "/tmp");
    await runGatedPlunge(run, plungeMoveArgs({ source: "net", dest: "app", urns: [u], yes: true }), "/tmp");
    expect(calls.map((c) => c.args)).toEqual([
      ["cancel", "--yes", "--stack", "dev"],
      ["state", "move", "--source", "net", "--dest", "app", "--yes", u],
      ["stack", "move", "--stack", "net", "--dest", "app", u, "--json"],
      ["stack", "move", "--stack", "net", "--dest", "app", u, "--json", "--yes"],
    ]);
  });

  test("no other form gets through, and the read entry points refuse the writes", async () => {
    const { run, calls } = fake(() => "{}");
    for (const args of [
      ["cancel", "--stack", "dev"],
      ["cancel", "--yes", "--stack", "dev", "--force"],
      ["state", "move", "--source", "net", "--dest", "app", "--yes", "--include-parents", u],
      ["state", "move", "--source", "net", "--dest", "app", u],
      ["state", "move", "--source", "net", "--dest", "app", "--yes"],
      ["state", "delete", u],
      ["stack", "import", "--file", "x.json"],
    ]) {
      await expect(runGatedPulumi(run, args, "/tmp")).rejects.toThrow(/gated Pulumi stack operation only as/);
    }
    await expect(runGatedPlunge(run, plungeMoveArgs({ source: "net", dest: "app", urns: [u] }), "/tmp")).rejects.toThrow(/moves plunge resources only as/);
    await expect(runGatedPlunge(run, ["stack", "move", "--dest", "app", u, "--json", "--yes"], "/tmp")).rejects.toThrow(/moves plunge resources only as/);
    await expect(runAllowedPlunge(run, plungeMoveArgs({ source: "net", dest: "app", urns: [u], yes: true }), "/tmp")).rejects.toThrow(/not plunge stack move/);
    await expect(runAllowedPulumi(run, pulumiCancelArgs({ stack: "dev" }), "/tmp")).rejects.toThrow(/not pulumi cancel/);
    expect(calls).toEqual([]);
  });
});

describe("plunge stack adopt (#4562)", () => {
  test("the preview form passes runAllowedPlunge, and only runAdoptPlunge runs --yes", async () => {
    const { run, calls } = fake(() => "{}");
    await runAllowedPlunge(run, plungeAdoptArgs({ stack: "dev" }), "/tmp");
    await runAllowedPlunge(run, plungeAdoptArgs({ stack: "dev", file: "/tmp/s.json" }), "/tmp");
    await runAdoptPlunge(run, plungeAdoptArgs({ stack: "dev", yes: true }), "/tmp");
    await runAdoptPlunge(run, plungeAdoptArgs({ stack: "dev", yes: true, file: "/tmp/s.json" }), "/tmp");
    expect(calls.map((c) => c.args)).toEqual([
      ["stack", "adopt", "--json", "--stack", "dev"],
      ["stack", "adopt", "--json", "--stack", "dev", "--file", "/tmp/s.json"],
      ["stack", "adopt", "--json", "--yes", "--stack", "dev"],
      ["stack", "adopt", "--json", "--yes", "--stack", "dev", "--file", "/tmp/s.json"],
    ]);
  });

  test("--yes through the read entry point, the adopt-file route, other flags and stock pulumi are refused", async () => {
    const { run, calls } = fake(() => "{}");
    await expect(runAllowedPlunge(run, plungeAdoptArgs({ stack: "dev", yes: true }), "/tmp")).rejects.toThrow(/not plunge stack adopt --json --yes/);
    await expect(runAllowedPulumi(run, plungeAdoptArgs({ stack: "dev" }), "/tmp")).rejects.toThrow(/not pulumi stack adopt/);
    for (const args of [
      ["stack", "adopt", "--json", "--stack", "dev", "--adopt", "a.yaml"],
      ["stack", "adopt", "--json", "--yes", "--stack", "dev", "--index-store", "/x"],
      ["stack", "adopt", "--yes", "--stack", "dev"],
      ["stack", "adopt", "--json", "--yes", "--stack", "--file"],
      ["stack", "adopt", "--json", "--stack", "dev"],
    ]) {
      await expect(runAdoptPlunge(run, args, "/tmp")).rejects.toThrow(/chant adopts a stack onto plunge only as/);
    }
    expect(calls).toEqual([]);
  });
});

describe("stack export (#4546)", () => {
  test("exactly stack export --stack <stack> reaches either runner", async () => {
    const { run, calls } = fake(() => "{}");
    await runAllowedPulumi(run, ["stack", "export", "--stack", "dev"], "/tmp");
    await runAllowedPlunge(run, ["stack", "export", "--stack", "dev"], "/tmp");
    expect(calls.map((c) => c.args)).toEqual([
      ["stack", "export", "--stack", "dev"],
      ["stack", "export", "--stack", "dev"],
    ]);
  });

  test("--file, --show-secrets, --version, no stack and a flag for a stack are refused before the runner", async () => {
    const { run, calls } = fake(() => "{}");
    for (const args of [
      ["stack", "export"],
      ["stack", "export", "--stack", "dev", "--file", "stack-export.json"],
      ["stack", "export", "--stack", "dev", "--show-secrets"],
      ["stack", "export", "--stack", "dev", "--version", "3"],
      ["stack", "export", "--stack", "--show-secrets"],
      ["stack", "export", "--file", "x", "--stack", "dev"],
    ]) {
      await expect(runAllowedPulumi(run, args, "/tmp")).rejects.toThrow(/pulumi stack export --stack <stack>/);
      await expect(runAllowedPlunge(run, args, "/tmp")).rejects.toThrow(/plunge stack export --stack <stack>/);
    }
    expect(calls).toEqual([]);
  });
});

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

  test("--stack <name> passes, and a --stack with no name or a flag for one is refused before the runner (#4514)", async () => {
    const { run, calls } = fake(() => "{}");
    for (const args of [
      ["preview", "--json", "--stack"],
      ["preview", "--json", "--stack", "--yes"],
      ["refresh", "--preview-only", "--json", "--stack", "-y"],
      ["preview", "--json", "--stack", ""],
    ]) {
      await expect(runAllowedPulumi(run, args, "/tmp")).rejects.toThrow(/only pulumi preview and pulumi refresh --preview-only/);
    }
    for (const args of [["preview", "--json", "--stack", "--yes"], ["drift", "--resource", "x", "--stream", "--stack", "--member"]]) {
      await expect(runAllowedPlunge(run, args, "/tmp")).rejects.toThrow(/only plunge drift --resource <urn> --stream/);
    }
    expect(calls).toEqual([]);
    await runAllowedPulumi(run, ["preview", "--json", "--show-sames", "--stack", "floci"], "/tmp");
    await runAllowedPulumi(run, ["refresh", "--preview-only", "--json", "--stack", "floci", "--target", "u"], "/tmp");
    await runAllowedPlunge(run, ["preview", "--json", "--show-sames", "--stack", "floci"], "/tmp");
    await runAllowedPlunge(run, ["drift", "--resource", "u", "--stream", "--stack", "floci", "--member", "site"], "/tmp");
    expect(calls.map((c) => c.args[0])).toEqual(["preview", "refresh", "preview", "drift"]);
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
    // No stack declared: the one the export's URNs name (#4514).
    expect(targetedCalls[0].args).toEqual(pulumiPreviewArgs({ stack: "floci", targets: [target] }));
    expect(targetedCalls[0].args).toEqual(["preview", "--json", "--show-sames", "--stack", "floci", "--target", target]);
    expect(part.entries.map((e) => e.address)).toEqual([target]);
    expect(calls).toEqual([]);
  });

  test("with no declared stack, the preview passes the stack the export's URNs name (#4514)", async () => {
    const { run, calls } = fake(() => text("pulumi-preview", "preview.json"));
    const part = await previewPulumiMember({ member: "site", dir, run });
    expect(calls).toEqual([{ args: ["preview", "--json", "--show-sames", "--stack", "floci"], cwd: dir }]);
    expect(part.member.scope).toBe("floci");
  });

  test("with no export and no declared stack, a targeted preview passes the stack its targets name, an untargeted one none (#4514)", async () => {
    const unexported = join(testdata, "pulumi-unexported");
    const asked = "urn:pulumi:qa::app::aws:s3/bucket:Bucket::logs";
    const { run, calls } = fake(() => JSON.stringify({ steps: [] }));
    await previewPulumiMember({ member: "site", dir: unexported, targets: [asked], run });
    await previewPulumiMember({ member: "site", dir: unexported, run });
    expect(calls.map((c) => c.args)).toEqual([
      ["preview", "--json", "--show-sames", "--stack", "qa", "--target", asked],
      ["preview", "--json", "--show-sames"],
    ]);
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
    expect(pulumiMemberEngine(dir, undefined, { env: {} })).toEqual({
      engine: "plunge",
      because: "Pulumi.yaml names the plunge backend plunge+file:///var/lib/plunge/site",
      source: "Pulumi.yaml",
    });
    expect(pulumiMemberEngine(dir, "pulumi").engine).toBe("pulumi");
    expect(pulumiMemberEngine(join(testdata, "pulumi-member"), undefined, { env: {} }).engine).toBe("pulumi");
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

describe("plunge graph (#4529, ruled on #4520 Q4 and Q6)", () => {
  const dir = join(testdata, "plunge-graph");
  const allowed = [
    ["graph", "--json"],
    ["graph", "--json", "--stack", "dev"],
    ["graph", "--json", "--versions"],
    ["graph", "--json", "--stack", "dev", "--versions"],
  ];

  test("each of the four argv reaches the plunge runner", async () => {
    for (const args of allowed) {
      const { run, calls } = fake(() => "{}");
      await runAllowedPlunge(run, args, dir);
      expect(calls).toEqual([{ args, cwd: dir }]);
    }
    expect(PLUNGE_GRAPH_COMMANDS).toEqual(["plunge graph --json", "plunge graph --json --stack <stack>", "plunge graph --json --versions", "plunge graph --json --stack <stack> --versions"]);
  });

  test.each([
    ["without --json, which plunge refuses too", ["graph"]],
    ["--versions without --json", ["graph", "--versions"]],
    ["--show-secrets", ["graph", "--json", "--show-secrets"]],
    ["--show-secrets=false", ["graph", "--json", "--show-secrets=false"]],
    ["--show-secrets with a stack", ["graph", "--json", "--stack", "dev", "--show-secrets"]],
    ["--outputs", ["graph", "--json", "--outputs"]],
    ["--show-outputs", ["graph", "--json", "--stack", "dev", "--versions", "--show-outputs"]],
    ["--stack with no name", ["graph", "--json", "--stack"]],
    ["--stack with a flag for a name", ["graph", "--json", "--stack", "--versions"]],
    ["--stack with an empty name", ["graph", "--json", "--stack", ""]],
    ["-s for --stack", ["graph", "--json", "-s", "dev"]],
    ["two stacks", ["graph", "--json", "--stack", "dev", "--stack", "prod"]],
    ["--versions before --stack", ["graph", "--json", "--versions", "--stack", "dev"]],
    ["--json after --stack", ["graph", "--stack", "dev", "--json"]],
    ["--json twice", ["graph", "--json", "--json"]],
    ["--versions twice", ["graph", "--json", "--versions", "--versions"]],
    ["a positional argument", ["graph", "--json", "dev"]],
    ["--versions=true", ["graph", "--json", "--versions=true"]],
    ["upstream's stack graph", ["stack", "graph", "--json"]],
  ])("refused before the runner: %s", async (_why, args) => {
    const { run, calls } = fake(() => "{}");
    await expect(runAllowedPlunge(run, args, dir)).rejects.toThrow(/only plunge drift --resource <urn> --stream/);
    expect(calls).toEqual([]);
  });

  test("the refusal names the four argv", async () => {
    const { run } = fake(() => "{}");
    const refused = await runAllowedPlunge(run, ["graph", "--json", "--show-secrets"], dir).catch((e: Error) => e.message);
    for (const command of PLUNGE_GRAPH_COMMANDS) expect(refused).toContain(command);
    expect(refused).toMatch(/not plunge graph --json --show-secrets$/);
  });

  test("stock pulumi gets no graph argv, and its list is unchanged", async () => {
    const { run, calls } = fake(() => "{}");
    for (const args of allowed) await expect(runAllowedPulumi(run, args, dir)).rejects.toThrow(/only pulumi preview/);
    expect(calls).toEqual([]);
    expect(PULUMI_ALLOWED_COMMANDS).toEqual([["preview"], ["refresh", "--preview-only"], ["stack", "output"], ["stack", "export"]]);
  });

  test("plungeGraphArgs builds each of the four, in the allowed order", () => {
    expect(plungeGraphArgs()).toEqual(allowed[0]);
    expect(plungeGraphArgs({ stack: "dev" })).toEqual(allowed[1]);
    expect(plungeGraphArgs({ versions: true })).toEqual(allowed[2]);
    expect(plungeGraphArgs({ stack: "dev", versions: true })).toEqual(allowed[3]);
  });

  test("plungeMemberGraph passes the stack the export names, and no --versions unless asked", async () => {
    const { run, calls } = fake(() => text("plunge-graph", "engine-graph.json"));
    const read = await plungeMemberGraph({ dir, plunge: run });
    expect(calls).toEqual([{ args: ["graph", "--json", "--stack", "dev"], cwd: dir }]);
    expect(read).toMatchObject({ ok: true, command: "plunge graph --json --stack dev", stack: "dev" });
    await plungeMemberGraph({ dir, stack: "qa", versions: true, plunge: run });
    expect(calls[1].args).toEqual(["graph", "--json", "--stack", "qa", "--versions"]);
  });

  test("a plunge without the command, a missing binary, and no JSON each say why", async () => {
    const old = fake(() => failure("Command failed: plunge graph --json --stack dev", { stderr: 'error: unknown command "graph" for "plunge"\n' }));
    expect(await plungeMemberGraph({ dir, plunge: old.run })).toMatchObject({ ok: false, reason: "read-failed", detail: expect.stringMatching(/no `plunge graph` \(INTENTIUS\/plunge#40\)/) });
    const missing = fake(() => failure("spawn plunge ENOENT", { code: "ENOENT" }));
    expect(await plungeMemberGraph({ dir, plunge: missing.run })).toMatchObject({ ok: false, detail: "the plunge binary was not found on PATH" });
    const blank = fake(() => "");
    expect(await plungeMemberGraph({ dir, plunge: blank.run })).toMatchObject({ ok: false, detail: "plunge graph --json --stack dev printed no JSON" });
  });
});

describe("the apply entry points (#4541)", () => {
  const tail = { configFile: "/tmp/c/Pulumi.floci.yaml", targets: ["urn:a", "urn:b"], policyPacks: [{ dir: "/packs/org", config: "/packs/org.json" }, { dir: "/packs/team" }] };

  test("the read entry points still refuse up", async () => {
    const { run, calls } = fake(() => "{}");
    await expect(runAllowedPulumi(run, pulumiUpArgs({ stack: "floci" }), "/tmp")).rejects.toThrow(/only pulumi preview/);
    await expect(runAllowedPlunge(run, plungeUpArgs({ plan: "/tmp/p.json", stack: "floci" }), "/tmp")).rejects.toThrow(/only plunge drift/);
    expect(calls).toEqual([]);
  });

  test("the fixed forms pass, with the tail in its order", async () => {
    const { run, calls } = fake(() => "");
    await runApplyPulumi(run, pulumiUpArgs({ stack: "floci", ...tail }), "/tmp");
    await runApplyPlunge(run, plungeUpArgs({ plan: "/tmp/p.json", stack: "floci", ...tail }), "/tmp");
    expect(calls.map((c) => c.args)).toEqual([
      ["up", "--yes", "--json", "--stack", "floci", "--config-file", "/tmp/c/Pulumi.floci.yaml", "--target", "urn:a", "--target", "urn:b", "--policy-pack", "/packs/org", "--policy-pack-config", "/packs/org.json", "--policy-pack", "/packs/team"],
      ["up", "--plan", "/tmp/p.json", "--yes", "--json", "--stack", "floci", "--config-file", "/tmp/c/Pulumi.floci.yaml", "--target", "urn:a", "--target", "urn:b", "--policy-pack", "/packs/org", "--policy-pack-config", "/packs/org.json", "--policy-pack", "/packs/team"],
    ]);
    expect(PULUMI_APPLY_COMMANDS).toHaveLength(2);
  });

  test("anything off the list is refused before the runner", async () => {
    const { run, calls } = fake(() => "");
    const base = pulumiUpArgs({ stack: "floci" });
    for (const extra of [["--skip-preview"], ["--refresh"], ["--show-secrets"], ["--replace", "urn:a"], ["--target-replace", "urn:a"], ["--target-dependents"], ["--exclude", "urn:a"], ["--remote"], ["--continue-on-error"], ["--config", "k=v"], ["--plan", "/tmp/p.json"]]) {
      await expect(runApplyPulumi(run, [...base, ...extra], "/tmp")).rejects.toThrow(/applies a Pulumi stack only as/);
    }
    for (const args of [
      ["up", "--json", "--yes", "--stack", "floci"],
      ["up", "--yes", "--json"],
      ["up", "--yes", "--json", "--stack", "--yes"],
      ["up", "--yes", "--json", "--stack", "floci", "--target"],
      ["up", "--yes", "--json", "--stack", "floci", "--target", "urn:a", "--config-file", "/tmp/c"],
      ["destroy", "--yes", "--json", "--stack", "floci"],
    ]) {
      await expect(runApplyPulumi(run, args, "/tmp")).rejects.toThrow(/applies a Pulumi stack only as/);
    }
    for (const args of [
      ["up", "--yes", "--json", "--stack", "floci"],
      ["up", "--plan", "--yes", "--json", "--stack", "floci"],
      ["up", "--plan", "/tmp/p.json", "--yes", "--json", "--stack", "floci", "--skip-preview"],
    ]) {
      await expect(runApplyPlunge(run, args, "/tmp")).rejects.toThrow(/applies a plunge stack only as/);
    }
    expect(calls).toEqual([]);
  });

  test("a preview with --show-secrets or --import-file is refused; --save-plan and the tail pass", async () => {
    const { run, calls } = fake(() => "");
    for (const extra of [["--show-secrets"], ["--show-secrets=true"], ["--import-file", "/tmp/i.json"], ["--import-file=/tmp/i.json"]]) {
      await expect(runAllowedPulumi(run, ["preview", "--json", ...extra], "/tmp")).rejects.toThrow(/only pulumi preview/);
      await expect(runAllowedPlunge(run, ["preview", "--json", ...extra], "/tmp")).rejects.toThrow(/only plunge drift/);
    }
    expect(calls).toEqual([]);
    await runAllowedPlunge(run, pulumiUpPreviewArgs({ stack: "floci", savePlan: "/tmp/p.json", ...tail }), "/tmp", { PULUMI_ENABLE_STREAMING_JSON_PREVIEW: "true" });
    expect(calls[0].args.slice(0, 7)).toEqual(["preview", "--json", "--show-sames", "--stack", "floci", "--save-plan", "/tmp/p.json"]);
  });
});
