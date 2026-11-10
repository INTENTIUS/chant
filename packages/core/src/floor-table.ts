/**
 * `@intentius/chant/floor-table` (#4792): every floor a product may
 * feature-detect on, as one table, and the version compare a product asks it
 * with.
 *
 * A floor is a constant `<NAME>_FLOOR` in chant core, or in a lexicon's
 * src/chant-floors.ts (#4916), naming the first chant release with a part
 * (an export, a field chant writes, a flag). Lexicons release with chant at
 * the same version, so a lexicon's floor is a chant version too. A product
 * that runs on several chant releases checks one before it calls the part. The
 * rows are written by scripts/floor-table.ts from the constants themselves
 * (./floor-table.data.ts), and scripts/release-floors.ts fails while a floor
 * is missing from them. A floor added since the last release has the version
 * of the next one, NEXT_RELEASE, which the release moves on. Each name is
 * declared once (#4916), and scripts/floor-table.ts fails on a second.
 *
 * `chant dev dead-guards` (./dead-guards.ts) reads this table against a
 * product's chant pin and names each check the pin already meets.
 */
import { FLOOR_ROWS } from "./floor-table.data";

/** One floor. */
export interface FloorRow {
  /** The constant's name, `CI_IMAGE_FLOOR`. */
  name: string;
  /** The first chant release with the part. A floor not yet released has the next release's number. */
  version: string;
  /** What the floor gates: the first sentence of the constant's doc comment. */
  gates: string;
  /** The issue that added it, `#4784`, or a product's (`terragucci issue 1303`). */
  issue?: string;
  /** The file under packages/core/src that declares it, or a lexicon's floors file from the repository root (`lexicons/terraform/src/chant-floors.ts`). */
  file: string;
  /** The subpaths a product can import the constant from: `@intentius/chant/...`, or the lexicon's own. */
  modules: readonly string[];
}

/** Every floor, core's in the order its files declare them, then each lexicon's. */
export const FLOOR_TABLE: readonly FloorRow[] = FLOOR_ROWS;

/** The rows named `name`: one, or none. A table a caller builds may hold more. */
export function floorRows(name: string): FloorRow[] {
  return FLOOR_TABLE.filter((r) => r.name === name);
}

/**
 * The version a product must reach for the floor `name`, or undefined when no
 * file declares it. Should a name ever have two rows, the higher version, so
 * a check that passes holds for either.
 */
export function floorVersion(name: string): string | undefined {
  const rows = floorRows(name);
  return rows.length === 0 ? undefined : rows.map((r) => r.version).reduce((a, b) => (compareChantVersions(a, b) >= 0 ? a : b));
}

/** A version's numbers, `0.124.84` as [0, 124, 84]; a pre-release or build suffix is dropped. */
function parts(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareChantVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Whether chant `version` has the part the floor `name` gates; false for a name no file declares. */
export function chantMeets(version: string, name: string): boolean {
  const floor = floorVersion(name);
  return floor !== undefined && compareChantVersions(version, floor) >= 0;
}
