/**
 * `chant index <substrate>` and the library function behind it (chant#4532,
 * tier 1 of INTENTIUS/behold#1025). It fills an index from a cloud with no
 * project and keeps it in the index store.
 *
 * Built in behold as behold#1026 (the command) and behold#1029 (the lister),
 * and moved here on the ruling that behold is a control plane and every
 * model lives in chant
 * (https://github.com/INTENTIUS/behold/issues/1024#issuecomment-6433236820).
 * behold's `behold index` calls {@link runCloudIndex} with its own command
 * name and default store directory.
 *
 * The pipeline, behold#1025's design as ruled (Q1-Q6, 2026-10-26):
 *
 *     listCloud(scope, target)         ../cloud-lister/
 *       -> ListingResult
 *       -> typeListing                 ./type-listing.ts (#4521)
 *       -> deriveEdges                 ./derive-edges.ts (#4522, with #4523's identity pass)
 *       -> IndexDocument
 *       -> store.writeIndex            ./snapshot-store.ts (#4519)
 *
 * One run writes one version (Q6): one substrate and one account,
 * subscription, project or cluster, with every location and type the flags
 * name. The version is one immutable file (Q3),
 * `index/cloud/<substrate>/<scopeId>/<scope digest>/<observedAt>-<digest12>.json`
 * under the store's root, beside the `scope.json` that says what the digest
 * means. A second run writes a second version; the first stays.
 *
 * Where it writes:
 *
 *  - `--store <spec>`: a store from its spec ({@link planIndexStore});
 *  - else, inside a chant project (a `chant.config.ts` or `chant.config.json`
 *    in the working directory or above it): that project's configured store;
 *  - else (Q4): a `local` store in chant's per-user data directory,
 *    `$XDG_DATA_HOME/chant`, else `~/.local/share/chant`
 *    ({@link chantUserStoreDir}). `CHANT_INDEX_DIR`, when set, names that
 *    store's `index/` directory. A caller (behold) passes its own
 *    `defaultStoreDir` instead.
 *
 * Read-only:
 *
 *  - the lister sends only its allowlisted reads (../cloud-lister/guard.ts),
 *    pins every call to an explicit endpoint, and with an endpoint takes
 *    static credentials only, never an SDK's default chain;
 *  - the command refuses to start with any action flag ({@link ACTION_FLAGS})
 *    before anything else is read, and starts no server;
 *  - nothing is written but the one index version (and its `scope.json`), and
 *    the store is never published to a remote by this command;
 *  - for GCP nothing is enabled: when the Cloud Asset API is off, the
 *    lister's note carries the `gcloud services enable` command for the
 *    person to run.
 *
 * The index is never consulted for a decision. Deleting it loses history and
 * nothing else.
 *
 * Environment the command reads (and nothing else):
 *
 *  - aws: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
 *    (static credentials, when the first two are set), `AWS_ENDPOINT_URL`
 *    (the endpoint when `--endpoint` is absent), `AWS_REGION` then
 *    `AWS_DEFAULT_REGION` (the region when `--regions` is absent);
 *  - azure: `CHANT_AZURE_TOKEN` (an ARM bearer token);
 *  - gcp: `CHANT_GCP_TOKEN` (an OAuth access token);
 *  - kubernetes: `KUBECONFIG` (its first path) when `--kubeconfig` is absent;
 *  - the store: `CHANT_INDEX_DIR`, `XDG_DATA_HOME`, and for `--store` the
 *    `CHANT_SNAPSHOT_*` variables ./snapshot-store.ts reads.
 *
 * The maintainer's emulator run (never run by an agent), against the pinned
 * floci on 4566 with a scratch data dir:
 *
 *     env -u AWS_PROFILE -u AWS_SESSION_TOKEN \
 *       AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
 *       XDG_DATA_HOME=$(mktemp -d) \
 *       npx tsx packages/core/src/cli/main.ts index aws --endpoint http://localhost:4566 \
 *         --account 000000000000 --regions us-east-1 \
 *         --types AWS::S3::Bucket,AWS::IAM::Role,AWS::SQS::Queue
 *
 * Its last line is the verdict, `chant index: wrote <version> ...`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { CHANT_VERSION } from "../chant-version";
import {
  kubeTargetFromKubeconfig,
  listCloud,
  ListerConfigError,
  MutatingCallRefused,
  OriginRefused,
  type CloudScope,
  type ListingResult,
  type ListOptions,
  type Substrate,
  type SubstrateTarget,
} from "../cloud-lister/index";
import type { TlsOptions } from "../cloud-lister/transport";
import { NEXT_RELEASE } from "../release-floors";
import { deriveEdges, type EdgeLexicon } from "./derive-edges";
import type { IndexDocument } from "./index-document";
import { createSnapshotStore, resolveSnapshotStore, snapshotStoreConfig, type SnapshotStore, type StoreWrite } from "./snapshot-store";
import { typeListing, type ListingLexicon } from "./type-listing";

/** The first chant with `chant index` and {@link runCloudIndex} / {@link indexCloud}. */
export const CLOUD_INDEX_FLOOR = NEXT_RELEASE;

