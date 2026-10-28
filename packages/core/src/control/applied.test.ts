/**
 * The apply outcome a dispatch carries and the control repo's record of it
 * (#4617). Written for the ci-products session; run at epic-ready.
 */

import { describe, expect, test } from "vitest";
import type { WaveMemberOutcome } from "../wave-blocked";
import {
  applyOutcomeOf,
  controlAppliedProblems,
  latestControlApplies,
  parseControlApplied,
  recordControlApplied,
  recordControlAppliedFromEnv,
  type ControlAppliedRecord,
} from "./applied";
import type { ControlLedgerPort } from "./records";
import { controlDependentsScript, controlDispatchRequest, controlDispatchScript, controlPipelineSpec, resolveControlTarget } from "./dispatch";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const outcomes = (o: Record<string, WaveMemberOutcome>) => new Map(Object.entries(o));

function memoryLedger(): ControlLedgerPort & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    async read() {
      return lines.length > 0 ? lines.join("\n") + "\n" : null;
    },
    async append(line) {
      lines.push(line);
      return `commit-${lines.length}`;
    },
  };
}

describe("the waves' outcome (#4617)", () => {
  test("every run applied or had nothing to apply: applied", () => {
    expect(applyOutcomeOf(outcomes({ a: { status: "applied" }, b: { status: "unchanged" } }))).toEqual({ outcome: "applied", applied: ["a"], counts: { applied: 1, unchanged: 1 } });
  });

  test("some applied and some failed or were blocked: partial", () => {
    const s = applyOutcomeOf(outcomes({ net: { status: "applied" }, db: { status: "failed" }, app: { status: "blocked", by: "db" } }));
    expect(s.outcome).toBe("partial");
    expect(s.applied).toEqual(["net"]);
  });

  test("nothing to apply anywhere: unchanged", () => {
    expect(applyOutcomeOf(outcomes({ a: { status: "unchanged" } })).outcome).toBe("unchanged");
  });

  test("nothing applied and a wave waits, with runs blocked behind it: waiting", () => {
    expect(applyOutcomeOf(outcomes({ a: { status: "unchanged" }, b: { status: "waiting" }, c: { status: "blocked", by: "b" } })).outcome).toBe("waiting");
  });

  test("nothing applied and a run failed, or no wave wrote an outcome: failed", () => {
    expect(applyOutcomeOf(outcomes({ a: { status: "failed" } })).outcome).toBe("failed");
    expect(applyOutcomeOf(outcomes({ a: { status: "refused" } })).outcome).toBe("failed");
    expect(applyOutcomeOf(new Map()).outcome).toBe("failed");
  });
});

describe("the dispatch carries the outcome (#4617)", () => {
  test("in GitHub's client_payload, Forgejo's inputs and GitLab's trigger variables", () => {
    const d = { member: "network", op: "deploy", sha: SHA, outcome: "partial" as const };
    const gh = controlDispatchRequest(resolveControlTarget({ repo: "github.com/acme/control", op: "deploy" }, "network"), d);
    expect(gh.body).toEqual({ json: { event_type: "chant-applied", client_payload: { member: "network", op: "deploy", sha: SHA, outcome: "partial" } } });
    const fj = controlDispatchRequest(resolveControlTarget({ repo: "codeberg.org/acme/control", op: "deploy" }, "network"), d);
    expect(fj.body).toEqual({ json: { ref: "main", inputs: { member: "network", op: "deploy", sha: SHA, outcome: "partial" } } });
    const gl = controlDispatchRequest(resolveControlTarget({ repo: "gitlab.com/acme/control", op: "deploy" }, "network"), d);
    expect("form" in gl.body && gl.body.form).toContainEqual(["variables[CHANT_CONTROL_OUTCOME]", "partial"]);
  });

  test("the pull request loop's dispatch, with no outcome, is unchanged", () => {
    const gh = controlDispatchRequest(resolveControlTarget({ repo: "github.com/acme/control", op: "deploy" }, "network"), { member: "network", op: "deploy", sha: SHA });
    expect(gh.body).toEqual({ json: { event_type: "chant-applied", client_payload: { member: "network", op: "deploy", sha: SHA } } });
  });

  test("an outcome chant does not know is refused", () => {
    expect(() =>
      controlDispatchRequest(resolveControlTarget({ repo: "github.com/acme/control", op: "deploy" }, "network"), { member: "network", op: "deploy", sha: SHA, outcome: "maybe" as never }),
    ).toThrow(/outcome "maybe"/);
  });

  test("the script reads the outcome from CHANT_CONTROL_OUTCOME, checks it, and keeps the token on stdin", () => {
    const target = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy" }, "network");
    const script = controlDispatchScript(target, { outcome: true });
    expect(script).toContain('outcome="${CHANT_CONTROL_OUTCOME:-}"');
    expect(script).toContain('case "$outcome" in applied|partial|unchanged|waiting|failed) ;;');
    expect(script).toContain(`"outcome":"'"$outcome"'"`);
    expect(script).toContain("-H @-");
    expect(script).not.toContain("$CHANT_CONTROL_TOKEN -");
    expect(controlDispatchScript(target)).not.toContain("CHANT_CONTROL_OUTCOME");
    const gitlab = controlDispatchScript(resolveControlTarget({ repo: "gitlab.com/acme/control", op: "deploy" }, "network"), { outcome: true });
    expect(gitlab).toContain('--form "variables[CHANT_CONTROL_OUTCOME]=$outcome"');
    expect(gitlab).toContain("--form 'token=<-'");
  });
});

