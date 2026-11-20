import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import { opWaveSoakStop, waveSoakAppliedFrom } from "../op/op-waves-soak";
import type { OpRunRecord } from "../op/runtime";
import type { OpWavesSpec } from "../op/op-waves";
import type { NotifyEvent } from "../notify";
import { pipelineSoakSection } from "./diff";
import { pipelineFromConfig } from "./product";
import { pipelinePromoteSoak } from "./promote";
import { decideSoak, soakCheckName, soakDurationMs, soakGlobMatch, soakProblems, soakRuleFor, soakSpan, type Soak, type SoakCheck, type SoakCheckReader, type SoakCheckResult } from "./soak";
import { healthVerdict, runRecordSoakSources, soakCheckReader } from "./soak-checks";
import { soakAtGate } from "./soak-gate";
import { asPipelineSpec, pipelineSpecProblems, type PipelineSpec } from "./spec";

const T0 = "2026-03-01T10:00:00.000Z";
const at = (h: number) => new Date(Date.parse(T0) + h * 3_600_000);
const subjects = [{ member: "app", targets: ["app"], appliedAt: T0 }];

/** A fake reader: each check by name answers from `answers`, else passes; `asked` lists what was read. */
function fake(answers: Record<string, SoakCheckResult["status"]> = {}) {
  const asked: string[] = [];
  const read: SoakCheckReader = async (check) => {
    const name = soakCheckName(check);
    asked.push(name);
    const status = answers[name] ?? "passed";
    return { status, detail: `${name} ${status}` };
  };
  return { read, asked };
}

const http = (name: string, onFail?: "restart" | "hold"): SoakCheck => ({ kind: "http", name, url: "https://x.example/healthz", ...(onFail ? { onFail } : {}) });