/** What typing and edge derivation read from a lexicon. A `LexiconPlugin` is one. */
export type IndexLexicon = ListingLexicon & EdgeLexicon;

/** The part of a {@link SnapshotStore} an index run uses. Tests pass a fake. */
export type IndexStore = Pick<SnapshotStore, "kind" | "where" | "writable" | "writeIndex" | "listIndex">;

// ── The pipeline ────────────────────────────────────────────────────────

export interface IndexCloudRequest {
  scope: CloudScope;
  target: SubstrateTarget;
  /** Where the version goes. */
  store: IndexStore;
  /** The lexicons that type the substrate's listed types. Empty keeps every object as a node of unknown kind. */
  lexicons: readonly IndexLexicon[];
  /** The caller's version, for the stamp's `source.version`. Default chant's. */
  version?: string;
}

export interface IndexCloudDeps {
  /** The lister; tests pass a fake. */
  list?: (scope: CloudScope, target: SubstrateTarget, options: ListOptions) => Promise<ListingResult>;
  /** Options handed to the lister (a test's fetcher and chains). */
  listOptions?: Omit<ListOptions, "version">;
}

export interface IndexCloudResult {
  listing: ListingResult;
  doc: IndexDocument;
  write: StoreWrite;
}

/**
 * List one scope, type it, derive its edges and write one stamped version.
 * Throws what the lister throws ({@link ListerConfigError},
 * {@link OriginRefused}, {@link MutatingCallRefused}, a failed read) before
 * anything is written, and {@link IndexWriteError} when the store's write
 * throws.
 */
export async function indexCloud(req: IndexCloudRequest, deps: IndexCloudDeps = {}): Promise<IndexCloudResult> {
  if (!req.store.writable && req.store.kind !== "none") {
    throw new IndexUsageError(`the store ${req.store.where} is read-only`);
  }
  const listing = await (deps.list ?? listCloud)(req.scope, req.target, { ...(deps.listOptions ?? {}), version: req.version ?? CHANT_VERSION });
  const doc = deriveEdges(typeListing(listing, req.lexicons), req.lexicons);
  let write: StoreWrite;
  try {
    write = (await req.store.writeIndex(doc)) ?? { written: false, reason: `the ${req.store.kind} store keeps nothing` };
  } catch (e) {
    throw new IndexWriteError((e as Error).message);
  }
  return { listing, doc, write };
}

// ── Arguments ───────────────────────────────────────────────────────────

/** Flags that would reach an action (deploy, apply, Ops, rollbacks). An index run refuses every one. */
export const ACTION_FLAGS: readonly string[] = [
  "--apply",
  "--approve",
  "--approver",
  "--auto-approve",
  "--adopt",
  "--create",
  "--delete",
  "--deploy",
  "--destroy",
  "--enable",
  "--enable-api",
  "--fix",
  "--import",
  "--live",
  "--op",
  "--ops",
  "--promote",
  "--rollback",
  "--run-op",
  "--write",
  "--yes",
];

