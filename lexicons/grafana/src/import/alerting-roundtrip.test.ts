/**
 * Round trips of alerting provisioning files through `chant import`.
 *
 * Provisioning YAML -> TypeScript -> `chant build` -> provisioning YAML must
 * give back the same file for every fixture: Grafana 12.4.11 and 13.2.2
 * exports, and files other projects provision Grafana from (provenance in
 * test/fixtures/alerting/README.md), and what the alerting example builds.
 * "The same" means equal after `normalizeAlerting` once the importer's
 * edits are applied to the source. The generated source must lint clean,
 * and the rebuilt file must pass GRAF108 and GRAF111-GRAF114 without
 * errors. generated-types.e2e.test.ts type-checks the generated source;
 * alerting.e2e.test.ts provisions the rebuilt exports into Grafana.
 */

import { describe, expect, test } from "vitest";
import { join } from "path";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { importCommand } from "@intentius/chant/cli/commands/import";
import { grafanaSerializer } from "../serializer";
import { ALERTING_FILE } from "../alerting-build";
import { buildGrafana } from "../build";
import { validateGrafanaOutput, type GrafanaIssue } from "../validate-output";
import { GrafanaParser, type AlertingResourceMetadata } from "./parser";
import { GrafanaGenerator } from "./generator";
import { applyEdits } from "./edits";
import { normalizeAlerting } from "./normalize-alerting";
import { ALERTING, exampleOutputs, fixturesDir, projectDir, read, removeDir, repoRoot, writeFiles } from "./testdata/fixtures";

type Json = Record<string, unknown>;

interface Imported {
  source: string;
  warnings: string[];
  expected: Json;
  rebuilt: Json;
  issues: GrafanaIssue[];
  lint: { errorCount: number; warningCount: number; output: string };
}

/** Several files -> IR -> TypeScript in one project -> `chant build`, `chant lint`, and the checks. */
async function importAndBuild(contents: string[]): Promise<Imported> {
  const dir = projectDir();
  try {
    const srcDir = join(dir, "src");
    const warnings: string[] = [];
    const sources: string[] = [];
    const expected: Json = { apiVersion: 1 };
    contents.forEach((content, i) => {
      const ir = new GrafanaParser().parse(content);
      warnings.push(...(ir.warnings ?? []));
      const generated = new GrafanaGenerator().generate(ir).map((f) => ({ ...f, path: contents.length > 1 ? `f${i}/${f.path}` : f.path }));
      writeFiles(srcDir, generated);
      sources.push(...generated.map((f) => `// ${f.path}\n${f.content}`));
      const meta = ir.resources[0]!.metadata as unknown as AlertingResourceMetadata;
      for (const [k, v] of Object.entries(applyEdits(meta.source, meta.edits))) {
        if (Array.isArray(v)) expected[k] = [...((expected[k] as unknown[]) ?? []), ...v];
      }
    });
    const result = await build(srcDir, [grafanaSerializer]);
    expect(result.errors).toEqual([]);
    const text = (result.outputs.get("grafana") as SerializerResult | undefined)?.files?.[ALERTING_FILE];
    const built = buildGrafana(new Map([...result.entities].filter(([, e]) => e.lexicon === "grafana")));
    const issues = validateGrafanaOutput({
      dashboards: [],
      datasources: built.datasources,
      externalDatasources: built.externalDatasources,
      alerting: built.alerting ? [{ json: built.alerting as unknown as Json }] : [],
    });
    const lint = await lintCommand({ path: srcDir, format: "stylish" });
    return {
      source: sources.join("\n"),
      warnings,
      expected,
      rebuilt: text === undefined ? { apiVersion: 1 } : (load(text) as Json),
      issues,
      lint: { errorCount: lint.errorCount, warningCount: lint.warningCount, output: lint.output },
    };
  } finally {
    removeDir(dir);
  }
}

async function expectRoundTrip(...contents: string[]): Promise<Imported> {
  const out = await importAndBuild(contents);
  expect(normalizeAlerting(out.rebuilt)).toEqual(normalizeAlerting(out.expected));
  expect(out.lint.errorCount + out.lint.warningCount, out.lint.output).toBe(0);
  expect(out.issues.filter((i) => i.severity === "error")).toEqual([]);
  return out;
}