describe("decideSoak with a fake clock and fake checks", () => {
  test("no soak releases; the clock holds until due, and a check passing releases at due", async () => {
    expect((await decideSoak({ soak: undefined, subjects, environment: "dev", now: at(0), read: fake().read })).via).toBe("no-soak");
    const soak: Soak = { duration: "2h", checks: [http("up")] };
    const early = await decideSoak({ soak, subjects, environment: "dev", now: at(1), read: fake().read });
    expect(early.outcome).toBe("hold");
    expect(early.holds).toEqual([{ reason: "time", due: at(2).toISOString(), leftMs: 3_600_000 }]);
    const due = await decideSoak({ soak, subjects, environment: "dev", now: at(2), read: fake().read });
    expect(due).toMatchObject({ outcome: "release", via: "soaked", clockStart: T0, due: at(2).toISOString() });
  });

  test("a restart check is read on every run, fails the soak, and starts the clock over once it passes again", async () => {
    const soak: Soak = { duration: "2h", checks: [http("up")] };
    const f = fake({ up: "failed" });
    const failing = await decideSoak({ soak, subjects, environment: "dev", now: at(3), read: f.read });
    expect(f.asked).toEqual(["up"]);
    expect(failing.outcome).toBe("hold");
    expect(failing.holds).toMatchObject([{ reason: "check", check: "up", onFail: "restart", status: "failed" }]);
    expect(failing.state.failing).toEqual(["up"]);
    // The next run finds it passing: the clock starts over there.
    const again = await decideSoak({ soak, subjects, environment: "dev", now: at(4), state: failing.state, read: fake().read });
    expect(again).toMatchObject({ outcome: "hold", clockStart: at(4).toISOString(), due: at(6).toISOString() });
    expect(again.state.restartedAt).toBe(at(4).toISOString());
    const later = await decideSoak({ soak, subjects, environment: "dev", now: at(6), state: again.state, read: fake().read });
    expect(later).toMatchObject({ outcome: "release", clockStart: at(4).toISOString() });
  });

  test("a hold check is read once the time is up, keeps the elapsed time, and releases when it passes", async () => {
    const soak: Soak = { duration: "2h", checks: [http("up", "hold")] };
    const f = fake({ up: "failed" });
    expect((await decideSoak({ soak, subjects, environment: "dev", now: at(1), read: f.read })).holds.map((h) => h.reason)).toEqual(["time"]);
    expect(f.asked).toEqual([]);
    const held = await decideSoak({ soak, subjects, environment: "dev", now: at(3), read: f.read });
    expect(held.holds).toMatchObject([{ reason: "check", onFail: "hold" }]);
    const passed = await decideSoak({ soak, subjects, environment: "dev", now: at(4), state: held.state, read: fake().read });
    expect(passed).toMatchObject({ outcome: "release", clockStart: T0 });
  });

  test("unknown holds, as does an apply with no time; a person's end releases whatever else is true", async () => {
    const soak: Soak = { duration: "0", checks: [http("up")] };
    expect((await decideSoak({ soak, subjects, environment: "dev", now: at(1), read: fake({ up: "unknown" }).read })).holds).toMatchObject([{ reason: "check", status: "unknown" }]);
    expect((await decideSoak({ soak, subjects: [{ member: "app", targets: ["app"] }], environment: "dev", now: at(1), read: fake().read })).holds).toEqual([{ reason: "clock-unknown", members: ["app"] }]);
    const ended = await decideSoak({ soak, subjects: [], environment: "dev", now: at(1), ended: { by: "dana" }, read: fake({ up: "failed" }).read });
    expect(ended).toMatchObject({ outcome: "release", via: "ended", endedBy: { by: "dana" } });
  });

  test("overrides by member glob: the first that names a member decides, and the longest duration is due", async () => {
    const soak: Soak = { duration: "1h", overrides: [{ members: ["payments/**"], duration: "3h" }] };
    expect(soakRuleFor(soak, ["payments/api"]).duration).toBe("3h");
    expect(soakRuleFor(soak, ["web"]).duration).toBe("1h");
    const d = await decideSoak({ soak, subjects: [{ member: "web", targets: ["web"], appliedAt: T0 }, { member: "payments/api", targets: ["payments/api"], appliedAt: T0 }], environment: "dev", now: at(2), read: fake().read });
    expect(d).toMatchObject({ outcome: "hold", due: at(3).toISOString() });
  });

  test("durations, globs, names and spans", () => {
    expect([soakDurationMs("30m"), soakDurationMs("2h"), soakDurationMs("1d"), soakDurationMs("0"), soakDurationMs("1w")]).toEqual([1_800_000, 7_200_000, 86_400_000, 0, undefined]);
    expect(soakGlobMatch("a/*", "a/b")).toBe(true);
    expect(soakGlobMatch("a/*", "a/b/c")).toBe(false);
    expect(soakGlobMatch("a/**/c", "a/c")).toBe(true);
    expect(soakCheckName({ kind: "drift" })).toBe("drift");
    expect(soakCheckName(http("x"))).toBe("x");
    expect(soakCheckName({ kind: "http", url: "https://a" })).toMatch(/^http-[0-9a-f]{8}$/);
    expect(soakSpan(3 * 86_400_000 + 3_600_000)).toBe("3d 1h");
    expect(soakSpan(125 * 60_000)).toBe("2h 5m");
  });
});

