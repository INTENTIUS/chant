/**
 * #4629: the responses to a refused wave, a failed apply and a pull request
 * description, posted through fake forges in the product's words.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ChangeSetDocument, ChangeSetEntry } from "./change-set";
import { assertProductWords } from "./ci-product-words";
import { checkDescription, changeSetDiff, parseRespondList, renderRefusedDiff, renderTriage, resolveResponses, respondList, respondMarker, CI_RESPOND_ENV } from "./ci-respond";
import { refusedOfOpWave, refusedOfPrReport, respondDescription, respondOpWave, respondPrApply, triageOfOpWave, triageOfPrReport } from "./ci-respond-run";
import { CHANT_EXIT } from "./exit-codes";
import type { PrReport } from "./pr-loop";
import type { OpWavesSpec } from "./op/op-waves";
import type { RunOpWaveResult } from "./op/op-waves-run";
import { productPipelineJobs } from "./components/product-pipeline";
import { parseOpWavesSpec } from "./op/op-waves-run";
import { assertOpWavesSpec } from "./op/op-waves";

const REPORT = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "pr-loop", "pr-plan.golden.json"), "utf-8")) as PrReport;
const PLYWOOD = assertProductWords({ product: "plywood", verbs: { plan: ["preview", "previewed"], apply: ["update", "updated"] }, noun: ["stack", "stacks"], stages: { plan: "preview", apply: "up" } });

type Posted = { kind: "comment"; pr: number; marker: string; body: string } | { kind: "issue"; marker: string; title: string; body: string };

function fakeForge(kind: "github" | "gitlab" | "forgejo", pull?: { title: string; body: string }) {
  const posted: Posted[] = [];
  const forge = {
    kind,
    host: kind === "github" ? "github.com" : kind === "gitlab" ? "gitlab.com" : "codeberg.org",
    async upsertComment(pr: number, marker: string, body: string) {
      const at = posted.findIndex((p) => p.kind === "comment" && p.pr === pr && p.marker === marker);
      if (at >= 0) posted[at] = { kind: "comment", pr, marker, body };
      else posted.push({ kind: "comment", pr, marker, body });
      return { action: at >= 0 ? "updated" : "created", id: posted.length } as const;
    },
    async findComment(pr: number, marker: string) {
      const found = posted.find((p) => p.kind === "comment" && p.pr === pr && p.marker === marker);
      return found ? { id: 1, body: found.body } : undefined;
    },
    async trackIssue(marker: string, finding: { title: string; body: string } | null) {
      if (finding) posted.push({ kind: "issue", marker, title: finding.title, body: finding.body });
      return { action: "opened", number: 7 } as const;
    },
    async pullRequestFor() {
      return null;
    },
    async pullRequestHead(pr: number) {
      return { sha: "a".repeat(40), branch: `feature-${pr}`, open: true, sameRepo: true };
    },
    async findPullRequest(head: string) {
      return pull ? { number: 12, title: pull.title, body: pull.body, head } : undefined;
    },
  };
  return { forge, posted };
}

function entry(member: string, address: string, action: ChangeSetEntry["action"], after?: unknown): ChangeSetEntry {
  return { member, lexicon: "terraform", planner: "terraform", address, type: address.split(".")[0]!, action, attributes: after === undefined ? [] : [{ path: "value", after }] } as unknown as ChangeSetEntry;
}

function doc(digest: string, members: Record<string, string | null>, entries: ChangeSetEntry[]): ChangeSetDocument {
  const actions = { create: 0, update: 0, replace: 0, delete: 0, read: 0, "no-op": 0, forget: 0 };
  for (const e of entries) actions[e.action]++;
  return {
    ...REPORT.changeSet,
    digest,
    members: Object.entries(members).map(([member, planDigest]) => ({ member, lexicon: "terraform", planner: "terraform", status: planDigest ? "planned" : "failed", planDigest })),
    entries,
    summary: { ...REPORT.changeSet.summary, actions },
  } as ChangeSetDocument;
}

const SPEC: OpWavesSpec = { name: "plywood-up", op: "plywood-up", plan: ["./bin/plan", "{target}", "{plan}"], waves: [{ name: "prod", runs: [{ target: "app" }, { target: "db" }] }] } as unknown as OpWavesSpec;

describe("the responses list (#4629)", () => {
  test("parses, defaults and round-trips", () => {
    expect(parseRespondList("wave-refused=off,description=check")).toEqual({ "wave-refused": "off", description: "check" });
    expect(parseRespondList("apply-failed=maybe")).toEqual({ error: expect.stringContaining("triage or off") });
    expect(parseRespondList("drift=off")).toEqual({ error: expect.stringContaining("no event") });
    expect(resolveResponses(undefined, {})).toEqual({ "wave-refused": "diff", "apply-failed": "triage", description: "off" });
    expect(resolveResponses({ description: "check" }, { [CI_RESPOND_ENV]: "apply-failed=off" })).toEqual({ "wave-refused": "diff", "apply-failed": "off", description: "check" });
    expect(respondList({ "wave-refused": "diff", "apply-failed": "off" })).toBe("apply-failed=off");
  });

  test("an op waves spec takes respond, and refuses a description check or a bad mode", () => {
    const ok = { ...SPEC, respond: { "apply-failed": "off" } };
    expect(() => assertOpWavesSpec(ok as OpWavesSpec)).not.toThrow(/respond/);
    expect(() => assertOpWavesSpec({ ...SPEC, respond: { description: "check" } } as unknown as OpWavesSpec)).toThrow(/plan-note job/);
    expect(() => assertOpWavesSpec({ ...SPEC, respond: { "wave-refused": "loud" } } as unknown as OpWavesSpec)).toThrow(/diff or off/);
    expect(parseOpWavesSpec(JSON.stringify(ok), "spec").respond).toEqual({ "apply-failed": "off" });
  });
});

describe("a refused wave posts the diff between the approved plan and the new one (#4629)", () => {
  const approved = doc("jcs1-sha256:aaa", { app: "jcs1-sha256:p1", db: "jcs1-sha256:d1" }, [entry("app", "aws_s3_bucket.logs", "update", "v1"), entry("db", "aws_db_instance.main", "update", 1)]);
  const current = doc("jcs1-sha256:bbb", { app: "jcs1-sha256:p2", db: "jcs1-sha256:d1" }, [entry("app", "aws_s3_bucket.logs", "replace", "v2"), entry("app", "aws_iam_role.r", "create", "x"), entry("db", "aws_db_instance.main", "update", 1)]);

  test("member by member and entry by entry", () => {
    const diff = changeSetDiff(approved, current);
    expect(diff).toEqual([
      {
        member: "app",
        approved: "jcs1-sha256:p1",
        current: "jcs1-sha256:p2",
        changes: [
          { address: "aws_iam_role.r", now: "create", attributes: ["value"] },
          { address: "aws_s3_bucket.logs", was: "update", now: "replace", attributes: ["value"] },
        ],
      },
    ]);
    const text = renderRefusedDiff({ label: "wave 1 (prod) of plywood-up", reason: "moved", approved: approved.digest, current: current.digest, members: diff }, PLYWOOD);
    expect(text).toContain("Wave 1 (prod) of plywood-up updated nothing");
    expect(text).toContain("Stack whose plan differs");
    expect(text).toContain("`aws_s3_bucket.logs` update -> replace: value");
  });

  for (const kind of ["github", "gitlab", "forgejo"] as const) {
    test(`pr-apply refused for a moved plan posts on the pull request (${kind})`, async () => {
      const { forge, posted } = fakeForge(kind);
      const report = { ...REPORT, stage: "apply", status: "refused", refusal: "plan-changed", digest: current.digest, approval: { status: "changed", approved: approved.digest }, changeSet: current } as PrReport;
      const read = async (d: string) => (d === approved.digest ? approved : undefined);
      expect((await refusedOfPrReport(report, read, PLYWOOD))?.members.map((m) => m.member)).toEqual(["app"]);
      const posts = await respondPrApply(forge, report, undefined, { read, env: {}, words: PLYWOOD });
      expect(posts).toEqual([{ posted: true }]);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ kind: "comment", pr: 12, marker: respondMarker("wave-refused", "pr-12:prod") });
      expect(posted[0]!.body).toContain("updated nothing: its plans changed after the approval");
      // Twice posts once: the comment is found again by its marker.
      await respondPrApply(forge, report, undefined, { read, env: {}, words: PLYWOOD });
      expect(posted).toHaveLength(1);
    });
  }

  test("a share job that refused moved runs posts their digests; off posts nothing", async () => {
    const result = {
      exitCode: CHANT_EXIT.moved,
      applied: [],
      failed: [],
      moved: ["app"],
      hooks: [],
      decision: { op: "pr-12", digest: "jcs1-sha256:set", members: [{ member: "app", planDigest: "jcs1-sha256:p1" }] },
      plans: { app: { planDigest: "jcs1-sha256:p2" } },
    } as unknown as RunOpWaveResult;
    const refused = await refusedOfOpWave(SPEC, 1, result, async () => undefined, PLYWOOD);
    expect(refused).toMatchObject({ reason: "moved", members: [{ member: "app", approved: "jcs1-sha256:p1", current: "jcs1-sha256:p2" }] });
    const { forge, posted } = fakeForge("github");
    await respondOpWave(SPEC, 1, { result }, { forge, env: {}, words: PLYWOOD, read: async () => undefined });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: "comment", pr: 12 });
    const quiet = fakeForge("github");
    await respondOpWave({ ...SPEC, respond: { "wave-refused": "off" } }, 1, { result }, { forge: quiet.forge, env: {}, words: PLYWOOD });
    expect(quiet.posted).toHaveLength(0);
  });

  test("a held wave and a declined wave say why; with no pull request the post goes to a tracking issue", async () => {
    const held = { exitCode: CHANT_EXIT.held, applied: [], failed: [], moved: [], hooks: [], outcome: { outcome: "held", holder: { run: "pr-9-171" } }, decision: { op: "plywood-up", digest: "jcs1-sha256:set", members: [] } } as unknown as RunOpWaveResult;
    const { forge, posted } = fakeForge("gitlab");
    await respondOpWave(SPEC, 1, { result: held }, { forge, env: {}, words: PLYWOOD, read: async () => undefined });
    expect(posted[0]).toMatchObject({ kind: "issue", title: "plywood: plywood-up wave 1" });
    expect(posted[0]!.body).toContain("another run holds what it changes (held by pr-9-171)");
    const declined = { exitCode: CHANT_EXIT.declined, applied: [], failed: [], moved: [], hooks: [], decision: { op: "plywood-up", digest: "d", members: [], refused: { reason: "point", runs: ["app"] }, point: { name: "release-ok", answer: { answer: false } } } } as unknown as RunOpWaveResult;
    expect(await refusedOfOpWave(SPEC, 1, declined, async () => undefined, PLYWOOD)).toMatchObject({ reason: "declined", detail: "release-ok answered false" });
  });
});

describe("a failed apply posts the members and resources that failed with the engine's error (#4629)", () => {
  for (const kind of ["github", "gitlab", "forgejo"] as const) {
    test(`from an op wave's run record (${kind})`, async () => {
      const result = {
        exitCode: CHANT_EXIT.failed,
        applied: ["app"],
        failed: ["db"],
        moved: [],
        hooks: [],
        decision: { op: "pr-12", digest: "d", members: [] },
        targets: { db: { startedAt: "2026-10-28T00:00:00Z", durationMs: 5, error: "error: creating RDS instance: InvalidParameterValue", failedResources: ["aws_db_instance.main"] } },
      } as unknown as RunOpWaveResult;
      const triage = triageOfOpWave(SPEC, 1, { result }, PLYWOOD);
      expect(triage).toEqual({ label: "wave 1 (prod) of plywood-up", exitCode: 1, members: [{ member: "db", error: "error: creating RDS instance: InvalidParameterValue", resources: ["aws_db_instance.main"] }] });
      const { forge, posted } = fakeForge(kind);
      await respondOpWave(SPEC, 1, { result }, { forge, env: {}, words: PLYWOOD });
      expect(posted).toHaveLength(1);
      expect(posted[0]!.body).toContain("Stack that did not update");
      expect(posted[0]!.body).toContain("failed resources: `aws_db_instance.main`");
      expect(posted[0]!.body).toContain("InvalidParameterValue");
    });
  }

  test("from a pr-apply report, and turned off by CHANT_RESPOND", async () => {
    const report = { ...REPORT, stage: "apply", status: "failed", members: [{ ...REPORT.members[0]!, status: "failed", error: "Error: 403 AccessDenied" }, REPORT.members[1]!] } as PrReport;
    expect(triageOfPrReport(report, PLYWOOD)?.members).toEqual([{ member: "a", error: "Error: 403 AccessDenied" }]);
    expect(renderTriage(triageOfPrReport(report, PLYWOOD)!, PLYWOOD)).toContain("The update of pull request 12 failed (exit 1).");
    const on = fakeForge("forgejo");
    await respondPrApply(on.forge, report, undefined, { env: {}, words: PLYWOOD });
    expect(on.posted).toHaveLength(1);
    const off = fakeForge("forgejo");
    await respondPrApply(off.forge, report, undefined, { env: { [CI_RESPOND_ENV]: "apply-failed=off" }, words: PLYWOOD });
    expect(off.posted).toHaveLength(0);
  });

  test("a wave that applied posts nothing", () => {
    expect(triageOfOpWave(SPEC, 1, { result: { exitCode: 0, applied: ["app"], failed: [], moved: [], hooks: [] } as unknown as RunOpWaveResult })).toBeUndefined();
  });
});

describe("the description check posts its finding without approving or gating (#4629)", () => {
  const destroying = doc("jcs1-sha256:ccc", { app: "jcs1-sha256:p1" }, [entry("app", "aws_s3_bucket.logs", "delete"), entry("app", "aws_iam_role.app", "replace", "x"), entry("app", "aws_sqs_queue.q", "update", 1)]);

  test("a confident yes names the destroys and replacements the text leaves out", async () => {
    const asked: unknown[] = [];
    const finding = await checkDescription({
      doc: destroying,
      title: "Rotate the app role",
      description: "Replaces aws_iam_role.app with a new trust policy.",
      ask: async (state) => {
        asked.push(state);
        return { model: "noul-1", probability: 0.93 };
      },
      words: PLYWOOD,
    });
    expect(finding.status).toBe("flagged");
    expect(finding.unmentioned).toEqual(["app: aws_s3_bucket.logs"]);
    expect(finding.body).toContain("approves nothing and never blocks a merge");
    expect(asked[0]).toMatchObject({ plan: { counts: { delete: 1, replace: 1, update: 1, create: 0 }, destroys: ["app: aws_s3_bucket.logs"], replacements: ["app: aws_iam_role.app"] } });
  });

  test("below the threshold, with nothing destructive, or with no service answer, nothing is flagged", async () => {
    expect((await checkDescription({ doc: destroying, title: "", description: "", ask: async () => ({ model: "m", probability: 0.4 }) })).status).toBe("clear");
    expect((await checkDescription({ doc: REPORT.changeSet, title: "", description: "", ask: async () => { throw new Error("not asked"); } })).status).toBe("skipped");
    expect((await checkDescription({ doc: destroying, title: "", description: "", ask: async () => { throw new Error("connection refused"); } })).status).toBe("error");
  });

  for (const kind of ["github", "gitlab", "forgejo"] as const) {
    test(`the plan-note job posts the finding as its own comment (${kind})`, async () => {
      const { forge, posted } = fakeForge(kind, { title: "Tidy logging", body: "" });
      const finding = await respondDescription(forge, { ...REPORT, changeSet: destroying }, { ask: async () => ({ model: "noul-1", probability: 0.9 }) }, PLYWOOD);
      expect(finding?.status).toBe("flagged");
      expect(posted).toEqual([expect.objectContaining({ kind: "comment", pr: 12, marker: respondMarker("description", "prod") })]);
      // A later clear answer replaces the finding in place.
      await respondDescription(forge, { ...REPORT, changeSet: destroying }, { ask: async () => ({ model: "noul-1", probability: 0.1 }) }, PLYWOOD);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.body).toContain("The description now covers");
    });
  }
});

describe("the product pipeline carries the responses (#4629)", () => {
  test("CHANT_RESPOND on the apply and note jobs, the backend on the note line, respond on the waves spec", () => {
    const jobs = productPipelineJobs("github", "prod", {
      words: { product: "plywood" },
      applyBeforeMerge: true,
      respond: { "apply-failed": "off", description: "check" },
      decide: { backend: "laya", model: "noul-1" },
    });
    expect(jobs.applyBeforeMerge?.env[CI_RESPOND_ENV]).toBe("apply-failed=off,description=check");
    expect(jobs.applyBeforeMerge?.run.env[CI_RESPOND_ENV]).toBe("apply-failed=off,description=check");
    expect(jobs.post.env[CI_RESPOND_ENV]).toBe("apply-failed=off,description=check");
    expect(jobs.post.command).toContain('--decide-backend "laya" --decide-model "noul-1"');
    expect(() => productPipelineJobs("github", "prod", { words: { product: "plywood" }, applyBeforeMerge: true, respond: { description: "check" } })).toThrow(/decide/);
    const waves = productPipelineJobs("gitlab", "prod", { words: { product: "plywood", op: "plywood-up" }, waves: SPEC, respond: { "wave-refused": "off" } });
    expect(waves.waves?.spec.respond).toEqual({ "wave-refused": "off" });
  });
});
