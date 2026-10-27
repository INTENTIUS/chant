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
 * A file in the repository, `.chant/observation-baseline/<env>.json` under
 * the project (#4519). An acceptance is then a commit in an ordinary pull
 * request, reviewed with the change that needed it. It is not derivable and
 * not critical, and it is meant to be reviewed: that is the rule that puts a
 * record here rather than in the index store.
 *
 * Other homes, through `observationBaseline` in chant.config.ts or
 * `CHANT_OBSERVATION_BASELINE_STORE`: `git-ref` (`refs/chant/observation-baseline`),
 * `s3` (`<prefix>/observation-baseline/<env>.json`, with the s3 settings of
 * `observationBaseline.s3`, else of `snapshots`), or `none`.
 *
 * A baseline written before #4519, `<environment>/observation-baseline.json`
 * on the `chant/lifecycle` orphan branch, is still read when the configured
 * home has none. It is never written there again.
 *
 * The parse/serialize/update half below is pure and storage-free.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ledgerDir, readBlobFromPath } from "./git";
import { encodeIndexSegment } from "./index-document";
import { sortedJsonReplacer } from "../utils";
import { EFFECT_RECEIPT_ENTITY_TYPE } from "../effect-receipt";

/** The file name under `<environment>/` on the orphan branch, where a baseline written before #4519 is read from. */
export const OBSERVATION_BASELINE_FILE = "observation-baseline.json";

/** The directory, relative to the project, that holds one baseline file per environment (#4519). */
export const OBSERVATION_BASELINE_DIR = ".chant/observation-baseline";

/** The ref a `git-ref` baseline is written to. */
export const OBSERVATION_BASELINE_REF = "refs/chant/observation-baseline";

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

/** Options for {@link acceptDeviations}. */
export interface AcceptDeviationsOptions {
  /** ISO timestamp to stamp instead of the wall clock (tests, replays). */
  now?: string;
  /**
   * Entity names the caller recognized as effect receipts (#1833) — the
   * marker-based read (`collectEffectReceipts`, ../effect-receipt.ts) over
   * the build's entities, which is how a lexicon-materialized receipt row is
   * caught even though its `entityType` is the row's own. Core-typed
   * receipts are refused regardless, via {@link DeviationToAccept.type}.
   */
  receipts?: ReadonlySet<string>;
}

/**
 * Record deviations as accepted, returning a new baseline (the input is not
 * mutated). An existing acceptance for the same entity+path is replaced — that
 * is how re-accepting after a deliberate change works, and it keeps the file
 * from growing a second entry for every value a path has ever held.
 *
 * REFUSES a deviation on an effect receipt (#1833, epic #1703), throwing
 * before anything is recorded: a receipt is the declared witness that its
 * effect ran, and the `effect()` step is its only writer — baselining a
 * receipt's live value would accept "the effect never fired" as the new
 * normal and silently defuse the effect. The whole acceptance aborts, not
 * just the receipt's row, so a partial baseline never lands.
 */