const SUBSTRATES: Readonly<Record<string, Substrate>> = { aws: "aws", azure: "azure", gcp: "gcp", kubernetes: "kubernetes", k8s: "kubernetes" };

/** The chant lexicon that types each substrate's listed types. */
export const SUBSTRATE_LEXICON: Readonly<Record<Substrate, string>> = { aws: "aws", azure: "azure", gcp: "gcp", kubernetes: "k8s" };

export function indexUsage(command = "chant index", storeDefault = "a local store in chant's per-user data directory ($XDG_DATA_HOME/chant, else ~/.local/share/chant)"): string {
  return `${command} <aws|azure|gcp|kubernetes> [scope] [target] [--store <spec>] [--json]

  Read one account, subscription, project or cluster through its inventory
  API, type it through chant's lexicons, add derived edges, and write one
  stamped index version to the index store. Read-only: it lists, and writes
  nothing but the index version. Every run writes a new version; the old ones
  stay.

Scope:
  --account <id> | --subscription <id> | --project <id> | --cluster <name> | --scope-id <id>
                      The AWS account, Azure subscription, GCP project or
                      cluster name the run reads (required, except for
                      kubernetes, which defaults to the kubeconfig's cluster).
  --regions <r,...>   Regions or locations (kubernetes: namespaces). AWS needs
                      them named (default AWS_REGION); others default to all.
  --locations <l,...> Same as --regions.
  --types <t,...>     Types as the inventory API names them (default: all,
                      or a fixed default set for AWS).
  --tag <k=v>         Only objects with this tag or label. Repeatable.

Target:
  --endpoint <url>    An emulator's endpoint. With one, credentials must be
                      static: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY,
                      CHANT_AZURE_TOKEN, CHANT_GCP_TOKEN or --anonymous.
                      No SDK default credential chain is used. AWS also reads
                      AWS_ENDPOINT_URL.
  --anonymous         gcp with --endpoint: send no token (floci-gcp).
  --ca <file>         A CA bundle for the endpoint's TLS.
  --insecure-skip-verify
                      Skip TLS verification; only for a loopback endpoint.
  --kubeconfig <file> kubernetes: the kubeconfig (default KUBECONFIG, then
                      ~/.kube/config). Token or client certificate only.
  --context <name>    kubernetes: the kubeconfig context.

Store:
  --store <spec>      local, local:<dir>, git-ref, git-ref:<ref>, s3,
                      s3://<bucket>[/<prefix>], or none.
                      Default: the chant project's store when run inside one,
                      else ${storeDefault}.
  --json              Print the result as one JSON object.

Refused: any action flag (${ACTION_FLAGS.slice(0, 5).join(", ")} and the rest of
ACTION_FLAGS in packages/core/src/lifecycle/cloud-index.ts). It starts no server.
`;
}

export interface IndexArgs {
  substrate: Substrate;
  scopeId?: string;
  locations?: string[];
  types?: string[];
  tags: Record<string, string>;
  endpoint?: string;
  anonymous: boolean;
  ca?: string;
  insecureSkipVerify: boolean;
  kubeconfig?: string;
  context?: string;
  store?: string;
  json: boolean;
}

