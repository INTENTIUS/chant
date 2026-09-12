/**
 * The printed derivation (#2420).
 *
 * #2417's eighth proof line is "the order was derived, with the derivation
 * printed". These tests hold the render to what makes that claim checkable by
 * a reader: the waves, a reason beside every component that is not running,
 * the third outcome, the seeds, and the digest verbatim.
 */

import { describe, test, expect } from "vitest";
import { planFanOut, type FanOutPlan } from "./fan-out";
import { renderFanOutPlan, renderFanOutHuman, renderFanOutJson } from "./fan-out-output";
import type { FanOutRunResult } from "./fan-out-run";
import type { DriverComponent } from "./driver";

const c = (name: string, dependsOn?: string[]): DriverComponent => ({
  name,
  deploy: [{ phase: "Deploy", steps: [{ kind: "ok-step" }] }],
  ...(dependsOn ? { dependsOn } : {}),
});

/** net -> two clusters -> three apps, plus an unrelated branch. #2417's proof shape. */
const ESTATE: DriverComponent[] = [
  c("net"),
  c("cluster-a", ["net"]),
  c("cluster-b", ["net"]),
  c("app-one", ["cluster-a"]),
  c("app-two", ["cluster-a"]),
  c("app-three", ["cluster-b"]),
  c("billing"),
  c("nightly-etl"),
];

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function render(plan: FanOutPlan, gate?: { op: string; gate: string }): string {
  const { lines, write } = capture();
  renderFanOutPlan(plan, { write, ...(gate ? { gate } : {}) });
  return lines.join("\n");
}

describe("the derivation", () => {
  test("prints the waves, so the order reads as a graph rather than a list", () => {
    const out = render(planFanOut({ components: ESTATE, changed: ["net"] }));
    expect(out).toContain("wave 1: net");
    expect(out).toContain("wave 2: cluster-a, cluster-b");
    expect(out).toContain("wave 3: app-one, app-three, app-two");
  });

  test("counts all three outcomes, never two", () => {
    const out = render(
      planFanOut({ components: ESTATE, changed: ["cluster-b"], indeterminate: ["nightly-etl"] }),
    );
    expect(out).toMatch(/^fan-out: 2 selected, 5 unaffected, 1 indeterminate$/m);
  });

  test("every component that is not running carries its reason", () => {
    const out = render(
      planFanOut({ components: ESTATE, changed: ["cluster-b"], indeterminate: ["nightly-etl"] }),
    );
    expect(out).toContain("not running (6):");
    expect(out).toMatch(/billing +unaffected/);
    expect(out).toMatch(/nightly-etl +indeterminate/);
  });

  test("an indeterminate component the walk did not reach is named on its own line", () => {
    const out = render(
      planFanOut({ components: ESTATE, changed: ["cluster-b"], indeterminate: ["nightly-etl"] }),
    );
    expect(out).toContain("the walk did not reach them: nightly-etl");
  });

  test("an indeterminate component the walk did reach is selected, and is not reported as undecided", () => {
    const out = render(
      planFanOut({ components: ESTATE, changed: ["net"], indeterminate: ["app-two"] }),
    );
    expect(out).toContain("wave 3: app-one, app-three, app-two");
    expect(out).not.toContain("the walk did not reach them");
    expect(out).toMatch(/^fan-out: 6 selected, 2 unaffected, 0 indeterminate$/m);
  });

  test("names the dependencies whose outputs are taken on trust", () => {
    const out = render(planFanOut({ components: ESTATE, changed: ["cluster-a"] }));
    expect(out).toContain("seeded from an earlier run: net");
  });

  test("prints the digest verbatim, because it is what `chant approve --plan` takes", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const out = render(plan, { op: "fan-out", gate: "release" });
    expect(out).toContain(`plan: ${plan.digest}`);
    expect(out).toContain(`chant approve fan-out release --plan ${plan.digest}`);
    // Nothing abbreviates it: the whole 64-hex string is on the line.
    expect(plan.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("says so plainly when a change propagates to nothing", () => {
    const plan: FanOutPlan = {
      order: [],
      waves: [],
      skipped: [],
      seeds: [],
      indeterminate: [],
      digest: "sha256:" + "0".repeat(64),
    };
    expect(render(plan)).toContain("nothing to run");
  });
});

describe("a dispatched fan-out", () => {
  const plan = planFanOut({ components: ESTATE, changed: ["net"] });

  const result = (over: Partial<FanOutRunResult>): FanOutRunResult => ({
    plan,
    status: "ok",
    results: [],
    completed: [],
    failed: [],
    blocked: [],
    componentOutputs: {},
    ...over,
  });

  test("a failure prints the blocked subtree naming the failure, not the nearest edge", () => {
    const { lines, write } = capture();
    renderFanOutHuman(
      result({
        status: "fail",
        completed: ["cluster-b", "net", "app-three"],
        failed: ["cluster-a"],
        blocked: [
          { component: "app-one", reason: "blocked", blockedBy: "cluster-a" },
          { component: "app-two", reason: "blocked", blockedBy: "cluster-a" },
        ],
      }),
      { write },
    );
    const out = lines.join("\n");
    expect(out).toContain('app-one: blocked by "cluster-a", so it never ran');
    expect(out).toContain('app-two: blocked by "cluster-a", so it never ran');
    // The independent branch is still reported as applied.
    expect(out).toContain("applied: cluster-b, net, app-three");
    expect(out).toContain("fan-out failed: 3 applied, 1 failed, 2 blocked");
  });

  test("a gated run says nothing ran, and names the gate", () => {
    const { lines, write } = capture();
    renderFanOutHuman(
      result({
        status: "gated",
        gate: {
          version: 1,
          kind: "pending",
          op: "fan-out",
          gate: "release",
          timestamp: "2026-01-01T00:00:00Z",
          expiresAt: "2026-01-03T00:00:00Z",
          planDigest: plan.digest,
        },
      }),
      { write },
    );
    const out = lines.join("\n");
    expect(out).toContain("gated: nothing ran.");
    expect(out).toContain('Waiting on "release" on "fan-out".');
    expect(out).toContain("expires: 2026-01-03T00:00:00Z");
  });

  test("the plan printed is the one dispatched, so a resume shows what it is skipping", () => {
    const { lines, write } = capture();
    renderFanOutHuman(
      result({
        plan: {
          ...plan,
          order: ["app-one"],
          waves: [["app-one"]],
          skipped: [
            { component: "billing", reason: "unaffected" },
            { component: "cluster-a", reason: "already-applied" },
            { component: "net", reason: "already-applied" },
          ],
        },
        completed: ["app-one"],
      }),
      { write },
    );
    const out = lines.join("\n");
    expect(out).toMatch(/net +already-applied/);
    expect(out).toMatch(/cluster-a +already-applied/);
    expect(out).toContain("fan-out completed: 1 applied, 0 failed, 0 blocked");
  });
});

describe("the JSON render", () => {
  test("emits one line, and the plan round-trips", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { lines, write } = capture();
    renderFanOutJson(plan, write);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(plan);
  });

  test("a run result carries its plan, which is how a consumer tells the two apart", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { lines, write } = capture();
    renderFanOutJson(
      { plan, status: "ok", results: [], completed: [], failed: [], blocked: [], componentOutputs: {} },
      write,
    );
    const parsed = JSON.parse(lines[0]) as FanOutRunResult;
    expect(parsed.plan.digest).toBe(plan.digest);
    expect(parsed.status).toBe("ok");
  });
});