describe("the check readers", () => {
  const ctx = { environment: "dev", targets: ["app"], since: T0, now: at(1) };
  test("http, prometheus, cloudwatch and command", async () => {
    const read = soakCheckReader({
      fetch: async (url) => (url.includes("/api/v1/query") ? { status: 200, text: async () => JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ value: [0, url.includes("bad") ? "9" : "0.5"] }] } }) } : { status: url.includes("down") ? 503 : 200, text: async () => "ok" }),
      exec: (argv) => (argv[0] === "aws" ? { status: 0, stdout: JSON.stringify({ MetricAlarms: [{ StateValue: argv.includes("hot") ? "ALARM" : "OK" }] }), stderr: "" } : { status: argv[0] === "true" ? 0 : 2, stdout: "", stderr: "boom" }),
    });
    expect((await read({ kind: "http", url: "https://a/up", body: "^ok$" }, ctx)).status).toBe("passed");
    expect((await read({ kind: "http", url: "https://a/down" }, ctx)).status).toBe("failed");
    expect((await read({ kind: "prometheus", url: "https://p", query: "good", max: 1 }, ctx)).status).toBe("passed");
    expect((await read({ kind: "prometheus", url: "https://p", query: "bad", max: 1 }, ctx)).status).toBe("failed");
    expect((await read({ kind: "cloudwatch-alarm", alarm: "ok" }, ctx)).status).toBe("passed");
    expect((await read({ kind: "cloudwatch-alarm", alarm: "hot" }, ctx)).status).toBe("failed");
    expect((await read({ kind: "command", command: ["true"] }, ctx)).status).toBe("passed");
    expect((await read({ kind: "command", command: ["false"] }, ctx))).toMatchObject({ status: "failed", detail: "false exited 2: boom" });
    // A source not given is unknown.
    expect((await soakCheckReader({})({ kind: "drift" }, ctx)).status).toBe("unknown");
  });

  test("health: unknown never passes, and covers scopes the check", () => {
    const doc = { schema: "chant-health/v1", lexicons: { aws: { entities: { svc: { type: "AWS::ECS::Service", state: "healthy" }, bucket: { type: "aws_s3_bucket", state: "unknown" } }, unobserved: {}, absent: [] } } };
    expect(healthVerdict(doc).status).toBe("unknown");
    expect(healthVerdict(doc, ["AWS::ECS::Service"]).status).toBe("passed");
    expect(healthVerdict(doc, ["nothing-*"]).status).toBe("unknown");
    expect(healthVerdict({ ...doc, lexicons: { aws: { entities: { svc: { type: "x", state: "unhealthy" } } } } }).status).toBe("failed");
  });

  test("applies and denials from op wave run records", async () => {
    const record = (ended: string, applied: string[], failed: string[], denied?: string): OpRunRecord =>
      ({ version: 1, id: ended, op: "shop-dev", env: "dev", started: ended, ended, status: "ok", phases: [], wave: { spec: "shop-dev", number: 1, name: "w", job: "wave", exitCode: 0, applied, failed, moved: [], ...(denied ? { plans: { [denied]: { planDigest: "sha256:x", policy: [{ source: "ci.policy", result: "denied", rules: ["r1"] }] } } } : {}) } }) as unknown as OpRunRecord;
    const src = runRecordSoakSources([record(at(2).toISOString(), ["app"], []), record(at(1).toISOString(), [], ["app"], "app")]);
    expect(await src.applies!("dev", undefined, ["app"])).toEqual({ app: "success" });
    expect(await src.denials!("dev", undefined, ["app"])).toEqual([{ target: "app", at: at(1).toISOString(), rules: ["r1"] }]);
  });
});