export class IndexUsageError extends Error {
  constructor(
    message: string,
    readonly actionFlag?: string,
  ) {
    super(message);
    this.name = "IndexUsageError";
  }
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An index run's arguments. Throws {@link IndexUsageError}; an action flag is named in `actionFlag`. */
export function parseIndexArgs(argv: readonly string[], command = "chant index"): IndexArgs {
  // An action flag is refused before anything else is read, wherever it sits.
  for (const a of argv) {
    const flag = a.startsWith("--") ? a.split("=")[0] : undefined;
    if (flag && ACTION_FLAGS.includes(flag)) {
      throw new IndexUsageError(
        `${command} is read-only and refuses ${flag}: it lists and writes one index version, and no deploy, apply, Op or rollback is reachable from it. Nothing was listed and nothing was written.`,
        flag,
      );
    }
  }
  const [first, ...rest] = argv;
  if (!first || first.startsWith("-")) throw new IndexUsageError(`${command} needs a substrate: aws, azure, gcp or kubernetes`);
  const substrate = SUBSTRATES[first];
  if (!substrate) throw new IndexUsageError(`${command}: unknown substrate '${first}' (aws, azure, gcp or kubernetes)`);
  const out: IndexArgs = { substrate, tags: {}, anonymous: false, insecureSkipVerify: false, json: false };
  const scopeFlags = ["--account", "--subscription", "--project", "--cluster", "--scope-id"];
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new IndexUsageError(`${command}: ${flag} needs a value`);
      i++;
      return v;
    };
    if (scopeFlags.includes(flag)) {
      const v = value();
      if (out.scopeId !== undefined && out.scopeId !== v) throw new IndexUsageError(`${command} reads one account, subscription, project or cluster per run; got ${out.scopeId} and ${v}`);
      out.scopeId = v;
    } else if (flag === "--regions" || flag === "--locations" || flag === "--namespaces") {
      out.locations = [...(out.locations ?? []), ...list(value())];
    } else if (flag === "--types") {
      out.types = [...(out.types ?? []), ...list(value())];
    } else if (flag === "--tag") {
      const v = value();
      const at = v.indexOf("=");
      if (at <= 0) throw new IndexUsageError(`${command}: --tag takes key=value, got '${v}'`);
      out.tags[v.slice(0, at)] = v.slice(at + 1);
    } else if (flag === "--endpoint") {
      out.endpoint = value();
    } else if (flag === "--anonymous") {
      out.anonymous = true;
    } else if (flag === "--ca") {
      out.ca = value();
    } else if (flag === "--insecure-skip-verify") {
      out.insecureSkipVerify = true;
    } else if (flag === "--kubeconfig") {
      out.kubeconfig = value();
    } else if (flag === "--context") {
      out.context = value();
    } else if (flag === "--store") {
      out.store = value();
    } else if (flag === "--json") {
      out.json = true;
    } else {
      throw new IndexUsageError(`${command}: unknown argument '${raw}'`);
    }
  }
  if (out.anonymous && out.substrate !== "gcp") throw new IndexUsageError(`${command}: --anonymous is for gcp against an emulator`);
  if (out.anonymous && out.endpoint === undefined) throw new IndexUsageError(`${command}: --anonymous needs --endpoint (an emulator); a real project always takes a token`);
  return out;
}

export type Env = Readonly<Record<string, string | undefined>>;

