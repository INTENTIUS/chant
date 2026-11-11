/**
 * #4992: a `rest` wave before merge runs one wave per run. Its four jobs
 * run the wave a follow-on run names, past the spec's waves; the record job
 * leaves a note and, when the run applied and the plan found another wave,
 * starts the follow-on; `before-merge-done`, the apply status and the
 * control outcome take a run that started one as not the last.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { opWaveJobs, opWaveOutcomeDir, opWaveRecordPath, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveRunPort, type OpWaveRunsFile, type OpWaveShowAtBase } from "./op-waves-run";
import { opWaveSavedPlanPath, opWaveSplitJobs } from "./op-waves-split";
import {
  followOnAfterRecord,
  OP_WAVE_REST_NOTE,
  opWaveRestPath,
  opWavesRestWave,
  parseFollowOnTarget,
  readOpWaveRestNote,
  startFollowOn,
  type OpWavesFollowOnTarget,
} from "./op-waves-follow-on";
import { memoryGateLedgerPort } from "./gate";
import { memoryFollowOnChainPort } from "./follow-on-store";
import { beforeMergeDone } from "./before-merge-done";
import { beforeMergeDigest } from "./before-merge";
import { opWaveApplyStatus, postOpWaveApplyStatus } from "./apply-status";
import { writeWaveOutcomeFile } from "../wave-blocked";
import { resolveProductWords } from "../ci-product-words";
import { CHANT_EXIT } from "../exit-codes";

const digest = (n: string) => `sha256:${n.repeat(64)}`;
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
const github: OpWavesFollowOnTarget = { forge: "github", workflow: "tf-apply.yml" };
const env = { CHANT_WAVES_FOLLOW_ON: JSON.stringify(github), GITHUB_SHA: "d".repeat(40) };
/** #4998: the record each record job writes before it starts a follow-on, held in memory. */
const chain = memoryFollowOnChainPort();

/** A job's checkout: `layers[k-1]` is what wave k's plan finds. */
function checkout(layers: Array<Record<string, { planDigest: string }>>) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-follow-on-"));
  const calls: string[] = [];
  const exec: OpWaveExec = (argv, dir) => {
    calls.push(argv.join(" "));
    const runs = JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile;
    if (argv[1] === "plan") {
      const found = layers[runs.number - 1] ?? {};
      writeFileSync(join(dir, argv[4]!), JSON.stringify({ runs: Object.entries(found).map(([target, p]) => ({ target, ...p })), waves: layers.length }));
    }
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  const records: unknown[] = [];
  const runs: OpWaveRunPort = { append: async (r) => void records.push(r) };
  return { cwd, calls, records, base: { spec, specFile: "waves.json", cwd, exec, show, log: () => {}, now: "2026-11-10T00:00:00.000Z" }, runs };
}

/** The four jobs of the rest wave's slot running wave `k`, each in the same checkout (the artifacts carry the files between them). */
async function runSlot(c: ReturnType<typeof checkout>, k: number) {
  const gates = memoryGateLedgerPort();
  const noRuns: OpWaveRunPort = { append: async () => Promise.reject(new Error("this job writes no run record to the ledger")) };
  const plan = await runOpWave({ ...c.base, wave: k, phase: "plan", gates, runs: noRuns });
  const gate = await runOpWave({ ...c.base, wave: k, phase: "gate", gates });
  const apply = await runOpWave({ ...c.base, wave: k, phase: "apply", gates, runs: noRuns });
  const record = await runOpWave({ ...c.base, wave: k, phase: "record", runs: c.runs });
  return { plan, gate, apply, record };
}

const layers: Array<Record<string, { planDigest: string }>> = [{ vpc: { planDigest: digest("1") } }, { db: { planDigest: digest("2") } }, { app: { planDigest: digest("3") } }, { edge: { planDigest: digest("4") } }];

