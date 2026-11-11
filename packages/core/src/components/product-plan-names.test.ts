/**
 * #5003: the product plan keeps a product's names. A plan's own status
 * context reaches every job that reads the plan status (the note job's
 * `pr-post --context`, the stale job, the apply before merge), and `pr-post`
 * posts and marks under it; on GitLab `pr-post --open --plan-job` finds a
 * plan job of the product's name. The forge renders are in each lexicon's
 * `product-plan-pipeline.names.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { OpWavesSpec } from "../op/op-waves";
import { parseArgs } from "../cli/parse-args";
import { markStaleNotes, postOpenPlanReports, postPlanReport, prNoteTipMarker } from "../pr-post";
import { prNoteMarker } from "../pr-loop";
import { planNoteHandoff, PR_PLAN_NOTE_FILE, type PrPlanNote } from "../pr-plan-note";
import { withProductWords } from "../ci-product-words";
import type { ForgeStatus, OpenPullRequest, PrForge } from "../pr-forge";
import { TERRAGUCCI, TERRAGUCCI_NOTE } from "../__fixtures__/product-words";
import { productPipelineJobs } from "./product-pipeline";
import { productPlanJobs, productPlanWorkflowFile } from "./product-plan";

const NOTE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "__fixtures__", "pr-loop", "terragucci-plan.note.json"), "utf-8")) as PrPlanNote;
const HEAD = NOTE.head;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeForge(open: OpenPullRequest[] = []): { forge: PrForge; statuses: Array<{ sha: string; status: ForgeStatus }>; notes: Map<string, string> } {
  const statuses: Array<{ sha: string; status: ForgeStatus }> = [];
  const notes = new Map<string, string>();
  const forge = {
    kind: "github",
    host: "github.com",
    async setStatus(sha: string, status: ForgeStatus) {
      statuses.push({ sha, status });
    },
    async upsertNote(pr: number, marker: string, body: string) {
      notes.set(`${pr} ${marker}`, body);
      return "1";
    },
    async findComment(pr: number, marker: string) {
      const body = notes.get(`${pr} ${marker}`);
      return body === undefined ? undefined : { id: 1, body };
    },
    async openPullRequests(base: string) {
      return open.filter((p) => p.base === base);
    },
  } as unknown as PrForge;
  return { forge, statuses, notes };
}

const at = { pr: 7, env: "default", state: "success" as const, description: "2 roots planned" };

describe("pr-post under a product plan's own status context (#5003)", () => {
  test("the note job posts the status under the context it is given", async () => {
    const { forge, statuses } = fakeForge();
    const dir = mkdtempSync(join(tmpdir(), "chant-pr-post-names-"));
    dirs.push(dir);
    writeFileSync(join(dir, PR_PLAN_NOTE_FILE), JSON.stringify(planNoteHandoff(NOTE, at)));
    await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir, pr: 7, head: HEAD, env: "default", result: "success", noteWords: TERRAGUCCI_NOTE, context: "tg/plan-roots" }));
    expect(statuses.map((s) => s.status.context)).toEqual(["tg/plan-roots"]);
  });

  test("pr-post --open asks for the plan job it is named and posts under the context", async () => {
    const { forge: base, statuses } = fakeForge();
    const asked: string[] = [];
    const forge = {
      ...base,
      kind: "gitlab",
      async mergeRequestJobs(_branch: string, job: string) {
        asked.push(job);
        return [{ pr: 7, head: HEAD, id: 11, status: "success", url: "https://gitlab.example/job/11" }];
      },
      async jobArtifact(_id: number, path: string) {
        return path === "terragucci-report/pr-plan-note.json" ? JSON.stringify(planNoteHandoff(NOTE, at)) : undefined;
      },
      async statusUrl() {
        return undefined;
      },
      setStatus: base.setStatus,
      upsertNote: base.upsertNote,
      findComment: base.findComment,
    } as unknown as PrForge;
    const done = await withProductWords(TERRAGUCCI, () => postOpenPlanReports({ forge, branch: "main", job: "tf-plan", artifactDir: "terragucci-report", env: "default", context: "tg/plan-roots" }));
    expect(asked).toEqual(["tf-plan"]);
    expect(done.posts[0]!.posted).toMatchObject({ noted: true });
    expect(statuses.map((s) => s.status.context)).toEqual(["tg/plan-roots"]);
  });

  test("the stale job sets the named status back to pending", async () => {
    const head = "d".repeat(40);
    const { forge, statuses, notes } = fakeForge([{ number: 7, head: "feature", headSha: head, base: "main", fork: false }]);
    notes.set(`7 ${prNoteMarker("default")}`, [prNoteMarker("default"), "body", prNoteTipMarker("a".repeat(40)), ""].join("\n"));
    await withProductWords(TERRAGUCCI, () => markStaleNotes({ forge, branch: "main", tip: "b".repeat(40), env: "default", context: "tg/plan-roots" }));
    expect(statuses).toEqual([{ sha: head, status: expect.objectContaining({ context: "tg/plan-roots", state: "pending" }) }]);
  });

  test("the command line takes --context (once a --member with --stale) and --plan-job", () => {
    expect(parseArgs(["components", "pr-post", "--stale", "--member", "dev", "--context", "tg/dev/plan", "--member", "prod", "--context", "tg/prod/plan"]).statusContexts).toEqual(["tg/dev/plan", "tg/prod/plan"]);
    expect(parseArgs(["components", "pr-post", "--open", "--plan-job", "tf-plan"]).planJob).toBe("tf-plan");
    expect(() => parseArgs(["components", "pr-post", "--context", "tg plan"])).toThrow(/--context needs the plan status's context/);
    expect(() => parseArgs(["components", "pr-post", "--plan-job", "--open"])).toThrow(/--plan-job needs the plan job's name/);
  });
});

const words = { product: "terragucci", noun: ["root", "roots"] as [string, string], commands: { plan: "plan" as const, apply: "apply" as const }, approval: "per-wave" as const, op: "tf-apply", bin: "npx --no-install terragucci" };
const waves: OpWavesSpec = { name: "tf-apply", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "dev", runs: [{ target: "envs/dev" }] }] } as OpWavesSpec;

describe("the product plan's status context in the pipeline (#5003)", () => {
  const productPlan = { command: "terragucci plan {target} --out {output}", targets: [{ name: "dev" }, { name: "prod" }], statusContext: "tg/{target}/plan" };

  test.each(["github", "forgejo", "gitlab"] as const)("on %s, the stale job sets each target's own status back", (forge) => {
    const jobs = productPipelineJobs(forge, "default", { words, waves, productPlan, staleNotes: true });
    expect(jobs.waves!.pipeline.staleNotes!.command).toBe(`npx --no-install terragucci components pr-post --stale --tip "$TIP_SHA" --env default --forge ${forge} --member dev --member prod --context tg/dev/plan --context tg/prod/plan`);
  });

  test("the apply before merge asks for the product's plan statuses", () => {
    const jobs = productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: true, wavesBeforeMerge: {} });
    expect(jobs.comment!.jobs.wavesBeforeMerge!.plan).toEqual(["tg/dev/plan", "tg/prod/plan"]);
    const gitlab = productPipelineJobs("gitlab", "default", { words, waves, productPlan: { ...productPlan, replan: true }, noteCommands: true, wavesBeforeMerge: {} });
    expect(JSON.stringify(gitlab.noteCommands!.env)).toContain('\\"plan\\":[\\"tg/dev/plan\\",\\"tg/prod/plan\\"]');
  });

  test("without the options the jobs carry no names of their own", () => {
    const [p] = productPlanJobs("github", "default", { plan: { command: "terragucci plan --out {output}" } }, { ...words, aliases: [] } as never);
    expect(p!.context).toBeUndefined();
    expect(p!.reportDir).toBeUndefined();
    expect(productPlanWorkflowFile("gitlab", "default", { workflow: "terragucci" })).toBe(".gitlab/terragucci.gitlab-ci.yml");
    expect(productPlanWorkflowFile("gitlab", "default", { workflowFile: ".gitlab/terragucci.yml" })).toBe(".gitlab/terragucci.yml");
    expect(() => productPlanWorkflowFile("gitlab", "default", { workflowFile: "../ci.yml" })).toThrow(/inside it/);
  });
});
