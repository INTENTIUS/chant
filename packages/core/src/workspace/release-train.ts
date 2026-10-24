/**
 * Release trains (#2554, #2524 D19, ws-043): one record that pins a release
 * of every `chant` member, so several members move together.
 *
 * Releases stay per member (ws-043): each is a digest over its artifacts and
 * a git commit, written to the member's own ledger by `chant release cut`. A
 * train names one of them per member: by default the newest cut release, or
 * the one `--pin <member>=<label|digest>` picks. It refuses unless every
 * `chant` member of the declaration has a release, so a train never leaves a
 * member out. It is written to `_members/_workspace/<env>/trains.jsonl`.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { readAllReleases, readCuts } from "../lifecycle/release-store";
import { readDeclaration, WorkspaceReadError } from "./declaration";
import { locateWorkspace } from "./which-chant";
import { appendWorkspaceLine, readWorkspaceLines } from "./workspace-ledger";

export interface TrainMember {
  member: string;
  releaseDigest: string;
  /** The release's git commit. */
  commit: string;
  /** The label its newest cut gave it, or null. */
  label: string | null;
}

export interface ReleaseTrainRecord {
  version: 1;
  id: string;
  env: string;
  timestamp: string;
  actor: string;
  /** Every `chant` member, by name. */
  members: TrainMember[];
}

const TRAINS_FILE = "trains.jsonl";

/** What one member offers a train: its releases, newest cut first. */
export interface MemberReleases {
  member: string;
  releases: TrainMember[];
}

/**
 * Pick each member's release, pure. `pins` maps a member to a label or a
 * digest; a member with no pin takes its newest. Returns the members, or
 * the problems that stop the train.
 */
export function pickTrain(members: readonly MemberReleases[], pins: ReadonlyMap<string, string> = new Map()): { members: TrainMember[] } | { problems: string[] } {
  const problems: string[] = [];
  const picked: TrainMember[] = [];
  for (const name of pins.keys()) {
    if (!members.some((m) => m.member === name)) problems.push(`--pin ${name}: not a chant member of the workspace`);
  }
  for (const m of members) {
    const pin = pins.get(m.member);
    const r = pin === undefined ? m.releases[0] : m.releases.find((x) => x.releaseDigest === pin || x.label === pin);
    if (!r) {
      problems.push(pin === undefined ? `member ${m.member} has no release; cut one with chant release cut in its directory` : `member ${m.member} has no release ${pin}`);
      continue;
    }
    picked.push(r);
  }
  return problems.length > 0 ? { problems } : { members: picked };
}

/** Every `chant` member's releases, newest cut first, read from its ledger. */
export async function readMemberReleases(cwd: string): Promise<MemberReleases[]> {
  const located = locateWorkspace(cwd);
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const out: MemberReleases[] = [];
  for (const m of declaration.members) {
    if (m.kind !== "chant") continue;
    const loc = { cwd: located.rootOnDisk, member: m.dir === "." ? "." : m.name };
    const { releases } = await readAllReleases(loc);
    const { cuts } = await readCuts(loc);
    const newest = (digest: string) => cuts.filter((c) => c.releaseDigest === digest).map((c) => c.timestamp).sort().at(-1) ?? "";
    const label = (digest: string) => cuts.filter((c) => c.releaseDigest === digest && c.label !== null).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)).at(-1)?.label ?? null;
    const list = releases
      .filter((r) => newest(r.releaseDigest) !== "")
      .sort((a, b) => (newest(b.releaseDigest) < newest(a.releaseDigest) ? -1 : newest(b.releaseDigest) > newest(a.releaseDigest) ? 1 : 0))
      .map((r) => ({ member: m.name, releaseDigest: r.releaseDigest, commit: r.commit, label: label(r.releaseDigest) }));
    out.push({ member: m.name, releases: list });
  }
  return out;
}

function isTrain(v: unknown): v is ReleaseTrainRecord {
  const t = v as ReleaseTrainRecord;
  return typeof t === "object" && t !== null && t.version === 1 && typeof t.id === "string" && typeof t.env === "string" && Array.isArray(t.members);
}

export async function readReleaseTrains(cwd: string, env: string): Promise<{ records: ReleaseTrainRecord[]; malformed: number }> {
  return readWorkspaceLines(cwd, env, TRAINS_FILE, isTrain);
}

export async function appendReleaseTrain(cwd: string, record: ReleaseTrainRecord): Promise<string> {
  return appendWorkspaceLine(cwd, record.env, TRAINS_FILE, record, `Release train: ${record.env} ${record.id}`);
}

const USAGE = "chant workspace train <env> [--pin <member>=<label|digest>]... [--dry-run] [--json] | chant workspace train list <env> [--json]";

export async function runWorkspaceTrain(ctx: CommandContext): Promise<number> {
  const words = ctx.args.positionals ?? [];
  const rest = words[0] === "train" ? words.slice(1) : words;
  const listing = rest[0] === "list";
  const env = listing ? rest[1] : rest[0];
  if (!env) {
    console.error(formatError({ message: "chant workspace train needs an environment", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  try {
    if (listing) {
      const root = locateWorkspace(cwd).rootOnDisk;
      const { records } = await readReleaseTrains(root, env);
      if (ctx.args.json) console.log(JSON.stringify({ env, trains: records }, null, 2));
      else if (records.length === 0) console.log(`No release train recorded for ${env}.`);
      else for (const t of records) console.log(`${t.timestamp}  ${t.id}  ${t.members.map((m) => `${m.member}@${m.label ?? m.releaseDigest.slice(0, 19)}`).join(" ")}`);
      return 0;
    }
    const pins = new Map<string, string>();
    for (const p of ctx.args.pins ?? []) {
      const at = p.indexOf("=");
      if (at <= 0) {
        console.error(formatError({ message: `--pin ${p}: expected <member>=<label|digest>`, hint: USAGE }));
        return 1;
      }
      pins.set(p.slice(0, at), p.slice(at + 1));
    }
    const root = locateWorkspace(cwd).rootOnDisk;
    const picked = pickTrain(await readMemberReleases(root), pins);
    if ("problems" in picked) {
      console.error(formatError({ message: `no release train for ${env}: every chant member needs a release`, hint: USAGE }));
      for (const p of picked.problems) console.error(`  ${p}`);
      return 1;
    }
    const actor = ctx.args.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER ?? "unknown";
    const record: ReleaseTrainRecord = { version: 1, id: `train-${randomUUID()}`, env, timestamp: new Date().toISOString(), actor, members: picked.members };
    if (!ctx.args.dryRun) await appendReleaseTrain(root, record);
    if (ctx.args.json) console.log(JSON.stringify({ ...record, written: !ctx.args.dryRun }, null, 2));
    else {
      console.log(`${ctx.args.dryRun ? "Would record" : "Recorded"} release train ${record.id} for ${env}:`);
      for (const m of record.members) console.log(`  ${m.member.padEnd(24)} ${m.label ?? "(no label)"}  ${m.releaseDigest}  ${m.commit.slice(0, 12)}`);
    }
    return 0;
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: USAGE }));
    return 1;
  }
}
