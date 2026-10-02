/**
 * Template versions and version ranges, for migration chains (#2550, D9).
 *
 * A template's version is read from the ref it was pinned at: `v1.4.0`,
 * `1.4`, or a prefixed release tag such as `chant-v0.80.0`. Missing minor and
 * patch numbers read as 0. A ref that is not a version (a branch, a commit)
 * has none, and a chain of migrations cannot be planned from it.
 *
 * Ranges use the familiar npm subset: comparators (`>=1.0.0 <2.0.0`), `^`,
 * `~`, `x` wildcards, a bare version for an exact match, `*` for any, and
 * `||` between alternatives. Pre-release tags compare below their release,
 * and a range matches a pre-release only through an exact comparator.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** The pre-release label after `-`, or empty for a release. */
  pre: string;
}

const VERSION_TAIL = /(?:^|[-_/@])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** The version a ref names, or null when it names none. */
export function parseVersion(ref: string | undefined | null): Version | null {
  if (!ref) return null;
  const m = VERSION_TAIL.exec(ref.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[4] ?? "" };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;
}

export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export class VersionRangeError extends Error {
  override name = "VersionRangeError";
}

type Comparator = { op: "<" | "<=" | ">" | ">=" | "="; v: Version };

function partial(text: string, range: string): { v: Version; parts: number } {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!m) throw new VersionRangeError(`"${range}" is not a version range: cannot read "${text}"`);
  const nums = [m[1], m[2], m[3]];
  let parts = 0;
  for (const n of nums) {
    if (n === undefined || /^[xX*]$/.test(n)) break;
    parts++;
  }
  const at = (i: number) => (i < parts ? Number(nums[i]) : 0);
  return { v: { major: at(0), minor: at(1), patch: at(2), pre: parts === 3 ? (m[4] ?? "") : "" }, parts };
}

function bump(v: Version, part: number): Version {
  if (part === 0) return { major: v.major + 1, minor: 0, patch: 0, pre: "" };
  if (part === 1) return { major: v.major, minor: v.minor + 1, patch: 0, pre: "" };
  return { major: v.major, minor: v.minor, patch: v.patch + 1, pre: "" };
}

/** The comparators of one `||` alternative. */
function comparators(alt: string, range: string): Comparator[] {
  const out: Comparator[] = [];
  const tokens = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token === "*" || /^[xX]$/.test(token)) continue;
    const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)!;
    const op = m[1] ?? "";
    const { v, parts } = partial(m[2], range);
    if (op === "^") {
      const upper = v.major > 0 || parts === 1 ? bump(v, 0) : v.minor > 0 || parts === 2 ? bump(v, 1) : bump(v, 2);
      out.push({ op: ">=", v }, { op: "<", v: upper });
    } else if (op === "~") {
      out.push({ op: ">=", v }, { op: "<", v: bump(v, parts >= 2 ? 1 : 0) });
    } else if (op === "" || op === "=") {
      if (parts === 3) out.push({ op: "=", v });
      else if (parts > 0) out.push({ op: ">=", v }, { op: "<", v: bump(v, parts - 1) });
    } else if (parts < 3 && (op === ">" || op === "<=")) {
      // `>1.2` means past every 1.2.x; `<=1.2` includes every 1.2.x.
      out.push({ op: op === ">" ? ">=" : "<", v: bump(v, parts - 1) });
    } else {
      out.push({ op: op as Comparator["op"], v });
    }
  }
  return out;
}

function test(v: Version, c: Comparator): boolean {
  const d = compareVersions(v, c.v);
  switch (c.op) {
    case "<":
      return d < 0;
    case "<=":
      return d <= 0;
    case ">":
      return d > 0;
    case ">=":
      return d >= 0;
    case "=":
      return d === 0;
  }
}

/** Check a range's syntax, throwing {@link VersionRangeError} when it cannot be read. */
export function validateRange(range: string): void {
  for (const alt of range.split("||")) comparators(alt, range);
}

/** Whether `version` falls in `range`. */
export function satisfies(version: Version, range: string): boolean {
  return range.split("||").some((alt) => {
    const cs = comparators(alt, range);
    if (version.pre && !cs.some((c) => c.op === "=" && compareVersions(c.v, version) === 0)) return false;
    return cs.every((c) => test(version, c));
  });
}
