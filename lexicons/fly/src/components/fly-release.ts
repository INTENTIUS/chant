/**
 * `fly-release` and `fly-rollback`: a component deploying to Fly with this
 * lexicon alone (#2736, ws-056), in place of chud's `Chud::FlySite`.
 *
 * A component declares its App and Machine as this lexicon's resources, builds
 * them (`chant build --lexicon fly -o <plan>`), and deploys with one step:
 *
 * ```ts
 * { kind: "fly-release", plan: "dist/fly.json", digest: "@app.publish.digest",
 *   image: "@app.publish.uri", migrations: [{ name: "001_init.sql", command: "node migrate.js 001_init.sql" }] }
 * ```
 *
 * `fly-release` runs the site steps in order, as the Machines activities
 * (../op/activities/machine-release.ts):
 *
 * 1. upload and start: apply the plan with the Machine serving the release,
 *    its digest and commit in the Machine's metadata;
 * 2. migrate: each migration runs inside the Machine once per environment,
 *    witnessed by a receipt in chant's lifecycle receipt store
 *    (`@intentius/chant/op/lifecycle-receipt-store`), then the Machine restarts
 *    on the migrated data;
 * 3. verify: the Machine is started with this release, and its health
 *    endpoint answers when a URL is given;
 * 4. on a failure after the Machine changed, restore: the config it replaced
 *    goes back (or, on a first release, the Machine is stopped), and the step
 *    fails.
 *
 * Its output carries `uri` and `digest`, so `chant run --components` records
 * the release in the ledger, and the Machine's metadata carries the same
 * digest, which `chant components status --live` compares with it.
 *
 * Each release's Machine config is kept on the lifecycle branch
 * (../release-store.ts). `fly-rollback` puts back the config of the release
 * the serving one replaced (or the digest it is given), which is also the
 * saga compensation `fly-release` declares. Given the source tree of that
 * release (#2800), it checks the archive against its digest before any flaps
 * call and refuses a recorded config that does not carry exactly that tree.
 */

import { createHash } from "node:crypto";
import type { Capability, DeployContext } from "@intentius/chant/components/capability";
import type { ReceiptStore, EffectReceiptRef } from "@intentius/chant/op/receipt-store";
import {
  findMachine,
  flyMachineExec,
  flyMachineRelease,
  flyMachineRestart,
  flyMachineRestore,
  flyMachineStop,
  flyMachineVerify,
  readMachineRelease,
  releaseTarget,
  type MachineFile,
  type MachineRelease,
} from "../op/activities/machine-release";
import { defaultFlyHttp, parsePlan, resolveEndpoint, type FlyHttp, type WaitOpts } from "../op/activities/fly-apply";
import type { MachineConfigStore } from "../release-store";
import { readFileSync } from "node:fs";

/** One migration, run inside the Machine once per environment. */
export interface FlyMigration {
  /** Its name: the receipt is named after it, so a name fires once. */
  name: string;
  /** The command, run in the Machine: an argv, or a string run with `sh -c`. */
  command: string[] | string;
  /** A digest of the migration's content. A migration whose content changes fires again. Default: a digest of the command. */
  sha?: string;
}

/** A source tree a release puts on the Machine. */
export interface FlySource {
  /** The archive (`sourceArchive`'s `archive`, a `git archive` tar). */
  archive: string;
  /** The sha256 the archive must have (`sha256:...`). */
  digest: string;
  /** The directory the archive holds, stripped from each path (`sourceArchive`'s `dir`). */
  dir?: string;
  /** Where the files go on the Machine. Default `/srv/app`. */
  into?: string;
  /** The command that starts the app, run in `into`: an argv, or a string run with `sh -c`. */
  start: string[] | string;
}

/** Most bytes of files, base64, a release puts in a Machine's config (as chud's fly-site.mjs capped them). */
export const SOURCE_FILES_LIMIT = 1024 * 1024;

/** Where a source tree goes on the Machine, without a trailing slash. */
const intoOf = (source: { into?: string }) => (source.into ?? "/srv/app").replace(/\/+$/, "");

