/**
 * The accepted-observation baseline (#1014) — a committed record of deviations
 * somebody looked at and accepted, so they stop re-alerting.
 *
 * Deep observation reports every property that differs between source and
 * cloud, including properties nobody ever declared. Some of those are real
 * findings. Many are permanent facts of the account — a platform team's
 * mandatory tag, a bucket setting an org policy flips on, a role an operator
 * attached by hand and everyone agreed to keep. Without somewhere to record
 * "yes, we know, leave it", a deep diff is a report nobody reads twice.
 *
 * The model is cdk-real-drift's `.cdkrd`: a snapshot of accepted *undeclared*
 * values that the diff subtracts. Accepting is an explicit act with a git
 * commit behind it, and the acceptance is value-bound — accept
 * `VersioningConfiguration.Status = Enabled` and a later change to `Suspended`
 * is drift again, because what was accepted was that value, not that path.
 *
 * ## What this is not
 *
 * Not state. The baseline never tells a deploy what to do and is never read on
 * the write path; deleting it costs you noise suppression and nothing else.
 * Which is also why it is safe for it to be incomplete or stale.
 *
 * ## Where it lives
 *
 * `<environment>/observation-baseline.json` on the `chant/lifecycle` orphan
 * branch — the epic's named candidate home, and the same storage the snapshots
 * (`<env>/<lexicon>.json`), the release ledger (`<env>/releases.jsonl`) and the
 * build archive (`_builds/<digest>.json`) already use, through the same
 * `writeBlobToPath`/`readBlobFromPath` plumbing. One env-keyed namespace for
 * everything chant records *about* an environment rather than *for* it.
 *
 * The parse/serialize/update half below is pure and storage-free, so the
 * decision is one function call deep if a repo-committed file (`.chant/`) turns
 * out to be the better review surface.
 */

import { readBlobFromPath, writeBlobToPath } from "./git";
import { sortedJsonReplacer } from "../utils";

/** The file name under `<environment>/` on the orphan branch. */
export const OBSERVATION_BASELINE_FILE = "observation-baseline.json";

/** One deviation somebody accepted, bound to the value they accepted. */
export interface AcceptedDeviation {
  /** Property path within the entity's normalized tree (`Tags[0].Value`, `Policy.Statement[1].Effect`). */
  path: string;
  /** The live value at the moment of acceptance. A different live value later is drift again. */
  value: unknown;
  /** Free-text justification, written by whoever accepted it. */
  note?: string;
  /** ISO timestamp of acceptance. */
  recordedAt?: string;
}

/** Every accepted deviation for one declared entity. */
export interface BaselineEntity {
  /** Entity type at acceptance time, for readability in the committed file. */
  type?: string;
  accepted: AcceptedDeviation[];
}

/** Accepted deviations for one lexicon, keyed by chant entity name. */
export type BaselineLexicon = Record<string, BaselineEntity>;

/** The committed baseline document for one environment. */
export interface ObservationBaseline {
  /** Discriminant + wire version. */
  readonly baseline: "v1";
  environment: string;
  /** ISO timestamp of the last `--update-baseline`. */
  updated?: string;
  /** lexicon → entity → accepted deviations. */
  lexicons: Record<string, BaselineLexicon>;
}

/** An environment with nothing accepted yet. */
export function emptyBaseline(environment: string): ObservationBaseline {
  return { baseline: "v1", environment, lexicons: {} };
}

/** True when `value` is a well-formed {@link ObservationBaseline}. */
export function isObservationBaseline(value: unknown): value is ObservationBaseline {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { baseline?: unknown }).baseline === "v1" &&
    typeof (value as { lexicons?: unknown }).lexicons === "object" &&
    (value as { lexicons?: unknown }).lexicons !== null
  );
}

/**
 * Parse a baseline document. Returns `null` for unparseable or unrecognized
 * content — a corrupt baseline degrades to "nothing is accepted", which is
 * noisy but never wrong. Silently treating garbage as a baseline would
 * suppress real drift.
 */