function isLoopback(endpoint: string): boolean {
  try {
    const h = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch {
    return false;
  }
}

export interface TargetDeps {
  env: Env;
  cwd: string;
  home: string;
  readFile?: (path: string) => string;
  command?: string;
}

/** The run's scope and target, from the flags and the variables the module comment lists. */
export function scopeAndTarget(args: IndexArgs, deps: TargetDeps): { scope: CloudScope; target: SubstrateTarget } {
  const { env } = deps;
  const command = deps.command ?? "chant index";
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const endpoint = args.endpoint ?? (args.substrate === "aws" ? env.AWS_ENDPOINT_URL || undefined : undefined);
  if (args.insecureSkipVerify && (endpoint === undefined || !isLoopback(endpoint))) {
    throw new ListerConfigError("--insecure-skip-verify is only for an emulator on a loopback endpoint");
  }
  const tls: TlsOptions | undefined =
    args.ca || args.insecureSkipVerify ? { ...(args.ca ? { ca: read(resolve(deps.cwd, args.ca)) } : {}), ...(args.insecureSkipVerify ? { insecureSkipVerify: true } : {}) } : undefined;
  const base = {
    locations: args.locations && args.locations.length > 0 ? args.locations : ("*" as const),
    types: args.types && args.types.length > 0 ? args.types : ("*" as const),
    ...(Object.keys(args.tags).length > 0 ? { tagFilter: args.tags } : {}),
  };
  const needScope = (what: string): string => {
    if (!args.scopeId) throw new ListerConfigError(`${command} ${args.substrate} needs ${what}`);
    return args.scopeId;
  };
  switch (args.substrate) {
    case "aws": {
      const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
      const locations = base.locations === "*" && region ? [region] : base.locations;
      const credentials =
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }
          : undefined;
      return {
        scope: { substrate: "aws", scopeId: needScope("--account <id>"), ...base, locations },
        target: { substrate: "aws", aws: { ...(endpoint !== undefined ? { endpoint } : {}), ...(credentials ? { credentials } : {}), ...(tls ? { tls } : {}) } },
      };
    }
    case "azure": {
      const token = env.CHANT_AZURE_TOKEN || undefined;
      return {
        scope: { substrate: "azure", scopeId: needScope("--subscription <id>"), ...base },
        target: { substrate: "azure", azure: { ...(endpoint !== undefined ? { endpoint } : {}), ...(token !== undefined ? { token } : {}), ...(tls ? { tls } : {}) } },
      };
    }
    case "gcp": {
      const token = args.anonymous ? null : env.CHANT_GCP_TOKEN || undefined;
      return {
        scope: { substrate: "gcp", scopeId: needScope("--project <id>"), ...base },
        target: { substrate: "gcp", gcp: { ...(endpoint !== undefined ? { endpoint } : {}), ...(token !== undefined ? { token } : {}), ...(tls ? { tls } : {}) } },
      };
    }
    case "kubernetes": {
      const path = args.kubeconfig
        ? resolve(deps.cwd, args.kubeconfig)
        : env.KUBECONFIG
          ? env.KUBECONFIG.split(delimiter).filter(Boolean)[0]
          : join(deps.home, ".kube", "config");
      if (!path) throw new ListerConfigError(`${command} kubernetes needs a kubeconfig (--kubeconfig or KUBECONFIG)`);
      let text: string;
      try {
        text = read(path);
      } catch (e) {
        throw new ListerConfigError(`${command} kubernetes could not read the kubeconfig ${path}: ${(e as Error).message}`);
      }
      const kube = kubeTargetFromKubeconfig(text, { ...(args.context ? { context: args.context } : {}), baseDir: dirname(path) });
      const server = endpoint ?? kube.server;
      const kubeTls = tls ? { ...kube.tls, ...tls } : kube.tls;
      return {
        scope: { substrate: "kubernetes", scopeId: args.scopeId ?? kube.clusterName, ...base },
        target: { substrate: "kubernetes", kubernetes: { server, ...(kube.token ? { token: kube.token } : {}), ...(kubeTls ? { tls: kubeTls } : {}) } },
      };
    }
  }
}

// ── The store ───────────────────────────────────────────────────────────

/** Where the run writes, before any store is built (so it can be tested without one). */
export type StorePlan =
  | { kind: "user"; dir: string }
  | { kind: "project"; projectDir: string }
  | { kind: "spec"; spec: string; configured: Record<string, unknown> & { store: string }; env: Record<string, string | undefined> };

/**
 * behold#1025 Q4: the per-user store's root, chant's per-user data directory.
 * `CHANT_INDEX_DIR` names the store's `index/` directory; else
 * `$XDG_DATA_HOME/chant`; else `~/.local/share/chant`.
 */
export function chantUserStoreDir(env: Env = process.env, home: string = homedir()): string {
  const indexDir = env.CHANT_INDEX_DIR?.trim();
  if (indexDir) {
    if (basename(indexDir) !== "index") {
      throw new IndexUsageError(`CHANT_INDEX_DIR (${indexDir}) must end in /index: the local store keeps index versions under <store>/index`);
    }
    return dirname(resolve(indexDir));
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "chant");
}

