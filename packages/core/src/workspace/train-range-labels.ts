/**
 * The labels a release train gives workspace packages (#5155), for
 * `release.version.ranges: "train"`: `chant release stamp <label> --train
 * <id|digest>` rewrites each workspace dependency's range to `^` and the
 * label the train pins for the member that owns that package.
 *
 * A package belongs to the member whose `release.version.packages` names its
 * directory. A member that declares no `release.version` owns no package a
 * range can follow, so a dependency on it keeps its committed range.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { RangeLabels } from "../lifecycle/release-version";
import { readDeclaration } from "./declaration";
import { readReleaseTrains, findTrain, type ReadTrain } from "./release-train";
import { locateWorkspace } from "./which-chant";

/** A train problem with a stable code, shown as the stamp's refusal. */
export class TrainLabelsError extends Error {
  constructor(readonly code: string, message: string, readonly fix?: string) {
    super(message);
    this.name = "TrainLabelsError";
  }
}

async function environmentsOf(cwd: string): Promise<string[]> {
  const { loadChantConfig } = await import("../config");
  return ((await loadChantConfig(cwd)).config.environments as string[] | undefined) ?? [];
}

/** Every train recorded for the environments `cwd`'s config declares, and for the workspace root's `release.train` (#5154), oldest first. */
async function trainsOf(cwd: string): Promise<{ trains: ReadTrain[]; rootOnDisk: string }> {
  const root = locateWorkspace(cwd).rootOnDisk;
  const trains: ReadTrain[] = [];
  const { loadChantConfig } = await import("../config");
  const rootEnv = await loadChantConfig(root)
    .then((c) => c.config.release?.train?.env)
    .catch(() => undefined);
  for (const env of new Set([...(await environmentsOf(cwd)), ...(rootEnv ? [rootEnv] : [])])) trains.push(...(await readReleaseTrains(root, env)).records);
  return { trains, rootOnDisk: root };
}

/** Package name to the train's label for the member that owns it. */
export async function trainPackageLabels(train: ReadTrain, rootOnDisk: string): Promise<RangeLabels> {
  return labelsOf(train, rootOnDisk);
}

async function labelsOf(train: ReadTrain, rootOnDisk: string): Promise<RangeLabels> {
  const located = locateWorkspace(rootOnDisk);
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const { loadChantConfig } = await import("../config");
  const labels: RangeLabels = {};
  for (const pinned of train.members) {
    const member = declaration.members.find((m) => m.name === pinned.member && m.kind === "chant");
    if (!member) continue;
    const dir = resolve(rootOnDisk, member.dir);
    const packages = (await loadChantConfig(dir)).config.release?.version?.packages ?? [];
    for (const p of packages) {
      const file = join(dir, posix.normalize(p.split("\\").join("/")), "package.json");
      if (!existsSync(file)) continue;
      const name = (JSON.parse(readFileSync(file, "utf-8")) as { name?: unknown }).name;
      if (typeof name === "string") labels[name] = pinned.label;
    }
  }
  return labels;
}

/**
 * The labels train `ref` (an id or a digest) gives workspace packages, for
 * the release of `own` (the package names the member stamps) at `label`.
 * Refuses a train that does not exist and one that pins none of the member's
 * packages at the release's label.
 */
export async function trainLabels(cwd: string, ref: string, own: readonly string[], label: string): Promise<RangeLabels> {
  const { trains, rootOnDisk } = await trainsOf(cwd);
  const train = findTrain(trains, ref);
  if (!train) throw new TrainLabelsError("release-train-unknown", `no release train ${ref} is recorded for this member's environments`, "List them with chant workspace train list <env> --json.");
  const labels = await labelsOf(train, rootOnDisk);
  const pinned = own.filter((n) => n in labels);
  if (pinned.length === 0) throw new TrainLabelsError("release-train-not-pinned", `train ${ref} pins no release of this member's packages`, "Stamp from a train that pins this member: the member's release.version.packages name its packages.");
  const wrong = pinned.find((n) => labels[n] !== label);
  if (wrong !== undefined) throw new TrainLabelsError("release-train-not-pinned", `train ${ref} pins ${wrong} at ${labels[wrong] ?? "no release"}, not ${label}`, `Stamp the label the train pins.`);
  return labels;
}

/**
 * The label tables of every train that pins a release at `label`, newest
 * first, for the publish's check that a stamped tree is the release's. A
 * train that cannot be read is left out.
 */
export async function trainLabelCandidates(cwd: string, label: string): Promise<RangeLabels[]> {
  try {
    const { trains, rootOnDisk } = await trainsOf(cwd);
    const out: RangeLabels[] = [];
    for (const t of [...trains].reverse().filter((x) => x.members.some((m) => m.label === label))) {
      try {
        out.push(await labelsOf(t, rootOnDisk));
      } catch {
        // Left out.
      }
    }
    return out;
  } catch {
    return [];
  }
}
