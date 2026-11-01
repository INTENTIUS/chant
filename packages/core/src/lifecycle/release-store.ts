/**
 * The release (#4026, ws-104): one green commit of one member, compiled for
 * every environment the member declares, stored on `chant/lifecycle`.
 *
 * A release is a different object from a deploy record. A deploy record is
 * one line of `<env>/releases.jsonl` (./release-ledger.ts) saying a component
 * was deployed. A release is what is cut once from a green commit and then
 * moves through the environments: the commit, the artifacts built once from
 * it, and one compile target per environment, each with the template digests
 * and the build parameters that environment was compiled with.
 *
 * Storage, per ws-104 question 3:
 *
 *   _releases/<releaseDigest>.json      the release, written once and never rewritten
 *   _releases/cuts.jsonl                one line per cut, with the release's label
 *   _releases/templates/<digest>.txt    each template's bytes, by content digest
 *   _releases/templates/<digest>.b64    a file that is not UTF-8, base64 (#4155)
 *
 * `:` is written as `_` in file names, as `_plans/` and `_builds/` do. A
 * workspace member's copy sits under `_members/<member>/` through the same
 * `ledgerDir` prefix every other store uses.
 *
 * The template bytes are kept so that a promote under a release deploys the
 * templates the cut recorded, not whatever the promoting checkout holds
 * (ws-104 question 5). They are named by content digest, so a template that
 * two environments or two releases share is stored once.
 *
 * Since #4155 a cut records every local file a deploy step deploys from, not
 * only `template`, `manifest` and `values` files: a chart, a kustomize
 * directory, a site's tree. A directory is recorded as one template per file
 * under it, and named in the target's `trees`, so a promote deploys the
 * recorded tree. A target with `trees` is one such cut; a target without the
 * field was cut before #4155, and a promote of it reads directories and the
 * other fields from the checkout, as it did then.
 *
 * `releaseDigest` is `computePlanDigest("release", subject)` over the member,
 * the commit, the artifact digests and each target's env, templates and the
 * name and value of each param. A param's `source`, the label, the actor, the
 * time and any signature stay outside it, so two cuts of one commit give the
 * same digest.
 */

import { sortedJsonReplacer } from "../utils";
import { contentDigest, sha256Hex } from "../content-digest";
import { computePlanDigest } from "./plan-digest";
import {
  ledgerDir,
  listFilesInDir,
  readBlobBySha,
  readBlobFromPath,
  readPathSha,
  RefCASConflictError,
  writeLedgerFiles,
  type LedgerFileWrite,
  type LedgerLocation,
} from "./git";
import type { RunOrigin } from "./release-ledger";

/** The directory on `chant/lifecycle` that holds releases, cuts and template bytes. */
export const RELEASES_DIR = "_releases";
/** The cut log inside {@link RELEASES_DIR}. */
export const CUTS_FILE = "cuts.jsonl";
/** The directory inside {@link RELEASES_DIR} that holds template bytes by content digest. */
export const TEMPLATES_SUBDIR = "templates";

/** The `kind` a release digest is computed under, so it can never equal a plan digest of another kind. */
export const RELEASE_DIGEST_KIND = "release";

/** An artifact built once from the release's commit: an `image` or `asset` archive entry. */
export interface ReleaseArtifact {
  component: string;
  kind: "image" | "asset";
  /** The archive path the build step wrote. */
  path: string;
  digest: string;
}

/** One template of a target: a file a component's deploy reads, compiled for the target's environment. */
export interface ReleaseTemplate {
  /** The component whose deploy reads it, or null for a project with no components. */
  component: string | null;
  /** The path the deploy step names, relative to the member's directory. */
  path: string;
  /** `sha256:<hex>` of the file's bytes. */
  digest: string;
  /** `base64` for a file that is not UTF-8 (#4155): its stored copy is base64. Absent for text. */
  encoding?: "base64";
}

/** A directory a component's deploy names, whose files the target records as templates under its path (#4155). */
export interface ReleaseTree {
  component: string | null;
  /** The directory as the deploy step names it, relative to the member's directory. */
  path: string;
}

/** One resolved build parameter of a target. */
export interface ReleaseParam {
  name: string;
  value: string | number | boolean;
  /** Where the value came from: `cli`, `params-file`, `env` or `default`. Outside the digest. */
  source: string;
}