export function parseBaseline(content: string | null | undefined): ObservationBaseline | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObservationBaseline(parsed)) return null;
  return parsed;
}

/** Deterministic on-disk form: sorted keys, trailing newline, reviewable diff. */
export function serializeBaseline(baseline: ObservationBaseline): string {
  return `${JSON.stringify(baseline, sortedJsonReplacer, 2)}\n`;
}

/** The accepted deviations for one lexicon, or an empty map. */
export function baselineForLexicon(
  baseline: ObservationBaseline | null | undefined,
  lexicon: string,
): BaselineLexicon {
  return baseline?.lexicons?.[lexicon] ?? {};
}

/** Look up one accepted deviation by entity + path. */
export function acceptedDeviation(
  lexiconBaseline: BaselineLexicon,
  entity: string,
  path: string,
): AcceptedDeviation | undefined {
  return lexiconBaseline[entity]?.accepted.find((a) => a.path === path);
}

/** One deviation to record as accepted. */
export interface DeviationToAccept {
  entity: string;
  type?: string;
  path: string;
  /** The live value being accepted. */
  value: unknown;
  note?: string;
}

/**
 * Record deviations as accepted, returning a new baseline (the input is not
 * mutated). An existing acceptance for the same entity+path is replaced — that
 * is how re-accepting after a deliberate change works, and it keeps the file
 * from growing a second entry for every value a path has ever held.
 */
export function acceptDeviations(
  baseline: ObservationBaseline,
  lexicon: string,
  deviations: readonly DeviationToAccept[],
  opts?: { now?: string },
): ObservationBaseline {
  if (deviations.length === 0) return baseline;
  const now = opts?.now ?? new Date().toISOString();
  const lexicons: Record<string, BaselineLexicon> = { ...baseline.lexicons };
  const entities: BaselineLexicon = { ...(lexicons[lexicon] ?? {}) };

  for (const dev of deviations) {
    const existing = entities[dev.entity];
    const accepted = (existing?.accepted ?? []).filter((a) => a.path !== dev.path);
    accepted.push({
      path: dev.path,
      value: dev.value,
      ...(dev.note ? { note: dev.note } : {}),
      recordedAt: now,
    });
    accepted.sort((a, b) => a.path.localeCompare(b.path));
    entities[dev.entity] = {
      ...(dev.type ?? existing?.type ? { type: dev.type ?? existing?.type } : {}),
      accepted,
    };
  }

  lexicons[lexicon] = entities;
  return { baseline: "v1", environment: baseline.environment, updated: now, lexicons };
}

/** Total accepted deviations across every lexicon — for the "N accepted" line. */
export function countAccepted(baseline: ObservationBaseline | null | undefined): number {
  if (!baseline) return 0;
  let n = 0;
  for (const entities of Object.values(baseline.lexicons)) {
    for (const entity of Object.values(entities)) n += entity.accepted.length;
  }
  return n;
}

// ── Storage (chant/lifecycle orphan branch) ─────────────────────────────────

/**
 * Read the accepted baseline for an environment. Returns `null` when the branch,
 * the environment, or the file does not exist — every one of which means
 * "nothing accepted yet", the normal state before anyone runs
 * `--update-baseline`.
 */
export async function readObservationBaseline(
  environment: string,
  opts?: { cwd?: string },
): Promise<ObservationBaseline | null> {
  return parseBaseline(await readBlobFromPath(environment, OBSERVATION_BASELINE_FILE, opts));
}

/** Write the accepted baseline to the orphan branch. Returns the new commit SHA. */
export async function writeObservationBaseline(
  baseline: ObservationBaseline,
  opts?: { cwd?: string },
): Promise<string> {
  return writeBlobToPath(
    baseline.environment,
    OBSERVATION_BASELINE_FILE,
    serializeBaseline(baseline),
    "Accepted observation baseline",
    opts,
  );
}
