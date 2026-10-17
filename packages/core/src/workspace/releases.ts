/**
 * The `releases` read (#4026, ws-104): every release of one member with its
 * targets, its cuts, and the environments that run it.
 *
 * `chant release list --json` prints this document. It reads the local
 * `chant/lifecycle` branch and never fetches. An environment runs a release
 * for the components whose latest deploy record there names the release in
 * `releaseDigest`. A promote under a release writes that field; deploys made
 * any other way do not name a release yet (#4043), so they list nowhere.
 *
 * A release file that is not a release, or whose content does not hash to its
 * digest, and a cut line that is not a cut, are left out and counted under
 * `reason` with `ledger-malformed`; the rest are listed. A read that fails
 * outright is the failure `ledger-unreadable`.
 */

import { execFileSync } from "node:child_process";
import { latestPerComponent, listReleaseEnvironments, readReleaseLedger } from "../lifecycle/release-ledger";
import { readAllReleases, readCuts, type Release, type ReleaseCut } from "../lifecycle/release-store";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { readerVersion } from "./declaration";

export const RELEASES_CONTRACT_VERSION = 1;
export const RELEASES_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/releases/v1/releases.schema.json";

/** Why the read stopped. Closed; each code is in `reason-codes.ts`. */
export const RELEASES_ERROR_CODES = ["not-a-git-repository", "ledger-unreadable"] as const;
/** Why some entries were left out. */
export const RELEASES_REASON_CODES = ["ledger-malformed"] as const;

/** One release as the document lists it. */
export interface ReleaseEntry extends Omit<Release, "version"> {
  /** The label its cuts gave it, or null. */
  label: string | null;
  /** Its cuts, oldest first. */
  cuts: Array<Omit<ReleaseCut, "version" | "releaseDigest">>;
  /** The environments that run it, and in each the components whose latest deploy names it. Sorted by env. */
  environments: Array<{ env: string; components: string[] }>;
}

export type ReleasesDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      /** The member read, its path of names joined with `/`, or null for a project outside a workspace. */
      member: string | null;
      /** Newest cut first; a release with no cut comes last. */
      releases: ReleaseEntry[];
      reason: { code: (typeof RELEASES_REASON_CODES)[number]; message: string } | null;
    }
  | { $schema: string; contract: number; chant: string; error: { code: (typeof RELEASES_ERROR_CODES)[number]; message: string } };

/** Read the releases of the member at `cwd`. */
export async function releasesDocument(req: { cwd: string }): Promise<ReleasesDocument> {
  const head = { $schema: RELEASES_SCHEMA_ID, contract: RELEASES_CONTRACT_VERSION, chant: readerVersion() };
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: req.cwd, stdio: "ignore" });
  } catch {
    return { ...head, error: { code: "not-a-git-repository", message: "releases are read from the chant/lifecycle branch, and this directory is not in a git repository" } };
  }
  try {
    const ledger = await resolveMemberLedger(req.cwd);
    const loc = { cwd: req.cwd };
    const { releases, malformed: badReleases } = await readAllReleases(loc);
    const { cuts, malformed: badCuts } = await readCuts(loc);

    const running = new Map<string, Map<string, string[]>>();
    for (const env of await listReleaseEnvironments(loc)) {
      const { records } = await readReleaseLedger(env, loc);
      for (const record of latestPerComponent(records).values()) {
        const digest = (record as { releaseDigest?: unknown }).releaseDigest;
        if (typeof digest !== "string") continue;
        const envs = running.get(digest) ?? new Map<string, string[]>();
        envs.set(env, [...(envs.get(env) ?? []), record.component].sort());
        running.set(digest, envs);
      }
    }

    const entries: ReleaseEntry[] = releases.map(({ version: _v, ...release }) => {
      const own = cuts.filter((c) => c.releaseDigest === release.releaseDigest);
      return {
        ...release,
        label: own.find((c) => c.label !== null)?.label ?? null,
        cuts: own.map(({ version: _cv, releaseDigest: _d, ...cut }) => cut),
        environments: [...(running.get(release.releaseDigest) ?? new Map<string, string[]>())]
          .map(([env, components]) => ({ env, components }))
          .sort((a, b) => (a.env < b.env ? -1 : 1)),
      };
    });
    const latest = (e: ReleaseEntry): string => e.cuts.map((c) => c.timestamp).sort().at(-1) ?? "";
    entries.sort((a, b) => (latest(b) !== latest(a) ? (latest(b) < latest(a) ? -1 : 1) : a.releaseDigest < b.releaseDigest ? -1 : 1));

    const bad = badReleases + badCuts;
    return {
      ...head,
      member: ledger.members.length > 0 ? ledger.members.join("/") : null,
      releases: entries,
      reason: bad > 0
        ? { code: "ledger-malformed", message: `${badReleases} release file(s) and ${badCuts} cut line(s) could not be read and are left out` }
        : null,
    };
  } catch (err) {
    return { ...head, error: { code: "ledger-unreadable", message: `reading the releases failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}
