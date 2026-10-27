import { describe, expect, test } from "vitest";
import { opWaveRunRecord, type RunOpWaveResult } from "./op-waves-run";
import type { OpWavesSpec } from "./op-waves";

const spec = { name: "tf-apply", op: "apply", plan: ["plan", "{plan}"], labels: { Env: "prod", Team: "infra" }, waves: [{ name: "network", runs: [{ target: "vpc" }, { target: "dns" }] }] } as unknown as OpWavesSpec;
const times = { started: "2026-10-27T10:00:00Z", ended: "2026-10-27T10:05:00Z" };
const base: RunOpWaveResult = { exitCode: 0, applied: [], failed: [], moved: [], hooks: [] };

describe("an op wave job's run record (#4551)", () => {
  test("goes under labels.Env with one step per run target", () => {
    const r = opWaveRunRecord({ spec, wave: 1 }, times, { result: { ...base, applied: ["vpc"], failed: ["dns"], exitCode: 1 } });
    expect(r).toMatchObject({ op: "tf-apply", env: "prod", labels: { Env: "prod", Team: "infra" }, status: "fail", failure: { code: "command-failed", exitCode: 1 } });
    expect(r.phases).toEqual([{ name: "wave-1", status: "fail", steps: [{ fn: "vpc", status: "ok", durationMs: 0 }, { fn: "dns", status: "fail", durationMs: 0 }] }]);
    expect(r.wave).toMatchObject({ spec: "tf-apply", number: 1, name: "network", job: "wave", exitCode: 1, applied: ["vpc"], failed: ["dns"] });
  });

  test("reads each exit code by the table", () => {
    const status = (exitCode: number) => opWaveRunRecord({ spec, wave: 1, share: 2 }, times, { result: { ...base, exitCode } });
    expect(status(0).status).toBe("ok");
    expect(status(5)).toMatchObject({ status: "ok" });
    expect(status(4)).toMatchObject({ status: "fail", failure: { code: "moved" } });
    expect(status(7)).toMatchObject({ status: "fail", failure: { code: "denied" } });
    expect(status(8)).toMatchObject({ status: "fail", failure: { code: "point-refused" } });
    expect(status(4).wave).toMatchObject({ job: "share", share: 2 });
  });

  test("a job that threw is a failed record with the error, and a spec with no Env goes under local", () => {
    const r = opWaveRunRecord({ spec: { ...spec, labels: undefined } as OpWavesSpec, wave: 1, decide: true }, times, { error: new Error("plans file unreadable") });
    expect(r).toMatchObject({ env: "local", status: "fail", failure: { code: "command-failed", reason: "plans file unreadable" } });
    expect(r.wave).toMatchObject({ job: "decide", exitCode: 1 });
  });
});
