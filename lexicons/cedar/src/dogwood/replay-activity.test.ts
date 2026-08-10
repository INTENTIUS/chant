/**
 * The replay activity and the PolicyReplayOp composite (#1661).
 *
 * Everything here injects a runner, per the epic's rule that nothing in gating
 * CI executes the dogwood binary — including on a machine that happens to have
 * one, which is why the binary is forced rather than resolved. The bundle
 * under test is the shipped `examples/policy-replay` build output, so the
 * example and the surface cannot drift apart: if the example stops emitting a
 * `.dw` file, this fails.
 *
 * The recorded verdicts (`@0 DENY`, `@10 ALLOW [rules: 0]`, `@7200 DENY`,
 * exit 0) are the ones the #1657 verification observed from a real run against
 * `dogwood-docs/examples/read_after_login`.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { cedarSerializer } from "../serializer";
import { configureDogwoodCli, findDogwoodBinary, resetDogwoodCli, type DogwoodRun } from "./cli";
import {
  compareVerdicts,
  dogwoodReplay,
  dogwoodReplayReport,
  renderReplaySummary,
  resolveReplayInputs,
} from "./replay-activity";
import { PolicyReplayOp, dogwoodReplayStep } from "./replay-op";
import { renderTrace } from "./trace";
import {
  readAfterLoginExpectations,
  readAfterLoginTrace,
} from "../../examples/policy-replay/trace/read-after-login";

const EXAMPLE = join(fileURLToPath(new URL("../..", import.meta.url)), "examples/policy-replay");
const TRACE_TEXT = readFileSync(join(EXAMPLE, "trace/read-after-login.log"), "utf-8");
const ACTION_SCHEMA = readFileSync(join(EXAMPLE, "schema.cedarschema"), "utf-8");

afterEach(() => resetDogwoodCli());

/** The example's own emitted artifacts — built, not transcribed. */
async function exampleArtifacts(): Promise<Record<string, string>> {
  const result = await build(join(EXAMPLE, "src"), [cedarSerializer]);
  expect(result.errors).toEqual([]);
  const output = result.outputs.get("cedar") as SerializerResult;
  return output.files ?? {};
}

/** The verdict stream #1657 recorded for this bundle. */
const RECORDED = {
  verdicts: [
    { index: 0, timestamp: 0, verdict: "deny", determining_rules: [], errors: [] },
    { index: 1, timestamp: 10, verdict: "allow", determining_rules: [0], errors: [] },
    { index: 2, timestamp: 7200, verdict: "deny", determining_rules: [], errors: [] },
  ],
};

function runOf(over: Partial<DogwoodRun>): DogwoodRun {
  return { status: 0, stdout: "", stderr: "", ...over };
}

/** A runner that answers with `body` and records what it was asked. */
function fakeRunner(body: unknown, status = 0) {
  const calls: Array<{ args: string[]; files: Record<string, string> }> = [];
  const runner = (_binary: string, args: string[]): DogwoodRun => {
    // The bundle files exist for the duration of the call and are removed in
    // `runBundle`'s finally, so reading them has to happen here.
    const files: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--") && args[i + 1] && existsSync(args[i + 1])) {
        files[args[i]] = readFileSync(args[i + 1], "utf-8");
      }
    }
    if (existsSync(args[1])) files.policies = readFileSync(args[1], "utf-8");
    calls.push({ args, files });
    return runOf({ status, stdout: typeof body === "string" ? body : JSON.stringify(body) });
  };
  return { runner, calls };
}

async function replayExample(over: Record<string, unknown> = {}, body: unknown = RECORDED, status = 0) {
  const files = await exampleArtifacts();
  const { runner, calls } = fakeRunner(body, status);
  configureDogwoodCli({ binary: "/nonexistent/dogwood", runner });
  const report = await dogwoodReplay({
    policies: files["policies.dw"],
    policySchema: ACTION_SCHEMA,
    eventSchema: files["events.dwschema"],
    trace: TRACE_TEXT,
    expect: readAfterLoginExpectations,
    ...over,
  });
  return { report, calls, files };
}