/** What one environment compiles to. */
export interface ReleaseTarget {
  env: string;
  templates: ReleaseTemplate[];
  params: ReleaseParam[];
  /** The directories the target records (#4155). Absent on a target cut before #4155. */
  trees?: ReleaseTree[];
}

/** The release file, `_releases/<releaseDigest>.json`. */
export interface Release {
  version: 1;
  releaseDigest: string;
  /** The workspace member, its path of names joined with `/` when nested, or null outside a workspace. */
  member: string | null;
  /** The full sha of the green commit. */
  commit: string;
  artifactDigests: ReleaseArtifact[];
  targets: ReleaseTarget[];
}

/** One line of `_releases/cuts.jsonl`. */
export interface ReleaseCut {
  version: 1;
  releaseDigest: string;
  /** The human name of the release, such as `v1.4.0`, or null for a cut with none. */
  label: string | null;
  actor: string;
  timestamp: string;
  /**
   * The run the cut ran in (#4027): the CI run's id in CI, or an id minted on
   * the machine that cut (`local-<epoch ms>`). Null on every cut written
   * before 0.124.29.
   */
  runId: string | null;
  /**
   * Where that run ran: the CI run's origin, or `{ forge: "local" }` for a
   * minted id (#4027). A cut written before 0.124.29 holds null outside CI.
   */
  runOrigin: RunOrigin | null;
  /**
   * The cut's signature (#4031): an armored ssh signature by the actor's key
   * in the `chant-release` namespace over the release digest, the label, the
   * actor and the time, one per line (`releaseSealPayload`). Null for an
   * unsigned cut, and on every cut written before 0.124.28.
   */
  signature: string | null;
  /**
   * A cut of a composed commit (#4168 4.3): its compose branch, the base it
   * was composed on, and the trunk commits picked onto the base, oldest
   * first. Absent on a cut of a trunk commit.
   */
  composed?: { branch: string; base: string; sources: string[] };
  /**
   * The channel the release publishes to (#4168 4.3): the npm dist-tag or
   * image tag a publish moves in place of `latest`. Absent for `latest`.
   */
  channel?: string;
  /**
   * The green lane the cut checked (#4692): the commit carried
   * `ci/green-<lane>/<sha>` and no `ci/revoked-<lane>/<sha>`, in place of
   * `ci/green/<sha>`. Absent on a cut that checked the full green tag.
   */
  lane?: string;
  /**
   * The commit was not green, and a person's override let the cut through
   * (#4693). Absent on a cut of a green commit.
   */
  override?: ReleaseCutOverride;
}

/**
 * The override a cut of a commit that was not green ran under (#4693): an
 * override on `_gates/policy-override.jsonl`, written by a person the
 * overriders file at base lists, which the cut spent.
 */
export interface ReleaseCutOverride {
  /** Always false: the commit had no green tag that counts. */
  green: false;
  /** The tag it lacked, `ci/green/<sha>` or `ci/green-<lane>/<sha>`. */
  tag: string;
  /** Who wrote the override. */
  by: string;
  /** When they wrote it. */
  at: string;
  /** Why, in their words. */
  reason: string;
  /** The override digest, binding the subject, the commit and the rule. */
  digest: string;
  /** Whether the override was sealed, as a release gate in identity.gates requires. */
  sealed: boolean;
}

/** Whether `v` reads as a {@link ReleaseCutOverride}. */
function isCutOverride(v: unknown): v is ReleaseCutOverride {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.green === false && typeof o.tag === "string" && typeof o.by === "string" && typeof o.at === "string" && typeof o.reason === "string" && typeof o.digest === "string" && typeof o.sealed === "boolean";
}

/** The parts of a release a digest is computed from. */
export type ReleaseSubject = Pick<Release, "member" | "commit" | "artifactDigests" | "targets">;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The same release with every list in the order ws-104 sets: artifacts by component then path, targets by env, templates by component then path, params by name. */
export function normalizeRelease<T extends ReleaseSubject>(release: T): T {
  return {
    ...release,
    artifactDigests: [...release.artifactDigests]
      .map(({ component, kind, path, digest }) => ({ component, kind, path, digest }))
      .sort((a, b) => byString(a.component, b.component) || byString(a.path, b.path)),
    targets: [...release.targets]
      .map((t) => ({
        env: t.env,
        templates: [...t.templates]
          .map(({ component, path, digest, encoding }) => ({ component, path, digest, ...(encoding ? { encoding } : {}) }))
          .sort((a, b) => byString(a.component ?? "", b.component ?? "") || byString(a.path, b.path)),
        params: [...t.params].map(({ name, value, source }) => ({ name, value, source })).sort((a, b) => byString(a.name, b.name)),
        ...(t.trees
          ? { trees: [...t.trees].map(({ component, path }) => ({ component, path })).sort((a, b) => byString(a.component ?? "", b.component ?? "") || byString(a.path, b.path)) }
          : {}),
      }))
      .sort((a, b) => byString(a.env, b.env)),
  };
}

