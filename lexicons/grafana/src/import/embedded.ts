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
 *
 * A v2 dashboard (`dashboard.grafana.app/v2*`, or a bare v2 spec) is matched
 * but kept as written, with a warning (#3031). The importer reads v2 (#2947),
 * but the build writes classic (v1) JSON, so delegating it would turn the
 * ConfigMap's v2 dashboard into a v1 one on the next build.
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
    return looksLikeDashboard(content.document) || looksLikeV2Dashboard(content.document);
  },

  keepsAsWritten(content) {
    if (!looksLikeV2Dashboard(content.document)) return undefined;
    return (
      "it is a v2 dashboard, and the grafana lexicon builds classic (v1) dashboard JSON, so importing it would change " +
      "this value from v2 to v1 on the next build. It stays a string. To manage it as a typed dashboard, import the " +
      "JSON on its own with `chant import <file> --lexicon grafana`, which reports what v1 cannot hold, and put " +
      "`dashboardJson(dashboard)` here."
    );
  },

  import(content): EmbeddedImport {
    const ir = parseGrafana(content.text!);
    const resource = ir.resources.find((r) => r.type === DASHBOARD_RESOURCE_TYPE);
    if (!resource) throw new Error((ir.warnings ?? []).join(" ") || "no dashboard was read");
    const { plan } = resource.properties as unknown as PlanResourceProperties;
    // Core gives the content a directory of its own; the plan's would nest a second one inside it. The host's
    // project need not list grafana (a k8s project holding a dashboard ConfigMap), and then core lint does not know
    // grafana's panels and queries are property-kind, so they keep the flat shape that lints clean without it: a
    // const per declaration, nested values lifted, eight to a module (#2988).
    const flat = { ...plan, directory: "", main: undefined, declarations: plan.declarations.map(({ property: _, ...d }) => d) };
    const { files, exported } = generatePlanModules(flat);
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