describe("the rest wave's jobs run the wave a follow-on run names (#4992)", () => {
  test("the split jobs of the rest wave name the wave CHANT_WAVES_WAVE gives, their own by default", () => {
    const split = opWaveSplitJobs(spec, opWaveJobs(spec, "waves.json", { beforeMerge: true }));
    const rest = split.filter((j) => j.rest);
    expect(rest.map((j) => j.jobName)).toEqual(["wave-2-rest-plan", "wave-2-rest-gate", "wave-2-rest", "wave-2-rest-record"]);
    expect(rest[0]!.command.join(" ")).toBe('chant run wave --spec waves.json --wave "${CHANT_WAVES_WAVE:-2}" --base "${CHANT_WAVES_BASE:-HEAD^1}" --phase plan');
    expect(split.find((j) => j.jobName === "wave-1-layer-plan")!.command.join(" ")).toContain("--wave 1 ");
    expect(opWavesRestWave(spec)).toBe(2);
    expect(opWavesRestWave({ waves: [spec.waves[0]!] })).toBeUndefined();
  });

  test("a rest wave's paths name the wave the run gives, and nothing else that holds its number", () => {
    expect(opWaveRestPath(".chant/op-waves/x/wave-2/saved-plan.json", 2, "$W")).toBe(".chant/op-waves/x/wave-$W/saved-plan.json");
    expect(opWaveRestPath(".chant/op-waves/x/outcomes/outcome-wave-2-apply.json", 2, "$W")).toBe(".chant/op-waves/x/outcomes/outcome-wave-$W-apply.json");
    expect(opWaveRestPath(".chant/op-waves/x/outcomes/run-record-wave-2.json", 2, "$W")).toBe(".chant/op-waves/x/outcomes/run-record-wave-$W.json");
    expect(opWaveRestPath(".chant/op-waves/x/wave-20.json", 2, "$W")).toBe(".chant/op-waves/x/wave-20.json");
  });

  test("the run applies wave 2 and starts wave 3; the follow-on applies waves 3 and 4, and the last starts none", async () => {
    const first = checkout(layers);
    const slot = await runSlot(first, 2);
    expect(slot.record).toMatchObject({ exitCode: 0, applied: ["db"] });
    const started: Array<[OpWavesFollowOnTarget, number]> = [];
    const start = async (t: OpWavesFollowOnTarget, wave: number) => (started.push([t, wave]), {});
    expect(await followOnAfterRecord({ spec, wave: 2, exitCode: slot.record.exitCode, cwd: first.cwd, env, chain, start, log: () => {} })).toBe(CHANT_EXIT.done);
    expect(started).toEqual([[github, 3]]);
    expect(readOpWaveRestNote([join(first.cwd, opWaveOutcomeDir(spec))])).toEqual({ version: 1, op: "tf-apply", wave: 2, found: 4, next: 3 });

    // The follow-on run: a fresh checkout, the rest wave's jobs at wave 3, past the spec's two waves.
    const second = checkout(layers);
    const three = await runSlot(second, 3);
    expect(three.plan.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(second.cwd, opWaveSavedPlanPath(spec, 3)), "utf-8"))).toMatchObject({ wave: 3, name: "rest", members: [{ member: "app" }] });
    expect(three.gate.decision).toMatchObject({ status: "not-required", discovered: { waves: 4 } });
    expect(three.record).toMatchObject({ exitCode: 0, applied: ["app"] });
    // Planned once, in the plan job, and applied once, in the applying job, at wave 3's files.
    expect(second.calls.map((c) => c.split(" ").slice(0, 3).join(" "))).toEqual(["tg plan rest", "tg apply rest"]);
    expect(second.calls[1]).toContain("wave-3");
    expect(await followOnAfterRecord({ spec, wave: 3, exitCode: three.record.exitCode, cwd: second.cwd, env, chain, start, log: () => {} })).toBe(0);
    expect(started.at(-1)).toEqual([github, 4]);

    const third = checkout(layers);
    const four = await runSlot(third, 4);
    expect(four.record).toMatchObject({ exitCode: 0, applied: ["edge"] });
    expect(await followOnAfterRecord({ spec, wave: 4, exitCode: four.record.exitCode, cwd: third.cwd, env, chain, start, log: () => {} })).toBe(0);
    expect(started).toHaveLength(2);
    // #4998: the last run's note carries the outcomes of the runs before it, from the record that started it.
    const note = readOpWaveRestNote([join(third.cwd, opWaveOutcomeDir(spec))]);
    expect({ ...note, chain: undefined }).toEqual({ version: 1, op: "tf-apply", wave: 4, found: 4, chain: undefined });
    expect(Object.fromEntries(Object.entries(note!.chain!).map(([m, o]) => [m, [o.status, o.wave]]))).toEqual({ db: ["applied", 2], app: ["applied", 3] });
  });
});

