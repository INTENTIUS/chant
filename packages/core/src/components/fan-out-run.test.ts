/**
 * Dispatching a derived fan-out (#2417).
 *
 * The behaviours here are the ones the issue said should not be implicit: one
 * approval over the whole set, a failure that skips its own subtree and leaves
 * independent branches alone, and a re-run that finishes without hand repair.
 */

import { describe, test, expect } from "vitest";
import { CapabilityRegistry, type DeployContext } from "./capability";
import { memoryGateLedgerPort } from "../op/gate";
import { planFanOut } from "./fan-out";
import { runFanOut } from "./fan-out-run";
import type { DriverComponent } from "./driver";

/** A component whose single deploy step calls `kind`. */
const c = (name: string, kind: string, dependsOn?: string[]): DriverComponent => ({
  name,
  deploy: [{ phase: "Deploy", steps: [{ kind }] }],
  ...(dependsOn ? { dependsOn } : {}),
});

/** net → cluster-a, cluster-b → apps. The issue's proof shape. */
const ESTATE: DriverComponent[] = [
  c("net", "ok-step"),
  c("cluster-a", "ok-step", ["net"]),
  c("cluster-b", "ok-step", ["net"]),
  c("app-one", "ok-step", ["cluster-a"]),
  c("app-two", "ok-step", ["cluster-a"]),
  c("app-three", "ok-step", ["cluster-b"]),
];

function registryWith(failing: string[] = []): { registry: CapabilityRegistry; ran: string[] } {
  const ran: string[] = [];
  const registry = new CapabilityRegistry();
  registry.register({
    kind: "ok-step",
    async run(ctx: DeployContext) {
      ran.push(ctx.component);
      if (failing.includes(ctx.component)) throw new Error(`${ctx.component} failed`);
      return { ok: true };
    },
  } as never);
  return { registry, ran };
}

const opts = () => ({ env: "test", gates: memoryGateLedgerPort(), now: "2026-01-01T00:00:00Z" });

describe("dispatching the plan", () => {
  test("every downstream component runs, in derived order, and nothing else", async () => {
    const estate = [...ESTATE, c("billing", "ok-step")];
    const plan = planFanOut({ components: estate, changed: ["net"] });
    const { registry, ran } = registryWith();

    const result = await runFanOut(plan, estate, registry, opts());

    expect(result.status).toBe("ok");
    expect(ran).toContain("net");
    expect(ran).not.toContain("billing");
    // No apply preceded its dependency.
    expect(ran.indexOf("net")).toBeLessThan(ran.indexOf("cluster-a"));
    expect(ran.indexOf("cluster-a")).toBeLessThan(ran.indexOf("app-one"));
    expect(result.completed).toEqual(["app-one", "app-three", "app-two", "cluster-a", "cluster-b", "net"]);
  });

  test("a change to a leaf propagates to nothing", async () => {
    const plan = planFanOut({ components: ESTATE, changed: ["app-three"] });
    const { registry, ran } = registryWith();
    await runFanOut(plan, ESTATE, registry, opts());
    expect(ran).toEqual(["app-three"]);
  });
});

describe("partial failure", () => {
  test("a failure skips its own subtree and leaves independent branches alone", async () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { registry, ran } = registryWith(["cluster-a"]);

    const result = await runFanOut(plan, ESTATE, registry, opts());

    expect(result.status).toBe("fail");
    expect(result.failed).toEqual(["cluster-a"]);
    // cluster-a's two apps never ran; cluster-b's branch finished.
    expect(ran).not.toContain("app-one");
    expect(ran).not.toContain("app-two");
    expect(ran).toContain("app-three");
    expect(result.completed).toContain("app-three");
  });

  test("a blocked component is reported as blocked, naming the failure to fix", async () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { registry } = registryWith(["cluster-a"]);
    const result = await runFanOut(plan, ESTATE, registry, opts());
    expect(result.blocked).toEqual([
      { component: "app-one", reason: "blocked", blockedBy: "cluster-a" },
      { component: "app-two", reason: "blocked", blockedBy: "cluster-a" },
    ]);
  });
});

describe("resuming", () => {
  test("a re-run finishes without redoing what already applied", async () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const first = await runFanOut(plan, ESTATE, registryWith(["cluster-a"]).registry, opts());
    expect(first.status).toBe("fail");

    // Whatever was wrong with cluster-a is fixed; run the same plan again.
    const { registry, ran } = registryWith();
    const second = await runFanOut(plan, ESTATE, registry, {
      ...opts(),
      progress: { completed: first.completed, failed: [] },
    });

    expect(second.status).toBe("ok");
    // Only the four that had not applied, and no hand repair.
    expect(ran.sort()).toEqual(["app-one", "app-two", "cluster-a"]);
    expect(second.plan.skipped).toContainEqual({ component: "net", reason: "already-applied" });
  });
});

describe("one approval over the whole set", () => {
  const gate = { op: "fan-out", gate: "approve-fan-out" };

  test("an unapproved gate stops before anything runs", async () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { registry, ran } = registryWith();

    const result = await runFanOut(plan, ESTATE, registry, { ...opts(), gate });

    expect(result.status).toBe("gated");
    expect(result.gate?.gate).toBe("approve-fan-out");
    // Nothing is half-applied, so there is nothing to compensate for.
    expect(ran).toEqual([]);
  });

  /** A ledger that already holds the pending fact from a first run, plus an approval of `digest`. */
  const approvedPort = (digest: string | undefined) =>
    memoryGateLedgerPort({
      pending: [{
        version: 1, kind: "pending", op: "fan-out", gate: "approve-fan-out",
        timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-03T00:00:00.000Z",
        ...(digest ? { planDigest: digest } : {}),
      }],
      resolutions: [{
        version: 1, op: "fan-out", gate: "approve-fan-out",
        resolvedBy: "alex", timestamp: "2026-01-01T00:01:00.000Z",
        ...(digest ? { planDigest: digest } : {}),
      }],
    });

  test("one approval covers every component in the set", async () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { registry, ran } = registryWith();

    const result = await runFanOut(plan, ESTATE, registry, {
      env: "test", now: "2026-01-01T00:02:00Z", gates: approvedPort(plan.digest), gate,
    });

    // Six components, one approval.
    expect(result.status).toBe("ok");
    expect(ran).toHaveLength(6);
  });

  test("the approval is bound to the fan-out that was derived, not to the next run", async () => {
    const approved = planFanOut({ components: ESTATE, changed: ["net"] });
    // A different change derives a different fan-out. The standing approval
    // named the other one, so this stops rather than riding on it.
    const different = planFanOut({ components: ESTATE, changed: ["cluster-b"] });
    expect(different.digest).not.toBe(approved.digest);

    const { registry, ran } = registryWith();
    const result = await runFanOut(different, ESTATE, registry, {
      env: "test", now: "2026-01-01T00:02:00Z", gates: approvedPort(approved.digest), gate,
    });

    expect(result.status).toBe("gated");
    expect(ran).toEqual([]);
  });

  test("an approval survives a resume, because the digest is carried not recomputed", async () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { registry, ran } = registryWith();

    // Half of it already applied in an earlier attempt. The gate must still
    // pass on the same approval.
    const result = await runFanOut(plan, ESTATE, registry, {
      env: "test", now: "2026-01-01T00:02:00Z", gates: approvedPort(plan.digest), gate,
      progress: { completed: ["net", "cluster-a"] },
    });

    expect(result.status).toBe("ok");
    expect(ran.sort()).toEqual(["app-one", "app-three", "app-two", "cluster-b"]);
  });
});