// ── The fixture is what the builder renders ────────────────────────

describe("the checked-in trace fixture", () => {
  test("is byte-for-byte what the typed builder produces", () => {
    expect(renderTrace(readAfterLoginTrace)).toBe(TRACE_TEXT);
  });

  test("has four lines and three decision points", () => {
    expect(TRACE_TEXT.trim().split("\n")).toHaveLength(4);
    // `Login::response` is history-only, so the expectations are three, and
    // they are written against timestamps for exactly that reason.
    expect(readAfterLoginExpectations).toHaveLength(3);
    expect(readAfterLoginExpectations.every((e) => e.timestamp !== undefined)).toBe(true);
  });
});

// ── Invocation ─────────────────────────────────────────────────────

describe("dogwoodReplay — the invocation", () => {
  test("runs `replay` with the trace and asks for JSON", async () => {
    const { calls } = await replayExample();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.args[0]).toBe("replay");
    expect(call.args).toContain("--policy-schema");
    expect(call.args).toContain("--event-schema");
    expect(call.args).toContain("--trace");
    expect(call.args.slice(-2)).toEqual(["--format", "json"]);
    // No `--emit`: it is ignored under `--format json`.
    expect(call.args).not.toContain("--emit");
  });

  test("hands the CLI the example's own emitted policy set and the trace text", async () => {
    const { calls, files } = await replayExample();
    expect(calls[0].files.policies).toBe(files["policies.dw"]);
    expect(calls[0].files["--trace"]).toBe(TRACE_TEXT);
    expect(calls[0].files["--policy-schema"]).toBe(ACTION_SCHEMA);
  });

  test("typed events are rendered and audited on the way in", async () => {
    const { calls, report } = await replayExample({ trace: undefined, traceEvents: readAfterLoginTrace });
    expect(calls[0].files["--trace"]).toBe(TRACE_TEXT);
    expect(report.traceIssues).toEqual([]);
  });

  test("a trace that populates one bag is reported, not swallowed", async () => {
    const weakened = readAfterLoginTrace.map((event) =>
      event.kind === "request" ? { ...event, requestContext: undefined } : event,
    );
    const { report } = await replayExample({ trace: undefined, traceEvents: weakened });
    // The replay still ran and still returned verdicts — that is the trap.
    expect(report.verdicts).toHaveLength(3);
    expect(report.traceIssues.map((i) => i.kind)).toContain("no-request-context");
    expect(report.summary).toMatch(/Trace weaknesses/);
  });

  test("optional service-schema flags are omitted when not supplied", async () => {
    const files = await exampleArtifacts();
    const { runner, calls } = fakeRunner(RECORDED);
    configureDogwoodCli({ binary: "/nonexistent/dogwood", runner });
    await dogwoodReplay({
      policies: files["policies.dw"],
      policySchema: ACTION_SCHEMA,
      trace: TRACE_TEXT,
    });
    expect(calls[0].args).not.toContain("--event-schema");
    expect(calls[0].args).not.toContain("--macros");
    expect(calls[0].args).not.toContain("--providers");
  });

  test("reads artifacts from paths as readily as inline", async () => {
    const resolved = await resolveReplayInputs({
      cwd: EXAMPLE,
      policies: "permit(principal, action, resource);",
      policySchemaPath: "schema.cedarschema",
      tracePath: "trace/read-after-login.log",
    });
    expect(resolved.bundle.policySchema).toBe(ACTION_SCHEMA);
    expect(resolved.trace).toBe(TRACE_TEXT);
  });

  test("names the missing artifact rather than failing at the CLI", async () => {
    await expect(resolveReplayInputs({ policies: "x", trace: "y" })).rejects.toThrow(
      /--policy-schema` is not optional/,
    );
    await expect(resolveReplayInputs({ policies: "x", policySchema: "y" })).rejects.toThrow(/no trace/);
  });
});

// ── Verdicts ───────────────────────────────────────────────────────

describe("dogwoodReplay — verdicts", () => {
  test("the recorded stream matches the declared expectations", async () => {
    const { report } = await replayExample();
    expect(report.ok).toBe(true);
    expect(report.findings).toBe(0);
    expect(report.verdicts.map((v) => v.verdict)).toEqual(["deny", "allow", "deny"]);
    expect(report.summary).toMatch(/3 decision point\(s\) replayed; 0 divergence/);
  });

  test("an all-DENY stream at exit 0 is a result, not a failure", async () => {
    // Upstream exits 0 even when every verdict is DENY; a nonzero exit means
    // the trace or the policy set failed to load. Reading the exit code as a
    // verdict would report a working deny-by-default set as broken.
    const allDeny = {
      verdicts: RECORDED.verdicts.map((v) => ({ ...v, verdict: "deny", determining_rules: [] })),
    };
    const { report } = await replayExample({ expect: [] }, allDeny);
    expect(report.ok).toBe(true);
    expect(report.verdicts.every((v) => v.verdict === "deny")).toBe(true);
  });

  test("a nonzero exit carrying a verdict report is still read — the JSON decides", async () => {
    const { report } = await replayExample({}, RECORDED, 2);
    expect(report.findings).toBe(0);
  });

  test("a flipped verdict is a divergence naming both sides", async () => {
    const flipped = {
      verdicts: RECORDED.verdicts.map((v) => (v.timestamp === 10 ? { ...v, verdict: "deny" } : v)),
    };
    const { report } = await replayExample({}, flipped);
    expect(report.ok).toBe(false);
    expect(report.findings).toBe(1);
    const [divergence] = report.divergences;
    expect(divergence).toMatchObject({ timestamp: 10, expected: "allow", actual: "deny" });
    expect(report.summary).toMatch(/\| @10 \|/);
  });

  test("the right verdict for the wrong reason is a divergence too", async () => {
    const otherRule = {
      verdicts: RECORDED.verdicts.map((v) => (v.timestamp === 10 ? { ...v, determining_rules: [3] } : v)),
    };
    const { report } = await replayExample({}, otherRule);
    expect(report.findings).toBe(1);
    expect(report.divergences[0].detail).toMatch(/right for a different reason/);
  });

  test("an expected decision point that never happened is a divergence", async () => {
    const short = { verdicts: RECORDED.verdicts.slice(0, 2) };
    const { report } = await replayExample({}, short);
    expect(report.divergences.map((d) => d.timestamp)).toContain(7200);
    expect(report.divergences[report.divergences.length - 1].detail).toMatch(/no decision point at @7200/);
  });

  test("a decision point nothing expected is a divergence — new decisions are drift", async () => {
    const extra = {
      verdicts: [
        ...RECORDED.verdicts,
        { index: 3, timestamp: 9000, verdict: "allow", determining_rules: [0], errors: [] },
      ],
    };
    const { report } = await replayExample({}, extra);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0].detail).toMatch(/unexpected decision point/);
  });

  test("a per-evaluation error is a divergence even when the verdict is right", async () => {
    const errored = {
      verdicts: RECORDED.verdicts.map((v) =>
        v.timestamp === 10 ? { ...v, errors: ["rhai implementation has no script"] } : v,
      ),
    };
    const { report } = await replayExample({}, errored);
    expect(report.findings).toBe(1);
    expect(report.divergences[0].errors).toEqual(["rhai implementation has no script"]);
  });

  test("…and with no expectations at all, an error is still reported", async () => {
    const errored = {
      verdicts: [{ ...RECORDED.verdicts[0], errors: ["provider Risk::score failed"] }],
    };
    const { report } = await replayExample({ expect: [] }, errored);
    expect(report.findings).toBe(1);
  });
});

describe("compareVerdicts", () => {
  const verdicts = [
    { index: 0, timestamp: 5, verdict: "allow" as const, determiningRules: [0], errors: [] },
    { index: 1, timestamp: 5, verdict: "deny" as const, determiningRules: [], errors: [] },
  ];

  test("two expectations at the same timestamp address the first and second decision", () => {
    expect(
      compareVerdicts(verdicts, [
        { timestamp: 5, verdict: "allow" },
        { timestamp: 5, verdict: "deny" },
      ]),
    ).toEqual([]);
  });

  test("an index expectation addresses the decision stream, not the trace line", () => {
    expect(compareVerdicts(verdicts, [{ index: 1, verdict: "deny" }])).toHaveLength(1);
    expect(compareVerdicts(verdicts, [{ index: 1, verdict: "deny" }])[0].detail).toMatch(
      /unexpected decision point/,
    );
  });

  test("an expectation with neither a timestamp nor an index is a caller error", () => {
    expect(() => compareVerdicts(verdicts, [{ verdict: "allow" }])).toThrow(/needs a `timestamp` or an `index`/);
  });
});

// ── A run that did not happen ──────────────────────────────────────

describe("dogwoodReplay — a run that could not happen", () => {
  test("no JSON on stdout throws instead of reporting zero divergences", async () => {
    await expect(replayExample({}, "")).rejects.toThrow(/without JSON on stdout/);
  });

  test("a fatal — a malformed trace line — throws with upstream's message", async () => {
    const fatal = {
      severity: "error",
      message: "trace parse: line 1: timepoint must start with `@`",
      spanned: false,
    };
    await expect(replayExample({}, fatal, 2)).rejects.toThrow(/timepoint must start with/);
  });

  test("no binary is a failure that says where chant looked", async () => {
    configureDogwoodCli({ binary: null });
    await expect(
      dogwoodReplay({ policies: "x", policySchema: "y", trace: "z" }),
    ).rejects.toThrow(/CHANT_DOGWOOD_BINARY/);
  });
});

// ── The report phase ───────────────────────────────────────────────

describe("dogwoodReplayReport", () => {
  test("the Replay phase writes the report the Report phase reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chant-replay-"));
    try {
      await replayExample({ reportPath: join(dir, "nested/report.json") });
      const written = JSON.parse(await readFile(join(dir, "nested/report.json"), "utf-8")) as {
        findings: number;
      };
      expect(written.findings).toBe(0);

      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const dispatch = await dogwoodReplayReport({ reportPath: join(dir, "nested/report.json") });
      expect(dispatch.mode).toBe("report");
      expect(dispatch.actionable).toBe(false);
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("issue and pull-request modes render a body and open nothing", async () => {
    const { report } = await replayExample({ mode: "issue" }, {
      verdicts: RECORDED.verdicts.map((v) => (v.timestamp === 10 ? { ...v, verdict: "deny" } : v)),
    });
    const dispatch = await dogwoodReplayReport({ report, title: "Policy replay diverged" });
    expect(dispatch.mode).toBe("issue");
    expect(dispatch.actionable).toBe(true);
    expect(dispatch.title).toBe("Policy replay diverged");
    expect(dispatch.body).toContain("## Policy replay");
  });

  test("failOnDivergence turns a finding into a failed step", async () => {
    const { report } = await replayExample({}, {
      verdicts: RECORDED.verdicts.map((v) => (v.timestamp === 10 ? { ...v, verdict: "deny" } : v)),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(dogwoodReplayReport({ report, failOnDivergence: true })).rejects.toThrow(
      /1 divergence/,
    );
    log.mockRestore();
  });

  test("a Report phase with no written report says so, rather than reporting clean", async () => {
    await expect(dogwoodReplayReport({ reportPath: "/nonexistent/report.json" })).rejects.toThrow(
      /has nothing to report on/,
    );
  });

  test("the clean summary says what was replayed", () => {
    const summary = renderReplaySummary({
      ok: true,
      mode: "report",
      verdicts: [],
      divergences: [],
      findings: 0,
      traceIssues: [],
    });
    expect(summary).toMatch(/replayed to the verdict it was expected to reach/);
  });
});

// ── The composite ──────────────────────────────────────────────────

describe("PolicyReplayOp", () => {
  function phasesOf(op: unknown) {
    return (op as { props: { phases: Array<{ name: string; steps: Array<Record<string, unknown>> }> } })
      .props.phases;
  }

  test("assembles gather → replay → report", () => {
    const { op } = PolicyReplayOp({ name: "policy-replay", tracePath: "trace/t.log" });
    expect(phasesOf(op).map((p) => p.name)).toEqual(["Artifacts", "Replay", "Report"]);
  });

  test("the phases resolve the activities by name, the flyApply way", () => {
    const { op } = PolicyReplayOp({ name: "policy-replay", tracePath: "trace/t.log" });
    const [artifacts, replay, report] = phasesOf(op);
    expect(artifacts.steps[0].fn).toBe("chantBuild");
    expect(replay.steps[0].fn).toBe("dogwoodReplay");
    expect(report.steps[0].fn).toBe("dogwoodReplayReport");
  });

  test("the divergence count rides out as a search attribute", () => {
    const { op } = PolicyReplayOp({ name: "policy-replay", tracePath: "trace/t.log" });
    expect(phasesOf(op)[1].steps[0].outcomeAttribute).toEqual({ name: "Divergences", from: "findings" });
  });

  test("checked-in artifacts drop the Artifacts phase rather than run it empty", () => {
    const { op } = PolicyReplayOp({ name: "r", tracePath: "t.log", buildScript: false });
    expect(phasesOf(op).map((p) => p.name)).toEqual(["Replay", "Report"]);
  });

  test("the finding mode reaches both the replay and the report", () => {
    const { op } = PolicyReplayOp({ name: "r", tracePath: "t.log", onFinding: "pull-request" });
    const [, replay, report] = phasesOf(op);
    expect((replay.steps[0].args as Record<string, unknown>).mode).toBe("pull-request");
    expect((report.steps[0].args as Record<string, unknown>).mode).toBe("pull-request");
  });

  test("the report file is the seam between the two phases", () => {
    const { op } = PolicyReplayOp({ name: "r", tracePath: "t.log", reportPath: "dist/r.json" });
    const [, replay, report] = phasesOf(op);
    expect((replay.steps[0].args as Record<string, unknown>).reportPath).toBe("dist/r.json");
    expect((report.steps[0].args as Record<string, unknown>).reportPath).toBe("dist/r.json");
  });

  test("the step builder carries the policyCheck profile by default", () => {
    expect(dogwoodReplayStep({ tracePath: "t.log" }).profile).toBe("policyCheck");
    expect(dogwoodReplayStep({ tracePath: "t.log", profile: "longInfra" }).profile).toBe("longInfra");
  });

  test("the example's Op is the composite, wired to the shipped fixture", async () => {
    const mod = (await import("../../examples/policy-replay/ops/policy-replay.op")) as {
      default: unknown;
    };
    const [, replay] = phasesOf(mod.default);
    const args = replay.steps[0].args as Record<string, unknown>;
    expect(args.tracePath).toBe("trace/read-after-login.log");
    expect(args.expect).toEqual(readAfterLoginExpectations);
  });
});

// ── Opt-in: a real binary ──────────────────────────────────────────

/**
 * Runs only when `CHANT_DOGWOOD_E2E=1` *and* a binary resolves. Never gates —
 * the epic's rule is that nothing in gating CI executes the dogwood binary.
 * This is where someone who has built one confirms the recorded verdicts are
 * still what the real thing produces after an upstream sync.
 */
const haveRealBinary = process.env.CHANT_DOGWOOD_E2E === "1" && findDogwoodBinary() !== undefined;

describe.skipIf(!haveRealBinary)("against a real dogwood binary (opt-in)", () => {
  test("the shipped example replays to the verdicts #1657 recorded", async () => {
    resetDogwoodCli();
    const files = await exampleArtifacts();
    const report = await dogwoodReplay({
      policies: files["policies.dw"],
      policySchema: ACTION_SCHEMA,
      eventSchema: files["events.dwschema"],
      trace: TRACE_TEXT,
      expect: readAfterLoginExpectations,
    });
    expect(report.divergences).toEqual([]);
    expect(report.verdicts.map((v) => [v.timestamp, v.verdict])).toEqual([
      [0, "deny"],
      [10, "allow"],
      [7200, "deny"],
    ]);
  });
});