/** A record job's checkout after wave `wave`: the gate's decision and the outcomes. */
function recorded(wave: number, found: number, status: "applied" | "failed" = "applied"): string {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-follow-on-record-"));
  mkdirSync(join(cwd, opWaveOutcomeDir(spec)), { recursive: true });
  writeFileSync(join(cwd, opWaveRecordPath(spec, wave)), JSON.stringify({ wave, discovered: { waves: found } }));
  writeWaveOutcomeFile(join(cwd, opWaveOutcomeDir(spec)), wave, { apply: true }, { db: { status } });
  return cwd;
}

describe("the rest wave's record job (#4992)", () => {
  const none = async () => Promise.reject(new Error("no follow-on starts here"));

  test("a run that failed, or a plan that found no more waves, starts nothing and says it is the last", async () => {
    const failed = recorded(2, 4, "failed");
    expect(await followOnAfterRecord({ spec, wave: 2, exitCode: CHANT_EXIT.failed, cwd: failed, env, chain, start: none, log: () => {} })).toBe(CHANT_EXIT.failed);
    expect(readOpWaveRestNote([join(failed, opWaveOutcomeDir(spec))])).toEqual({ version: 1, op: "tf-apply", wave: 2, found: 4 });
    const done = recorded(2, 2);
    expect(await followOnAfterRecord({ spec, wave: 2, exitCode: 0, cwd: done, env, chain, start: none, log: () => {} })).toBe(0);
    expect(readOpWaveRestNote([join(done, opWaveOutcomeDir(spec))])).toEqual({ version: 1, op: "tf-apply", wave: 2, found: 2 });
  });

  test("a follow-on that cannot be started fails the job, and the note still says one was to start", async () => {
    const cwd = recorded(2, 3);
    const lines: string[] = [];
    expect(await followOnAfterRecord({ spec, wave: 2, exitCode: 0, cwd, env, chain, start: async () => Promise.reject(new Error("403 Forbidden")), log: (l) => lines.push(l) })).toBe(CHANT_EXIT.failed);
    expect(lines.at(-1)).toContain("the follow-on run for wave 3 could not be started (403 Forbidden)");
    expect(readOpWaveRestNote([join(cwd, opWaveOutcomeDir(spec))])?.next).toBe(3);
  });

  test("a job that is not the rest wave's, or a pipeline that sets no follow-on, is left as it is", async () => {
    const cwd = recorded(1, 4);
    expect(await followOnAfterRecord({ spec, wave: 1, exitCode: 0, cwd, env, chain, start: none })).toBe(0);
    expect(await followOnAfterRecord({ spec, wave: 2, exitCode: 0, cwd: recorded(2, 4), env: {}, start: none })).toBe(0);
    expect(() => readFileSync(join(cwd, opWaveOutcomeDir(spec), OP_WAVE_REST_NOTE))).toThrow();
    expect(() => parseFollowOnTarget('{"forge":"github"}')).toThrow("workflow");
    expect(parseFollowOnTarget('{"forge":"gitlab"}')).toEqual({ forge: "gitlab" });
  });
});

describe("starting the follow-on on each forge (#4992)", () => {
  const HEAD = "a".repeat(40);
  const PUSHED = "d".repeat(40);
  const posts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchFn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ web_url: "https://gitlab.example/acme/infra/-/pipelines/9" }), { status: 201 });
  }) as unknown as typeof fetch;

  test("GitHub dispatches the workflow on its branch with the decision and the wave", async () => {
    await startFollowOn(github, 3, { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://api.github.com", GITHUB_REF_NAME: "main", CHANT_WAVES_FOLLOW_ON_TOKEN: "job-token", CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: digest("e") }, fetchFn);
    expect(posts.at(-1)).toMatchObject({ url: "https://api.github.com/repos/acme/infra/actions/workflows/tf-apply.yml/dispatches", headers: { Authorization: "token job-token" }, body: { ref: "main", inputs: { pr: "7", head: HEAD, digest: digest("e"), wave: "3" } } });
  });

  test("Forgejo dispatches a push's follow-on with the commit the run applied, with CHANT_FORGE_TOKEN", async () => {
    await startFollowOn({ forge: "forgejo", workflow: "tf-apply.yml" }, 4, { FORGEJO_REPOSITORY: "acme/infra", FORGEJO_SERVER_URL: "https://code.example", GITHUB_REF: "refs/heads/main", CHANT_FORGE_TOKEN: "pat", CHANT_WAVES_COMMIT: PUSHED, GITHUB_SHA: "f".repeat(40) }, fetchFn);
    expect(posts.at(-1)).toMatchObject({ url: "https://code.example/api/v1/repos/acme/infra/actions/workflows/tf-apply.yml/dispatches", headers: { Authorization: "token pat" }, body: { ref: "main", inputs: { wave: "4", commit: PUSHED } } });
  });

  test("GitLab starts a pipeline of the branch with the variables, with CHANT_FORGE_TOKEN", async () => {
    const started = await startFollowOn({ forge: "gitlab" }, 3, { CI_API_V4_URL: "https://gitlab.example/api/v4", CI_PROJECT_ID: "42", CI_COMMIT_REF_NAME: "main", CI_COMMIT_SHA: PUSHED, CHANT_FORGE_TOKEN: "pat", CI_JOB_TOKEN: "job" }, fetchFn);
    expect(started.url).toBe("https://gitlab.example/acme/infra/-/pipelines/9");
    expect(posts.at(-1)).toMatchObject({
      url: "https://gitlab.example/api/v4/projects/42/pipeline",
      headers: { "PRIVATE-TOKEN": "pat" },
      body: { ref: "main", variables: [{ key: "CHANT_WAVES_WAVE", value: "3", variable_type: "env_var" }, { key: "CHANT_WAVES_COMMIT", value: PUSHED, variable_type: "env_var" }] },
    });
  });
});