/** The hash input of ws-104 question 3: a param's `source` is left out. */
export function releaseHashInput(release: ReleaseSubject): unknown {
  const n = normalizeRelease(release);
  return {
    member: n.member,
    commit: n.commit,
    artifactDigests: n.artifactDigests,
    targets: n.targets.map((t) => ({
      env: t.env,
      templates: t.templates,
      params: t.params.map(({ name, value }) => ({ name, value })),
      ...(t.trees ? { trees: t.trees } : {}),
    })),
  };
}

/** `computePlanDigest("release", input)` over {@link releaseHashInput}. */
export function computeReleaseDigest(release: ReleaseSubject): string {
  return computePlanDigest(RELEASE_DIGEST_KIND, releaseHashInput(release));
}

/** A release with its digest computed and its lists in order. */
export function makeRelease(subject: ReleaseSubject): Release {
  const normalized = normalizeRelease(subject);
  return { version: 1, releaseDigest: computeReleaseDigest(normalized), ...normalized };
}

/** Whether a release's own `releaseDigest` is the digest of what it holds. */
export function verifyReleaseDigest(release: Release): boolean {
  return release.releaseDigest === computeReleaseDigest(release);
}

const stem = (digest: string): string => digest.replace(/:/g, "_");
const releaseFile = (digest: string): string => `${stem(digest)}.json`;
const templateFile = (digest: string, encoding?: "base64"): string => `${stem(digest)}.${encoding === "base64" ? "b64" : "txt"}`;

/** The digest of a template's bytes: its text, or what its base64 decodes to. */
export function templateBytesDigest(content: string, encoding?: "base64"): string {
  return encoding === "base64" ? `sha256:${sha256Hex(Buffer.from(content, "base64"))}` : contentDigest(content);
}

/** A label names a release in commands such as `chant release cut <label>`, so it is one plain word. */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/** Why a label can't be used, or undefined when it can. */
export function invalidLabel(label: string): string | undefined {
  if (LABEL_PATTERN.test(label)) return undefined;
  return `"${label}" is not a release label: use letters, digits and . _ + -, starting with a letter or digit, at most 128 characters`;
}

/** Thrown when a cut would give a label two digests, or a digest two labels. */
export class ReleaseLabelError extends Error {
  constructor(
    readonly code: "release-label-taken" | "release-already-labelled" | "release-label-invalid",
    message: string,
  ) {
    super(message);
    this.name = "ReleaseLabelError";
  }
}

/** A release's template bytes, as the cut read them. */
export interface TemplateContent {
  digest: string;
  /** The text, or the base64 of the bytes when `encoding` is `base64`. */
  content: string;
  encoding?: "base64";
}

/**
 * Store a release and its template bytes in one commit. A release already
 * stored under its digest is never rewritten, and a template already stored
 * is not written again. Does not push.
 */
export async function persistRelease(
  release: Release,
  templates: readonly TemplateContent[],
  opts?: { cwd?: string },
): Promise<{ commit: string | null; written: boolean }> {
  if (!verifyReleaseDigest(release)) {
    throw new Error(`release ${release.releaseDigest} does not hash to its own digest; refusing to store it`);
  }
  for (const t of templates) {
    if (templateBytesDigest(t.content, t.encoding) !== t.digest) throw new Error(`template bytes do not hash to ${t.digest}; refusing to store them`);
  }
  const dir = await ledgerDir(RELEASES_DIR, opts);
  const files: LedgerFileWrite[] = [];
  const releasePath = `${dir}/${releaseFile(release.releaseDigest)}`;
  const exists = (await readPathSha(RELEASES_DIR, releaseFile(release.releaseDigest), opts)) !== null;
  if (!exists) files.push({ path: releasePath, content: `${JSON.stringify(release, sortedJsonReplacer)}\n`, expectPriorSha: null });
  const seen = new Set<string>();
  for (const t of templates) {
    const file = templateFile(t.digest, t.encoding);
    if (seen.has(file)) continue;
    seen.add(file);
    if ((await readPathSha(`${RELEASES_DIR}/${TEMPLATES_SUBDIR}`, file, opts)) !== null) continue;
    files.push({ path: `${dir}/${TEMPLATES_SUBDIR}/${file}`, content: t.content, expectPriorSha: null });
  }
  if (files.length === 0) return { commit: null, written: false };
  try {
    const commit = await writeLedgerFiles(files, `Release ${release.releaseDigest}`, opts);
    return { commit, written: !exists };
  } catch (err) {
    // Another writer stored the same content-addressed files first.
    if (err instanceof RefCASConflictError) return { commit: null, written: false };
    throw err;
  }
}