const PROJECT_FILES = ["chant.config.ts", "chant.config.json"];

/** The chant project the working directory is in, if any: the nearest directory with a chant config. */
export function findChantProject(cwd: string, exists: (p: string) => boolean = existsSync): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (PROJECT_FILES.some((f) => exists(join(dir, f)))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * The store a run writes to. `--store` takes ./snapshot-store.ts's kinds as a
 * spec: `local` (`.chant/store`, or `CHANT_SNAPSHOT_STORE_DIR`),
 * `local:<dir>`, `git-ref`, `git-ref:<ref>`, `s3` (from `CHANT_SNAPSHOT_S3_*`),
 * `s3://<bucket>[/<prefix>]`, `none`. The read-only `orphan-branch` store is
 * refused. With no `--store`: the project's store, else `defaultStoreDir`.
 */
export function planIndexStore(o: { store?: string; cwd: string; env: Env; defaultStoreDir: () => string; exists?: (p: string) => boolean; command?: string }): StorePlan {
  const command = o.command ?? "chant index";
  const env: Record<string, string | undefined> = { ...o.env };
  if (o.store === undefined) {
    const project = findChantProject(o.cwd, o.exists);
    if (project) return { kind: "project", projectDir: project };
    return { kind: "user", dir: o.defaultStoreDir() };
  }
  const spec = o.store.trim();
  const colon = spec.indexOf(":");
  const head = spec.startsWith("s3://") ? "s3" : colon > 0 ? spec.slice(0, colon) : spec;
  const tail = spec.startsWith("s3://") ? spec.slice("s3://".length) : colon > 0 ? spec.slice(colon + 1) : undefined;
  env.CHANT_SNAPSHOT_STORE = head;
  switch (head) {
    case "local": {
      if (tail !== undefined) {
        if (!tail) throw new IndexUsageError(`${command}: --store local:<dir> needs a directory`);
        env.CHANT_SNAPSHOT_STORE_DIR = isAbsolute(tail) ? tail : resolve(o.cwd, tail);
      }
      return { kind: "spec", spec, configured: { store: "local" }, env };
    }
    case "git-ref":
      return { kind: "spec", spec, configured: { store: "git-ref", readOrphanBranch: false, ...(tail ? { ref: tail } : {}) }, env };
    case "s3": {
      if (tail !== undefined) {
        const [bucket, ...prefix] = tail.split("/");
        if (!bucket) throw new IndexUsageError(`${command}: --store s3://<bucket>[/<prefix>] needs a bucket`);
        env.CHANT_SNAPSHOT_S3_BUCKET = bucket;
        const p = prefix.join("/").replace(/\/+$/, "");
        if (p) env.CHANT_SNAPSHOT_S3_PREFIX = p;
        else delete env.CHANT_SNAPSHOT_S3_PREFIX;
      }
      return { kind: "spec", spec, configured: { store: "s3" }, env };
    }
    case "none":
      return { kind: "spec", spec, configured: { store: "none" }, env };
    case "orphan-branch":
      throw new IndexUsageError(`${command}: the orphan-branch store is read-only; pass local, git-ref, s3 or none`);
    default:
      throw new IndexUsageError(`${command}: --store '${spec}' is not a store spec (local, local:<dir>, git-ref, git-ref:<ref>, s3, s3://<bucket>[/<prefix>], none)`);
  }
}

/** Build the planned store. */
export async function openIndexStore(plan: StorePlan, cwd: string): Promise<IndexStore> {
  switch (plan.kind) {
    case "user":
      return createSnapshotStore({ store: "local", dir: plan.dir }, { cwd });
    case "project":
      return resolveSnapshotStore({ cwd: plan.projectDir });
    case "spec":
      return createSnapshotStore(snapshotStoreConfig(plan.configured, plan.env), { cwd, env: plan.env });
  }
}

/** The substrate's lexicon plugin, or a note saying why there is none. */
export async function substrateLexicons(substrate: Substrate): Promise<{ lexicons: IndexLexicon[]; note?: string }> {
  const name = SUBSTRATE_LEXICON[substrate];
  const pkg = `@intentius/chant-lexicon-${name}`;
  let plugin: IndexLexicon | undefined;
  try {
    const { loadPlugin } = await import("../cli/plugins");
    plugin = (await loadPlugin(name)) as IndexLexicon;
  } catch {
    plugin = undefined;
  }
  if (!plugin || typeof plugin.name !== "string") {
    return {
      lexicons: [],
      note: `${pkg} is not installed, so ${substrate} objects are kept as nodes of unknown kind and get no derived edges; install it to type them`,
    };
  }
  if (!plugin.listedTypes) {
    return { lexicons: [plugin], note: `${pkg} has no listedTypes (chant#4521), so ${substrate} objects are kept as nodes of unknown kind` };
  }
  return { lexicons: [plugin] };
}

// ── The command ─────────────────────────────────────────────────────────

export interface IndexSummary {
  substrate: Substrate;
  scopeId: string;
  scopeKey: string;
  observedAt: string;
  digest: string;
  store: { kind: string; where: string };
  written: boolean;
  version?: string;
  path?: string;
  reason?: string;
  nodes: number;
  typed: number;
  unmapped: number;
  derivedEdges: number;
  coverage: { listed: number; notObserved: number };
  notes: string[];
}

export interface RunCloudIndexOptions extends IndexCloudDeps {
  /** The command name in messages: `chant index` (default) or `behold index`. */
  command?: string;
  /** The per-user store root when there is no project and no `--store`. Default {@link chantUserStoreDir}. */
  defaultStoreDir?: () => string;
  /** How the usage text names that default. */
  defaultStoreText?: string;
  cwd?: string;
  env?: Env;
  home?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** The substrate's lexicons; tests pass a table. */
  lexicons?: (substrate: Substrate) => Promise<{ lexicons: IndexLexicon[]; note?: string }>;
  /** Builds the store; tests pass a fake. */
  openStore?: (plan: StorePlan, cwd: string) => Promise<IndexStore>;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  /** The caller's version, for the stamp's `source.version`. Default chant's. */
  version?: string;
}

function summarize(doc: IndexDocument): Pick<IndexSummary, "nodes" | "typed" | "unmapped" | "derivedEdges" | "coverage"> {
  const nodes = doc.graph.nodes;
  const unmapped = nodes.filter((n) => n.unmappedKind === true).length;
  const listed = doc.coverage.filter((c) => c.verdict === "listed").length;
  return {
    nodes: nodes.length,
    typed: nodes.length - unmapped,
    unmapped,
    derivedEdges: doc.graph.edges.filter((e) => e.origin === "derived").length,
    coverage: { listed, notObserved: doc.coverage.length - listed },
  };
}

/**
 * `chant index <substrate> …`, and `behold index` through it. Returns the
 * exit code: 0 written (or a store that keeps nothing), 1 a read or write
 * failed, 2 refused (usage, an action flag, a credential rule, a read-only
 * store).
 */
export async function runCloudIndex(argv: readonly string[], opts: RunCloudIndexOptions = {}): Promise<number> {
  const command = opts.command ?? "chant index";
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const out = opts.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => void process.stderr.write(s));
  const usage = indexUsage(command, opts.defaultStoreText);

  if (argv.includes("-h") || argv.includes("--help")) {
    out(usage);
    return 0;
  }

  let args: IndexArgs;
  let plan: StorePlan;
  try {
    args = parseIndexArgs(argv, command);
    plan = planIndexStore({
      store: args.store,
      cwd,
      env,
      defaultStoreDir: opts.defaultStoreDir ?? (() => chantUserStoreDir(env, home)),
      command,
      ...(opts.exists ? { exists: opts.exists } : {}),
    });
  } catch (e) {
    if (e instanceof IndexUsageError) {
      err(`${e.message}\n`);
      if (!e.actionFlag) err(`\n${usage}`);
      return 2;
    }
    throw e;
  }

  let scope: CloudScope;
  let target: SubstrateTarget;
  try {
    ({ scope, target } = scopeAndTarget(args, { env, cwd, home, command, ...(opts.readFile ? { readFile: opts.readFile } : {}) }));
  } catch (e) {
    if (e instanceof ListerConfigError) {
      err(`${e.message}. Nothing was listed and nothing was written.\n`);
      return 2;
    }
    throw e;
  }

  let store: IndexStore;
  try {
    store = await (opts.openStore ?? openIndexStore)(plan, cwd);
  } catch (e) {
    err(`${command}: the index store could not be opened: ${(e as Error).message}. Nothing was listed and nothing was written.\n`);
    return 2;
  }
  if (!store.writable && store.kind !== "none") {
    err(`${command}: the store ${store.where} is read-only. Nothing was listed and nothing was written.\n`);
    return 2;
  }

  const lex = await (opts.lexicons ?? substrateLexicons)(args.substrate);
  let result: IndexCloudResult;
  try {
    result = await indexCloud(
      { scope, target, store, lexicons: lex.lexicons, ...(opts.version ? { version: opts.version } : {}) },
      { ...(opts.list ? { list: opts.list } : {}), ...(opts.listOptions ? { listOptions: opts.listOptions } : {}) },
    );
  } catch (e) {
    if (e instanceof ListerConfigError || e instanceof OriginRefused || e instanceof MutatingCallRefused) {
      err(`${e.message}. Nothing was written.\n`);
      return 2;
    }
    if (e instanceof IndexWriteError) {
      err(`${command}: the index version could not be written to ${store.where}: ${e.message}\n`);
      return 1;
    }
    err(`${command}: ${(e as Error).message}. Nothing was written.\n`);
    return 1;
  }
  const { doc, write } = result;
  const notes: string[] = [];
  if (lex.note) notes.push(lex.note);
  for (const n of doc.notes ?? []) notes.push(n.message);

  const version = write.path ? basename(write.path) : undefined;
  const summary: IndexSummary = {
    substrate: args.substrate,
    scopeId: scope.scopeId,
    scopeKey: doc.stamp.scopeKey,
    observedAt: doc.stamp.observedAt,
    digest: doc.stamp.digest,
    store: { kind: store.kind, where: store.where },
    written: write.written,
    ...(version ? { version } : {}),
    ...(write.path ? { path: write.path } : {}),
    ...(write.reason ? { reason: write.reason } : {}),
    ...summarize(doc),
    notes,
  };

  if (args.json) {
    out(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    out(`${args.substrate} ${scope.scopeId}: ${summary.nodes} nodes (${summary.typed} typed, ${summary.unmapped} of unknown kind), ${summary.derivedEdges} derived edges\n`);
    out(`coverage: ${summary.coverage.listed} (type, location) listed, ${summary.coverage.notObserved} not observed\n`);
    for (const n of notes) out(`  note: ${n}\n`);
    if (write.written) out(`${command}: wrote ${version} under ${summary.scopeKey} in ${store.where}\n`);
    else out(`${command}: wrote nothing to ${store.where}: ${write.reason ?? "the store kept nothing"}\n`);
  }
  // An unchanged re-read at the same second, or a store that keeps nothing, is not a failure.
  return 0;
}

/** A store write that threw, told apart from a failed listing. */
export class IndexWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexWriteError";
  }
}

export { listCloud, ListerConfigError, MutatingCallRefused, OriginRefused, READ_OPERATIONS } from "../cloud-lister/index";
export type { CloudScope, ListingResult, ListOptions, Substrate, SubstrateTarget } from "../cloud-lister/index";