describe("the control repo's side (#4617)", () => {
  test("the step records a dispatch that carries an outcome, and runs dependents only when something applied", () => {
    const script = controlDependentsScript({ label: "plywood" });
    expect(script).toContain('outcome="${CHANT_CONTROL_OUTCOME:-}"');
    expect(script).toContain("recordControlAppliedFromEnv");
    expect(script).toContain('case "$outcome" in ""|applied|partial) ;;');
    expect(script.indexOf("recordControlAppliedFromEnv")).toBeLessThan(script.indexOf("workspace run --dependents-of"));
    expect(script).toMatch(/node --input-type=module -e '[^']*'/);
  });

  test("the GitHub and Forgejo workflow takes the outcome from the payload or the manual input", () => {
    const spec = controlPipelineSpec("forgejo", { product: "plywood" });
    expect(spec.inputs.outcome).toMatchObject({ required: false, type: "string" });
    expect(spec.env.CHANT_CONTROL_OUTCOME).toBe("${{ github.event.client_payload.outcome || inputs.outcome }}");
    expect(controlPipelineSpec("gitlab").env).toEqual({});
  });
});

describe("the apply records (#4617)", () => {
  const at = (iso: string) => () => new Date(iso);

  test("a record's digest covers every field, and a tampered line is left out", async () => {
    const port = memoryLedger();
    const { record } = await recordControlApplied(port, { member: "network", op: "deploy", sha: SHA, outcome: "applied" }, { now: at("2026-10-27T10:00:00.000Z") });
    expect(controlAppliedProblems(record)).toEqual([]);
    const tampered = { ...record, outcome: "failed" } as ControlAppliedRecord;
    expect(controlAppliedProblems(tampered)).toContain("digest does not match the record");
    const { records, malformed } = parseControlApplied(`${port.lines[0]}\n${JSON.stringify(tampered)}\nnot json\n`);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(2);
  });

  test("each member's newest apply that applied something", async () => {
    const port = memoryLedger();
    await recordControlApplied(port, { member: "network", op: "deploy", sha: SHA, outcome: "applied" }, { now: at("2026-10-27T10:00:00.000Z") });
    await recordControlApplied(port, { member: "network", op: "deploy", sha: SHA, outcome: "failed" }, { now: at("2026-10-27T11:00:00.000Z") });
    await recordControlApplied(port, { member: "dns", op: "deploy", sha: SHA, outcome: "unchanged" }, { now: at("2026-10-27T12:00:00.000Z") });
    const latest = latestControlApplies(parseControlApplied(await port.read()).records);
    expect([...latest.keys()]).toEqual(["network"]);
    expect(latest.get("network")!.at).toBe("2026-10-27T10:00:00.000Z");
  });

  test("the control repo's call records nothing for a dispatch with no outcome or no sha", async () => {
    expect(await recordControlAppliedFromEnv({ env: { CHANT_CONTROL_MEMBER: "network", CHANT_CONTROL_OP: "deploy", CHANT_CONTROL_SHA: SHA } })).toEqual({ skipped: "the dispatch carries no outcome" });
    expect((await recordControlAppliedFromEnv({ env: { CHANT_CONTROL_OUTCOME: "applied", CHANT_CONTROL_SHA: "" } })).skipped).toMatch(/no commit sha/);
    expect((await recordControlAppliedFromEnv({ env: { CHANT_CONTROL_OUTCOME: "sideways", CHANT_CONTROL_SHA: SHA } })).skipped).toMatch(/not one chant knows/);
  });
});