/** Parse a stored release file, or null when it is not a release. */
export function parseRelease(text: string): Release | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Partial<Release>;
  const ok =
    r.version === 1 &&
    typeof r.releaseDigest === "string" &&
    (r.member === null || typeof r.member === "string") &&
    typeof r.commit === "string" &&
    Array.isArray(r.artifactDigests) &&
    r.artifactDigests.every((a) => a && typeof a.component === "string" && (a.kind === "image" || a.kind === "asset") && typeof a.path === "string" && typeof a.digest === "string") &&
    Array.isArray(r.targets) &&
    r.targets.every(
      (t) =>
        t &&
        typeof t.env === "string" &&
        Array.isArray(t.templates) &&
        t.templates.every(
          (x) =>
            x &&
            (x.component === null || typeof x.component === "string") &&
            typeof x.path === "string" &&
            typeof x.digest === "string" &&
            (x.encoding === undefined || x.encoding === "base64"),
        ) &&
        (t.trees === undefined || (Array.isArray(t.trees) && t.trees.every((x) => x && (x.component === null || typeof x.component === "string") && typeof x.path === "string"))) &&
        Array.isArray(t.params) &&
        t.params.every((p) => p && typeof p.name === "string" && ["string", "number", "boolean"].includes(typeof p.value) && typeof p.source === "string"),
    );
  return ok ? (r as Release) : null;
}

/** Read one release by digest. Null when none is stored, or when the file is not a release whose content hashes to its digest. */
export async function readRelease(digest: string, opts?: LedgerLocation): Promise<Release | null> {
  const text = await readBlobFromPath(RELEASES_DIR, releaseFile(digest), opts);
  if (text === null) return null;
  const release = parseRelease(text);
  if (!release || release.releaseDigest !== digest || !verifyReleaseDigest(release)) return null;
  return release;
}

/** Every stored release, and how many release files could not be read as one. */
export async function readAllReleases(opts?: LedgerLocation): Promise<{ releases: Release[]; malformed: number }> {
  const releases: Release[] = [];
  let malformed = 0;
  for (const name of await listFilesInDir(RELEASES_DIR, opts)) {
    if (!name.endsWith(".json")) continue;
    const digest = name.slice(0, -".json".length).replace(/_/g, ":");
    const release = await readRelease(digest, opts);
    if (release) releases.push(release);
    else malformed++;
  }
  return { releases, malformed };
}

/** Parse the lines of `cuts.jsonl`. A line that is not a cut is counted and skipped. */
export function parseCuts(text: string | null): { cuts: ReleaseCut[]; malformed: number } {
  const cuts: ReleaseCut[] = [];
  let malformed = 0;
  for (const line of (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const c = JSON.parse(line) as Partial<ReleaseCut>;
      const ok =
        c &&
        c.version === 1 &&
        typeof c.releaseDigest === "string" &&
        (c.label === null || typeof c.label === "string") &&
        typeof c.actor === "string" &&
        typeof c.timestamp === "string" &&
        (c.runOrigin === null || (typeof c.runOrigin === "object" && typeof c.runOrigin?.forge === "string")) &&
        (c.signature === null || c.signature === undefined || typeof c.signature === "string") &&
        (c.runId === null || c.runId === undefined || typeof c.runId === "string") &&
        (c.channel === undefined || typeof c.channel === "string") &&
        (c.lane === undefined || typeof c.lane === "string") &&
        (c.override === undefined || isCutOverride(c.override)) &&
        (c.composed === undefined || (typeof c.composed === "object" && c.composed !== null && typeof c.composed.base === "string" && Array.isArray(c.composed.sources)));
      if (!ok) {
        malformed++;
        continue;
      }
      cuts.push({ ...(c as ReleaseCut), runId: c.runId ?? null, signature: c.signature ?? null });
    } catch {
      malformed++;
    }
  }
  return { cuts, malformed };
}

