/**
 * Coverage analysis for the cpln lexicon.
 *
 * The shared `computeCoverage` measures CloudFormation-shaped dimensions
 * (lifecycle flags, return attributes, extension constraints) that an
 * eight-kind OpenAPI lexicon has no analog for — it would report 0% on
 * everything and mean nothing. What cpln needs to know is two different things:
 *
 *   1. **Kind coverage** — which of the API's kinds are modelled as declarables
 *      and which are deliberately not, with the reason, so an unmodelled kind
 *      is a decision on record rather than an omission nobody noticed.
 *   2. **Property coverage** — for each modelled kind, how much of its writable
 *      surface is typed rather than loosened to `Record<string, unknown>`. A
 *      drop here means upstream reshaped something and the parser quietly
 *      stopped following it.
 *
 * Both are measured against the spec the generator actually reads, so running
 * this after `just generate` compares like with like.
 */

import { fetchSchemas, SPEC_KEY } from "./spec/fetch";
import { parseCplnOpenAPI } from "./spec/parse";
import { KINDS } from "./kinds";

/**
 * Kinds the API exposes that this lexicon does not model, and why.
 *
 * "First pass" is a real reason, not a placeholder: each of these is a row in
 * `kinds.ts` away, and listing them keeps the gap visible instead of leaving a
 * reader to infer it from the absence.
 */
export const UNMODELLED_KINDS: Record<string, string> = {
  agent: "first pass — org infrastructure, not the workload surface",
  auditctx: "first pass — governance",
  cloudaccount: "first pass — org infrastructure",
  group: "first pass — principals",
  serviceaccount: "first pass — principals",
  user: "first pass — principals; membership is invite-driven, not declarative",
  image: "read-mostly — images are produced by `cpln image build`, not declared",
  location: "read-mostly — locations are platform-provided; only `patch` is writable",
  org: "not declarable — an org is immutable and cannot be deleted",
  quota: "read-only",
  mk8s: "first pass — a very large nested spec that deserves its own pass",
  task: "read-only — an operation record, not estate",
  deployment: "read-only — a workload's runtime status",
};

export interface KindCoverage {
  kind: string;
  /** Writable top-level properties on the resource. */
  properties: number;
  /** Property types generated beneath it. */
  propertyTypes: number;
  /** Properties resolving to a loose map rather than a typed shape. */
  loose: number;
}

export interface CplnCoverage {
  modelled: number;
  unmodelled: number;
  propertyTypes: number;
  kinds: KindCoverage[];
  /** Share of writable properties across all kinds that are typed. */
  typedRatio: number;
}

const LOOSE = /^Record<string, (unknown|any)>/;

/** Compute coverage from the spec the generator reads. */
export async function computeCplnCoverage(options?: { force?: boolean }): Promise<CplnCoverage> {
  const schemas = await fetchSchemas({ force: options?.force });
  const raw = schemas.get(SPEC_KEY);
  if (!raw) throw new Error(`spec fetch returned no ${SPEC_KEY} entry`);

  const results = parseCplnOpenAPI(raw);
  const resources = results.filter((r) => !r.isProperty);
  const propertyTypes = results.filter((r) => r.isProperty);

  const kinds: KindCoverage[] = [];
  let typed = 0;
  let total = 0;

  for (const kind of KINDS) {
    const resource = resources.find((r) => r.resource.typeName === kind.typeName);
    if (!resource) continue;

    const properties = resource.resource.properties;
    const loose = properties.filter((p) => LOOSE.test(p.tsType)).length;
    // Property types whose name is derived from this kind's class name.
    const owned = propertyTypes.filter((p) =>
      p.resource.typeName.split("::").pop()!.startsWith(kind.className),
    ).length;

    kinds.push({ kind: kind.kind, properties: properties.length, propertyTypes: owned, loose });
    typed += properties.length - loose;
    total += properties.length;
  }

  return {
    modelled: resources.length,
    unmodelled: Object.keys(UNMODELLED_KINDS).length,
    propertyTypes: propertyTypes.length,
    kinds,
    typedRatio: total === 0 ? 0 : typed / total,
  };
}

/**
 * Print the coverage report. Exits non-zero when `minOverall` is set and the
 * typed ratio falls below it, so CI can gate on the surface not silently
 * loosening.
 */
export async function analyzeCplnCoverage(options?: {
  verbose?: boolean;
  force?: boolean;
  minOverall?: number;
}): Promise<CplnCoverage> {
  const coverage = await computeCplnCoverage({ force: options?.force });

  console.error(
    `cpln coverage: ${coverage.modelled} kinds modelled, ${coverage.unmodelled} not, ` +
      `${coverage.propertyTypes} property types, ${(coverage.typedRatio * 100).toFixed(0)}% of writable ` +
      `properties typed`,
  );

  for (const kind of coverage.kinds) {
    const detail = kind.loose > 0 ? ` (${kind.loose} loose)` : "";
    console.error(
      `  ${kind.kind.padEnd(11)} ${String(kind.properties).padStart(2)} properties, ` +
        `${String(kind.propertyTypes).padStart(3)} property types${detail}`,
    );
  }

  if (options?.verbose) {
    console.error("\nNot modelled:");
    for (const [kind, reason] of Object.entries(UNMODELLED_KINDS)) {
      console.error(`  ${kind.padEnd(15)} ${reason}`);
    }
  }

  if (options?.minOverall !== undefined && coverage.typedRatio * 100 < options.minOverall) {
    console.error(
      `\nTyped ratio ${(coverage.typedRatio * 100).toFixed(0)}% is below the ${options.minOverall}% minimum.`,
    );
    process.exitCode = 1;
  }

  return coverage;
}