/** A source tree's files as a Machine config carries them, once its archive is the approved one. */
async function sourceTreeFiles(source: Omit<FlySource, "start">, kind: string): Promise<MachineFile[]> {
  const { readSourceArchive } = await import("@intentius/chant/op/source-archive");
  const into = intoOf(source);
  const files: MachineFile[] = readSourceArchive(source).map((f) => ({
    guest_path: `${into}/${f.path}`,
    raw_value: f.data.toString("base64"),
    ...(f.executable ? { mode: 0o755 } : {}),
  }));
  if (files.length === 0) throw new Error(`${kind}: ${source.archive} holds no files`);
  return files;
}

/** A source tree as Machine files and the start command, once its archive is the approved one. */
export async function sourceMachineFiles(source: FlySource): Promise<{ files: MachineFile[]; cmd: string[] }> {
  const into = intoOf(source);
  const files = await sourceTreeFiles(source, "fly-release");
  const bytes = files.reduce((n, f) => n + f.raw_value.length, 0);
  if (bytes > SOURCE_FILES_LIMIT) {
    throw new Error(
      `fly-release: the source tree is ${Math.round(bytes / 1024)} KiB encoded; a Machine's config carries at most ${SOURCE_FILES_LIMIT / 1024} KiB of files. Ship a larger app as an image (\`image\`).`,
    );
  }
  const start = typeof source.start === "string" ? source.start : source.start.map(shellQuote).join(" ");
  return { files, cmd: ["sh", "-c", `cd ${shellQuote(into)} && exec ${start}`] };
}

const shellQuote = (v: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`);

/** Health check after the release serves. */
export interface FlyVerify {
  /** The app's public URL. Without it, only the Machine's state and metadata are checked. */
  url?: string;
  /** Default `/health`. */
  healthPath?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface FlyReleaseInput {
  /** Path to the fly build output (`chant build --lexicon fly -o <path>`). */
  plan: string;
  /** The Machine that serves, when the plan declares more than one (entity or Machine name). */
  machine?: string;
  /** The release's digest: what the ledger records and the Machine's metadata names. */
  digest: string;
  /** The commit it was built from. Default: `git rev-parse HEAD`, as the ledger records. */
  gitSha?: string;
  /** A human label for the release. */
  release?: string;
  /** An image to run in place of the declared one. */
  image?: string;
  /** Env added to the declared Machine's env. */
  env?: Record<string, string>;
  /**
   * A source tree to put on the Machine (#2782), for an app shipped as its
   * own files on a declared runtime image rather than as an image of its own.
   * The archive is read only once its bytes hash to `digest` (the digest the
   * release plan carries), so the Machine never gets a tree nobody approved.
   */
  source?: FlySource;
  /** Migrations, in order. */
  migrations?: FlyMigration[];
  verify?: FlyVerify;
  /** flaps endpoint override. Default: `FLY_FLAPS_BASE_URL`, else real Fly. */
  endpoint?: string;
  wait?: WaitOpts;
}

export interface FlyReleaseOutput {
  /** `fly://<app>/<machine>`: where the release was promoted. */
  uri: string;
  digest: string;
  gitSha?: string;
  app: string;
  machine: { id: string; name: string };
  /** The release the Machine served before this one, when it named one. */
  previous: MachineRelease | null;
  /** Each migration, and whether it fired this run. */
  migrations: Array<{ name: string; fired: boolean }>;
}

/** The source tree a rollback puts back (#2800): the archive of the release it goes back to. */
export type FlyRollbackSource = Omit<FlySource, "start">;

export interface FlyRollbackInput {
  /** Path to the fly build output, naming the App and Machine. */
  plan: string;
  machine?: string;
  /** The release digest to go back to. Default: the one the serving release replaced. */
  to?: string;
  /**
   * The source tree of the release it goes back to (#2800). The archive is
   * read only once its bytes hash to `digest`, before any flaps call, and the
   * Machine config recorded for `to` must carry exactly that tree under
   * `into`, or the rollback is refused.
   */
  source?: FlyRollbackSource;
  verify?: FlyVerify;
  endpoint?: string;
  wait?: WaitOpts;
}

