/**
 * Where a Fly release's Machine config is kept, so a rollback can put it back
 * (#2736, ws-056).
 *
 * The Machine's metadata says which release it serves and which one it
 * replaced; the config that earlier release applied is kept on the
 * `chant/lifecycle` branch beside the release ledger, one file per release at
 * `<env>/fly/<app>/<machine>/<digest>.json`. It is written through core's
 * ledger plumbing, so a workspace member's copy lands under its own prefix,
 * and every checkout that fetches the branch can roll back.
 *
 * Not exported from the package entry point: it spawns git, which stays off
 * the build path. The `fly-release` and `fly-rollback` capabilities import it.
 */

import { readBlobFromPath, writeBlobToPath } from "@intentius/chant/lifecycle/git";

/** Which Machine and release a config belongs to. */
export interface MachineConfigRef {
  app: string;
  machine: string;
  digest: string;
}

/** A store of the Machine config each release applied. */
export interface MachineConfigStore {
  read(ref: MachineConfigRef): Promise<Record<string, unknown> | undefined>;
  write(ref: MachineConfigRef, config: Record<string, unknown>): Promise<void>;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "_");

/** The file a release's Machine config is kept in, under the environment's ledger directory. */
export function machineConfigFile(ref: MachineConfigRef): string {
  return `fly/${safe(ref.app)}/${safe(ref.machine)}/${safe(ref.digest.replace(/^sha256:/, ""))}.json`;
}

/** The lifecycle-branch store for `environment`. */
export function lifecycleMachineConfigStore(environment: string, opts?: { cwd?: string }): MachineConfigStore {
  return {
    async read(ref) {
      const content = await readBlobFromPath(environment, machineConfigFile(ref), opts);
      return content === null ? undefined : (JSON.parse(content) as Record<string, unknown>);
    },
    async write(ref, config) {
      await writeBlobToPath(
        environment,
        machineConfigFile(ref),
        `${JSON.stringify(config, null, 2)}\n`,
        `Fly release config ${ref.app}/${ref.machine} ${ref.digest}`,
        opts,
      );
    },
  };
}

/** An in-memory store, for tests and for a caller with nowhere to keep configs. */
export function memoryMachineConfigStore(): MachineConfigStore & { entries: Map<string, Record<string, unknown>> } {
  const entries = new Map<string, Record<string, unknown>>();
  return {
    entries,
    async read(ref) {
      const found = entries.get(machineConfigFile(ref));
      return found ? structuredClone(found) : undefined;
    },
    async write(ref, config) {
      entries.set(machineConfigFile(ref), structuredClone(config));
    },
  };
}