/** Every cut, oldest first. */
export async function readCuts(opts?: LedgerLocation): Promise<{ cuts: ReleaseCut[]; malformed: number }> {
  return parseCuts(await readBlobFromPath(RELEASES_DIR, CUTS_FILE, opts));
}

/** The label each digest carries, from its labelled cuts. */
export function labelsByDigest(cuts: readonly ReleaseCut[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cuts) if (c.label !== null && !out.has(c.releaseDigest)) out.set(c.releaseDigest, c.label);
  return out;
}

/** What {@link appendCut} did. */
export type CutOutcome =
  | { appended: true; cut: ReleaseCut }
  /** The digest was already cut; nothing was written. `label` is the label it carries, or null. */
  | { appended: false; label: string | null };

const CUT_RETRY_ATTEMPTS = 5;

/**
 * Append a cut for `releaseDigest`. A label names one digest and a digest
 * takes at most one label (ws-104 question 3): cutting a digest again is a
 * no-op that returns its label, giving an unlabelled digest a label appends a
 * cut, and cutting a digest under a label other than its own, or under a
 * label another digest has, throws {@link ReleaseLabelError}. Does not push.
 */
export async function appendCut(
  input: Omit<ReleaseCut, "version" | "signature" | "runId"> & { signature?: string | null; runId?: string | null },
  opts?: { cwd?: string },
): Promise<CutOutcome> {
  if (input.label !== null) {
    const why = invalidLabel(input.label);
    if (why) throw new ReleaseLabelError("release-label-invalid", why);
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CUT_RETRY_ATTEMPTS; attempt++) {
    const priorSha = await readPathSha(RELEASES_DIR, CUTS_FILE, opts);
    const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
    const { cuts } = parseCuts(existing);
    const labels = labelsByDigest(cuts);
    const own = labels.get(input.releaseDigest);
    const alreadyCut = cuts.some((c) => c.releaseDigest === input.releaseDigest);
    if (own !== undefined) {
      if (input.label === null || input.label === own) return { appended: false, label: own };
      throw new ReleaseLabelError(
        "release-already-labelled",
        `release ${input.releaseDigest} is already labelled "${own}", and a release takes one label`,
      );
    }
    if (input.label === null && alreadyCut) return { appended: false, label: null };
    if (input.label !== null) {
      for (const [digest, label] of labels) {
        if (label === input.label) {
          throw new ReleaseLabelError("release-label-taken", `the label "${input.label}" already names release ${digest}`);
        }
      }
    }
    const cut: ReleaseCut = {
      version: 1,
      releaseDigest: input.releaseDigest,
      label: input.label,
      actor: input.actor,
      timestamp: input.timestamp,
      runId: input.runId ?? null,
      runOrigin: input.runOrigin,
      signature: input.signature ?? null,
      ...(input.composed ? { composed: input.composed } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.lane ? { lane: input.lane } : {}),
      ...(input.override ? { override: input.override } : {}),
    };
    const content = `${existing ? `${existing.replace(/\n$/, "")}\n` : ""}${JSON.stringify(cut, sortedJsonReplacer)}\n`;
    try {
      const dir = await ledgerDir(RELEASES_DIR, opts);
      await writeLedgerFiles([{ path: `${dir}/${CUTS_FILE}`, content, expectPriorSha: priorSha }], "Release cut", opts);
      return { appended: true, cut };
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** A template's bytes by digest, or null when none is stored. Under `base64` (#4155), the stored base64 of the bytes. */
export async function readReleaseTemplate(digest: string, opts?: LedgerLocation, encoding?: "base64"): Promise<string | null> {
  return readBlobFromPath(`${RELEASES_DIR}/${TEMPLATES_SUBDIR}`, templateFile(digest, encoding), opts);
}

/**
 * Find a release by its digest or its label. Null when neither names one.
 * A string that names a digest is read as a digest first.
 */
export async function resolveRelease(ref: string, opts?: LedgerLocation): Promise<{ release: Release; label: string | null } | null> {
  const { cuts } = await readCuts(opts);
  const labels = labelsByDigest(cuts);
  let digest: string | undefined = ref.includes(":") ? ref : undefined;
  if (!digest) for (const [d, label] of labels) if (label === ref) digest = d;
  if (!digest) return null;
  const release = await readRelease(digest, opts);
  return release ? { release, label: labels.get(digest) ?? null } : null;
}
