/**
 * A release train across repositories (#5119): the dispatch into a member
 * repository, the member's train job and its answer, and the control
 * repo's side. Nothing reaches a forge: requests go to a fake fetch, and
 * the generated scripts run under bash with a stand-in curl and chant.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { controlAppliedProblems, parseControlApplied, recordControlApplied, recordControlAppliedFromEnv } from "./applied";
import { controlDependentsScript, controlDispatchRequest, controlDispatchScript, controlPipelineSpec, resolveControlTarget } from "./dispatch";
import type { ControlLedgerPort } from "./records";
import {
  dispatchTrainMember,
  trainControlJobSpec,
  trainDispatchRequest,
  trainMemberJobSpec,
  trainMemberTarget,
  trainProductOf,
  trainTokenEnv,
  trainTokenEnvOf,
  type TrainDispatch,
} from "./train";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REL = `jcs1-sha256:${"a".repeat(64)}`;
const TRAIN = "train-6f1c2d4e-0000-4000-8000-000000000001";
const RUN = "ws-6f1c2d4e-0000-4000-8000-000000000002";
const d: TrainDispatch = { member: "network", env: "prod", train: TRAIN, run: RUN, releaseDigest: REL, commit: SHA };
const control = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy", tokenSecret: "PLYWOOD_CONTROL_TOKEN" }, "network");

const scratch: string[] = [];
afterAll(() => {
  for (const s of scratch) rmSync(s, { recursive: true, force: true });
});
function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-5119-")));
  scratch.push(dir);
  return dir;
}

describe("the dispatch into a member repository", () => {
  test("a repo member's URL names its forge repository, in each spelling a declaration uses", () => {
    expect(trainMemberTarget("https://github.com/acme/network.git")).toMatchObject({ host: "github.com", path: "acme/network", forge: "github", apiBase: "https://api.github.com" });
    expect(trainMemberTarget("git@github.com:acme/network.git")).toMatchObject({ host: "github.com", path: "acme/network", forge: "github" });
    expect(trainMemberTarget("ssh://git@codeberg.org/acme/network")).toMatchObject({ host: "codeberg.org", path: "acme/network", forge: "forgejo", apiBase: "https://codeberg.org/api/v1" });
    expect(trainMemberTarget("https://bot:secret@github.com/acme/network").repo).toBe("https://github.com/acme/network");
    expect(() => trainMemberTarget("../network")).toThrow(/names no forge repository/);
    expect(() => trainMemberTarget("https://git.example.com/acme/network")).toThrow(/does not say which forge/);
    expect(() => trainMemberTarget("https://gitlab.com/acme/network")).toThrow(/GitHub and Forgejo repositories only/);
  });

  test("GitHub: a repository_dispatch of <product>-train carrying the train's fields; Forgejo: a dispatch of <product>-train.yml", () => {
    const gh = trainDispatchRequest(trainMemberTarget("https://github.com/acme/network"), d, { product: "plywood" });
    expect(gh.url).toBe("https://api.github.com/repos/acme/network/dispatches");
    expect(gh.body.json).toEqual({ event_type: "plywood-train", client_payload: { member: "network", env: "prod", train: TRAIN, run: RUN, release: REL, commit: SHA } });
    const fj = trainDispatchRequest(trainMemberTarget("https://codeberg.org/acme/network"), d, { product: "plywood" });
    expect(fj.url).toBe("https://codeberg.org/api/v1/repos/acme/network/actions/workflows/plywood-train.yml/dispatches");
    expect(fj.body.json).toEqual({ ref: "main", inputs: { member: "network", env: "prod", train: TRAIN, run: RUN, release: REL, commit: SHA } });
    expect(() => trainDispatchRequest(trainMemberTarget("https://github.com/acme/network"), { ...d, commit: "HEAD; rm" })).toThrow(/not a commit sha/);
  });

  test("the token is the member's own, from CHANT_TRAIN_TOKEN_<MEMBER>; a refusal never shows it, and no token sends nothing", async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const target = trainMemberTarget("https://github.com/acme/network");
    const ok = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      sent.push({ url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
      return { ok: true, status: 204, text: async () => "" };
    };
    await dispatchTrainMember(target, d, { env: { CHANT_TRAIN_TOKEN_NETWORK: "tok-n" }, fetch: ok });
    expect(sent[0]!.headers.Authorization).toBe("Bearer tok-n");
    expect(JSON.parse(sent[0]!.body!)).toMatchObject({ event_type: "chant-train" });
    const refuse = async () => ({ ok: false, status: 404, text: async () => "no tok-n here" });
    await expect(dispatchTrainMember(target, d, { env: { CHANT_TRAIN_TOKEN_NETWORK: "tok-n" }, fetch: refuse })).rejects.toThrow("refused the dispatch (HTTP 404): no *** here");
    await expect(dispatchTrainMember(target, d, { env: {}, fetch: ok })).rejects.toThrow(/CHANT_TRAIN_TOKEN_NETWORK is not set/);
    expect(sent).toHaveLength(1);
  });

  test("one token variable per member, and two members that would share one are refused", () => {
    expect(trainTokenEnv("data/warehouse-1")).toBe("CHANT_TRAIN_TOKEN_DATA_WAREHOUSE_1");
    expect(trainTokenEnvOf(["api", "web"])).toEqual({ CHANT_TRAIN_TOKEN_API: "${{ secrets.CHANT_TRAIN_TOKEN_API }}", CHANT_TRAIN_TOKEN_WEB: "${{ secrets.CHANT_TRAIN_TOKEN_WEB }}" });
    expect(() => trainTokenEnvOf(["a-b", "a.b"])).toThrow(/would share the dispatch token CHANT_TRAIN_TOKEN_A_B/);
    expect(trainProductOf({ CHANT_TRAIN_PRODUCT: "plywood" })).toEqual({ product: "plywood" });
    expect(trainProductOf({ CHANT_TRAIN_PRODUCT: "no way" })).toEqual({});
  });
});

/** A stand-in curl on PATH: it keeps its stdin and argv and answers 204. */
function fakeCurl(dir: string): void {
  const bin = join(dir, "curl");
  writeFileSync(bin, `#!/usr/bin/env bash\ncat > "${dir}/curl.stdin"\nprintf '%s\\n' "$@" > "${dir}/curl.argv"\nprintf 204\n`);
  chmodSync(bin, 0o755);
}

