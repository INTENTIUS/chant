/**
 * The plans an op-waves `pr-review` wave records for a pull request's head
 * (#3684, #3865): `_wave-plans/<name>/<head>.json` on `chant/lifecycle`,
 * written by `chant run wave --record-plans` (`../op/op-waves-run.ts`) and read
 * after the merge, where the review of that head approves the digests it
 * planned and only those (`../op/gate-review.ts`).
 *
 * The parser and the readers here touch no git, no clock and no file: they
 * take a {@link LedgerReadPort}, so a product that shows or checks the
 * records bundles them in one file (`wave-plans-bundle.test.ts` holds the
 * import graph). `gitLedgerReadPort({ member })` from `./git.ts` reads a
 * workspace member's records (`_members/<member>/_wave-plans/...`) from a
 * checkout.
 */
import type { LedgerReadPort } from "./ledger-port";

/** The digests each wave planned at one commit, recorded for a review of it to approve. */
export interface HeadPlans {
  version: 1;
  /** The Op waves spec's name. */
  name: string;
  /** The commit the waves were planned at: a pull request's head. */
  head: string;
  timestamp: string;
  waves: Array<{ wave: number; name: string; digest: string }>;
}

/** Where {@link HeadPlans} for `head` live on `chant/lifecycle`: `_wave-plans/<name>/<head>.json`. */
export const HEAD_PLANS_DIR = "_wave-plans";

export function headPlansPath(name: string, head: string): { dir: string; file: string } {
  return { dir: `${HEAD_PLANS_DIR}/${name}`, file: `${head}.json` };
}

/**
 * Parse one record. Null when the text is not JSON or not a version 1 plans
 * record: a record that cannot be read approves nothing.
 */
export function parseHeadPlans(text: string | null): HeadPlans | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (r.version !== 1 || typeof r.name !== "string" || typeof r.head !== "string" || typeof r.timestamp !== "string" || !Array.isArray(r.waves)) return null;
  const waves: HeadPlans["waves"] = [];
  for (const w of r.waves) {
    if (w === null || typeof w !== "object") return null;
    const { wave, name, digest } = w as Record<string, unknown>;
    if (typeof wave !== "number" || typeof name !== "string" || typeof digest !== "string") return null;
    waves.push({ wave, name, digest });
  }
  return { version: 1, name: r.name, head: r.head, timestamp: r.timestamp, waves };
}

/** The record for `head` of the spec `name`, or null when none was recorded or it cannot be read. */
export async function readHeadPlans(port: LedgerReadPort, name: string, head: string): Promise<HeadPlans | null> {
  const { dir, file } = headPlansPath(name, head);
  return parseHeadPlans(await port.read(dir, file));
}

/** Every record of the spec `name` by head. A file that is not a record is left out. */
export async function readAllHeadPlans(port: LedgerReadPort, name: string): Promise<Map<string, HeadPlans>> {
  const out = new Map<string, HeadPlans>();
  const { dir } = headPlansPath(name, "");
  for (const file of (await port.list(dir)).sort()) {
    if (!file.endsWith(".json")) continue;
    const plans = parseHeadPlans(await port.read(dir, file));
    if (plans) out.set(file.slice(0, -".json".length), plans);
  }
  return out;
}

/** The digests a record holds by wave number. */
export function waveDigests(plans: HeadPlans): Map<number, string> {
  return new Map(plans.waves.map((w) => [w.wave, w.digest]));
}

/** The digests recorded for each head of the spec `name`: head, then wave number, to digest. */
export async function readHeadPlanDigests(port: LedgerReadPort, name: string): Promise<Map<string, Map<number, string>>> {
  const out = new Map<string, Map<number, string>>();
  for (const [head, plans] of await readAllHeadPlans(port, name)) out.set(head, waveDigests(plans));
  return out;
}

/** The names of the specs that have records: the directories under `_wave-plans/`. */
export async function listWavePlanSpecs(port: LedgerReadPort): Promise<string[]> {
  return (await port.list(HEAD_PLANS_DIR)).sort();
}
