/**
 * The follow-on records on `chant/lifecycle` (#4998): read and written
 * through the ledger's git, at `_waves/<op>.follow-on.json` from the top of
 * the branch (./follow-on-run.ts says what a record is). Kept apart so the
 * generators and the guard load no git code.
 */

import { fetchLifecycleStatus, pushLifecycleStatus, readBlobBySha, readPathSha, writeBlobToPath } from "../lifecycle/git";
import { FOLLOW_ON_DIR, followOnFile, parseFollowOn, renderFollowOn, type FollowOnChainPort, type FollowOnFile } from "./follow-on-run";

export type { FollowOnChainPort } from "./follow-on-run";

/** The port over `chant/lifecycle`: fetched, written and pushed again when another writer pushed first, up to three times. */
export function gitFollowOnChainPort(opts: { cwd?: string } = {}): FollowOnChainPort {
  const where = { ...opts, ledgerPrefix: "" };
  return {
    async read(op, key) {
      const fetched = await fetchLifecycleStatus(opts);
      if (fetched.status === "unreachable") throw new Error("chant/lifecycle could not be fetched, so the follow-on records cannot be read");
      const blob = await readPathSha(FOLLOW_ON_DIR, followOnFile(op), where);
      if (!blob) return undefined;
      return parseFollowOn(await readBlobBySha(blob, opts)).chains[key];
    },
    async write(op, record) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const fetched = await fetchLifecycleStatus(opts);
        if (fetched.status === "unreachable") throw new Error("chant/lifecycle could not be fetched, so the follow-on was not recorded");
        const blob = await readPathSha(FOLLOW_ON_DIR, followOnFile(op), where);
        const file = parseFollowOn(blob ? await readBlobBySha(blob, opts) : null);
        const next: FollowOnFile = { version: 1, chains: { ...file.chains, [record.key]: record } };
        await writeBlobToPath(FOLLOW_ON_DIR, followOnFile(op), renderFollowOn(next), `Follow on ${op}: wave ${record.wave} at ${record.key.slice(0, 12)}, started by run ${record.run}`, { ...where, expectPriorPathSha: blob });
        const pushed = await pushLifecycleStatus(opts);
        if (pushed.status === "stale") continue;
        if (pushed.status === "failed") throw new Error(`could not push the follow-on record to chant/lifecycle (${pushed.stderr.trim()})`);
        return;
      }
      throw new Error("chant/lifecycle kept moving, so the follow-on was not recorded");
    },
  };
}

/** A port held in memory, for tests and for a caller that keeps the records itself. */
export function memoryFollowOnChainPort(initial: Record<string, FollowOnFile> = {}): FollowOnChainPort & { files: Record<string, FollowOnFile> } {
  const files: Record<string, FollowOnFile> = { ...initial };
  return {
    files,
    async read(op, key) {
      return files[op]?.chains[key];
    },
    async write(op, record) {
      files[op] = parseFollowOn(renderFollowOn({ version: 1, chains: { ...(files[op]?.chains ?? {}), [record.key]: record } }));
    },
  };
}
