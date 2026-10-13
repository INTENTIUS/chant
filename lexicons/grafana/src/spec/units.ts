/**
 * The units Grafana knows, for GRAF115.
 *
 * A field's `unit` is a free string in the dashboard schema. Grafana looks it
 * up in its value-format registry (`getValueFormat()` in
 * `packages/grafana-data/src/valueFormats/valueFormats.ts`): a registered id
 * formats the value, `<kind>:<arg>` builds a custom unit, and anything else is
 * shown after the value as a literal suffix. So `"byte"` renders `5 byte`
 * where `"bytes"` would render `5 B`, and nothing complains.
 *
 * The ids in `units.gen.ts` are taken from the registry at
 * `GRAFANA_UNITS_SOURCE` by `just fetch-units`.
 */

import { GRAFANA_UNIT_IDS } from "./units.gen";

export const GRAFANA_UNITS_SOURCE = Object.freeze({
  repo: "grafana/grafana",
  ref: "v13.2.2",
  commit: "3db12332b66497c31f8ad2a5fb0eb0fe0ca05a7e",
  path: "packages/grafana-data/src/valueFormats/categories.ts",
});

/** Old ids `buildFormats()` in valueFormats.ts still resolves (v13.2.2). */
export const LEGACY_UNIT_ALIASES: readonly string[] = ["farenheit"];

/**
 * The `<kind>:` prefixes `getValueFormat()` turns into a custom unit
 * (v13.2.2): `prefix:$`, `suffix: req`, `time:YYYY-MM-DD`, `si:mF`,
 * `count:reqs`, `currency:€` (or `currency:financial:€[:suffix]`) and
 * `bool:yes/no`.
 */
export const CUSTOM_UNIT_KINDS: readonly string[] = ["prefix", "suffix", "time", "si", "count", "currency", "bool"];

const KNOWN = new Set(GRAFANA_UNIT_IDS);

export { GRAFANA_UNIT_IDS };

/** Whether Grafana formats `unit` as a unit rather than showing it as a literal suffix. An empty unit means none. */
export function isGrafanaUnit(unit: string): boolean {
  if (unit === "" || KNOWN.has(unit)) return true;
  const colon = unit.indexOf(":");
  return colon > 0 && CUSTOM_UNIT_KINDS.includes(unit.slice(0, colon));
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length];
}

/** The registered id `unit` most likely meant: same letters in another case, or one or two edits away. */
export function closestGrafanaUnit(unit: string): string | undefined {
  const lower = unit.toLowerCase();
  const sameCase = GRAFANA_UNIT_IDS.filter((id) => id.toLowerCase() === lower);
  if (sameCase.length === 1) return sameCase[0];
  if (unit.length < 3) return undefined;
  let best: string | undefined;
  let bestDistance = Math.min(2, Math.floor(unit.length / 3));
  for (const id of GRAFANA_UNIT_IDS) {
    if (LEGACY_UNIT_ALIASES.includes(id)) continue;
    const d = distance(lower, id.toLowerCase());
    if (d < bestDistance || (d === bestDistance && best === undefined)) {
      best = id;
      bestDistance = d;
    }
  }
  return best;
}
