/**
 * #4998: the rest wave's record job records each follow-on it starts on
 * `chant/lifecycle` before it starts it (the run, the wave, the decision or
 * the pushed commit, and the chain's outcomes so far), and the last run's
 * control outcome and apply status add up every run of the chain: a chain
 * whose last wave changed nothing reports `applied`. On each forge.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { opWaveOutcomeDir, opWaveRecordPath, type OpWavesSpec } from "./op-waves";
import { followOnAfterRecord, followOnChainOf, readOpWaveRestNote, withChainOutcomes, type OpWavesFollowOnTarget } from "./op-waves-follow-on";
import { memoryFollowOnChainPort, type FollowOnChainPort } from "./follow-on-store";
import { opWaveApplyStatus, postOpWaveApplyStatus } from "./apply-status";
import { applyOutcomeOf } from "../control/applied";
import { earlierWaveOutcomes, writeWaveOutcomeFile, type WaveMemberStatus } from "../wave-blocked";
import { CHANT_EXIT } from "../exit-codes";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  digest: { over: "changing" },
  planWave: ["tg", "plan", "{wave}", "{runs}", "{plans}"],
  applyWave: ["tg", "apply", "{wave}", "{runs}", "{plans}"],
  waves: [
    { name: "layer", runs: [], discover: true, gate: "never" },
    { name: "rest", runs: [], discover: true, rest: true, gate: "never" },
  ],
};
const HEAD = "a".repeat(40);
const PUSHED = "d".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;

/** Each forge's record job: the follow-on target, and the variables a push's run and a decided head's run carry. */
const forges: Array<{ forge: OpWavesFollowOnTarget["forge"]; target: OpWavesFollowOnTarget; push: Record<string, string>; run: string; url?: string }> = [
  { forge: "github", target: { forge: "github", workflow: "tf-apply.yml" }, push: { GITHUB_SHA: PUSHED, GITHUB_RUN_ID: "101", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/infra" }, run: "101", url: "https://github.com/acme/infra/actions/runs/101" },
  { forge: "forgejo", target: { forge: "forgejo", workflow: "tf-apply.yml" }, push: { GITHUB_SHA: PUSHED, GITHUB_RUN_ID: "7", GITHUB_SERVER_URL: "https://code.example", GITHUB_REPOSITORY: "acme/infra" }, run: "7" },
  { forge: "gitlab", target: { forge: "gitlab" }, push: { CI_COMMIT_SHA: PUSHED, CI_PIPELINE_ID: "9001", CI_PIPELINE_URL: "https://gitlab.example/acme/infra/-/pipelines/9001" }, run: "9001", url: "https://gitlab.example/acme/infra/-/pipelines/9001" },
];

/** A record job's checkout after wave `wave`: the gate's decision (the plan found `found` waves) and the run's outcomes. */
function recorded(wave: number, found: number, members: Record<string, WaveMemberStatus>, at: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-follow-on-chain-"));
  const dir = join(cwd, opWaveOutcomeDir(spec));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, opWaveRecordPath(spec, wave)), JSON.stringify({ wave, discovered: { waves: found } }));
  writeWaveOutcomeFile(dir, wave, { apply: true }, Object.fromEntries(Object.entries(members).map(([m, status]) => [m, { status }])), at);
  return cwd;
}

const outcomeIn = (cwd: string) => {
  const dirs = [join(cwd, opWaveOutcomeDir(spec))];
  return { dirs, own: applyOutcomeOf(earlierWaveOutcomes(dirs, Number.MAX_SAFE_INTEGER).members).outcome, chain: applyOutcomeOf(withChainOutcomes(earlierWaveOutcomes(dirs, Number.MAX_SAFE_INTEGER).members, readOpWaveRestNote(dirs))).outcome };
};

