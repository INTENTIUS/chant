/**
 * The runner-start statement (#4147): a provisioner signs that it started a
 * runner for one CI job, and the job verifies it before it runs.
 */

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  ciJobFromEnv,
  DEFAULT_RUNNER_START_FILE,
  readRunnerStart,
  RUNNER_START_PREDICATE,
  signRunnerStart,
  verifyRunnerStart,
  verifyRunnerStartForJob,
  type CiJobIdentity,
  type RunnerStartSigner,
} from "./runner-start";
import { IN_TOTO_PAYLOAD_TYPE, signEnvelope, sshFromEd25519 } from "./workspace/trust/dsse";

function signer(principal: string): RunnerStartSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { principal, key: privateKey, publicKey: sshFromEd25519(Buffer.from(jwk.x, "base64url")) };
}

const PROVISIONER = signer("provisioner");
const RUNNERS = [{ principal: "provisioner", key: PROVISIONER.publicKey }];
const ROLES = { runner: ["provisioner"] };
const SHA = "a".repeat(40);
const JOB: CiJobIdentity = { system: "github", repo: "acme/infra", run: "4242", attempt: "1", job: "apply", commit: SHA, runner: "jit-apply-4242-1" };
const GITHUB_ENV = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/infra",
  GITHUB_RUN_ID: "4242",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "apply",
  GITHUB_SHA: SHA,
  RUNNER_NAME: "jit-apply-4242-1",
};

const verify = (envelope: unknown, job: CiJobIdentity = JOB, extra: Partial<Parameters<typeof verifyRunnerStart>[0]> = {}) =>
  verifyRunnerStart({ envelope, job, runners: RUNNERS, roles: ROLES, ...extra });

describe("signRunnerStart and verifyRunnerStart", () => {
  test("a statement the provisioner signed for this job verifies, as an object or as JSON text", () => {
    const envelope = signRunnerStart(JOB, PROVISIONER, new Date("2026-10-20T12:00:00Z"));
    expect(envelope.payloadType).toBe(IN_TOTO_PAYLOAD_TYPE);
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    expect(statement.predicateType).toBe(RUNNER_START_PREDICATE);
    expect(statement.subject).toEqual([{ name: SHA, digest: { gitCommit: SHA } }]);
    expect(statement.predicate).toEqual({
      signer: "provisioner",
      ci: { system: "github", repo: "acme/infra", run: "4242", attempt: "1", job: "apply" },
      runner: { name: "jit-apply-4242-1", singleJob: true },
      issuedAt: "2026-10-20T12:00:00.000Z",
    });
    expect(verify(envelope)).toMatchObject({ status: "verified", signer: "provisioner", issuedAt: "2026-10-20T12:00:00.000Z" });
    expect(verify(JSON.stringify(envelope)).status).toBe("verified");
  });

  test.each([
    ["another job", { job: "plan" }, "it is for job apply"],
    ["another attempt", { attempt: "2" }, "it is for attempt 1"],
    ["another run", { run: "4243" }, "it is for run 4242"],
    ["another commit", { commit: "b".repeat(40) }, "it is for commit aaaaaaaaaaaa"],
    ["another repository", { repo: "acme/app" }, "it is for repository acme/infra"],
    ["another runner of the same matrix job", { runner: "jit-apply-4242-2" }, "it is for runner jit-apply-4242-1, and this is jit-apply-4242-2"],
    ["a job whose environment names no runner", { runner: undefined }, "the job's environment names no runner"],
  ])("a statement for %s is refused as a mismatch", (_what, change, says) => {
    const v = verify(signRunnerStart(JOB, PROVISIONER), { ...JOB, ...change } as CiJobIdentity);
    expect(v.status).toBe("mismatch");
    expect(v.reason).toContain(says);
  });

  test("a missing statement is refused, naming the job", () => {
    for (const none of [undefined, null, ""]) {
      const v = verify(none);
      expect(v.status).toBe("missing");
      expect(v.reason).toContain("the github job apply of run 4242 (attempt 1) has no runner-start statement");
    }
  });

  test("a statement signed by a key outside runners is untrusted", () => {
    const stranger = signer("provisioner");
    const v = verify(signRunnerStart(JOB, stranger));
    expect(v.status).toBe("untrusted");
    expect(v.reason).toContain("no signature verifies against a runner key");
  });

  test("a listed key whose principal holds no runner role is untrusted", () => {
    const v = verify(signRunnerStart(JOB, PROVISIONER), JOB, { roles: { admin: ["provisioner"] } });
    expect(v.status).toBe("untrusted");
    expect(v.reason).toContain("holds no runner role");
  });

  test("a statement whose payload was changed after signing does not verify", () => {
    const envelope = signRunnerStart(JOB, PROVISIONER);
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    statement.predicate.ci.job = "plan";
    const tampered = { ...envelope, payload: Buffer.from(JSON.stringify(statement)).toString("base64") };
    expect(verify(tampered, { ...JOB, job: "plan" }).status).toBe("untrusted");
  });

  test("a signed payload with a field the verifier does not know, or another predicate, is invalid", () => {
    const sign = (statement: unknown) => signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from(JSON.stringify(statement)), PROVISIONER.key, PROVISIONER.publicKey);
    const good = JSON.parse(Buffer.from(signRunnerStart(JOB, PROVISIONER).payload, "base64").toString("utf8"));
    const extra = verify(sign({ ...good, predicate: { ...good.predicate, reused: true } }));
    expect(extra.status).toBe("invalid");
    expect(extra.reason).toContain("predicate has fields other than");
    const other = verify(sign({ ...good, predicateType: "https://intentius.io/chant/op-run/v1" }));
    expect(other.status).toBe("invalid");
    const notSingle = verify(sign({ ...good, predicate: { ...good.predicate, runner: { name: "jit-apply-4242-1", singleJob: false } } }));
    expect(notSingle.reason).toContain("singleJob: true");
    const forged = verify(sign({ ...good, predicate: { ...good.predicate, signer: "someone-else" } }));
    expect(forged.reason).toContain("names signer \"someone-else\"");
  });

  test("maxAgeSeconds refuses an old statement, and nothing limits age by default", () => {
    const envelope = signRunnerStart(JOB, PROVISIONER, new Date("2026-10-20T12:00:00Z"));
    const later = new Date("2026-10-20T13:00:00Z");
    expect(verify(envelope, JOB, { now: later }).status).toBe("verified");
    expect(verify(envelope, JOB, { now: later, maxAgeSeconds: 600 }).status).toBe("stale");
  });

  test("a GitLab statement needs no runner name, since CI_JOB_ID is unique", () => {
    const job: CiJobIdentity = { system: "gitlab", repo: "acme/platform/infra", run: "900", attempt: "1", job: "77001", commit: SHA };
    expect(verify(signRunnerStart(job, PROVISIONER), job).status).toBe("verified");
    expect(verify(signRunnerStart(job, PROVISIONER), { ...job, job: "77002" }).status).toBe("mismatch");
  });

  test("the provisioner cannot sign for a GitHub job without the runner's name, or for a short commit", () => {
    expect(() => signRunnerStart({ ...JOB, runner: undefined }, PROVISIONER)).toThrow(/needs the runner's name/);
    expect(() => signRunnerStart({ ...JOB, commit: "abc123" }, PROVISIONER)).toThrow(/not a full commit id/);
  });
});

