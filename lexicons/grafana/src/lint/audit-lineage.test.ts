import { describe, test, expect } from "vitest";
import { grafanaAuditCatalog } from "./audit-catalog";

describe("grafana audit lineage (#2916)", () => {
  const credits = (id: string) => (grafanaAuditCatalog[id].lineage ?? []).map((l) => `${l.tool}:${l.rule}:${l.relation}`);

  test("credits dashboard-linter only where it has the same check", () => {
    expect(credits("GRAF108")).toEqual([
      "dashboard-linter:target-promql-rule:equivalent",
      "dashboard-linter:template-label-promql-rule:equivalent",
    ]);
    expect(credits("GRAF115")).toEqual(["dashboard-linter:panel-units-rule:overlaps"]);
    expect(credits("GRAF116")).toEqual(["dashboard-linter:target-logql-rule:equivalent"]);
  });

  test("rules with no upstream equivalent carry no credit", () => {
    for (const id of ["GRAF101", "GRAF102", "GRAF103", "GRAF104", "GRAF105", "GRAF106", "GRAF107", "GRAF117"]) {
      expect(grafanaAuditCatalog[id].lineage, id).toBeUndefined();
    }
  });
});
