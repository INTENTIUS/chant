/**
 * Round trips through `chant import`.
 *
 * YAML -> TypeScript -> `chant build` -> YAML must give back the same file
 * (key order, quoting and the order of groups, receivers and time intervals
 * aside) for every fixture: each prometheus example's built rule file and
 * alertmanager.yml, `Slo()` output, a rule file and an alertmanager.yml
 * using every field and the deprecated spellings, and upstream samples from
 * the Prometheus docs and Alertmanager's example configs at the pinned
 * releases. The generated source must lint clean, apart from the literal
 * credentials a fixture carries, which PROM001 must report.
 *
 * Where `promtool` / `amtool` are on PATH (or `PROMTOOL` / `AMTOOL` name
 * them) the re-emitted files are also checked by `promtool check rules` and
 * `amtool check-config`. generated-types.e2e.test.ts type-checks the
 * generated source.
 */

import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { prometheusSerializer } from "../serializer";
import { amtoolCheckConfig, hasTool, promtoolCheckRules } from "../tools";
import type { AlertmanagerConfig, RouteConfig, RuleFileConfig } from "../model";
import { PrometheusParser } from "./parser";
import { PrometheusGenerator } from "./generator";
import { builtFiles, exampleOutputs, pkgDir, read, sloOutputs, UPSTREAM, type BuiltFile } from "./testdata/fixtures";

// ── helpers ─────────────────────────────────────────────────────────

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** `match` / `match_re` maps as the matcher strings Alertmanager reads them as. */
function asMatchers(match: unknown, re: unknown): string[] {
  const q = (v: unknown) => JSON.stringify(String(v));
  return [
    ...Object.entries((match ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}=${q(v)}`),
    ...Object.entries((re ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}=~${q(v)}`),
  ];
}

function normalizeRoute(r: RouteConfig & { match?: unknown; match_re?: unknown }): RouteConfig {
  const { match, match_re, ...rest } = r;
  const matchers = [...(rest.matchers ?? []), ...asMatchers(match, match_re)];
  return { ...rest, ...(matchers.length > 0 ? { matchers } : {}), ...(rest.routes ? { routes: rest.routes.map(normalizeRoute) } : {}) };
}

/**
 * A parsed rule file or alertmanager.yml with the differences Prometheus and
 * Alertmanager do not see taken out: groups, receivers and time intervals
 * sorted by name; deprecated `match*` maps and the top-level
 * `mute_time_intervals` in their current spelling; label values as strings.
 */
function normalize(yaml: string): unknown {
  const doc = (load(yaml) ?? {}) as Record<string, unknown>;
  if ("groups" in doc) {
    const file = doc as unknown as RuleFileConfig;
    const labels = (l?: Record<string, unknown>) => (l ? Object.fromEntries(Object.entries(l).map(([k, v]) => [k, String(v)])) : undefined);
    return {
      groups: [...file.groups].sort(byName).map((g) => ({
        ...g,
        ...(g.labels ? { labels: labels(g.labels) } : {}),
        rules: g.rules.map((r) => ({
          ...r,
          ...(r.labels ? { labels: labels(r.labels) } : {}),
          ...("annotations" in r && r.annotations ? { annotations: labels(r.annotations) } : {}),
        })),
      })),
    };
  }
  const am = doc as AlertmanagerConfig & { mute_time_intervals?: AlertmanagerConfig["time_intervals"] };
  const out: Record<string, unknown> = { ...am };
  delete out.mute_time_intervals;
  if (am.route) out.route = normalizeRoute(am.route);
  if (am.inhibit_rules) {
    out.inhibit_rules = am.inhibit_rules.map((r) => {
      const { source_match, source_match_re, target_match, target_match_re, ...rest } = r as Record<string, unknown>;
      const src = [...((rest.source_matchers as string[]) ?? []), ...asMatchers(source_match, source_match_re)];
      const tgt = [...((rest.target_matchers as string[]) ?? []), ...asMatchers(target_match, target_match_re)];
      return { ...rest, ...(src.length ? { source_matchers: src } : {}), ...(tgt.length ? { target_matchers: tgt } : {}) };
    });
  }
  if (am.receivers) out.receivers = [...am.receivers].sort(byName);
  const intervals = [...(am.time_intervals ?? []), ...(am.mute_time_intervals ?? [])].sort(byName);
  if (intervals.length > 0) out.time_intervals = intervals;
  return out;
}