describe("ciJobFromEnv", () => {
  test("GitHub, Forgejo and GitLab jobs name themselves from the forge's variables", () => {
    expect(ciJobFromEnv(GITHUB_ENV)).toEqual({ ok: true, job: JOB });
    expect(ciJobFromEnv({ ...GITHUB_ENV, FORGEJO_ACTIONS: "true" })).toEqual({ ok: true, job: { ...JOB, system: "forgejo" } });
    const { GITHUB_RUN_ATTEMPT: _a, ...noAttempt } = GITHUB_ENV;
    expect(ciJobFromEnv(noAttempt)).toMatchObject({ ok: true, job: { attempt: "1" } });
    expect(ciJobFromEnv({ GITLAB_CI: "true", CI_PROJECT_PATH: "acme/platform/infra", CI_PIPELINE_ID: "900", CI_JOB_ID: "77001", CI_COMMIT_SHA: SHA })).toEqual({
      ok: true,
      job: { system: "gitlab", repo: "acme/platform/infra", run: "900", attempt: "1", job: "77001", commit: SHA },
    });
  });

  test("a job missing a variable, or no forge at all, names no job", () => {
    const { GITHUB_JOB: _j, ...noJob } = GITHUB_ENV;
    expect(ciJobFromEnv(noJob)).toEqual({ ok: false, reason: "the job's environment does not set GITHUB_JOB" });
    expect(ciJobFromEnv({}).ok).toBe(false);
  });
});

describe("readRunnerStart and verifyRunnerStartForJob", () => {
  const envelope = signRunnerStart(JOB, PROVISIONER);

  test("the statement comes from CHANT_RUNNER_START, else the file CHANT_RUNNER_START_FILE names, else the default file", () => {
    const files: Record<string, string> = { "/tmp/rs.json": "from-file", [DEFAULT_RUNNER_START_FILE]: "from-default" };
    const read = (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    };
    expect(readRunnerStart({ CHANT_RUNNER_START: "inline", CHANT_RUNNER_START_FILE: "/tmp/rs.json" }, read)).toBe("inline");
    expect(readRunnerStart({ CHANT_RUNNER_START_FILE: "/tmp/rs.json" }, read)).toBe("from-file");
    expect(readRunnerStart({}, read)).toBe("from-default");
    expect(readRunnerStart({ CHANT_RUNNER_START_FILE: "/nowhere" }, read)).toBeUndefined();
  });

  test("one call verifies the job's own statement, and refuses it in another job", () => {
    const env = { ...GITHUB_ENV, CHANT_RUNNER_START: JSON.stringify(envelope) };
    expect(verifyRunnerStartForJob({ runners: RUNNERS, roles: ROLES, env }).status).toBe("verified");
    expect(verifyRunnerStartForJob({ runners: RUNNERS, roles: ROLES, env: { ...env, GITHUB_RUN_ATTEMPT: "2" } }).status).toBe("mismatch");
    expect(verifyRunnerStartForJob({ runners: RUNNERS, roles: ROLES, env, commit: "c".repeat(40) }).status).toBe("mismatch");
    expect(verifyRunnerStartForJob({ runners: RUNNERS, roles: ROLES, env: GITHUB_ENV, readFile: () => { throw new Error("ENOENT"); } }).status).toBe("missing");
  });
});
