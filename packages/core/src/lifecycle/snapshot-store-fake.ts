/**
 * A {@link SnapshotStore} made of the methods a test supplies, every other
 * method reading as empty (#4519). It imports nothing at runtime, so a
 * `vi.mock` factory can load it while the modules the real store needs are
 * themselves mocked.
 */
import type { SnapshotStore } from "./snapshot-store";

export function fakeSnapshotStore(parts: Partial<SnapshotStore> = {}): SnapshotStore {
  return {
    kind: "git-ref",
    where: "the test store",
    writable: true,
    write: async () => ({ written: true }),
    readLatest: async () => null,
    readAt: async () => null,
    list: async () => [],
    keys: async () => [],
    environments: async () => [],
    writeIndex: async () => ({ written: false, reason: "the test store keeps no index" }),
    listIndex: async () => [],
    readIndexAt: async () => null,
    readIndexLatest: async () => null,
    readIndexScope: async () => null,
    fetch: async () => {},
    publish: async () => ({ status: "local" }),
    ...parts,
  };
}
