/**
 * Whether what Grafana holds already is what the applier would write
 * (#2948), so a re-apply reports `unchanged` and writes nothing.
 *
 * Grafana does not answer this itself: a `PUT` of identical content still
 * bumps `generation` and `resourceVersion` (measured on 12.4.11 and 13.2.2),
 * so a no-op cannot be told from an update after the fact. And the stored
 * dashboard is not the one sent: Grafana fills in defaults
 * (`fiscalYearStartMonth: 0`, `links: []`, `timepicker: {}`, ...), adds the
 * built-in annotation, drops `null`s and empty `options`, and may migrate
 * `schemaVersion`.
 *
 * So the test is one-sided: every value the applier would send must be in
 * the live object, equal, and anything Grafana added on top is ignored. An
 * array must match element for element, since a panel added in the UI is a
 * change. The noise is the same list the drift hooks carry (#2946):
 *
 * - `null` and empty objects sent are satisfied by an absent key;
 * - the built-in "Annotations & Alerts" annotation is ignored on both sides;
 * - `id`, `version` and `uid` at the top level are identity, not content, and
 *   `schemaVersion` is Grafana's to migrate.
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Top-level dashboard keys that are identity or Grafana-managed, never content. */
export const IDENTITY_KEYS: readonly string[] = ["id", "uid", "version", "schemaVersion"];

function isBuiltInAnnotation(v: unknown): boolean {
  return isObject(v) && (v.builtIn === 1 || v.builtIn === true);
}

function covers(want: unknown, live: unknown, path: string[]): boolean {
  if (want === null || want === undefined) return live === null || live === undefined;
  if (Array.isArray(want)) {
    if (!Array.isArray(live)) return want.length === 0 && live === undefined;
    const annotations = path[path.length - 1] === "list" && path[path.length - 2] === "annotations";
    const w = annotations ? want.filter((a) => !isBuiltInAnnotation(a)) : want;
    const l = annotations ? live.filter((a) => !isBuiltInAnnotation(a)) : live;
    return w.length === l.length && w.every((x, i) => covers(x, l[i], [...path, String(i)]));
  }
  if (isObject(want)) {
    if (live === undefined || live === null) return Object.values(want).every((v) => covers(v, undefined, path));
    if (!isObject(live)) return false;
    return Object.entries(want).every(([k, v]) => covers(v, live[k], [...path, k]));
  }
  return want === live;
}

/**
 * True when `live` already holds everything in `want`. For a dashboard,
 * the top-level identity keys ({@link IDENTITY_KEYS}) are left out of the
 * comparison.
 */
export function converged(want: unknown, live: unknown, opts: { dashboard?: boolean } = {}): boolean {
  if (!opts.dashboard || !isObject(want)) return covers(want, live, []);
  const content = Object.fromEntries(Object.entries(want).filter(([k]) => !IDENTITY_KEYS.includes(k)));
  return covers(content, live, []);
}