for (const f of forges) {
  describe(`${f.forge}: a chain of follow-on runs (#4998)`, () => {
    test("each record job records the follow-on, then starts it; the last run adds up the chain, so an unchanged last wave reports applied", async () => {
      const chain = memoryFollowOnChainPort();
      const env = { CHANT_WAVES_FOLLOW_ON: JSON.stringify(f.target), ...f.push };
      const order: string[] = [];
      const start = async (_t: OpWavesFollowOnTarget, wave: number) => {
        // The record is on the ledger before the follow-on starts.
        order.push(`start ${wave} with the record at wave ${(await chain.read("tf-apply", PUSHED))?.wave}`);
        return {};
      };
      const at = (n: number) => () => new Date(`2026-11-10T12:0${n}:00.000Z`);

      // Run 1: the rest wave (2) applies vpc; the plan found 4 waves.
      const one = recorded(2, 4, { vpc: "applied" }, "2026-11-10T12:00:30.000Z");
      expect(await followOnAfterRecord({ spec, wave: 2, exitCode: 0, cwd: one, env, chain, start, now: at(1), log: () => {} })).toBe(CHANT_EXIT.done);
      expect(await chain.read("tf-apply", PUSHED)).toEqual({
        key: PUSHED,
        commit: PUSHED,
        wave: 3,
        from: 2,
        run: f.run,
        ...(f.url ? { url: f.url } : {}),
        at: "2026-11-10T12:01:00.000Z",
        outcomes: { vpc: { status: "applied", wave: 2, at: "2026-11-10T12:00:30.000Z" } },
      });

      // Run 2: wave 3 applies db, and records wave 4 with both runs' outcomes.
      const two = recorded(3, 4, { db: "applied" }, "2026-11-10T12:02:30.000Z");
      const follow = { ...env, CHANT_WAVES_WAVE: "3", CHANT_WAVES_COMMIT: PUSHED };
      expect(await followOnAfterRecord({ spec, wave: 3, exitCode: 0, cwd: two, env: follow, chain, start, now: at(3), log: () => {} })).toBe(0);
      expect(Object.keys((await chain.read("tf-apply", PUSHED))!.outcomes).sort()).toEqual(["db", "vpc"]);
      expect(order).toEqual(["start 3 with the record at wave 3", "start 4 with the record at wave 4"]);

      // Run 3, the last: wave 4 changes nothing. On its own it is unchanged; with the chain it applied.
      const three = recorded(4, 4, { edge: "unchanged" }, "2026-11-10T12:04:30.000Z");
      expect(await followOnAfterRecord({ spec, wave: 4, exitCode: 0, cwd: three, env: { ...follow, CHANT_WAVES_WAVE: "4" }, chain, start, now: at(5), log: () => {} })).toBe(0);
      expect(order).toHaveLength(2);
      const last = outcomeIn(three);
      expect(last.own).toBe("unchanged");
      expect(last.chain).toBe("applied");
      expect(applyOutcomeOf(withChainOutcomes(earlierWaveOutcomes(last.dirs, Number.MAX_SAFE_INTEGER).members, readOpWaveRestNote(last.dirs))).applied).toEqual(["db", "vpc"]);

      // The apply status of the last run posts the one success.
      const posted: Array<{ state: string; description: string }> = [];
      const forge = { kind: f.forge, setStatus: async (_sha: string, s: { state: string; description: string }) => void posted.push(s) };
      expect(await postOpWaveApplyStatus({ forge, dirs: last.dirs, wave: 4, of: 2, context: "x/apply", at: PUSHED })).toBe(`x/apply on ${PUSHED.slice(0, 12)}: success: all 4 waves applied`);
    });

    test("a decided head's record names the decision; a last run that failed reports partial, not failed", async () => {
      const chain = memoryFollowOnChainPort();
      const env = { CHANT_WAVES_FOLLOW_ON: JSON.stringify(f.target), ...f.push, CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: DIGEST };
      const one = recorded(2, 3, { vpc: "applied" }, "2026-11-10T12:00:30.000Z");
      expect(await followOnAfterRecord({ spec, wave: 2, exitCode: 0, cwd: one, env, chain, start: async () => ({}), log: () => {} })).toBe(0);
      expect(await chain.read("tf-apply", HEAD)).toMatchObject({ key: HEAD, pr: 7, digest: DIGEST, wave: 3, from: 2, run: f.run });
      expect((await chain.read("tf-apply", HEAD))!.commit).toBeUndefined();
      const two = recorded(3, 3, { db: "failed" }, "2026-11-10T12:02:30.000Z");
      expect(await followOnAfterRecord({ spec, wave: 3, exitCode: CHANT_EXIT.failed, cwd: two, env: { ...env, CHANT_WAVES_WAVE: "3" }, chain, start: async () => Promise.reject(new Error("no start")), log: () => {} })).toBe(CHANT_EXIT.failed);
      expect(outcomeIn(two)).toMatchObject({ own: "failed", chain: "partial" });
      expect(opWaveApplyStatus(outcomeIn(two).dirs, 3, 3, f.forge)).toEqual({ state: "failed", description: "wave 3 of 3: 1 applied, 1 failed" });
    });
  });
}

