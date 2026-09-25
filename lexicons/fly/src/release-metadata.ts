/**
 * The release a Fly Machine serves, as its metadata records it (#2736, ws-056).
 *
 * Pure: the keys, a reader, and a writer over a Machine config. The Machines
 * activities (./op/activities/machine-release.ts) stamp these on a release,
 * `describeResources` (./describe-resources.ts) reads them back, and
 * `chant components status --live` compares the digest with the release
 * ledger.
 */

/**
 * The Machine metadata keys that say which release it serves. Fly metadata is
 * a string map, so each field is its own key.
 *
 * - `digest`: the release's digest, the release ledger's join key.
 * - `gitSha`: the commit the release was built from.
 * - `release`: an optional human label (a tag, a release id).
 * - `previousDigest`: the release this one replaced when it first shipped, so
 *   a rollback knows where to go back to with no history of its own.
 */
export const RELEASE_METADATA_KEYS = {
  digest: "chant-release-digest",
  gitSha: "chant-release-git-sha",
  release: "chant-release",
  previousDigest: "chant-release-previous-digest",
} as const;

/** A release, as a Machine's metadata records it. */
export interface MachineRelease {
  /** The release's digest (`sha256:...`): what the release ledger records. */
  digest: string;
  /** The commit it was built from. */
  gitSha?: string;
  /** A human label for it. */
  release?: string;
  /** The digest of the release it replaced, when there was one. */
  previousDigest?: string;
}

export type MachineConfig = Record<string, unknown> & { metadata?: Record<string, string>; env?: Record<string, string> };

/** The release a Machine's metadata names, or undefined when it names none. Pure. */
export function readMachineRelease(metadata: Record<string, string> | null | undefined): MachineRelease | undefined {
  const digest = metadata?.[RELEASE_METADATA_KEYS.digest];
  if (!digest) return undefined;
  const gitSha = metadata?.[RELEASE_METADATA_KEYS.gitSha];
  const release = metadata?.[RELEASE_METADATA_KEYS.release];
  const previousDigest = metadata?.[RELEASE_METADATA_KEYS.previousDigest];
  return {
    digest,
    ...(gitSha ? { gitSha } : {}),
    ...(release ? { release } : {}),
    ...(previousDigest ? { previousDigest } : {}),
  };
}

/**
 * A Machine config serving `release`: a copy of `config` with the release's
 * metadata keys set (and any it does not carry removed). Pure.
 */
export function withReleaseMetadata(config: MachineConfig | undefined, release: MachineRelease): MachineConfig {
  const out = structuredClone(config ?? {}) as MachineConfig;
  const metadata = { ...(out.metadata ?? {}) };
  for (const key of Object.values(RELEASE_METADATA_KEYS)) delete metadata[key];
  metadata[RELEASE_METADATA_KEYS.digest] = release.digest;
  if (release.gitSha) metadata[RELEASE_METADATA_KEYS.gitSha] = release.gitSha;
  if (release.release) metadata[RELEASE_METADATA_KEYS.release] = release.release;
  if (release.previousDigest) metadata[RELEASE_METADATA_KEYS.previousDigest] = release.previousDigest;
  out.metadata = metadata;
  return out;
}

