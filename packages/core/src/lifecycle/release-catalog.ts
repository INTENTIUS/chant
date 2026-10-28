/**
 * The release catalog (#4595, terragucci#1289 bundle B): one document per
 * registry that lists every component a repo publishes, each with its
 * versions, read from the release ledger only (ruling A, 2026-10-27).
 *
 * A version carries its digest, commit, time and actor from the release
 * record, its status (active, deprecated or yanked, from the status records
 * of #4596), the changelog entries of the commits it shipped (#4597), its
 * attestation state with the `cosign verify` line that checks it, the
 * consumers that pin it, and a `fields` map an engine fills under its own
 * key. Core never names an engine: the terraform lexicon fills `terraform`
 * (#4598), and a product publishing npm packages fills `npm`.
 *
 * {@link buildReleaseCatalog} joins the inputs and validates the result
 * against `../workspace/release-catalog.schema.json`;
 * {@link parseReleaseCatalog} reads one back. ./release-catalog-site.ts
 * renders it as a static site. Neither reads git or the network: the caller
 * reads the ledger (`readReleaseRecords`, ./release-read.ts) and passes the
 * records in.
 */

import schema from "../workspace/release-catalog.schema.json" with { type: "json" };
import { loadAjv2020 } from "../workspace/ajv2020";
import { NEXT_RELEASE } from "../release-floors";
import type { ReleaseRecord } from "./release-ledger";

/** The first chant that writes and reads a release catalog (#4595). */
export const RELEASE_CATALOG_FLOOR = NEXT_RELEASE;

/** The catalog document's `$schema`. */
export const RELEASE_CATALOG_SCHEMA_ID: string = schema.$id;

/** The catalog's contract version. A field is only ever added within a version. */
export const RELEASE_CATALOG_CONTRACT = 1;

/** A version's status. A version with no status record is `active`. */
export type ReleaseStatusValue = "active" | "deprecated" | "yanked";

/**
 * One status change for a release (#4596's record, as the catalog reads it).
 * Matched to a version by `digest`, or by `version` when no version has the
 * digest. The latest by `timestamp` wins, ties going to the later entry, so
 * a restore is one more record with `status: "active"`.
 */
export interface CatalogStatusInput {
  component: string;
  digest: string;
  version?: string;
  status: ReleaseStatusValue;
  reason?: string;
  /** The version to move to instead. */
  replacement?: string;
  actor: string;
  timestamp: string;
}

/** The group a changelog entry falls in. */
export type ChangelogKind = "breaking" | "feat" | "fix" | "other";

/** The bump a set of changes implies. */
export type ReleaseBump = "major" | "minor" | "patch";

/** One commit in a version's changelog. */
export interface CatalogChangelogEntry {
  kind: ChangelogKind;
  sha: string;
  subject: string;
  /** The conventional-commit scope, when the subject had one. */
  scope?: string;
}

/** The changelog of one version, matched by `version` or `digest`. */
export interface CatalogChangelogInput {
  component: string;
  version?: string;
  digest?: string;
  entries: CatalogChangelogEntry[];
  bump?: ReleaseBump;
}

/** Where a version is used: one call, import or dependency in a consuming repo. */
export interface CatalogConsumer {
  /** The consuming repository, as the scan names it (a slug or a URL). Absent for the repo that publishes. */
  repo?: string;
  /** The root, project or package directory that holds the call, from the repo's top. */
  root: string;
  /** The file holding the call, from the repo's top. */
  file?: string;
  /** Where in the file: a Terraform block path such as `module.vpc`, or a package.json key. */
  address?: string;
}

/** The consumers of one version, matched by `version` or `digest`. */
export interface CatalogConsumersInput {
  component: string;
  version?: string;
  digest?: string;
  consumers: CatalogConsumer[];
}

/** A version's attestation state. */
export type AttestationState = "verified" | "signed" | "unsigned";

/** The attestation of one release, matched by `digest`. */
export interface CatalogAttestationInput {
  component: string;
  digest: string;
  state: AttestationState;
  /** The command a consumer runs to check it, such as `cosign verify-blob --bundle ...`. */
  verify?: string;
  /** The signing identity, when known. */
  identity?: string;
}

/**
 * Engine fields for a component, or for one of its versions when `version`
 * or `digest` is given. `engine` is the key they sit under; core reads none
 * of them.
 */
