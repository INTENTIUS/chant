/**
 * Grafana serializer.
 *
 * Emits Grafana's own files, as `SerializerResult.files` keyed by path
 * relative to the output directory:
 *
 * - `dashboards/[<folder>/]<uid>.json`: one per dashboard, the JSON Grafana
 *   imports as it is (UI import, the HTTP API, or file provisioning).
 * - `provisioning/datasources/chant.yaml`: every declared datasource.
 * - `provisioning/dashboards/chant.yaml`: the provider that loads the
 *   dashboard files, a default one unless a `DashboardProvider` is declared.
 *
 * Mount `provisioning/` at `/etc/grafana/provisioning` and `dashboards/` at
 * the provider's path (`/var/lib/grafana/dashboards` by default).
 *
 * The primary output is a small JSON index of what was built. The dashboard
 * JSON carries no ownership marker, because Grafana keeps who manages a
 * dashboard outside it, in the resource's metadata on its
 * `dashboard.grafana.app` API. For a file-provisioned dashboard that metadata
 * is the `grafana.app/managerId` annotation Grafana writes, whose value is the
 * provider name in `provisioning/dashboards/chant.yaml`: `chant` unless a
 * `DashboardProvider` names another. That name is the marker chant stamps at
 * synthesis, and ./ownership.ts reads it back.
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { buildGrafana } from "./build";

export const grafanaSerializer: Serializer = {
  name: "grafana",
  rulePrefix: "GRAF",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    const grafana = new Map([...entities].filter(([, e]) => e?.lexicon === "grafana"));
    if (grafana.size === 0) return "";
    const built = buildGrafana(grafana);
    const primary = `${JSON.stringify(built.index, null, 2)}\n`;
    return { primary, files: built.files };
  },
};
