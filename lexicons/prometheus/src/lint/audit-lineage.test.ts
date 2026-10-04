import { describe, test, expect } from "vitest";
import { prometheusAuditCatalog } from "./audit-catalog";

describe("prometheus audit lineage (#2916, #3136)", () => {
  const credits = (id: string) => (prometheusAuditCatalog[id].lineage ?? []).map((l) => `${l.tool}:${l.rule ?? ""}:${l.relation}`);

  test("credits promtool where rulefmt rejects the same file", () => {
    for (const id of ["PROM101", "PROM103", "PROM104", "PROM105"]) {
      expect(credits(id), id).toContain("promtool::equivalent");
    }
    expect(credits("PROM002")).toContain("promtool::equivalent");
  });

  test("credits pint's named checks", () => {
    expect(credits("PROM002")).toEqual(["promtool::equivalent", "pint:promql/syntax:equivalent"]);
    expect(credits("PROM102")).toEqual(["pint:rule/duplicate:overlaps"]);
    expect(credits("PROM103")).toEqual(["promtool::equivalent", "pint:alerts/for:overlaps"]);
    expect(credits("PROM104")).toEqual(["promtool::equivalent", "pint:promql/syntax:equivalent"]);
    expect(credits("PROM106")).toEqual(["pint:rule/label:overlaps"]);
    expect(credits("PROM107")).toEqual(["pint:alerts/annotation:overlaps"]);
    expect(credits("PROM211")).toEqual(["pint:rule/for:overlaps"]);
    expect(credits("PROM212")).toEqual(["pint:alerts/annotation:overlaps"]);
    expect(credits("PROM213")).toEqual(["pint:alerts/comparison:equivalent"]);
    expect(credits("PROM214")).toEqual(["pint:alerts/template:overlaps"]);
    expect(credits("PROM215")).toEqual(["pint:promql/rate:overlaps"]);
    expect(credits("PROM217")).toEqual(["pint:rule/name:overlaps"]);
    expect(credits("PROM218")).toEqual(["pint:promql/regexp:equivalent"]);
  });

  test("credits amtool check-config where Alertmanager rejects the same config", () => {
    for (const id of ["PROM201", "PROM203", "PROM204", "PROM205", "PROM206", "PROM208"]) {
      expect(credits(id), id).toEqual(["amtool::equivalent"]);
    }
    expect(credits("PROM209")).toEqual(["amtool::overlaps"]);
    expect(credits("PROM210")).toEqual(["amtool::overlaps"]);
  });

  test("rules no upstream tool checks carry no credit", () => {
    for (const id of ["PROM001", "PROM003", "PROM202", "PROM207", "PROM216", "PROM219", "PROM220", "PROM221", "PROM222", "PROM223", "PROM224"]) {
      expect(prometheusAuditCatalog[id].lineage, id).toBeUndefined();
    }
  });

  test("every rule is either credited above or deliberately left uncredited", () => {
    const credited = Object.keys(prometheusAuditCatalog).filter((id) => prometheusAuditCatalog[id].lineage !== undefined);
    expect(credited.sort()).toEqual(
      [
        "PROM002",
        "PROM101",
        "PROM102",
        "PROM103",
        "PROM104",
        "PROM105",
        "PROM106",
        "PROM107",
        "PROM201",
        "PROM203",
        "PROM204",
        "PROM205",
        "PROM206",
        "PROM208",
        "PROM209",
        "PROM210",
        "PROM211",
        "PROM212",
        "PROM213",
        "PROM214",
        "PROM215",
        "PROM217",
        "PROM218",
      ].sort(),
    );
  });
});