describe("the soak at a gate", () => {
  const soak: Soak = { duration: "2h", checks: [http("up")] };
  const base = { op: "shop", gate: "dev-soak", soak, stage: "dev", holds: "stage prod", to: "prod", digest: "sha256:" + "a".repeat(64), subjects };

  test("holds with exit 3, records the soak on its pending fact, and the next run reads it back", async () => {
    const port = memoryGateLedgerPort();
    const sent: NotifyEvent[] = [];
    const notify = { config: { webhook: "HOOK" }, source: "chant", send: async (_c: unknown, e: NotifyEvent) => void sent.push(e) };
    const first = await soakAtGate({ ...base, port, read: fake({ up: "failed" }).read, now: at(1), notify });
    expect(first).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-soak-waiting" });
    expect(port.appended).toHaveLength(1);
    expect(port.appended[0]!.soak).toMatchObject({ stage: "dev", to: "prod", clockStart: T0, due: at(2).toISOString(), leftMs: 3_600_000, failing: ["up"] });
    expect(sent.map((e) => e.event)).toEqual(["soak"]);
    // Still failing: no second notice.
    await soakAtGate({ ...base, port, read: fake({ up: "failed" }).read, now: at(1.5), notify });
    expect(sent).toHaveLength(1);
    // Passing again: the clock starts over, recorded on a fresh fact.
    const again = await soakAtGate({ ...base, port, read: fake().read, now: at(3), notify });
    expect(again.passed).toBe(false);
    expect(port.appended.at(-1)!.soak).toMatchObject({ restartedAt: at(3).toISOString(), due: at(5).toISOString() });
    expect((await soakAtGate({ ...base, port, read: fake().read, now: at(5) })).passed).toBe(true);
  });

  test("a person ends it early through its gate, and the ledger records who", async () => {
    const port = memoryGateLedgerPort();
    await soakAtGate({ ...base, port, read: fake().read, now: at(1) });
    await port.appendResolution!({ op: "shop", gate: "dev-soak", resolvedBy: "dana", timestamp: at(1.1).toISOString(), planDigest: base.digest, environment: "dev" } as never);
    const ended = await soakAtGate({ ...base, port, read: fake({ up: "failed" }).read, now: at(1.2) });
    expect(ended).toMatchObject({ passed: true, lines: ["the soak of dev was ended early by dana through shop dev-soak"] });
    expect(port.applied).toMatchObject([{ gate: "dev-soak", approvedBy: "dana" }]);
  });

  test("an urgent promote waits on an unfinished soak, until a person ends it through its gate (#5355)", async () => {
    const spec = asPipelineSpec({
      name: "shop",
      stages: [
        { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], soak },
        { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], gate: { urgent: { role: "oncall" } } },
      ],
    });
    const port = memoryGateLedgerPort();
    // The urgent rule's approval stands, and the soak still holds: it is no gate the urgent path stands in for.
    await port.appendResolution!({ op: "shop", gate: "prod-urgent", resolvedBy: "oncall-1", timestamp: at(0.5).toISOString(), planDigest: base.digest, environment: "prod" } as never);
    const promote = () => pipelinePromoteSoak({ spec, from: "dev", to: "prod", items: [{ component: "app", source: { timestamp: T0 } }], digest: base.digest, port, read: fake().read, now: at(1) });
    expect(await promote()).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-soak-waiting" });
    await port.appendResolution!({ op: "shop", gate: "dev-soak", resolvedBy: "dana", timestamp: at(1.1).toISOString(), planDigest: base.digest, environment: "dev" } as never);
    expect(await promote()).toMatchObject({ passed: true, lines: ["the soak of dev was ended early by dana through shop dev-soak"] });
  });

  test("a rejection is read before the soak, so a rejected release records no soak fact (#5354)", async () => {
    const { pipelinePromoteRejected } = await import("./promote");
    const spec = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], soak }, { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }] }] });
    const port = { ...memoryGateLedgerPort(), readRejections: async () => [{ version: 1, kind: "rejection", op: "shop", gate: "prod", planDigest: base.digest, environment: "prod", rejectedBy: "erin", reason: "breaks checkout", timestamp: at(0.5).toISOString() }] } as never;
    const got = await pipelinePromoteRejected({ spec, to: "prod", skipped: [], digest: base.digest, port });
    expect(got).toMatchObject({ exitCode: 8, code: "pipeline-release-rejected" });
    expect(await pipelinePromoteRejected({ spec, to: "prod", skipped: [], digest: base.digest, port: memoryGateLedgerPort() })).toBeUndefined();
  });

  test("a promote reads the soak of the stage it promotes from", async () => {
    const spec = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], soak }, { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }] }] });
    const got = await pipelinePromoteSoak({ spec, from: "dev", to: "prod", items: [{ component: "app", source: { timestamp: T0 } }], digest: base.digest, port: memoryGateLedgerPort(), read: fake().read, now: at(1) });
    expect(got).toMatchObject({ passed: false, exitCode: 3 });
    expect((await pipelinePromoteSoak({ spec, from: "prod", to: "x", items: [], digest: base.digest, port: memoryGateLedgerPort(), read: fake().read, now: at(1) })).passed).toBe(true);
  });
});

describe("a wave's soak", () => {
  const spec = { name: "roll", op: "roll", labels: { Env: "dev" }, waves: [{ name: "a", runs: [{ target: "a" }], soak: { duration: "1h" } }, { name: "b", runs: [{ target: "b" }] }] } as unknown as OpWavesSpec;
  test("holds the next wave from the wave's newest run, and passes once soaked", async () => {
    const applied = async () => ({ subjects: [{ member: "a", targets: ["a"], appliedAt: T0 }], digest: "sha256:" + "b".repeat(64) });
    const port = memoryGateLedgerPort();
    const lines: string[] = [];
    const held = await opWaveSoakStop({ spec, k: 2, cwd: ".", gates: port, soak: { applied, read: fake().read, now: at(0.5) }, log: (l) => lines.push(l) });
    expect(held).toMatchObject({ passed: false, exitCode: 3 });
    expect(port.appended[0]).toMatchObject({ gate: "roll-wave-1-soak", soak: { wave: 1 } });
    expect(await opWaveSoakStop({ spec, k: 2, cwd: ".", gates: port, soak: { applied, read: fake().read, now: at(1) }, log: () => {} })).toBeUndefined();
    expect(await opWaveSoakStop({ spec, k: 1, cwd: ".", gates: port, soak: { applied, read: fake().read, now: at(0) }, log: () => {} })).toBeUndefined();
  });

  test("the run ledger gives the wave's applied targets at the record's end", () => {
    const r = { ended: T0, wave: { spec: "roll", number: 1, applied: ["a"], failed: [], exitCode: 0, digest: "sha256:d" } } as unknown as OpRunRecord;
    expect(waveSoakAppliedFrom([r], spec, 1)).toEqual({ subjects: [{ member: "a", targets: ["a"], appliedAt: T0 }], digest: "sha256:d" });
    expect(waveSoakAppliedFrom([r], spec, 2)).toBeNull();
  });
});