export interface FlyRollbackOutput {
  uri: string;
  /** The release serving now. */
  digest: string;
  gitSha?: string;
  app: string;
  machine: { id: string; name: string };
  /** The release it replaced. */
  previous: MachineRelease | null;
}

/** What the capabilities reach the world through. Every field has a default; tests replace them. */
export interface FlyReleaseDeps {
  http?: FlyHttp;
  /** The Machine configs each release applied. Default: the lifecycle branch, per environment. */
  configStore?: (ctx: DeployContext) => MachineConfigStore | Promise<MachineConfigStore>;
  /** Migration receipts. Default: chant's lifecycle receipt store, per environment. */
  receiptStore?: (ctx: DeployContext) => ReceiptStore | Promise<ReceiptStore>;
  /** The commit a release defaults to. Default: `git rev-parse HEAD`. */
  headCommit?: () => Promise<string>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

async function defaultConfigStore(ctx: DeployContext): Promise<MachineConfigStore> {
  const { lifecycleMachineConfigStore } = await import("../release-store");
  return lifecycleMachineConfigStore(ctx.env);
}

async function defaultReceiptStore(ctx: DeployContext): Promise<ReceiptStore> {
  const { lifecycleReceiptStore } = await import("@intentius/chant/op/lifecycle-receipt-store");
  return lifecycleReceiptStore({ environment: ctx.env });
}

async function defaultHeadCommit(): Promise<string> {
  const { getHeadCommit } = await import("@intentius/chant/lifecycle/git");
  return getHeadCommit();
}

const sha256 = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

/** The receipt a migration fires under on an app. */
export function migrationReceipt(app: string, migration: FlyMigration): { ref: EffectReceiptRef; expectation: string } {
  const command = typeof migration.command === "string" ? migration.command : JSON.stringify(migration.command);
  return {
    ref: { name: `fly-migration:${app}/${migration.name}`, effect: "fly-migrate", flavor: "hash", inputs: { app, migration: migration.name } },
    expectation: migration.sha ?? sha256(command),
  };
}

function loadTarget(planPath: string, machine?: string) {
  const plan = parsePlan(readFileSync(planPath, "utf8"));
  return { plan, target: releaseTarget(plan, machine) };
}

const uriOf = (app: string, machine: string) => `fly://${app}/${machine}`;

/** Build the `fly-release` capability. */
export function createFlyReleaseCapability(deps: FlyReleaseDeps = {}): Capability<FlyReleaseInput, FlyReleaseOutput> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const httpFor = () => deps.http ?? defaultFlyHttp();

  async function rollBack(ctx: DeployContext, input: FlyReleaseInput, output?: FlyReleaseOutput): Promise<void> {
    if (!output) return;
    const http = httpFor();
    const target = { app: output.app, machine: output.machine.name, endpoint: input.endpoint };
    if (!output.previous) {
      await flyMachineStop({ ...target, wait: input.wait }, undefined, http);
      log(`fly-release: nothing served before ${output.digest}; stopped ${output.app}/${output.machine.name}`);
      return;
    }
    const store = await (deps.configStore ?? defaultConfigStore)(ctx);
    const config = await store.read({ app: output.app, machine: output.machine.name, digest: output.previous.digest });
    if (!config) {
      throw new Error(`fly-release: no recorded Machine config for ${output.previous.digest} on ${output.app}/${output.machine.name}; nothing to roll back to`);
    }
    await flyMachineRestore({ ...target, config, wait: input.wait }, undefined, http);
    log(`fly-release: rolled ${output.app}/${output.machine.name} back to ${output.previous.digest}`);
  }