interface Imported {
  source: string;
  files: string[];
  warnings: string[];
  rules?: string;
  alertmanager?: string;
  buildErrors: unknown[];
  lint: { errorCount: number; warningCount: number; output: string };
}

/** A chant project dir inside the package, so the lexicon resolves as it does for a user. */
function projectDir(): string {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["prometheus"] };\n');
  writeFileSync(join(dir, "package.json"), '{ "name": "prometheus-import-roundtrip", "private": true, "type": "module" }\n');
  return dir;
}

/** YAML files -> IR -> TypeScript, all into one project -> `chant build` -> YAML, and `chant lint` over the source. */
async function importAndBuild(...yamls: string[]): Promise<Imported> {
  const dir = projectDir();
  try {
    const srcDir = join(dir, "src");
    const sources: string[] = [];
    const files: string[] = [];
    const warnings: string[] = [];
    for (const yaml of yamls) {
      const ir = new PrometheusParser().parse(yaml);
      warnings.push(...(ir.warnings ?? []));
      for (const file of new PrometheusGenerator().generate(ir)) {
        writeFileSync(join(srcDir, file.path), file.content);
        sources.push(`// ${file.path}\n${file.content}`);
        files.push(file.path);
      }
    }
    const result = await build(srcDir, [prometheusSerializer]);
    const lint = await lintCommand({ path: srcDir, format: "stylish" });
    return {
      source: sources.join("\n"),
      files,
      warnings,
      ...builtFiles(result.outputs.get("prometheus")),
      buildErrors: result.errors,
      lint: { errorCount: lint.errorCount, warningCount: lint.warningCount, output: lint.output },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every import must rebuild equal and lint clean; a fixture may name lint rules it expects to fire. */
async function expectRoundTrip(yaml: string, opts: { lintRules?: string[] } = {}): Promise<Imported> {
  const out = await importAndBuild(yaml);
  expect(out.buildErrors).toEqual([]);
  const rebuilt = out.rules ?? out.alertmanager ?? "";
  expect(normalize(rebuilt)).toEqual(normalize(yaml));
  if (opts.lintRules) {
    for (const rule of opts.lintRules) expect(out.lint.output).toContain(rule);
    const ids = [...out.lint.output.matchAll(/\b([A-Z]{3,4}\d{3})\b/g)].map((m) => m[1]);
    expect(ids.filter((id) => !opts.lintRules!.includes(id))).toEqual([]);
  } else {
    if (out.lint.errorCount + out.lint.warningCount > 0) console.log(out.lint.output);
    expect(out.lint.errorCount).toBe(0);
    expect(out.lint.warningCount).toBe(0);
  }
  return out;
}

const PROMTOOL = hasTool(process.env.PROMTOOL ?? "promtool");
const AMTOOL = hasTool(process.env.AMTOOL ?? "amtool");

const upstream = (file: string): BuiltFile => ({ name: file, yaml: read("upstream", file) });
const handWritten = (file: string): BuiltFile => ({ name: file, yaml: read(file) });

// ── YAML -> TypeScript -> YAML ──────────────────────────────────────

describe("YAML -> TypeScript -> YAML", () => {
  test("the prometheus examples' built rule files and alertmanager.yml", async () => {
    const outputs = await exampleOutputs();
    expect(outputs.map((o) => o.name)).toEqual([
      "alerting/rules.yml",
      "alerting/alertmanager.yml",
      "getting-started/rules.yml",
      "k3d-stack/rules.yml",
      "k3d-stack/alertmanager.yml",
      "rules-from-data/rules.yml",
      "slo/rules.yml",
      "slo/alertmanager.yml",
    ]);
    for (const { name, yaml } of outputs) {
      const out = await expectRoundTrip(yaml);
      // Import is a fixed point from the built file: the same YAML, text for text.
      expect(out.rules ?? out.alertmanager, name).toBe(yaml);
      expect(out.warnings, name).toEqual([]);
    }
  });

  test("the alerting example's two files, imported into one project, build back to both", async () => {
    const [rules, am] = (await exampleOutputs()).filter((o) => o.name.startsWith("alerting/"));
    const out = await importAndBuild(rules.yaml, am.yaml);
    expect(out.buildErrors).toEqual([]);
    expect(out.rules).toBe(rules.yaml);
    expect(out.alertmanager).toBe(am.yaml);
    expect(out.lint.errorCount + out.lint.warningCount, out.lint.output).toBe(0);
    expect(out.files).toEqual(["rules.ts", "receivers.ts", "time-intervals.ts", "routes.ts", "inhibit-rules.ts", "settings.ts"]);
    // Routes name receivers and time intervals by variable.
    expect(out.source).toContain('import { defaultReceiver, paymentsOncall, paymentsTickets } from "./receivers";');
    expect(out.source).toContain('import { outsideOfficeHours } from "./time-intervals";');
    expect(out.source).toContain("receiver: paymentsOncall");
    expect(out.source).toContain("mute_time_intervals: [outsideOfficeHours]");
    // *_file credentials are kept as written.
    expect(out.source).toContain('routing_key_file: "/etc/alertmanager/secrets/pagerduty-key"');
    expect(out.source).toContain('smtp_auth_password_file: "/etc/alertmanager/secrets/smtp-password"');
  });

  test("Slo() output comes back as the Slo declaration", async () => {
    for (const { name, yaml } of sloOutputs()) {
      const out = await expectRoundTrip(yaml);
      expect(out.rules, name).toBe(yaml);
      expect(out.files, name).toEqual(["slos.ts"]);
      expect(out.source, name).toContain(" = Slo({");
      expect(out.source, name).toContain("[{{window}}]");
      expect(out.source, name).not.toContain("new RuleGroup(");
    }
  });

  test("the slo example's rule file is two Slo declarations with their props", async () => {
    const slo = (await exampleOutputs()).find((o) => o.name === "slo/rules.yml")!;
    const out = await expectRoundTrip(slo.yaml);
    expect(out.source).toContain("const orderAcknowledged = Slo({");
    expect(out.source).toContain('description: "Orders are acknowledged without an error span."');
    expect(out.source).toContain('annotations: { runbook_url: "https://runbooks.example.com/order-ack" }');
    expect(out.source).toContain("export { checkout, orderAcknowledged };");
  });

  test("a group an Slo built, then edited by hand, stays a RuleGroup", async () => {
    const [first] = sloOutputs();
    const edited = first.yaml.replace("vector(0.999)", "vector(0.998)");
    const out = await expectRoundTrip(edited);
    expect(out.source).toContain("new RuleGroup(");
    expect(out.source).not.toContain("Slo(");
  });

  test("a rule file using every field", async () => {
    const out = await expectRoundTrip(read("rules-full.yml"));
    expect(out.source).toContain("const nodeLabels: LabelSet = { team: \"platform\", tier: \"1\" };");
    expect(out.source).toContain('query_offset: "30s"');
    expect(out.source).toContain("limit: 100");
    expect(out.source).toContain('keep_firing_for: "5m"');
    // A multi-line expression is a template literal; the PromQL raw string keeps its backticks.
    expect(out.source).toContain("expr: `1 - avg without (cpu, mode) (\n");
    expect(out.source).toContain('"$1", "instance", `(.*):.*`)\'');
    // Go templates are kept as written.
    expect(out.source).toContain('summary: "{{ $labels.instance }} CPU above 90%"');
    expect(out.warnings).toEqual([]);
  });

  test("an alertmanager.yml using every section and the deprecated spellings", async () => {
    const out = await expectRoundTrip(read("alertmanager-full.yml"), { lintRules: ["PROM001"] });
    // The one literal credential is imported as found, and PROM001 reports it.
    expect(out.source).toContain('auth_password: "hunter2"');
    expect(out.lint.output.match(/PROM001/g)).toHaveLength(1);
    // *_file fields and Go templates are kept as written.
    expect(out.source).toContain('url_file: "/etc/alertmanager/secrets/default-webhook-url"');
    expect(out.source).toContain("description: '{{ template \"pagerduty.default.description\" . }}'");
    expect(out.source).toContain('summary: "{{ .GroupLabels.alertname }} in {{ .GroupLabels.cluster }}"');
    // Integrations and global fields the lexicon does not type are carried as data, spread in.
    expect(out.source).toContain("// Receiver \"oncall\": opsgenie_configs is not typed by this lexicon");
    expect(out.source).toContain("...oncallUntyped,");
    expect(out.source).toContain("...globalUntyped,");
    // Deprecated spellings are rewritten, and each rewrite is named.
    expect(out.source).toContain(`matchers: ['severity="page"', 'service=~"^(api|web)$"']`);
    expect(out.source).toContain(`source_matchers: ['severity="page"']`);
    expect(out.source).toContain("mute_time_intervals: [weekends]");
    expect(out.source).toContain("active_time_intervals: [businessHours]");
    expect(out.warnings).toHaveLength(4);
    expect(out.warnings.join("\n")).toContain("match/match_re are written as matchers");
    expect(out.warnings.join("\n")).toContain("top-level mute_time_intervals (weekends)");
  });

  for (const file of UPSTREAM) {
    test(`upstream sample: ${file}`, async () => {
      const yaml = read("upstream", file);
      // The Alertmanager example writes placeholder secrets inline, which PROM001 reports.
      const out = await expectRoundTrip(yaml, file === "alertmanager-simple.yml" ? { lintRules: ["PROM001"] } : {});
      expect(out.warnings).toEqual([]);
      if (file === "alertmanager-simple.yml") {
        expect(out.source).toContain('service_key: "<team-X-key>"');
        expect(out.source).toContain("const tracing: AlertmanagerTracingConfig = {");
        expect(out.lint.output.match(/PROM001/g)).toHaveLength(4);
      }
      if (file === "alertmanager-route-labels.yml") {
        expect(out.source).toContain('reason: "database {{ .GroupLabels.database }}"');
      }
    });
  }
});

// ── promtool and amtool ─────────────────────────────────────────────

describe("upstream tools accept the re-emitted files", () => {
  const rulesFixtures = async (): Promise<BuiltFile[]> => [
    ...(await exampleOutputs()).filter((o) => o.name.endsWith("rules.yml")),
    ...sloOutputs(),
    handWritten("rules-full.yml"),
    ...UPSTREAM.filter((f) => f.startsWith("prometheus-")).map(upstream),
  ];
  const amFixtures = async (): Promise<BuiltFile[]> => [
    ...(await exampleOutputs()).filter((o) => o.name.endsWith("alertmanager.yml")),
    handWritten("alertmanager-full.yml"),
    ...UPSTREAM.filter((f) => f.startsWith("alertmanager-")).map(upstream),
  ];

  test.skipIf(!PROMTOOL)("promtool check rules", async () => {
    for (const { name, yaml } of await rulesFixtures()) {
      const { rules } = await importAndBuild(yaml);
      const r = promtoolCheckRules(rules ?? "");
      expect(r.ok, `${name}: ${r.output}`).toBe(true);
    }
  }, 60_000);

  test.skipIf(!AMTOOL)("amtool check-config", async () => {
    for (const { name, yaml } of await amFixtures()) {
      const { alertmanager } = await importAndBuild(yaml);
      const r = amtoolCheckConfig(alertmanager ?? "");
      expect(r.ok, `${name}: ${r.output}`).toBe(true);
    }
  }, 60_000);
});
