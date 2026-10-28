/**
 * Release records from op-wave applies and per-resource progress lines
 * (#4615): each run a `step` applied gets one record on its environment's
 * ledger, joined to a release cut from the applied commit when one records
 * the component, and a capability's per-resource lines reach the run's
 * `step-settle` event and the job's log.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { opWaveResourceLines, runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import { opWaveReleaseNames, opWaveReleaseProblems, releaseOfCommit, type OpWaveReleaseRequest } from "./op-waves-release";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { RunEventBody, RunEventResource } from "../run-event";
import type { Release, ReleaseCut } from "../lifecycle/release-store";

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const COMMIT = "c".repeat(40);

const resources: RunEventResource[] = [
  { resource: "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::assets", type: "aws:s3/bucket:Bucket", name: "assets", status: "ok", startedAt: "2026-10-27T10:00:00.000Z", durationMs: 412, calls: 3 },
  { resource: "urn:pulumi:dev::shop::aws:iam/role:Role::app", type: "aws:iam/role:Role", name: "app", status: "failed", startedAt: "2026-10-27T10:00:00.500Z", durationMs: 90, calls: 1 },
];

function capability(digests: Record<string, string>, failing: string[] = []): CapabilityRegistry {
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-up",
    async plan(_ctx, input) {
      const stack = String(input.stack);
      return { member: stack, planDigest: digests[stack]!, artifact: { stack } };
    },
    async run(_ctx, input) {
      if (failing.includes(String(input.stack))) throw new Error(`${input.stack} broke`);
      return { applied: input.stack };
    },
    traceFacts(input) {
      return input.stack === "web" ? { resources } : {};
    },
  };
  return new CapabilityRegistry().register(cap);
}

const spec: OpWavesSpec = {
  name: "pulumi-up",
  op: "pulumi-up",
  step: { kind: "fake-up", stack: "{target}" },
  waves: [{ name: "dev", runs: [{ target: "web" }, { target: "api", release: { component: "shop-api" } }, { target: "jobs" }], gate: "never" }],
};

function harness(s: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-release-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("op-wave release names (#4615)", () => {
  const wave = { name: "dev" };
  test("default to labels.Env, else the wave's name, and the run's target", () => {
    expect(opWaveReleaseNames(spec, wave, { target: "web" })).toEqual({ env: "dev", component: "web" });
    expect(opWaveReleaseNames({ ...spec, labels: { Env: "staging" } }, wave, { target: "web" })).toEqual({ env: "staging", component: "web" });
  });

  test("take the spec's release, then the run's, with {target}, {op} and {wave} filled", () => {
    const s: OpWavesSpec = { ...spec, release: { env: "{wave}-eu", component: "stack-{target}" } };
    expect(opWaveReleaseNames(s, wave, { target: "web" })).toEqual({ env: "dev-eu", component: "stack-web" });
    expect(opWaveReleaseNames(s, wave, { target: "web", release: { component: "{op}" } })).toEqual({ env: "dev-eu", component: "pulumi-up" });
  });

  test("are null without a step, and with release: false", () => {
    const { step: _step, ...noStep } = spec;
    expect(opWaveReleaseNames({ ...noStep, plan: ["p", "{plan}"] } as OpWavesSpec, wave, { target: "web" })).toBeNull();
    expect(opWaveReleaseNames({ ...spec, release: false }, wave, { target: "web" })).toBeNull();
  });

  test("a spec's release is checked", () => {
    expect(opWaveReleaseProblems({ waves: [], release: false })).toEqual([]);
    expect(opWaveReleaseProblems({ waves: [], release: { env: "" } })).toEqual(["`release`.env must be a non-empty string"]);
    expect(opWaveReleaseProblems({ waves: [], release: { stage: "x" } as never })[0]).toContain('unknown key "stage"');
    expect(opWaveReleaseProblems({ waves: [{ name: "dev", runs: [{ target: "web", release: false as never }] }] })[0]).toContain('run "web"');
    expect(() => assertOpWavesSpec({ ...spec, release: "yes" as never })).toThrow(/`release` must be/);
  });
});

describe("the release an op-wave record joins (#4615)", () => {
  const release = (n: string, commit: string, components: string[]): Release => ({
    version: 1,
    releaseDigest: digest(n),
    member: null,
    commit,
    artifactDigests: [],
    targets: [{ env: "dev", params: [], templates: components.map((c) => ({ component: c, path: `${c}/Pulumi.yaml`, digest: digest("e") })) as never }],
  });
  const cut = (n: string, timestamp: string): ReleaseCut => ({ version: 1, releaseDigest: digest(n), label: null, actor: "ana", timestamp, runId: null, runOrigin: null, signature: null }) as ReleaseCut;
  const templates = (r: Release, env: string, component: string) =>
    r.targets.find((t) => t.env === env)?.templates.some((t) => t.component === component) ? `templates:${r.releaseDigest}` : null;

  test("is the newest cut from the commit that records the component", () => {
    const releases = [release("1", COMMIT, ["web"]), release("2", COMMIT, ["web"]), release("3", "d".repeat(40), ["web"])];
    const cuts = [cut("1", "2026-10-27T09:00:00Z"), cut("2", "2026-10-27T10:00:00Z"), cut("3", "2026-10-27T11:00:00Z")];
    expect(releaseOfCommit(releases, cuts, { commit: COMMIT, env: "dev", component: "web" }, templates)).toEqual({ releaseDigest: digest("2"), templatesDigest: `templates:${digest("2")}` });
  });

  test("is null when no release from the commit records the component in the environment", () => {
    const releases = [release("1", COMMIT, ["api"])];
    expect(releaseOfCommit(releases, [cut("1", "2026-10-27T09:00:00Z")], { commit: COMMIT, env: "dev", component: "web" }, templates)).toBeNull();
    expect(releaseOfCommit(releases, [], { commit: COMMIT, env: "prod", component: "api" }, templates)).toBeNull();
  });
});

describe("an op-wave apply records what it applied (#4615)", () => {
  test("one request per applied run, under its names, with the plan digest and commit; a failed run gets none", async () => {
    const h = harness(spec);
    const asked: OpWaveReleaseRequest[] = [];
    const log: string[] = [];
    try {
      const result = await runOpWave({
        spec,
        specFile: "waves.json",
        wave: 1,
        cwd: h.cwd,
        show: h.show,
        head: COMMIT,
        gates: memoryGateLedgerPort(),
        runs: { append: async () => {} },
        releases: {
          async record(requests) {
            asked.push(...requests);
            return requests.map((r) => (r.component === "shop-api" ? { recorded: false as const, reason: "no actor" } : { recorded: true as const, env: r.env, component: r.component, digest: r.planDigest }));
          },
        },
        capabilities: capability({ web: digest("1"), api: digest("2"), jobs: digest("3") }, ["jobs"]),
        log: (line) => log.push(line),
      });
      expect(result).toMatchObject({ applied: ["web", "api"], failed: ["jobs"] });
      expect(asked).toEqual([
        { env: "dev", component: "web", target: "web", planDigest: digest("1"), gitSha: COMMIT },
        { env: "dev", component: "shop-api", target: "api", planDigest: digest("2"), gitSha: COMMIT },
      ]);
      expect(log).toContain(`web: recorded on the "dev" release ledger as web ${digest("1")}`);
      expect(log).toContain('api: applied, and no release record was written for shop-api in "dev": no actor');
    } finally {
      h.done();
    }
  });

  test("release: false and releases: false write none", async () => {
    for (const [s, releases] of [[{ ...spec, release: false }, undefined], [spec, false]] as const) {
      const h = harness(s);
      const asked: OpWaveReleaseRequest[] = [];
      try {
        await runOpWave({
          spec: s,
          specFile: "waves.json",
          wave: 1,
          cwd: h.cwd,
          show: h.show,
          head: COMMIT,
          gates: memoryGateLedgerPort(),
          runs: { append: async () => {} },
          releases: releases ?? { record: async (r) => (asked.push(...r), []) },
          capabilities: capability({ web: digest("1"), api: digest("2"), jobs: digest("3") }),
          log: () => {},
        });
        expect(asked).toEqual([]);
      } finally {
        h.done();
      }
    }
  });
});

describe("per-resource progress (#4615)", () => {
  test("a capability's resources reach the target's step-settle and the log, and other targets carry none", async () => {
    const h = harness(spec);
    const events: RunEventBody[] = [];
    const log: string[] = [];
    try {
      await runOpWave({
        spec,
        specFile: "waves.json",
        wave: 1,
        cwd: h.cwd,
        show: h.show,
        head: COMMIT,
        gates: memoryGateLedgerPort(),
        runs: { append: async () => {} },
        releases: false,
        capabilities: capability({ web: digest("1"), api: digest("2"), jobs: digest("3") }),
        events: (b) => events.push(b),
        log: (line) => log.push(line),
      });
      const settle = (step: string) => events.find((e) => e.type === "step-settle" && e.step === step) as Extract<RunEventBody, { type: "step-settle" }>;
      expect(settle("web").resources).toEqual(resources);
      expect(settle("api").resources).toBeUndefined();
      expect(log).toContain("web: assets (aws:s3/bucket:Bucket) ok in 412 ms, 3 calls");
      expect(log).toContain("web: app (aws:iam/role:Role) failed in 90 ms, 1 call");
    } finally {
      h.done();
    }
  });

  test("a line names the resource by its id when the engine gives no name, and leaves out what it did not time", () => {
    expect(opWaveResourceLines("net", [{ resource: "aws_vpc.main", status: "ok", durationMs: null }])).toEqual(["net: aws_vpc.main ok"]);
  });
});
