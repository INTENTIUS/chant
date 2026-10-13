import { describe, expect, test } from "vitest";
import { GrafanaActions, grafanaActionsFor } from "./grafana";

describe("GrafanaActions", () => {
  test("every action is a Grafana RBAC action name (<resource>:<verb>), with no duplicate in a group", () => {
    for (const actions of Object.values(GrafanaActions)) {
      for (const a of actions) expect(a).toMatch(/^[a-z]+(\.[a-z]+)*:[a-z]+$/);
      expect(new Set(actions).size).toBe(actions.length);
    }
  });

  test("apply and prune together cover every call the applier makes", () => {
    expect(grafanaActionsFor("Apply", "Prune")).toEqual(
      expect.arrayContaining(["dashboards:create", "dashboards:write", "dashboards:delete", "folders:create", "folders:delete", "library.panels:create", "library.panels:write"]),
    );
    expect(grafanaActionsFor("Prune")).not.toContain("library.panels:delete");
  });

  test("levels are merged without duplicates", () => {
    const merged = grafanaActionsFor("Observe", "Apply");
    expect(new Set(merged).size).toBe(merged.length);
    expect(merged[0]).toBe("dashboards:read");
  });
});