  return {
    kind: "fly-release",
    rollbackPolicy: "native",
    async run(ctx, input) {
      if (!input.digest) throw new Error("fly-release: a release needs its digest");
      const http = httpFor();
      const { plan } = loadTarget(input.plan, input.machine);
      const gitSha = input.gitSha ?? (await (deps.headCommit ?? defaultHeadCommit)());
      const configs = await (deps.configStore ?? defaultConfigStore)(ctx);
      // The tree is checked against its digest before the Machine changes.
      const source = input.source ? await sourceMachineFiles(input.source) : undefined;

      const released = await flyMachineRelease(
        {
          plan,
          machine: input.machine,
          release: { digest: input.digest, gitSha, ...(input.release ? { release: input.release } : {}) },
          image: input.image,
          env: input.env,
          ...(source ? { files: source.files, cmd: source.cmd } : {}),
          endpoint: input.endpoint,
          wait: input.wait,
        },
        undefined,
        http,
      );
      const where = { app: released.app, machine: released.machine.name, endpoint: input.endpoint };
      log(`fly-release: ${released.app}/${released.machine.name} ${released.action}, serving ${input.digest}`);

      // The config the Machine served before is kept too, so a Machine
      // released before chant recorded configs can still be rolled back to.
      const replaced = released.previous?.release;
      const previousRelease: MachineRelease | null =
        replaced && replaced.digest !== input.digest
          ? replaced
          : released.release.previousDigest
            ? { digest: released.release.previousDigest }
            : null;
      if (replaced && previousRelease?.digest === replaced.digest && !(await configs.read({ app: released.app, machine: released.machine.name, digest: previousRelease.digest }))) {
        await configs.write({ app: released.app, machine: released.machine.name, digest: previousRelease.digest }, released.previous!.config);
      }

      const migrations: FlyReleaseOutput["migrations"] = [];
      try {
        if (input.migrations?.length) {
          const receipts = await (deps.receiptStore ?? defaultReceiptStore)(ctx);
          for (const migration of input.migrations) {
            const { ref, expectation } = migrationReceipt(released.app, migration);
            if ((await receipts.read(ref)) === expectation) {
              migrations.push({ name: migration.name, fired: false });
              continue;
            }
            log(`fly-release: migrating ${migration.name} on ${released.app}/${released.machine.name}`);
            await flyMachineExec({ ...where, command: migration.command }, undefined, http);
            // The receipt is written last, on success only: a failed migration fires again next run.
            await receipts.write(ref, expectation);
            migrations.push({ name: migration.name, fired: true });
          }
          if (migrations.some((m) => m.fired)) await flyMachineRestart({ ...where, wait: input.wait }, undefined, http);
        }
        await flyMachineVerify({ ...where, digest: input.digest, ...(input.verify ?? {}) }, undefined, http, deps.fetch);
      } catch (err) {
        // Restore: the Machine changed, so put back what it served (or stop it
        // when it served nothing), then fail the step.
        try {
          if (released.previous) {
            await flyMachineRestore({ ...where, config: released.previous.config, wait: input.wait }, undefined, http);
            log(`fly-release: restored ${released.app}/${released.machine.name} to ${previousRelease?.digest ?? "its previous config"}`);
          } else {
            await flyMachineStop({ ...where, wait: input.wait }, undefined, http);
            log(`fly-release: nothing had been released on ${released.app}/${released.machine.name}; stopped it`);
          }
        } catch (restoreErr) {
          log(`fly-release: restore failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
        }
        throw err;
      }

      await configs.write({ app: released.app, machine: released.machine.name, digest: input.digest }, released.config);
      return {
        uri: uriOf(released.app, released.machine.name),
        digest: input.digest,
        ...(gitSha ? { gitSha } : {}),
        app: released.app,
        machine: released.machine,
        previous: previousRelease,
        migrations,
      };
    },
    rollback: rollBack,
  };
}

/** Build the `fly-rollback` capability. */
export function createFlyRollbackCapability(deps: FlyReleaseDeps = {}): Capability<FlyRollbackInput, FlyRollbackOutput> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const httpFor = () => deps.http ?? defaultFlyHttp();

  async function recordedConfig(ctx: DeployContext, app: string, machine: string, digest: string): Promise<Record<string, unknown>> {
    const store = await (deps.configStore ?? defaultConfigStore)(ctx);
    const config = await store.read({ app, machine, digest });
    if (!config) throw new Error(`fly-rollback: no recorded Machine config for ${digest} on ${app}/${machine}`);
    return config;
  }

  async function restoreTo(ctx: DeployContext, input: FlyRollbackInput, app: string, machine: string, digest: string, config?: Record<string, unknown>, serving?: string) {
    config ??= await recordedConfig(ctx, app, machine, digest);
    const http = httpFor();
    // Already serving it (a rerun after the rollback finished): leave the Machine as it is.
    if (serving !== digest) await flyMachineRestore({ app, machine, config, endpoint: input.endpoint, wait: input.wait }, undefined, http);
    await flyMachineVerify({ app, machine, digest, endpoint: input.endpoint, ...(input.verify ?? {}) }, undefined, http, deps.fetch);
    return readMachineRelease((config as { metadata?: Record<string, string> }).metadata);
  }

  return {
    kind: "fly-rollback",
    rollbackPolicy: "native",
    async run(ctx, input) {
      // The tree is checked against its digest before any flaps call.
      const tree = input.source ? await sourceTreeFiles(input.source, "fly-rollback") : undefined;
      const http = httpFor();
      const { target } = loadTarget(input.plan, input.machine);
      const live = await findMachine({ base: resolveEndpoint(input) }, target.app, target.name, http);
      if (!live) throw new Error(`fly-rollback: no machine ${target.name} on app ${target.app}`);
      const serving = readMachineRelease(live.config?.metadata);
      const to = input.to ?? serving?.previousDigest;
      if (!to) throw new Error(`fly-rollback: ${target.app}/${target.name} serves ${serving?.digest ?? "no release"}, with no release before it to roll back to`);
      const config = await recordedConfig(ctx, target.app, target.name, to);
      if (tree) {
        const differs = treeDifference(config, tree, intoOf(input.source!));
        if (differs) {
          throw new Error(`fly-rollback: the Machine config recorded for ${to} does not carry the tree ${input.source!.digest} (${differs}); refusing to restore it`);
        }
      }
      const restored = await restoreTo(ctx, input, target.app, target.name, to, config, serving?.digest);
      log(
        serving?.digest === to
          ? `fly-rollback: ${target.app}/${target.name} already serves ${to}`
          : `fly-rollback: ${target.app}/${target.name} serves ${to} again (was ${serving?.digest ?? "no release"})`,
      );
      return {
        uri: uriOf(target.app, target.name),
        digest: to,
        ...(restored?.gitSha ? { gitSha: restored.gitSha } : {}),
        app: target.app,
        machine: { id: live.id, name: target.name },
        previous: serving ?? null,
      };
    },
    async rollback(ctx, input, output) {
      if (!output?.previous) return;
      await restoreTo(ctx, input, output.app, output.machine.name, output.previous.digest);
    },
  };
}

/**
 * How a recorded Machine config's files under `into` differ from a source
 * tree, or undefined when they are the same files with the same bytes. Pure.
 */
export function treeDifference(config: Record<string, unknown>, tree: MachineFile[], into: string): string | undefined {
  const prefix = `${into}/`;
  const recorded = new Map(((config.files as MachineFile[] | undefined) ?? []).filter((f) => f.guest_path.startsWith(prefix)).map((f) => [f.guest_path, f.raw_value]));
  for (const f of tree) {
    const bytes = recorded.get(f.guest_path);
    if (bytes === undefined) return `${f.guest_path} is not in it`;
    if (bytes !== f.raw_value) return `${f.guest_path} has other bytes`;
    recorded.delete(f.guest_path);
  }
  const extra = [...recorded.keys()][0];
  return extra ? `it also carries ${extra}` : undefined;
}

/** The default `fly-release` capability. */
export const flyReleaseCapability = createFlyReleaseCapability();
/** The default `fly-rollback` capability. */
export const flyRollbackCapability = createFlyRollbackCapability();