describe("the jobs after the waves read the note (#4992)", () => {
  const words = resolveProductWords({});
  const HEAD = "a".repeat(40);
  const decision = { pr: 7, head: HEAD, base: "c".repeat(40), at: "2026-11-10T12:00:00.000Z", by: "alice" };
  const record = { ...decision, digest: beforeMergeDigest("tf-apply", decision) };

  test("before-merge-done merges nothing in a run that started a follow-on, and posts nothing", async () => {
    const said: string[] = [];
    const done = await beforeMergeDone({
      op: "tf-apply",
      waves: 2,
      run: { pr: "7", head: HEAD, digest: record.digest },
      record,
      outcome: { outcome: "applied", applied: ["db"], counts: { applied: 1 } },
      followOn: { wave: 2, next: 3, found: 4 },
      merge: "auto",
      forge: { kind: "github", addComment: async (_pr, text) => (said.push(text), { id: 1 }) },
      release: async () => Promise.reject(new Error("nothing is released")),
      words,
    });
    expect(done).toEqual({ code: 0, text: `wave 2 of 4 applied pull request 7's head ${HEAD.slice(0, 12)}, and a follow-on run goes on with wave 3; its done job merges, so nothing is merged here` });
    expect(said).toEqual([]);
  });

  test("the apply status counts the waves the plan found, and stays pending in a run that started a follow-on", async () => {
    const started = recorded(2, 4);
    const dir = join(started, opWaveOutcomeDir(spec));
    await followOnAfterRecord({ spec, wave: 2, exitCode: 0, cwd: started, env, chain, start: async () => ({}), log: () => {} });
    const posted: unknown[] = [];
    const forge = { kind: "github" as const, setStatus: async (_sha: string, s: unknown) => void posted.push(s) };
    expect(await postOpWaveApplyStatus({ forge, dirs: [dir], wave: 2, of: 2, context: "x/apply", at: HEAD })).toContain("running: wave 2 of 4 applied");
    // The last follow-on run, wave 4 of 4, posts the one success.
    const last = recorded(4, 4);
    await followOnAfterRecord({ spec, wave: 4, exitCode: 0, cwd: last, env, chain, start: async () => ({}), log: () => {} });
    expect(await postOpWaveApplyStatus({ forge, dirs: [join(last, opWaveOutcomeDir(spec))], wave: 4, of: 2, context: "x/apply", at: HEAD })).toContain("success: all 4 waves applied");
    // A follow-on whose gate waits leaves no note: the wave it ran is counted as the last one known.
    const waiting = mkdtempSync(join(tmpdir(), "op-waves-follow-on-wait-"));
    writeWaveOutcomeFile(waiting, 3, {}, { app: { status: "waiting" } });
    expect(opWaveApplyStatus([waiting], 3, 3, "github")).toEqual({ state: "running", description: "wave 3 of 3 waits for an approval" });
    expect(await postOpWaveApplyStatus({ forge, dirs: [waiting], wave: 3, of: 2, context: "x/apply", at: HEAD })).toContain("wave 3 of 3 waits for an approval");
  });
});