export interface CatalogFieldsInput {
  component: string;
  version?: string;
  digest?: string;
  engine: string;
  fields: Record<string, unknown>;
}

/** One version of a component in the catalog. */
export interface CatalogVersion {
  /** The release's version, or null for a record that names none (listed by digest). */
  version: string | null;
  digest: string;
  commit: string;
  /** The first time any environment recorded this release. */
  time: string;
  actor: string;
  /** The environments whose ledgers hold the release, sorted. */
  envs: string[];
  status: {
    state: ReleaseStatusValue;
    reason: string | null;
    replacement: string | null;
    actor: string | null;
    time: string | null;
  };
  changelog: { bump: ReleaseBump | null; entries: CatalogChangelogEntry[] };
  attestation: { state: AttestationState; verify: string | null; identity: string | null };
  consumers: CatalogConsumer[];
  fields: Record<string, Record<string, unknown>>;
}

/** One component in the catalog. */
export interface CatalogComponent {
  name: string;
  /** The newest active version (its version, or its digest when it has none), or null when every version is yanked or deprecated. */
  latest: string | null;
  fields: Record<string, Record<string, unknown>>;
  /** Newest first. */
  versions: CatalogVersion[];
}

/** The catalog document. */
export interface ReleaseCatalog {
  $schema: string;
  contract: 1;
  chant: string;
  generatedAt: string;
  components: CatalogComponent[];
}

/** Everything {@link buildReleaseCatalog} joins. Only `releases` is required. */
export interface ReleaseCatalogInput {
  releases: readonly ReleaseRecord[];
  statuses?: readonly CatalogStatusInput[];
  changelogs?: readonly CatalogChangelogInput[];
  consumers?: readonly CatalogConsumersInput[];
  attestations?: readonly CatalogAttestationInput[];
  fields?: readonly CatalogFieldsInput[];
  /** Keep only these components. */
  components?: readonly string[];
}

/** Thrown when a catalog fails its schema, with one line per problem. */
export class ReleaseCatalogError extends Error {
  constructor(public readonly problems: string[]) {
    super(`release catalog is not valid: ${problems.join("; ")}`);
    this.name = "ReleaseCatalogError";
  }
}

/** The key a version is listed under: its version, or its digest when it names none. */
export function catalogVersionKey(v: { version?: string | null; digest: string }): string {
  return v.version ?? v.digest;
}

/**
 * Join release records with their status, changelog, consumers, attestation
 * and engine fields into one catalog. Records of one component that share a
 * version (or, without one, a digest) become one version listing every
 * environment that recorded it, timed by the earliest record. An input that
 * matches no version is left out. The result is validated against the
 * schema, so a field an engine filled with something JSON cannot hold fails
 * here, before anything is written.
 */
