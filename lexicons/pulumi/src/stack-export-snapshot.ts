/**
 * The stack export as the member's snapshot (#4546).
 *
 * After a successful `up`, the `pulumi-up` capability (`./pulumi-up.ts`)
 * runs `pulumi stack export --stack <s>` (`plunge stack export` on plunge),
 * strips its secrets, and writes it through chant's index store (#4519,
 * `@intentius/chant/lifecycle/snapshot-store`), whose default is
 * `refs/chant/snapshots`. Ruling B on INTENTIUS/plywood#1 put it there:
 * never `chant/lifecycle`, and never the working tree. The graph read
 * (`./workspace-member.ts`) and the member's reads in `./run.ts` take that
 * snapshot, and fall back to a checked-in `stack-export.json` when the store
 * has none, so a member nobody applies through chant reads as before.
 *
 * ## Where it sits in the store
 *
 * One snapshot per environment and stack, at
 * `<env>/<stack>__pulumi-export.json` under the member's ledger prefix
 * (`_members/<member>/` in a workspace, found from the stack's directory).
 * The key is its own, so `chant lifecycle snapshot` of the pulumi lexicon
 * (`<stack>__pulumi`) never overwrites it. The document is a
 * `LifecycleSnapshot` (lexicon `pulumi`, the resources by node key, the
 * stack's outputs under `stackExports`) with the stripped export under
 * `pulumiExport`, so every reader of the snapshot family can list it.
 *
 * ## Secrets
 *
 * The export holds each secret as ciphertext, and `deployment.secrets_providers.state`
 * holds what decrypts it (a passphrase salt, an encrypted data key). Before
 * the store sees it, every secret envelope becomes `"[secret]"`, the string
 * the preview and `stack output` print for one, and the provider's `state`
 * is dropped. A `plaintext` envelope (an export someone took with
 * `--show-secrets`) is blinded the same way, though chant never asks for one.
 *
 * ## Failing
 *
 * The snapshot is derived and safe to lose (snapshot-store.ts's rule), so a
 * failed export or write never fails the apply. The capability's output
 * says what happened (`exportSnapshot`), and the next apply writes it again.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SnapshotStore, StorePublish } from "@intentius/chant/lifecycle/snapshot-store";
import { isPulumiNodeless, pulumiNodeKey } from "@intentius/chant/pulumi-urn";
import { pulumiExportResources } from "./change-set";
import { pulumiExportedOutputValues } from "./member-outputs";
import type { PulumiMemberEngine } from "./member-engine";
import {
  defaultPlungeRunner,
  defaultPulumiRunner,
  pulumiRunFailure,
  readMemberExport,
  runAllowedPlunge,
  runAllowedPulumi,
  type PulumiRunner,
} from "./run";
import { isObject, PULUMI_BLINDED_SECRET, PULUMI_SECRET_SIG, PULUMI_SIG_KEY } from "./values";
import { PULUMI_EXPORT_FILE } from "./workspace-member";

const execFileAsync = promisify(execFile);

/** The store key's suffix: `<stack>__pulumi-export`, beside the lexicon snapshot's `<stack>__pulumi`. */
export const PULUMI_EXPORT_SNAPSHOT_SUFFIX = "pulumi-export";

/** The snapshot key for a stack's export. */
export function pulumiExportSnapshotKey(stack: string): string {
  return `${stack}__${PULUMI_EXPORT_SNAPSHOT_SUFFIX}`;
}

/** The argv chant runs for the export, after `pulumi` or `plunge`: no `--file`, no `--show-secrets`, no `--version`. */
export function pulumiStackExportArgs(opts: { stack: string }): string[] {
  return ["stack", "export", "--stack", opts.stack];
}

/**
 * The export with every secret blinded and the secrets provider's state
 * dropped. Returns a new value; the input is not changed.
 */
export function stripPulumiExportSecrets(doc: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObject(v)) return v;
    if (v[PULUMI_SIG_KEY] === PULUMI_SECRET_SIG) return PULUMI_BLINDED_SECRET;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    return out;
  };
  const stripped = walk(doc);
  const deployment = isObject(stripped) ? stripped.deployment : undefined;
  if (isObject(deployment) && isObject(deployment.secrets_providers)) {
    const { state: _state, ...rest } = deployment.secrets_providers;
    deployment.secrets_providers = rest;
  }
  return stripped;
}

