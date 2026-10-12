/**
 * Wave gate names and the share split of a wide wave (#3766), the parts of
 * the wave engine (`./wave-engine.ts`) that the Op waves spec module
 * (`./op/op-waves.ts`) needs. That module is in the gate-decision bundle
 * (`./gate-decision.ts` re-exports a constant from it), so this imports
 * nothing and keeps the change-set digest code out of that bundle.
 */

/** The default wave gate name pattern: `{gate}` is the base gate name, `{k}` the wave's number. */
export const WAVE_GATE_NAME_PATTERN = "{gate}-wave-{k}";

/**
 * The gate wave `k` waits on under a name pattern (#3821). With the default
 * pattern this is `waveGateName(gate, k)` from `./gated-waves.ts`; an Op
 * waves spec's `gateName` names another (such as `"wave-{k}"`) so approvals
 * already on the ledger under a product's old names keep matching.
 *
 * `{gate}` is filled in before `{k}`, as `opWaveGateName` always did, so a
 * base gate name holding the text `{k}` is filled in too. That is the one
 * input on which this and `waveGateName` differ, and each entry point keeps
 * the one it shipped with.
 */
export function waveGateNameFrom(pattern: string | undefined, gate: string, k: number): string {
  return (pattern ?? WAVE_GATE_NAME_PATTERN).replaceAll("{gate}", gate).replaceAll("{k}", String(k));
}

/**
 * Share `share` (1-based) of `shares` of a wide wave (#3679): the items
 * sorted by `keyOf`, cut into contiguous slices whose sizes differ by at most
 * one. The deciding job and every share job cut the same way, so each item
 * is applied by exactly one share.
 */
export function waveShare<T>(items: readonly T[], share: number, shares: number, keyOf: (item: T) => string): T[] {
  const sorted = [...items].sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const base = Math.floor(sorted.length / shares);
  const extra = sorted.length % shares;
  const start = (share - 1) * base + Math.min(share - 1, extra);
  const size = base + (share <= extra ? 1 : 0);
  return sorted.slice(start, start + size);
}
