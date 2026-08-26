import { describe, test, expect } from "vitest";
import { deriveSymptoms, worstStatus, CONVERGE_SYMPTOM_FIELDS } from "./symptoms";
import type { ChangeSet, ChangeSetEntry } from "./change-set";
import type { ComponentStatusRow } from "./status";

function entry(overrides: Partial<ChangeSetEntry> & Pick<ChangeSetEntry, "name" | "action">): ChangeSetEntry {
  return {
    ownership: "unknown",
    evidence: { declared: true, inSnapshot: true, live: true, observed: true },
    ...overrides,
  };
}

function statusRow(component: string, reconciliation: ComponentStatusRow["reconciliation"]): ComponentStatusRow {
  return { component, env: "staging", reconciliation, detail: "test fixture" };
}

describe("worstStatus", () => {
  test("reconciled for no rows", () => {
    expect(worstStatus([])).toBe("reconciled");
  });

  test("unknown outranks everything else", () => {
    const rows = [statusRow("a", "reconciled"), statusRow("b", "drifted"), statusRow("c", "unknown")];
    expect(worstStatus(rows)).toBe("unknown");
  });

  test("drifted outranks stale and unrecorded", () => {
    const rows = [statusRow("a", "stale"), statusRow("b", "unrecorded"), statusRow("c", "drifted")];
    expect(worstStatus(rows)).toBe("drifted");
  });

  test("stale outranks unrecorded", () => {
    expect(worstStatus([statusRow("a", "unrecorded"), statusRow("b", "stale")])).toBe("stale");
  });

  test("all reconciled -> reconciled", () => {
    expect(worstStatus([statusRow("a", "reconciled"), statusRow("b", "reconciled")])).toBe("reconciled");
  });
});

describe("deriveSymptoms", () => {
  test("a quiet environment: no entries, all-reconciled rows", () => {
    const cs: ChangeSet = { env: "staging", entries: [] };
    const rows = [statusRow("a", "reconciled")];
    const s = deriveSymptoms("staging", cs, rows);
    expect(s.env).toBe("staging");
    expect(s.status).toBe("reconciled");
    expect(s.createCount).toBe(0);
    expect(s.updateCount).toBe(0);
    expect(s.deleteCount).toBe(0);
    expect(s.adoptCount).toBe(0);
    expect(s.unobservedCount).toBe(0);
    expect(s.unobservedReasons).toEqual([]);
    expect(s.totalCount).toBe(0);
    expect(s.components).toEqual(rows);
  });

  test("counts change-set actions per type", () => {
    const cs: ChangeSet = {
      env: "staging",
      entries: [
        entry({ name: "a", action: "create" }),
        entry({ name: "b", action: "update" }),
        entry({ name: "c", action: "update" }),
        entry({ name: "d", action: "delete", ownership: "owned" }),
        entry({ name: "e", action: "adopt" }),
        entry({ name: "f", action: "adopt" }),
        entry({ name: "g", action: "runtime" }),
        entry({ name: "h", action: "noop" }),
      ],
    };
    const s = deriveSymptoms("staging", cs, [statusRow("x", "drifted")]);
    expect(s.createCount).toBe(1);
    expect(s.updateCount).toBe(2);
    expect(s.deleteCount).toBe(1);
    expect(s.adoptCount).toBe(2);
    expect(s.runtimeCount).toBe(1);
    expect(s.totalCount).toBe(8);
    expect(s.status).toBe("drifted");
  });

  test("unobserved entries surface count and deduplicated, sorted reasons", () => {
    const cs: ChangeSet = {
      env: "staging",
      entries: [
        entry({ name: "a", action: "unobserved", unobservedReason: "no-credentials" }),
        entry({ name: "b", action: "unobserved", unobservedReason: "read-failed" }),
        entry({ name: "c", action: "unobserved", unobservedReason: "no-credentials" }),
      ],
    };
    const s = deriveSymptoms("staging", cs, [statusRow("x", "unknown")]);
    expect(s.unobservedCount).toBe(3);
    expect(s.unobservedReasons).toHaveLength(2);
    expect(s.unobservedReasons).toContain("no-credentials");
    expect(s.unobservedReasons).toContain("read-failed");
    expect(s.status).toBe("unknown");
  });

  test("adopt entries never affect status directly — reported via adoptCount only", () => {
    const cs: ChangeSet = { env: "staging", entries: [entry({ name: "a", action: "adopt" })] };
    const s = deriveSymptoms("staging", cs, [statusRow("x", "reconciled")]);
    expect(s.adoptCount).toBe(1);
    expect(s.status).toBe("reconciled");
  });
});

describe("CONVERGE_SYMPTOM_FIELDS", () => {
  test("names every field deriveSymptoms actually produces", () => {
    const cs: ChangeSet = { env: "staging", entries: [] };
    const s = deriveSymptoms("staging", cs, []);
    for (const key of Object.keys(s)) {
      expect(CONVERGE_SYMPTOM_FIELDS.has(key)).toBe(true);
    }
  });
});
