/**
 * The known-module catalog (chant#4560): choudoufu's module compatibility
 * table (choudoufu#2292, `live/module-compat.json`), vendored in
 * `./static-tier.ts` and read by TF047 and by terragucci's tip and estate
 * column (terragucci#1286).
 *
 * The catalog holds the static tier only. A static row is one
 * terraform-aws-modules example at one tag, measured offline by choudoufu's
 * refusal probe in the onboarded form: `clear` means `choudoufu live-check`
 * plans it, `refused` lists choudoufu refusal IDs with site counts. The
 * gauntlet tier (end-to-end runs against an emulator) is a separate table in
 * choudoufu, has no rows until choudoufu#2291's run, and is never folded into
 * these numbers: every result here carries `tier: "static"`, and a figure in
 * it counts static rows only.
 *
 * This subpath, `@intentius/chant-lexicon-terraform/module-catalog`, imports
 * nothing but its own data, so a consumer can load it on its own.
 */
import { SOURCE_COMMIT, SOURCE_PATH, STATIC_MEASUREMENT, STATIC_ROWS } from "./static-tier";
import type { StaticRow } from "./types";

export type { StaticRefusal, StaticRow, StaticMeasurement, StaticSource } from "./types";

/** Where the vendored rows came from. */
export const MODULE_CATALOG_SOURCE = {
  repo: "INTENTIUS/choudoufu",
  path: SOURCE_PATH,
  commit: SOURCE_COMMIT,
  /** The static tier's measurement date. */
  date: STATIC_MEASUREMENT.date,
  /** The choudoufu commit the static tier was measured at. */
  measuredAt: STATIC_MEASUREMENT.commit,
  /** The hashicorp/aws provider version the static tier was measured with. */
  awsProvider: STATIC_MEASUREMENT.aws_provider,
} as const;

/** choudoufu's site page that renders both tiers. */
export const MODULE_COMPATIBILITY_PAGE = "https://intentius.io/choudoufu/aws/compatibility/#modules";

/** The tiers this catalog holds. */
export type ModuleCatalogTier = "static";

/** Every static row, as vendored. */
export const staticRows: readonly StaticRow[] = STATIC_ROWS;

/** One refusal ID across the examples of a module version that carry it. */
export interface ModuleRefusalSummary {
  id: string;
  /** Sites summed across the examples that carry it. */
  sites: number;
  docsUrl: string;
  /** Example directories that carry it, sorted. */
  examples: string[];
}

/**
 * What the catalog says about one pinned module version.
 *
 * - `unknown-module`: no static row for this module at any version.
 * - `unknown-version`: rows for the module, none measured at this version
 *   (`measuredVersions` lists the ones there are).
 * - `refused`: at least one example at this version is refused.
 * - `clear`: every measured example at this version is clear.
 */
export interface ModuleCompatibility {
  module: string;
  /** The pinned version, without a leading `v` or `=`. */
  version: string;
  tier: ModuleCatalogTier;
  status: "unknown-module" | "unknown-version" | "clear" | "refused";
  /** Static rows measured at this version (an `unmeasured` row is left out). */
  examples: number;
  clearExamples: number;
  refusedExamples: number;
  /** Refusal IDs at this version, most refused examples first, then by ID. */
  refusals: ModuleRefusalSummary[];
  /** Versions the static tier measured for this module, without a leading `v`. */
  measuredVersions: string[];
}

/**
 * The registry address of a module source, without a registry host, a
 * `//subdir` or a query, lowercased: `registry.terraform.io/terraform-aws-modules/iam/aws//modules/iam-role`
 * gives `terraform-aws-modules/iam/aws`. Undefined when the source is not a
 * three-part registry address.
 */
export function registryModuleAddress(source: string): string | undefined {
  let s = source.trim().split("?")[0];
  const sub = s.indexOf("//");
  if (sub >= 0) s = s.slice(0, sub);
  const parts = s.split("/");
  if (parts.length === 4 && parts[0].includes(".")) parts.shift();
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p))) return undefined;
  return parts.join("/").toLowerCase();
}

/** `= 1.4.0`, `v1.4.0` and `1.4.0` all give `1.4.0`; a range gives undefined. */
export function exactModuleVersion(version: string): string | undefined {
  const v = version.trim().replace(/^=\s*/, "").replace(/^v/, "");
  return /^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v) ? v : undefined;
}

const bare = (version: string): string => version.replace(/^v/, "");

function byModule(): Map<string, StaticRow[]> {
  const out = new Map<string, StaticRow[]>();
  for (const row of STATIC_ROWS) {
    const key = row.module.toLowerCase();
    const list = out.get(key) ?? [];
    list.push(row);
    out.set(key, list);
  }
  return out;
}

let index: Map<string, StaticRow[]> | undefined;

/**
 * The catalog's answer for a module `source` pinned at `version`, or
 * undefined when the source is not a registry address or the version is not
 * exact (a range is TF039's finding, and the catalog has no row for one).
 */
export function moduleCompatibility(source: string, version: string): ModuleCompatibility | undefined {
  const module = registryModuleAddress(source);
  const pinned = exactModuleVersion(version);
  if (module === undefined || pinned === undefined) return undefined;

  index ??= byModule();
  const rows = index.get(module) ?? [];
  const measuredVersions = [...new Set(rows.map((r) => bare(r.version)))].sort();
  const at = rows.filter((r) => bare(r.version) === pinned && r.verdict !== "unmeasured");
  const refusedRows = at.filter((r) => r.verdict === "refused");

  const refusals = new Map<string, ModuleRefusalSummary>();
  for (const row of refusedRows) {
    for (const r of row.refusals) {
      const s = refusals.get(r.id) ?? { id: r.id, sites: 0, docsUrl: r.docs_url, examples: [] };
      s.sites += r.sites;
      if (!s.examples.includes(row.example)) s.examples.push(row.example);
      refusals.set(r.id, s);
    }
  }
  for (const s of refusals.values()) s.examples.sort();

  const status: ModuleCompatibility["status"] =
    rows.length === 0 ? "unknown-module" : at.length === 0 ? "unknown-version" : refusedRows.length > 0 ? "refused" : "clear";

  return {
    module,
    version: pinned,
    tier: "static",
    status,
    examples: at.length,
    clearExamples: at.filter((r) => r.verdict === "clear").length,
    refusedExamples: refusedRows.length,
    refusals: [...refusals.values()].sort((a, b) => b.examples.length - a.examples.length || a.id.localeCompare(b.id)),
    measuredVersions,
  };
}