describe("declaring a soak", () => {
  const stage = (extra: Record<string, unknown> = {}) => ({ name: "dev", waves: [{ name: "a", runs: [{ target: "a" }] }, { name: "b", runs: [{ target: "b" }] }], ...extra });
  test("a stage and a wave take soak; bad ones are refused with a line each", () => {
    expect(pipelineSpecProblems({ name: "p", stages: [stage({ soak: { duration: "1h", checks: [{ kind: "drift", onFail: "hold" }] } })] })).toEqual([]);
    expect(pipelineSpecProblems({ name: "p", stages: [{ ...stage(), waves: [{ name: "a", runs: [], soak: { duration: "1h" } }, { name: "b", runs: [] }] }] })).toEqual([]);
    expect(pipelineSpecProblems({ name: "p", stages: [{ ...stage(), waves: [{ name: "a", runs: [] }, { name: "b", runs: [], soak: { duration: "1h" } }] }] }).join()).toContain("last wave");
    expect(soakProblems({ duration: "1w", checks: [{ kind: "ping" }, { kind: "http", url: "ftp://x", onFail: "later" }] }, "s")).toEqual([
      "s.soak.duration must be a duration in minutes, hours or days, such as 24h, or 0",
      's.soak.checks[0] must be a check: { "kind": drift, apply, policy, http, prometheus, cloudwatch-alarm, command, health, ... }',
      "s.soak.checks[1].onFail is restart or hold",
      "s.soak.checks[1].url must be an http or https URL",
    ]);
    expect(pipelineSpecProblems({ name: "p", stages: [stage()], recheck: { schedule: "hourly" } }).join()).toContain("recheck.schedule");
  });

  test("a product's config maps onto it, and nothing soaks by default", () => {
    const waves = { dev: [{ name: "dev", runs: [{ target: "dev" }] }], prod: [{ name: "prod", runs: [{ target: "prod" }] }] };
    const plain = pipelineFromConfig({ name: "shop", promotion: ["dev", "prod"], waves });
    expect(plain.stages.some((s) => s.soak) || plain.recheck).toBeFalsy();
    const d = pipelineFromConfig({ name: "shop", promotion: ["dev", "prod"], waves, recheck: { schedule: "0 * * * *" }, environments: { dev: { soak: { duration: "24h", checks: [{ kind: "http", url: "https://x", on_fail: "hold", timeout_seconds: 5 }] } } } });
    expect(d.stages[0]!.soak).toEqual({ duration: "24h", checks: [{ kind: "http", url: "https://x", onFail: "hold", timeoutSeconds: 5 }] });
    expect(d.recheck).toEqual({ schedule: "0 * * * *" });
  });

  test("the plan note names every soak a change passes through", () => {
    const spec = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: [{ name: "a", runs: [], soak: { duration: "1h" } }, { name: "b", runs: [] }], soak: { duration: "24h", checks: [{ kind: "drift" }] } }, { name: "prod", waves: [{ name: "p", runs: [] }] }] }) as PipelineSpec;
    const section = pipelineSoakSection(spec)!;
    expect(section).toContain("### Soak");
    expect(section).toContain("wave `b` waits for wave `a` to soak: 1h");
    expect(section).toContain("A promotion from `dev` into `prod` waits for `dev` to soak: 24h, while drift (restart) passes");
    expect(pipelineSoakSection({ ...spec, stages: spec.stages.map((s) => ({ name: s.name, waves: [{ name: "w", runs: [] }] })) })).toBeUndefined();
  });
});
