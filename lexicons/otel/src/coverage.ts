/**
 * Coverage of the otel lexicon against a distribution manifest (#3361).
 *
 * The question a collector lexicon answers is "which components of the binary
 * I run does chant type?". The committed snapshot holds the `otelcol-contrib`
 * and `otelcol-k8s` manifests' component index at the pinned releases, with
 * each component's type and whether upstream publishes a `config.schema.yaml`
 * for it. Each component is in one of three places:
 *
 * - a built-in, with its config type generated from the schema (or
 *   hand-written when upstream publishes none);
 * - not built in, reached through `defineComponent`, which carries its own pin;
 * - a built-in the distribution does not ship, which is a lexicon defect.
 *
 * `unaccountedKinds` (what `check-lexicon` gates on) lists the defects: a
 * built-in missing from the contrib manifest, or a built-in whose upstream
 * schema exists but whose config type is not generated from it. Everything
 * here is read from the snapshot, offline.
 */

import { BUILTIN_SPECS } from "./spec/builtins";
import { loadSnapshot } from "./spec/snapshot";
import { DISTRIBUTIONS, type DistributionName, type IndexedComponent, type OtelSpecSnapshot } from "./spec/fetch";
import type { ComponentKind } from "./model";

export interface DistributionCoverage {
  distribution: DistributionName;
  version: string;
  /** Components the manifest lists. */
  components: number;
  /** Of those, how many ship a `config.schema.yaml`. */
  withSchema: number;
  /** Built-ins in this distribution, as `kind/type`. */
  builtin: string[];
  /** Built-ins this distribution does not ship, as `kind/type`. */
  builtinMissing: string[];
  /** Components with a schema chant does not build in, as `kind/type`; `defineComponent` reaches them. */
  schemaNotBuiltin: string[];
  /** Components without a schema chant does not build in, as `kind/type` (or the module when it has no type). */
  noSchemaNotBuiltin: string[];
}

export interface OtelCoverageReport {
  /** Built-ins whose config type is generated from upstream, as class names. */
  generated: string[];
  /** Built-ins with a hand-written config type, because upstream publishes no schema, as class names. */
  handWritten: string[];
  distributions: DistributionCoverage[];
  /** The defects, for `check-lexicon`. */
  unaccountedKinds: string[];
}

function label(c: { kind: ComponentKind; type?: string; module?: string }): string {
  return `${c.kind}/${c.type ?? c.module}`;
}

function find(index: IndexedComponent[], kind: ComponentKind, type: string): IndexedComponent | undefined {
  return index.find((c) => c.kind === kind && (c.type === type || c.deprecatedType === type));
}

/** The coverage report for a snapshot (the committed one by default). */
export function coverageReport(snapshot: OtelSpecSnapshot = loadSnapshot()): OtelCoverageReport {
  const contrib = snapshot.distributions["otelcol-contrib"];
  const generated: string[] = [];
  const handWritten: string[] = [];
  const unaccounted: string[] = [];
  for (const b of BUILTIN_SPECS) {
    const hit = find(contrib, b.kind, b.type);
    if (!hit) {
      unaccounted.push(`${b.className}: ${b.kind} "${b.type}" is not in otelcol-contrib ${snapshot.versions["otelcol-contrib"]}`);
      continue;
    }
    if (hit.schema && snapshot.schemas[hit.schema] !== undefined) generated.push(b.className);
    else if (hit.schema) unaccounted.push(`${b.className}: upstream ships ${hit.schema} but the snapshot does not carry it; run \`just snapshot\``);
    else handWritten.push(b.className);
  }

  const distributions = DISTRIBUTIONS.map((distribution): DistributionCoverage => {
    const index = snapshot.distributions[distribution];
    const builtinHits = new Set<IndexedComponent>();
    const builtin: string[] = [];
    const builtinMissing: string[] = [];
    for (const b of BUILTIN_SPECS) {
      const hit = find(index, b.kind, b.type);
      if (hit) {
        builtinHits.add(hit);
        builtin.push(`${b.kind}/${b.type}`);
      } else builtinMissing.push(`${b.kind}/${b.type}`);
    }
    const others = index.filter((c) => !builtinHits.has(c));
    return {
      distribution,
      version: snapshot.versions[distribution],
      components: index.length,
      withSchema: index.filter((c) => c.schema).length,
      builtin,
      builtinMissing,
      schemaNotBuiltin: others.filter((c) => c.schema).map(label),
      noSchemaNotBuiltin: others.filter((c) => !c.schema).map(label),
    };
  });

  return { generated, handWritten, distributions, unaccountedKinds: unaccounted };
}

/** The report as `coverage()` prints it. */
export function formatCoverage(report: OtelCoverageReport): string {
  const lines = [
    `otel: ${report.generated.length + report.handWritten.length} built-in components, ${report.generated.length} with config types generated from upstream config.schema.yaml`,
  ];
  if (report.handWritten.length > 0) lines.push(`  hand-written (no upstream schema): ${report.handWritten.join(", ")}`);
  for (const d of report.distributions) {
    lines.push(
      `${d.distribution} ${d.version}: ${d.components} components, ${d.withSchema} with a schema; ` +
        `${d.builtin.length} built in, ${d.schemaNotBuiltin.length + d.noSchemaNotBuiltin.length} through defineComponent`,
    );
    if (d.builtinMissing.length > 0) lines.push(`  built-ins this distribution does not ship: ${d.builtinMissing.join(", ")}`);
  }
  for (const u of report.unaccountedKinds) lines.push(`  unaccounted: ${u}`);
  return lines.join("\n");
}
