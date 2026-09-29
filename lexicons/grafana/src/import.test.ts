/**
 * "A dashboard builds to JSON that Grafana imports without edits", offline.
 *
 * Builds every example and validates each dashboard against Grafana's
 * dashboard schema at `GRAFANA_SCHEMA_PIN`, each panel's options and each
 * query against their plugin's schema, and runs the GRAF1xx checks over the
 * output. `import.e2e.test.ts` does the same against a real Grafana when
 * Docker is available.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { load } from "js-yaml";
import { grafanaSerializer } from "./serializer";
import { validateDashboardSchema } from "./schema-validate";
import { validateGrafanaOutput } from "./validate-output";
import type { ProvisionedDatasource } from "./build";

const examplesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "examples");
const examples = readdirSync(examplesDir).filter((e) => {
  try {
    return statSync(join(examplesDir, e, "src")).isDirectory();
  } catch {
    return false;
  }
});

describe.each(examples)("example %s", (example) => {
  test("every dashboard matches the pinned Grafana schemas, and every check passes", { timeout: 30_000 }, async () => {
    const result = await build(join(examplesDir, example, "src"), [grafanaSerializer]);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("grafana") as SerializerResult;
    const dashboards = Object.entries(out.files ?? {}).filter(([f]) => f.startsWith("dashboards/"));
    expect(dashboards.length).toBeGreaterThan(0);
    for (const [file, text] of dashboards) {
      expect({ file, problems: validateDashboardSchema(JSON.parse(text)) }).toEqual({ file, problems: [] });
    }
    const ds = load(out.files?.["provisioning/datasources/chant.yaml"] ?? "datasources: []") as { datasources: ProvisionedDatasource[] };
    const issues = validateGrafanaOutput({ dashboards: dashboards.map(([source, t]) => ({ source, json: JSON.parse(t) })), datasources: ds.datasources });
    expect(issues).toEqual([]);
  });
});