/** The snapshot document the store holds. A `LifecycleSnapshot` with the export beside it. */
export interface PulumiExportSnapshot {
  lexicon: "pulumi";
  environment: string;
  stack: string;
  commit: string;
  timestamp: string;
  resources: Record<string, { type: string; physicalId?: string; status: string }>;
  stackExports?: Record<string, Record<string, unknown>>;
  /** The stripped `pulumi stack export`. */
  pulumiExport: unknown;
  /** The engine that took it. */
  engine: PulumiMemberEngine;
}

/** The snapshot for a stripped export. `resources` are keyed by the URN tail the graph uses, providers and the stack left out. */
export function pulumiExportSnapshot(opts: {
  exported: unknown;
  environment: string;
  stack: string;
  engine: PulumiMemberEngine;
  commit?: string;
  timestamp: string;
}): PulumiExportSnapshot {
  const resources: PulumiExportSnapshot["resources"] = {};
  for (const r of pulumiExportResources(opts.exported)) {
    if (isPulumiNodeless(r.type)) continue;
    const key = pulumiNodeKey(r.urn);
    if (key === null) continue;
    resources[key] = { type: r.type, ...(typeof r.id === "string" && r.id !== "" ? { physicalId: r.id } : {}), status: "deployed" };
  }
  const outputs = pulumiExportedOutputValues(opts.exported);
  return {
    lexicon: "pulumi",
    environment: opts.environment,
    stack: opts.stack,
    commit: opts.commit ?? "",
    timestamp: opts.timestamp,
    resources,
    ...(Object.keys(outputs).length > 0 ? { stackExports: { [opts.stack]: outputs } } : {}),
    pulumiExport: opts.exported,
    engine: opts.engine,
  };
}

/** What writing the export did, for the apply's output. */
export interface PulumiExportWrite {
  written: boolean;
  /** The store, for messages: `refs/chant/snapshots`, a directory, an s3 URL. */
  where?: string;
  /** `<env>/<stack>__pulumi-export`. */
  key?: string;
  /** The commit or object version the write made. */
  version?: string;
  publish?: StorePublish;
  /** Why nothing was written. */
  reason?: string;
}

export interface WritePulumiExportOptions {
  /** The stack's directory. The store and the member's ledger prefix are found from it. */
  dir: string;
  stack: string;
  /** The deploy environment (`DeployContext.env`). */
  environment: string;
  engine: PulumiMemberEngine;
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  /** The store. Default: the project's (`resolveSnapshotStore` from `dir`). `null` writes nothing. */
  store?: SnapshotStore | null;
  /** The time stamped on the snapshot. Default: now. */
  now?: () => Date;
}

