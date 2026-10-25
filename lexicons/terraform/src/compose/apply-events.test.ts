/**
 * Each member's outcome of a composed apply (#4442), read from recorded
 * `apply -json` output of a run of the three-module plan that failed in its
 * second module (`../__fixtures__/compose/apply-failed-in-app.jsonl`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composedApplyOutcomes, memberApply, readApplyEvents } from "./apply-events";

const out = readFileSync(join(import.meta.dirname, "..", "__fixtures__", "compose", "apply-failed-in-app.jsonl"), "utf-8");
const modules = ["net", "app", "edge"];

describe("readApplyEvents", () => {
  const ev = readApplyEvents(out, modules);

  test("counts each module's started and completed changes and keeps its first error", () => {
    expect(ev.started).toEqual(new Map([["net", 1], ["app", 1]]));
    expect(ev.done).toEqual(new Map([["net", 1]]));
    expect(ev.errored.get("app")).toBe("terraform_data.service: module.app.terraform_data.service: Creation errored after 0s");
    expect(ev.errored.has("edge")).toBe(false);
  });

  test("an error no module's resource names is other", () => {
    expect(ev.other).toEqual(["Provider produced inconsistent final plan: This is a bug in the provider."]);
  });

  test("a run that failed in the second module: applied, failed, not-started", () => {
    expect(memberApply("net", 1, ev)).toEqual({ apply: "applied", done: 1 });
    expect(memberApply("app", 2, ev)).toEqual({ apply: "failed", done: 0 });
    expect(memberApply("edge", 1, ev)).toEqual({ apply: "not-started", done: 0 });
  });

  test("some changes done is partial; none planned is no-changes", () => {
    expect(memberApply("net", 2, ev)).toEqual({ apply: "partial", done: 1 });
    expect(memberApply("edge", 0, ev)).toEqual({ apply: "no-changes", done: 0 });
  });

  test("a diagnostic naming a module's resource is that module's error when no hook named one", () => {
    const line = JSON.stringify({ type: "diagnostic", diagnostic: { severity: "error", summary: "Invalid input", detail: "first\nsecond", address: "module.edge.terraform_data.dns" } });
    expect(readApplyEvents(line, modules).errored.get("edge")).toBe("terraform_data.dns: Error: Invalid input: first");
  });

  test("a module whose name starts with another's is its own", () => {
    const line = JSON.stringify({ type: "apply_complete", hook: { resource: { addr: "module.app2.terraform_data.x" } } });
    expect(readApplyEvents(line, ["app", "app2"]).done).toEqual(new Map([["app2", 1]]));
  });
});

describe("composedApplyOutcomes", () => {
  test("every member by component, the failed one with its error", () => {
    const c = { order: ["net", "app", "edge"], modules: new Map(modules.map((m) => [m, m])) };
    const { members, other } = composedApplyOutcomes(c, new Map([["net", 1], ["app", 2], ["edge", 1]]), out);
    expect(members).toEqual({
      net: { status: "applied", done: 1 },
      app: { status: "failed", done: 0, error: "terraform_data.service: module.app.terraform_data.service: Creation errored after 0s" },
      edge: { status: "not-started", done: 0 },
    });
    expect(other).toHaveLength(1);
  });
});