describe("the member's answer carries the train", () => {
  test("in GitHub's client_payload, Forgejo's inputs and GitLab's trigger variables", () => {
    const answer = { member: "network", op: "deploy", sha: SHA, outcome: "applied" as const, train: { train: TRAIN, run: RUN, env: "prod", releaseDigest: REL } };
    const gh = controlDispatchRequest(control, answer);
    expect(gh.body).toEqual({ json: { event_type: "chant-applied", client_payload: { member: "network", op: "deploy", sha: SHA, outcome: "applied", train: TRAIN, run: RUN, env: "prod", release: REL } } });
    const fj = controlDispatchRequest(resolveControlTarget({ repo: "codeberg.org/acme/control", op: "deploy" }, "network"), answer);
    expect(fj.body).toMatchObject({ json: { inputs: { train: TRAIN, run: RUN, env: "prod", release: REL } } });
    const gl = controlDispatchRequest(resolveControlTarget({ repo: "gitlab.com/acme/control", op: "deploy" }, "network"), answer);
    expect("form" in gl.body && gl.body.form).toEqual(expect.arrayContaining([["variables[CHANT_CONTROL_TRAIN]", TRAIN], ["variables[CHANT_CONTROL_RELEASE]", REL]]));
    expect(() => controlDispatchRequest(control, { ...answer, train: { ...answer.train, run: "x" } })).toThrow(/run must be a workspace run's id/);
  });

  test("the script sends the train's fields with the outcome, the token on curl's stdin", () => {
    const dir = tmp();
    fakeCurl(dir);
    const script = controlDispatchScript(control, { outcome: true, train: true });
    const env = { PATH: `${dir}:${process.env.PATH}`, CHANT_CONTROL_TOKEN: "tok-c", CHANT_CONTROL_SHA: SHA, CHANT_CONTROL_OUTCOME: "applied", CHANT_CONTROL_TRAIN: TRAIN, CHANT_CONTROL_RUN: RUN, CHANT_CONTROL_ENV: "prod", CHANT_CONTROL_RELEASE: REL };
    const r = spawnSync("bash", ["-c", script], { env, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "curl.stdin"), "utf-8")).toContain("Authorization: Bearer tok-c");
    const argv = readFileSync(join(dir, "curl.argv"), "utf-8").split("\n");
    expect(argv.join(" ")).not.toContain("tok-c");
    expect(JSON.parse(argv[argv.indexOf("-d") + 1]!)).toEqual({ event_type: "chant-applied", client_payload: { member: "network", op: "deploy", sha: SHA, outcome: "applied", train: TRAIN, run: RUN, env: "prod", release: REL } });
    const bad = spawnSync("bash", ["-c", script], { env: { ...env, CHANT_CONTROL_RELEASE: "v1" }, encoding: "utf-8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("the train's fields are not usable");
  });

  test("the control repo keeps the train on the apply record, and a record without one hashes as before", async () => {
    const lines: string[] = [];
    const port: ControlLedgerPort = { read: async () => lines.join("\n"), append: async (l) => (lines.push(l), "c") };
    const now = () => new Date("2026-11-15T00:00:00.000Z");
    const { record } = await recordControlApplied(port, { member: "network", op: "deploy", sha: SHA, outcome: "applied", train: { train: TRAIN, run: RUN, env: "prod", releaseDigest: REL } }, { now });
    expect(record.train).toEqual({ train: TRAIN, run: RUN, env: "prod", releaseDigest: REL });
    expect(controlAppliedProblems(record)).toEqual([]);
    expect(controlAppliedProblems({ ...record, train: { ...record.train!, releaseDigest: `jcs1-sha256:${"b".repeat(64)}` } })).toContain("digest does not match the record");
    const { record: plain } = await recordControlApplied(port, { member: "network", op: "deploy", sha: SHA, outcome: "applied" }, { now });
    expect(plain).not.toHaveProperty("train");
    expect(parseControlApplied(lines.join("\n")).records).toHaveLength(2);
    const skipped = await recordControlAppliedFromEnv({ env: { CHANT_CONTROL_MEMBER: "network", CHANT_CONTROL_OP: "deploy", CHANT_CONTROL_SHA: SHA, CHANT_CONTROL_OUTCOME: "applied", CHANT_CONTROL_TRAIN: TRAIN, CHANT_CONTROL_RUN: "nope" } });
    expect(skipped.skipped).toMatch(/train fields are not usable: run must be/);
  });

  test("the control repo's step continues the train for an answer, in place of the dependents", () => {
    const script = controlDependentsScript({ label: "plywood" });
    const train = script.indexOf('workspace train promote "$tenv" "$train" --continue --json');
    expect(train).toBeGreaterThan(script.indexOf("recordControlAppliedFromEnv"));
    expect(train).toBeLessThan(script.indexOf("workspace run --dependents-of"));
    expect(script).toContain("git push -q origin refs/heads/chant/lifecycle:refs/heads/chant/lifecycle");
    const spec = controlPipelineSpec("github", { product: "plywood" }, { trainMembers: ["api", "web"] });
    expect(spec.inputs).toHaveProperty("train");
    expect(spec.env).toMatchObject({ CHANT_CONTROL_TRAIN: "${{ github.event.client_payload.train || inputs.train }}", CHANT_TRAIN_PRODUCT: "plywood", CHANT_TRAIN_TOKEN_API: "${{ secrets.CHANT_TRAIN_TOKEN_API }}" });
    expect(controlPipelineSpec("github")).not.toHaveProperty(["env", "CHANT_TRAIN_PRODUCT"]);
  });
});

/** A member repository at one commit, a stand-in chant that keeps its argv and exits `code`, and the job's GITHUB_ENV. */
function memberCheckout(code: number): { dir: string; chant: string; githubEnv: string; head: string } {
  const dir = tmp();
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf-8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const chant = join(dir, "..", `${dir.split("/").pop()}-chant.sh`);
  writeFileSync(chant, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}.argv"\nexit ${code}\n`);
  chmodSync(chant, 0o755);
  scratch.push(chant, `${dir}.argv`, `${dir}.env`);
  return { dir, chant, githubEnv: `${dir}.env`, head: git("rev-parse", "HEAD") };
}

describe("the member's train job", () => {
  const spec = (chant: string) => trainMemberJobSpec("github", control, { words: { product: "plywood" }, command: chant, install: "true" });

  test("runs chant run --components all --release at the release's commit, and hands the outcome to the answer step", () => {
    for (const [code, outcome] of [[0, "applied"], [3, "waiting"], [1, "failed"]] as const) {
      const m = memberCheckout(code);
      const env = { PATH: process.env.PATH!, GITHUB_ENV: m.githubEnv, CHANT_TRAIN_ENV: "prod", CHANT_TRAIN_RELEASE: REL, CHANT_TRAIN_COMMIT: m.head, CHANT_TRAIN_ID: TRAIN, CHANT_TRAIN_RUN: RUN };
      const r = spawnSync("bash", ["-c", spec(m.chant).run.script], { cwd: m.dir, env, encoding: "utf-8" });
      expect(r.status).toBe(code);
      expect(readFileSync(`${m.dir}.argv`, "utf-8").trim().split("\n")).toEqual(["run", "--components", "all", "--env", "prod", "--release", REL]);
      expect(readFileSync(m.githubEnv, "utf-8")).toContain(`CHANT_CONTROL_OUTCOME=${outcome}\nCHANT_CONTROL_SHA=${m.head}\nCHANT_CONTROL_TRAIN=${TRAIN}\nCHANT_CONTROL_RUN=${RUN}\nCHANT_CONTROL_ENV=prod\nCHANT_CONTROL_RELEASE=${REL}\n`);
    }
  });

  test("refuses a checkout that is not the release's commit, and a dispatch that is not usable, before chant runs", () => {
    const m = memberCheckout(0);
    const env = { PATH: process.env.PATH!, GITHUB_ENV: m.githubEnv, CHANT_TRAIN_ENV: "prod", CHANT_TRAIN_RELEASE: REL, CHANT_TRAIN_COMMIT: SHA, CHANT_TRAIN_ID: TRAIN, CHANT_TRAIN_RUN: RUN };
    const moved = spawnSync("bash", ["-c", spec(m.chant).run.script], { cwd: m.dir, env, encoding: "utf-8" });
    expect(moved.status).toBe(2);
    expect(moved.stderr).toContain("not at the release's commit");
    const bad = spawnSync("bash", ["-c", spec(m.chant).run.script], { cwd: m.dir, env: { ...env, CHANT_TRAIN_COMMIT: m.head, CHANT_TRAIN_ENV: "prod; true" }, encoding: "utf-8" });
    expect(bad.status).toBe(2);
    expect(() => readFileSync(`${m.dir}.argv`)).toThrow();
  });

  test("the payload reaches the run step through its environment, and only the answer step holds the control repo's token", () => {
    const s = trainMemberJobSpec("github", control, { words: { product: "plywood" } });
    expect(s.path).toBe(".github/workflows/plywood-train.yml");
    expect(s.event).toBe("plywood-train");
    expect(s.run.env.CHANT_TRAIN_RELEASE).toBe("${{ github.event.client_payload.release || inputs.release }}");
    expect(s.run.script).not.toContain("${{");
    expect(JSON.stringify(s.run.env)).not.toContain("secrets.");
    expect(s.answer.env).toEqual({ CHANT_CONTROL_TOKEN: "${{ secrets.PLYWOOD_CONTROL_TOKEN }}" });
    expect(s.run.script).toContain('npx --no-install chant run --components all --env "$env" --release "$release"');
  });
});

describe("the control repo's train job", () => {
  test("starts the promote with one dispatch token per member and no cloud credential", () => {
    const s = trainControlJobSpec("github", ["api", "web"], { words: { product: "plywood" } });
    expect(s.path).toBe(".github/workflows/plywood-train.yml");
    expect(Object.keys(s.env).sort()).toEqual(["CHANT_TRAIN_ENV", "CHANT_TRAIN_ID", "CHANT_TRAIN_PRODUCT", "CHANT_TRAIN_TOKEN_API", "CHANT_TRAIN_TOKEN_WEB"]);
    expect(s.script).toContain('workspace train promote "$env" ${train:+"$train"} --json');
    expect(s.script).not.toMatch(/aws|gcloud|azure|vault|id-token/i);
    expect(() => trainControlJobSpec("github", [])).toThrow(/needs the repo members/);
  });
});
