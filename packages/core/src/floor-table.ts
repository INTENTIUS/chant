/**
 * `@intentius/chant/floor-table` (#4792): every floor a product may
 * feature-detect on, as one table, and the version compare a product asks it
 * with.
 *
 * A floor is a constant `<NAME>_FLOOR` in chant core naming the first chant
 * release with a part (an export, a field chant writes, a flag). A product
 * that runs on several chant releases checks one before it calls the part. The
 * rows are written by scripts/floor-table.ts from the constants themselves
 * (./floor-table.data.ts), and scripts/release-floors.ts fails while a floor
 * is missing from them. A floor added since the last release has the version
 * of the next one, NEXT_RELEASE, which the release moves on.
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
  /** The file under packages/core/src that declares it. */
  file: string;
  /** The `@intentius/chant` subpaths a product can import the constant from. */
  modules: readonly string[];
}

/** Every floor, in the order the files declare them. Two files may declare the same name; each is a row. */
export const FLOOR_TABLE: readonly FloorRow[] = FLOOR_ROWS;

/** The rows named `name`: one, or more when two files declare it. */
export function floorRows(name: string): FloorRow[] {
  return FLOOR_TABLE.filter((r) => r.name === name);
}

/**
 * The version a product must reach for the floor `name`, or undefined when no
 * file declares it. When two files declare the name, the higher version, so a
 * check that passes holds for either.
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