describe("the record job's record (#4998)", () => {
  const target: OpWavesFollowOnTarget = { forge: "github", workflow: "tf-apply.yml" };
  const env = { CHANT_WAVES_FOLLOW_ON: JSON.stringify(target), GITHUB_SHA: PUSHED, GITHUB_RUN_ID: "5" };

  test("a record that cannot be written starts no follow-on and fails the job", async () => {
    const broken: FollowOnChainPort = { read: async () => undefined, write: async () => Promise.reject(new Error("could not push the follow-on record to chant/lifecycle (denied)")) };
    const lines: string[] = [];
    let started = 0;
    const cwd = recorded(2, 3, { vpc: "applied" }, "2026-11-10T12:00:30.000Z");
    expect(await followOnAfterRecord({ spec, wave: 2, exitCode: 0, cwd, env, chain: broken, start: async () => (started++, {}), log: (l) => lines.push(l) })).toBe(CHANT_EXIT.failed);
    expect(started).toBe(0);
    expect(lines.at(-1)).toContain("the follow-on for wave 3 could not be recorded on chant/lifecycle (could not push the follow-on record to chant/lifecycle (denied)), so none is started");
  });

  test("a follow-on whose record names another wave carries no chain, and says so", async () => {
    const chain = memoryFollowOnChainPort();
    await chain.write("tf-apply", { key: PUSHED, commit: PUSHED, wave: 5, from: 4, run: "4", at: "2026-11-10T12:00:00.000Z", outcomes: { vpc: { status: "applied", wave: 2, at: "2026-11-10T11:00:00.000Z" } } });
    const lines: string[] = [];
    const cwd = recorded(3, 3, { db: "unchanged" }, "2026-11-10T12:02:30.000Z");
    await followOnAfterRecord({ spec, wave: 3, exitCode: 0, cwd, env: { ...env, CHANT_WAVES_WAVE: "3", CHANT_WAVES_COMMIT: PUSHED }, chain, start: async () => ({}), log: (l) => lines.push(l) });
    expect(readOpWaveRestNote([join(cwd, opWaveOutcomeDir(spec))])?.chain).toBeUndefined();
    expect(lines[0]).toContain("no record on chant/lifecycle started this wave");
  });

  test("the chain's key: the decided head before merge, else the commit the run applied", () => {
    expect(followOnChainOf("github", { GITHUB_SHA: PUSHED })).toEqual({ key: PUSHED, commit: PUSHED });
    expect(followOnChainOf("gitlab", { CI_COMMIT_SHA: "f".repeat(40), CHANT_WAVES_COMMIT: PUSHED })).toEqual({ key: PUSHED, commit: PUSHED });
    expect(followOnChainOf("forgejo", { CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: DIGEST, GITHUB_SHA: PUSHED })).toEqual({ key: HEAD, pr: 7, digest: DIGEST });
    expect(followOnChainOf("github", {})).toBeUndefined();
  });
});