export function buildReleaseCatalog(
  input: ReleaseCatalogInput,
  opts: { generatedAt: string; chant?: string },
): ReleaseCatalog {
  const keep = input.components ? new Set(input.components) : undefined;
  const byComponent = new Map<string, Map<string, CatalogVersion>>();

  const ordered = [...input.releases].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  for (const r of ordered) {
    if (keep && !keep.has(r.component)) continue;
    let versions = byComponent.get(r.component);
    if (!versions) byComponent.set(r.component, (versions = new Map()));
    const key = r.releaseVersion ?? r.digest;
    const found = versions.get(key);
    if (found) {
      if (!found.envs.includes(r.env)) found.envs.push(r.env);
      continue;
    }
    versions.set(key, {
      version: r.releaseVersion ?? null,
      digest: r.digest,
      commit: r.gitSha,
      time: r.timestamp,
      actor: r.actor,
      envs: [r.env],
      status: { state: "active", reason: null, replacement: null, actor: null, time: null },
      changelog: { bump: null, entries: [] },
      attestation: { state: "unsigned", verify: null, identity: null },
      consumers: [],
      fields: {},
    });
  }

  const find = (component: string, at: { version?: string; digest?: string }): CatalogVersion | undefined => {
    const versions = byComponent.get(component);
    if (!versions) return undefined;
    if (at.digest) for (const v of versions.values()) if (v.digest === at.digest) return v;
    if (at.version) return versions.get(at.version);
    return undefined;
  };

  // Latest status per version: by time, ties to the later input.
  const statuses = [...(input.statuses ?? [])].map((s, i) => ({ s, i })).sort((a, b) => (a.s.timestamp === b.s.timestamp ? a.i - b.i : a.s.timestamp < b.s.timestamp ? -1 : 1));
  for (const { s } of statuses) {
    const v = find(s.component, s);
    if (!v) continue;
    v.status = { state: s.status, reason: s.reason ?? null, replacement: s.replacement ?? null, actor: s.actor, time: s.timestamp };
  }
  for (const c of input.changelogs ?? []) {
    const v = find(c.component, c);
    if (v) v.changelog = { bump: c.bump ?? null, entries: [...c.entries] };
  }
  for (const c of input.consumers ?? []) {
    const v = find(c.component, c);
    if (v) v.consumers.push(...c.consumers);
  }
  for (const a of input.attestations ?? []) {
    const v = find(a.component, a);
    if (v) v.attestation = { state: a.state, verify: a.verify ?? null, identity: a.identity ?? null };
  }

  const componentFields = new Map<string, Record<string, Record<string, unknown>>>();
  for (const f of input.fields ?? []) {
    if (!byComponent.has(f.component)) continue;
    if (f.version !== undefined || f.digest !== undefined) {
      const v = find(f.component, f);
      if (v) v.fields[f.engine] = { ...v.fields[f.engine], ...f.fields };
      continue;
    }
    const at = componentFields.get(f.component) ?? {};
    at[f.engine] = { ...at[f.engine], ...f.fields };
    componentFields.set(f.component, at);
  }

  const components: CatalogComponent[] = [...byComponent.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, versions]) => {
      const list = [...versions.values()].reverse();
      for (const v of list) {
        v.envs.sort();
        v.consumers.sort((a, b) => consumerKey(a).localeCompare(consumerKey(b)));
      }
      const latest = list.find((v) => v.status.state === "active");
      return { name, latest: latest ? catalogVersionKey(latest) : null, fields: componentFields.get(name) ?? {}, versions: list };
    });

  const catalog: ReleaseCatalog = {
    $schema: RELEASE_CATALOG_SCHEMA_ID,
    contract: RELEASE_CATALOG_CONTRACT,
    chant: opts.chant ?? NEXT_RELEASE,
    generatedAt: opts.generatedAt,
    components,
  };
  // Round-trip through JSON so `fields` holds only what the written file will.
  const problems = validateReleaseCatalog(JSON.parse(JSON.stringify(catalog)));
  if (problems.length > 0) throw new ReleaseCatalogError(problems);
  return catalog;
}

function consumerKey(c: CatalogConsumer): string {
  return [c.repo ?? "", c.root, c.file ?? "", c.address ?? ""].join("\u0000");
}

interface AjvError {
  instancePath: string;
  message?: string;
}
type Validate = ((data: unknown) => boolean) & { errors?: AjvError[] | null };

let compiled: Validate | undefined;
function validator(): Validate {
  if (compiled) return compiled;
  const Ajv = loadAjv2020() as new (opts: object) => { compile(s: object): Validate };
  compiled = new Ajv({ allErrors: true, strict: true }).compile(schema);
  return compiled;
}

/** The schema problems of `doc`, one line each; empty when it is a valid catalog. */
export function validateReleaseCatalog(doc: unknown): string[] {
  const validate = validator();
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is not valid"}`);
}

/**
 * Read a catalog from its JSON text or its parsed value. Throws
 * {@link ReleaseCatalogError} when it is not valid JSON or fails the schema.
 * A field this chant does not know is kept, as the contract lets a newer
 * writer add one.
 */
export function parseReleaseCatalog(text: string | unknown): ReleaseCatalog {
  let doc: unknown = text;
  if (typeof text === "string") {
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new ReleaseCatalogError([`not JSON: ${(e as Error).message}`]);
    }
  }
  const problems = validateReleaseCatalog(doc);
  if (problems.length > 0) throw new ReleaseCatalogError(problems);
  return doc as ReleaseCatalog;
}

/** The version of `component` listed under `key` (a version, or a digest for one without). */
export function catalogVersion(catalog: ReleaseCatalog, component: string, key: string): CatalogVersion | undefined {
  const c = catalog.components.find((x) => x.name === component);
  return c?.versions.find((v) => v.version === key || v.digest === key);
}
