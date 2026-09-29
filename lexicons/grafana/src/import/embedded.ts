/**
 * Dashboard JSON embedded in another lexicon's resource, for `chant import`
 * (#2962): a k8s ConfigMap holding a dashboard, as the Grafana dashboard
 * sidecar (the `grafana_dashboard` label) and file provisioning both mount
 * them. Matching is by content, so a dashboard in an unlabelled ConfigMap
 * is imported too.
 *
 * The dashboard is imported exactly as `chant import dashboard.json` would
 * import it, into a directory of its own, and the host's value becomes
 * `dashboardJson(dashboard)`, the JSON text the grafana serializer writes.
 */

import type { EmbeddedContentImporter, EmbeddedImport } from "@intentius/chant/import/embedded";
import { looksLikeDashboard, looksLikeV2Dashboard } from "../detect";
import { DASHBOARD_RESOURCE_TYPE, parseGrafana, type PlanResourceProperties } from "./parser";
import { generatePlanModules } from "./generator";

const PACKAGE = "@intentius/chant-lexicon-grafana";

export const dashboardImporter: EmbeddedContentImporter = {
  what: "a Grafana dashboard",

  matches(content) {
    if (typeof content.text !== "string" || content.select !== undefined) return false;
    return looksLikeDashboard(content.document) && !looksLikeV2Dashboard(content.document);
  },

  import(content): EmbeddedImport {
    const ir = parseGrafana(content.text!);
    const resource = ir.resources.find((r) => r.type === DASHBOARD_RESOURCE_TYPE);
    if (!resource) throw new Error((ir.warnings ?? []).join(" ") || "no dashboard was read");
    const { plan } = resource.properties as unknown as PlanResourceProperties;
    // Core gives the content a directory of its own; the plan's would nest a second one inside it.
    const { files, exported } = generatePlanModules({ ...plan, directory: "" });
    const dashboard = exported.get("dashboard");
    if (!dashboard) throw new Error("the import declared no dashboard");
    return {
      files,
      value: {
        bindings: [{ from: dashboard.path, name: dashboard.name }],
        shape: "single",
        through: { from: PACKAGE, name: "dashboardJson" },
      },
      warnings: ir.warnings ?? [],
    };
  },
};
