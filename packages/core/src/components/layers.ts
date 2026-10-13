/**
 * Kahn layering over a plain name graph: the wave computation
 * `resolveComponentGraph` (./driver.ts) runs for `chant components fan-out`.
 *
 * It lives on its own, with no imports, so code that needs the same order
 * without the driver can take it. The terraform lexicon's pin-bump rollout
 * (#3189) orders roots with it, and that code has to bundle without the
 * driver's gate and ledger modules (#3421).
 */

/** The layers, or the names left when no name is ready (a cycle). */
export type KahnLayers = { waves: string[][]; cycle?: undefined } | { waves?: undefined; cycle: string[] };

/**
 * Split `deps` (name -> the names it depends on) into waves. A name is ready
 * once every dependency it names has been placed in an earlier wave. Names in
 * one wave are sorted. A dependency that is not a key of `deps` is the caller's
 * to refuse or drop first: here it never becomes ready, so it reads as a cycle.
 */
export function kahnLayers(deps: ReadonlyMap<string, ReadonlySet<string>>): KahnLayers {
  const remaining = new Set(deps.keys());
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining].filter((n) => [...deps.get(n)!].every((d) => !remaining.has(d))).sort();
    if (wave.length === 0) return { cycle: [...remaining].sort() };
    for (const n of wave) remaining.delete(n);
    waves.push(wave);
  }
  return { waves };
}
