import { describe, expect, test } from "vitest";
import { makePostSynthCtxFromFiles } from "@intentius/chant-test-utils";
import type { Declarable } from "@intentius/chant/declarable";
import { grafanaSerializer } from "../../serializer";
import { Datasource } from "../../datasource";
import { Dashboard } from "../../dashboard";
import { StatPanel } from "../../panels";
import { graf104 } from "./graf104";

function ctxOf(entities: Record<string, Declarable>, keep = true) {
  const map = new Map(Object.entries(entities));
  const out = grafanaSerializer.serialize(map);
  if (typeof out === "string") throw new Error("expected files");
  return makePostSynthCtxFromFiles("grafana", out.files!, out.primary, keep ? map : undefined);
}

describe("a grafana finding names the declaring entity", () => {
  test("a dashboard finding carries the export name, which resolves to the declaring file", () => {
    const slow = new Dashboard({ title: "Slow requests", panels: [new StatPanel({ id: 7 }), new StatPanel({ id: 7 })] });
    const diags = graf104.check(ctxOf({ slowRequests: slow }));
    expect(diags.map((d) => d.entity)).toEqual(["slowRequests"]);
  });

  test("a dashboard with its own uid still resolves to its export name", () => {
    const d = new Dashboard({ title: "A", uid: "custom-uid", panels: [new StatPanel({ id: 3 }), new StatPanel({ id: 3 })] });
    expect(graf104.check(ctxOf({ overview: d })).map((x) => x.entity)).toEqual(["overview"]);
  });

  test("a datasource finding carries the export name of the datasource", () => {
    const a = new Datasource({ name: "Prometheus", type: "prometheus" });
    const b = new Datasource({ name: "Prometheus", type: "prometheus", uid: "other" });
    const diags = graf104.check(ctxOf({ first: a, second: b }));
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.entity === "first" || d.entity === "second")).toBe(true);
  });

  test("without entities (an audit of provisioning files) the finding keeps the uid", () => {
    const d = new Dashboard({ title: "Slow requests", panels: [new StatPanel({ id: 7 }), new StatPanel({ id: 7 })] });
    expect(graf104.check(ctxOf({ slowRequests: d }, false)).map((x) => x.entity)).toEqual(["slow-requests"]);
  });
});