async function headCommit(dir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** The project's store from `dir`, or null when this chant has no index store or it cannot be built. */
async function projectStore(dir: string): Promise<SnapshotStore | null> {
  try {
    const mod = (await import("@intentius/chant/lifecycle/snapshot-store")) as { resolveSnapshotStore?: (o: { cwd: string }) => Promise<SnapshotStore> };
    return typeof mod.resolveSnapshotStore === "function" ? await mod.resolveSnapshotStore({ cwd: dir }) : null;
  } catch {
    return null;
  }
}

/**
 * Export the stack, strip its secrets and write it to the store. Never
 * throws: a failure is `written: false` with the reason. With no store, or
 * one that keeps nothing (`none`, the read-only `orphan-branch`), nothing
 * runs.
 */
export async function writePulumiExportSnapshot(opts: WritePulumiExportOptions): Promise<PulumiExportWrite> {
  const store = opts.store === undefined ? await projectStore(opts.dir) : opts.store;
  if (store === null) return { written: false, reason: "no index store to write to (#4519), so the export was not taken" };
  if (!store.writable) return { written: false, where: store.where, reason: `the ${store.kind} store keeps no snapshot, so the export was not taken` };
  const args = pulumiStackExportArgs({ stack: opts.stack });
  let stdout: string;
  try {
    ({ stdout } =
      opts.engine === "plunge"
        ? await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, args, opts.dir)
        : await runAllowedPulumi(opts.run ?? defaultPulumiRunner, args, opts.dir));
  } catch (err) {
    const f = pulumiRunFailure(err);
    const why = f.missingBinary ? `the ${opts.engine} binary was not found on PATH` : (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
    return { written: false, reason: `${opts.engine} ${args.join(" ")} failed: ${why}` };
  }
  let exported: unknown;
  try {
    exported = JSON.parse(stdout) as unknown;
  } catch {
    return { written: false, reason: `${opts.engine} ${args.join(" ")} printed no JSON` };
  }
  const key = pulumiExportSnapshotKey(opts.stack);
  const snapshot = pulumiExportSnapshot({
    exported: stripPulumiExportSecrets(exported),
    environment: opts.environment,
    stack: opts.stack,
    engine: opts.engine,
    commit: await headCommit(opts.dir),
    timestamp: (opts.now ?? (() => new Date()))().toISOString(),
  });
  const at = { cwd: opts.dir };
  try {
    const result = await store.write(opts.environment, key, `${JSON.stringify(snapshot, null, 2)}\n`, at);
    if (!result.written) return { written: false, where: store.where, key: `${opts.environment}/${key}`, reason: result.reason ?? "the store kept nothing" };
    const publish = await store.publish(at);
    return { written: true, where: store.where, key: `${opts.environment}/${key}`, ...(result.version ? { version: result.version } : {}), publish };
  } catch (err) {
    return { written: false, where: store.where, key: `${opts.environment}/${key}`, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** An export the store holds for a member. */
export interface StoredPulumiExport {
  /** The stripped export. */
  doc: unknown;
  environment: string;
  stack: string;
  /** `<env>/<stack>__pulumi-export`. */
  key: string;
  where: string;
  timestamp: string;
}

export interface ReadStoredPulumiExportOptions {
  /** The member's directory. The store and the member's ledger prefix are found from it. */
  dir: string;
  /** The member's stack, when known. Without it, the store's export is read only when it holds one stack's. */
  stack?: string;
  /** Read this environment only. Default: the newest export of any environment. */
  environment?: string;
  /** The store. Default: the project's. `null` reads nothing. */
  store?: SnapshotStore | null;
}

/**
 * The newest export the store holds for the member, or undefined when it
 * holds none, holds several stacks' and no stack was named, or cannot be
 * read. Never throws.
 */
export async function readStoredPulumiExport(opts: ReadStoredPulumiExportOptions): Promise<StoredPulumiExport | undefined> {
  const store = opts.store === undefined ? await projectStore(opts.dir) : opts.store;
  if (store === null) return undefined;
  const at = { cwd: opts.dir };
  const suffix = `__${PULUMI_EXPORT_SNAPSHOT_SUFFIX}`;
  try {
    const environments = opts.environment ? [opts.environment] : await store.environments(at);
    const found: StoredPulumiExport[] = [];
    for (const environment of environments) {
      const keys = (await store.keys(environment, at)).filter((k) => (opts.stack ? k === pulumiExportSnapshotKey(opts.stack) : k.endsWith(suffix)));
      for (const key of keys) {
        const text = await store.readLatest(environment, key, at);
        if (text === null) continue;
        let snap: Partial<PulumiExportSnapshot>;
        try {
          snap = JSON.parse(text) as Partial<PulumiExportSnapshot>;
        } catch {
          continue;
        }
        if (snap.pulumiExport === undefined) continue;
        const stack = typeof snap.stack === "string" ? snap.stack : key.slice(0, -suffix.length);
        found.push({ doc: snap.pulumiExport, environment, stack, key: `${environment}/${key}`, where: store.where, timestamp: typeof snap.timestamp === "string" ? snap.timestamp : "" });
      }
    }
    if (found.length === 0) return undefined;
    if (!opts.stack && new Set(found.map((f) => f.stack)).size > 1) return undefined;
    return found.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))[0];
  } catch {
    return undefined;
  }
}

/** Where a member's export came from. */
export type MemberExportSource = { from: "store"; stored: StoredPulumiExport } | { from: "file"; file: string };

/**
 * The member's export: the store's, else the checked-in
 * {@link PULUMI_EXPORT_FILE}. Undefined when neither reads.
 */
export async function readMemberExportStored(
  dir: string,
  opts: { stack?: string; environment?: string; store?: SnapshotStore | null } = {},
): Promise<{ doc: unknown; source: MemberExportSource } | undefined> {
  const stored = await readStoredPulumiExport({ dir, ...opts });
  if (stored) return { doc: stored.doc, source: { from: "store", stored } };
  const doc = readMemberExport(dir);
  return doc === undefined ? undefined : { doc, source: { from: "file", file: PULUMI_EXPORT_FILE } };
}