export function acceptDeviations(
  baseline: ObservationBaseline,
  lexicon: string,
  deviations: readonly DeviationToAccept[],
  opts?: AcceptDeviationsOptions,
): ObservationBaseline {
  if (deviations.length === 0) return baseline;
  for (const dev of deviations) {
    if (dev.type === EFFECT_RECEIPT_ENTITY_TYPE || opts?.receipts?.has(dev.entity)) {
      throw new Error(
        `cannot accept drift on effect receipt "${dev.entity}" (path ${dev.path}): ` +
          `the effect() step is the receipt's only writer — accepting the live value would ` +
          `silently defuse the effect. Re-run the effect (or change its inputs) instead of ` +
          `baselining the receipt.`,
      );
    }
  }
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

// ── Storage ─────────────────────────────────────────────────────────────────

export type ObservationBaselineStoreKind = "file" | "git-ref" | "s3" | "none";

/** `observationBaseline` in chant.config.ts. */
export interface ObservationBaselineStoreConfig {
  store: ObservationBaselineStoreKind;
  /** `file`: the directory, relative to the project. Default {@link OBSERVATION_BASELINE_DIR}. */
  dir?: string;
  /** `git-ref`: the ref. Default {@link OBSERVATION_BASELINE_REF}. */
  ref?: string;
  /** `s3`: where. Default: the `snapshots` store's s3 settings. */
  s3?: import("./snapshot-store-s3").S3StoreSettings;
}

const BASELINE_KINDS: readonly ObservationBaselineStoreKind[] = ["file", "git-ref", "s3", "none"];

/** Where to read and write a baseline: the project directory, and its config when the caller has it loaded. */
export interface ObservationBaselineLocation {
  cwd?: string;
  /** The project's loaded chant.config. Loaded from `cwd` upward when absent. */
  config?: { observationBaseline?: unknown; snapshots?: unknown };
  /** Overrides the configured home. */
  store?: ObservationBaselineStoreConfig;
}

/** The home in effect: `CHANT_OBSERVATION_BASELINE_STORE` over `observationBaseline` over `file`. */
export function observationBaselineStoreConfig(
  configured?: unknown,
  env: Record<string, string | undefined> = process.env,
): ObservationBaselineStoreConfig {
  const base = (configured && typeof configured === "object" ? configured : {}) as Partial<ObservationBaselineStoreConfig>;
  const kind = (env.CHANT_OBSERVATION_BASELINE_STORE?.trim() || base.store || "file") as ObservationBaselineStoreKind;
  if (!BASELINE_KINDS.includes(kind)) {
    throw new Error(`observation baseline store "${kind}" is not one of ${BASELINE_KINDS.join(", ")}`);
  }
  return { ...(base.store === kind ? base : {}), store: kind };
}

async function resolveLocation(
  opts?: ObservationBaselineLocation,
): Promise<{ cwd: string; projectDir: string; store: ObservationBaselineStoreConfig; snapshots?: unknown }> {
  const cwd = resolve(opts?.cwd ?? process.cwd());
  const { findProjectConfigPastFragments, loadChantConfigUpward } = await import("../config");
  let config: ObservationBaselineLocation["config"] = opts?.config;
  if (!opts?.store && config === undefined) {
    try {
      config = (await loadChantConfigUpward(cwd)).config;
    } catch {
      config = undefined;
    }
  }
  // The `file` home is relative to the project, not to wherever the command
  // ran: a run from a member's subdirectory writes under that member's own
  // directory, as every other store writes under its member path (#2538).
  const projectDir = findProjectConfigPastFragments(cwd).dir;
  return { cwd, projectDir, store: opts?.store ?? observationBaselineStoreConfig(config?.observationBaseline), snapshots: config?.snapshots };
}

/** The `file` home's path for one environment, under the project directory. */
function baselineFile(projectDir: string, store: ObservationBaselineStoreConfig, env: string): string {
  return join(projectDir, store.dir ?? OBSERVATION_BASELINE_DIR, `${env}.json`);
}

async function s3For(store: ObservationBaselineStoreConfig, snapshots: unknown) {
  const { S3Medium } = await import("./snapshot-store-s3");
  const { snapshotStoreConfig } = await import("./snapshot-store");
  let settings = store.s3;
  if (!settings) {
    const snap = snapshotStoreConfig(snapshots);
    if (snap.store !== "s3") throw new Error("the s3 observation baseline store needs observationBaseline.s3, or a snapshots store that is s3");
    const { store: _s, ...rest } = snap;
    settings = rest;
  }
  return new S3Medium(settings);
}

/** Where a baseline for `environment` lives in the configured home, for messages. */
export async function observationBaselineWhere(environment: string, opts?: ObservationBaselineLocation): Promise<string> {
  const { cwd, store, snapshots } = await resolveLocation(opts);
  switch (store.store) {
    case "file":
      return join(store.dir ?? OBSERVATION_BASELINE_DIR, `${encodeIndexSegment(environment)}.json`);
    case "git-ref":
      return `${store.ref ?? OBSERVATION_BASELINE_REF}:${await ledgerDir(encodeIndexSegment(environment), { cwd })}.json`;
    case "s3":
      return `${(await s3For(store, snapshots)).where}/observation-baseline/${await ledgerDir(encodeIndexSegment(environment), { cwd })}.json`;
    case "none":
      return "nowhere (the observation baseline store is none)";
  }
}

/**
 * Read the accepted baseline for an environment. Returns `null` when there is
 * none, the normal state before anyone runs `--update-baseline`. When the
 * configured home has none, a baseline written before #4519 on the
 * `chant/lifecycle` branch is read instead.
 */
export async function readObservationBaseline(
  environment: string,
  opts?: ObservationBaselineLocation,
): Promise<ObservationBaseline | null> {
  const { cwd, projectDir, store, snapshots } = await resolveLocation(opts);
  let text: string | null = null;
  switch (store.store) {
    case "none":
      return null;
    case "file":
      try {
        text = readFileSync(baselineFile(projectDir, store, encodeIndexSegment(environment)), "utf8");
      } catch {
        text = null;
      }
      break;
    case "git-ref": {
      const { getRuntime } = await import("../runtime-adapter");
      const path = `${await ledgerDir(encodeIndexSegment(environment), { cwd })}.json`;
      const r = await getRuntime().spawn(["git", "cat-file", "blob", `${store.ref ?? OBSERVATION_BASELINE_REF}:${path}`], { cwd });
      text = r.exitCode === 0 ? r.stdout : null;
      break;
    }
    case "s3":
      text = await (await s3For(store, snapshots)).get(`observation-baseline/${await ledgerDir(encodeIndexSegment(environment), { cwd })}.json`);
      break;
  }
  return parseBaseline(text ?? (await readBlobFromPath(environment, OBSERVATION_BASELINE_FILE, { cwd })));
}

/** What {@link saveObservationBaseline} did. `file` means written in the working tree, for the caller to commit. */
export interface SavedObservationBaseline {
  where: string;
  published: "file" | "pushed" | "local" | "failed" | "none";
  detail?: string;
}

/** Write the accepted baseline to its home, and push it when the home is a ref. */
export async function saveObservationBaseline(
  baseline: ObservationBaseline,
  opts?: ObservationBaselineLocation,
): Promise<SavedObservationBaseline> {
  const { cwd, projectDir, store, snapshots } = await resolveLocation(opts);
  const where = await observationBaselineWhere(baseline.environment, { cwd, store, ...(snapshots !== undefined ? { config: { snapshots } } : {}) });
  const content = serializeBaseline(baseline);
  const env = encodeIndexSegment(baseline.environment);
  switch (store.store) {
    case "none":
      return { where, published: "none" };
    case "file": {
      const file = baselineFile(projectDir, store, env);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, content);
      renameSync(tmp, file);
      return { where, published: "file" };
    }
    case "git-ref": {
      const { commitFilesToRef, publishRef } = await import("./snapshot-store");
      const ref = store.ref ?? OBSERVATION_BASELINE_REF;
      const path = `${await ledgerDir(env, { cwd })}.json`;
      await commitFilesToRef(ref, [{ path, content }], "Accepted observation baseline", { cwd });
      const pushed = await publishRef(ref, new Map([[path, content]]), "Accepted observation baseline", { cwd });
      return { where, published: pushed.status === "pushed" ? "pushed" : pushed.status === "local" ? "local" : "failed", ...(pushed.detail ? { detail: pushed.detail } : {}) };
    }
    case "s3":
      await (await s3For(store, snapshots)).put(`observation-baseline/${await ledgerDir(env, { cwd })}.json`, content);
      return { where, published: "pushed" };
  }
}

/** Write the accepted baseline to its home. Returns where it went. */
export async function writeObservationBaseline(
  baseline: ObservationBaseline,
  opts?: ObservationBaselineLocation,
): Promise<string> {
  return (await saveObservationBaseline(baseline, opts)).where;
}