describe("alerting provisioning YAML -> TypeScript -> alerting provisioning YAML", () => {
  for (const file of ALERTING) {
    test(file, async () => {
      await expectRoundTrip(read(file));
    });
  }

  test("each Grafana version's exports, imported into one project, reference each other and pass every check", async () => {
    for (const v of ["grafana-12.4.11", "grafana-13.2.2"]) {
      const files = ALERTING.filter((f) => f.startsWith(`alerting/${v}/`)).map((f) => read(f));
      const out = await expectRoundTrip(...files);
      // With the contact points and mute timings declared, GRAF113 checks every reference and finds them all.
      expect(out.issues.filter((i) => i.code === "GRAF113")).toEqual([]);
      expect(out.issues.filter((i) => i.code === "GRAF112")).toEqual([]);
    }
  });

  test("a project's files, imported together, pass every check", async () => {
    const marin = ALERTING.filter((f) => f.includes("/marin.")).map((f) => read(f));
    const out = await expectRoundTrip(...marin);
    expect(out.issues.filter((i) => i.code === "GRAF113")).toEqual([]);
  });

  test("the typed classes carry each server-side expression, and a datasource query keeps its model", async () => {
    const out = await importAndBuild([read("alerting/grafana-13.2.2/alert-rules.yaml")]);
    for (const cls of ["ReduceExpression", "ThresholdExpression", "ResampleExpression", "MathExpression", "ClassicConditionsExpression"]) {
      expect(out.source).toContain(`new ${cls}(`);
    }
    expect(out.source).toContain('const prom = new ExternalDatasource({ type: "prometheus", uid: "prom" });');
    expect(out.source).toContain("new AlertQuery({ datasource: prom, model:");
    // The recovery threshold is carried; the editor's operator/query/reducer on a threshold are not needed.
    expect(out.source).toContain('unloadEvaluator: { params: [0.03], type: "lt" }');
    expect(out.warnings).toEqual([]);
  });

  test("what cannot be carried, or had to be guessed, is a warning", async () => {
    const proto = await importAndBuild([read("alerting/community/proto-fleet.proto-fleet-rules.yaml")]);
    expect(proto.warnings).toContainEqual(expect.stringContaining('the plugin type of "protofleet-timescaledb"'));
    expect(proto.warnings).toContainEqual(expect.stringContaining("2 rule deletions (deleteRules)"));
    expect(proto.source).toContain('datasource: "protofleet-timescaledb"');

    const eth = await importAndBuild([read("alerting/community/eth-docker.disk_space.yml")]);
    expect(eth.warnings).toContainEqual(expect.stringContaining('"PBFA97CFB590B2093"; the queries look like PromQL'));

    const cps = await importAndBuild([read("alerting/grafana-13.2.2/contact-points.yaml")]);
    expect(cps.warnings).toEqual([expect.stringContaining("url as $__env{ONCALL_SLACK_URL} is read from the environment")]);
    expect(cps.rebuilt).toMatchObject({ contactPoints: expect.arrayContaining([expect.objectContaining({ name: "oncall" })]) });
    expect(JSON.stringify(cps.rebuilt)).not.toContain("[REDACTED]");
  });

  test("the alerting example's file round-trips", async () => {
    const [, text] = (await exampleOutputs()).find(([f]) => f === `alerting/${ALERTING_FILE}`)!;
    await expectRoundTrip(text);
  });

  test("chant import detects the file as grafana's, and a Prometheus rule file as prometheus's", async () => {
    const dir = projectDir();
    try {
      const alerting = await importCommand({ templatePath: join(fixturesDir, "alerting", "grafana-13.2.2", "policies.yaml"), output: join(dir, "src"), force: true });
      expect(alerting.lexicon).toBe("grafana");
      expect(alerting.generatedFiles).toEqual(["notifications.ts"]);
      const rules = await importCommand({ templatePath: join(repoRoot, "lexicons/prometheus/src/import/testdata/rules-full.yml"), output: join(dir, "rules"), force: true });
      expect(rules.lexicon).toBe("prometheus");
    } finally {
      removeDir(dir);
    }
  });
});
