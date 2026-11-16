/**
 * #5189: the jobs chant generates for GitHub, as Prow jobs of the matching
 * kind. A check with no credential is a presubmit; the record, the apply and
 * the deploys after merge are postsubmits; a schedule is a periodic. No job
 * that holds a credential is a presubmit, which PROW104 and PROW105 check on
 * every config here.
 */
import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { postSynthChecks } from "../lint/post-synth";
import { prow104 } from "../lint/post-synth/prow104";
import { prow105 } from "../lint/post-synth/prow105";
import { jobsOf, parseJobConfig, type LocatedJob } from "../job-config";
import { COMPONENTS, generatedConfigs } from "../testdata/generated-configs";
import { generateProwPipeline, prowLoopProblem } from "./generate-pipeline";
import { generateProwOpPipeline, prowOpsFileName } from "./generate-op-pipeline";
import { prowValue, renderProwJob, resolveProwSettings } from "./prow-jobs";
import { prowPlugin } from "../plugin";

function ctx(yaml: string): PostSynthContext {
  const outputs = new Map<string, string>([["prow", yaml]]);
  return { outputs, entities: new Map(), buildResult: { outputs, entities: new Map(), warnings: [] } } as unknown as PostSynthContext;
}

const jobs = (yaml: string): LocatedJob[] => jobsOf(parseJobConfig(yaml)!);
const byName = (yaml: string, name: string): LocatedJob => {
  const j = jobs(yaml).find((x) => x.job.name === name);
  if (!j) throw new Error(`no job ${name} in\n${yaml}`);
  return j;
};
type Container = { args: string[]; env?: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string; optional?: boolean } } }> };
const container = (j: LocatedJob): Container => (j.job.spec as { containers: Container[] }).containers[0]!;
const script = (j: LocatedJob): string => container(j).args[0]!;
const secrets = (j: LocatedJob): string[] => (container(j).env ?? []).filter((e) => e.valueFrom).map((e) => `${e.name}<-${e.valueFrom!.secretKeyRef.name}`);

describe("chant build --components --generate prow", () => {
  test("the plugin generates components and Ops", () => {
    expect(prowPlugin.generateComponentPipeline).toBeTypeOf("function");
    expect(prowPlugin.generateOpPipeline).toBeTypeOf("function");
  });

  test("the deploy pipeline is one postsubmit that runs the components in wave order, each seeding from its dependency", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "prod" });
    expect(r.env).toBe("prod");
    expect(r.stages).toEqual(["wave-1", "wave-2", "wave-3"]);
    expect(r.jobs.map((j) => `${j.jobName}<${j.needs.join(",")}`)).toEqual(["db<", "api<db", "web<api"]);
    const all = jobs(r.yaml);
    expect(all.map((j) => `${j.type} ${j.repo} ${j.job.name} ${j.job.cluster}`)).toEqual(["postsubmit acme/app chant-components-prod trusted"]);
    const s = script(all[0]!);
    const order = ["--components db", "--components api", "--components web"].map((x) => s.indexOf(x));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(s).toContain("chant run --components db --env prod --dump-outputs db.outputs.json");
    expect(s).toContain("chant run --components api --env prod --seed-outputs db.outputs.json --dump-outputs api.outputs.json");
    expect(all[0]!.job.max_concurrency).toBe(1);
    expect(all[0]!.job.branches).toEqual(["^main$"]);
    expect(secrets(all[0]!)).toEqual(["GITHUB_TOKEN<-chant-github-token"]);
  });

  test("the promote job is the postsubmit's last line, with the digest each publishing run recorded", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "staging", promoteTo: "prod" });
    const s = script(byName(r.yaml, "chant-components-staging"));
    expect(s).toContain("--digest-file api.digest");
    expect(s.trim().split("\n").at(-1)).toBe('chant components promote --from staging --to prod --digest "api=$(cut -d= -f2- api.digest)"');
    expect(r.jobs.at(-1)).toEqual({ jobName: "promote-prod", component: "promote-prod", stage: "promote-prod", needs: ["api", "db", "web"] });
  });

  test("gated waves are one postsubmit that runs the waves in order and keeps the record", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "prod", gatedWaves: { gate: "rollout" } });
    const j = byName(r.yaml, "chant-waves-prod");
    expect(j.type).toBe("postsubmit");
    const lines = script(j).split("\n").filter((l) => l.startsWith("chant components fan-out"));
    expect(lines.map((l) => l.match(/--wave (\d)/)![1])).toEqual(["1", "2", "3"]);
    expect(script(j)).toContain(".chant/fan-out.json");
    expect(r.jobs.map((x) => x.jobName)).toEqual(["wave-1", "wave-2", "wave-3"]);
  });

  test("the pull request plan is a presubmit with no credential that reads Prow's variables", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "prod", prLoop: {} });
    const plan = byName(r.yaml, "chant-plan-prod");
    expect(plan.type).toBe("presubmit");
    expect(plan.job.cluster).toBe("untrusted");
    expect(plan.job.always_run).toBe(true);
    expect(secrets(plan)).toEqual([]);
    expect((plan.job.spec as Record<string, unknown>).automountServiceAccountToken).toBe(false);
    expect((plan.job.spec as Record<string, unknown>).serviceAccountName).toBeUndefined();
    const s = script(plan);
    expect(s).toContain('export BASE_SHA="$PULL_BASE_SHA"');
    expect(s).toContain('export PR_NUMBER="$PULL_NUMBER"');
    expect(s).toContain('chant ci run plan --in-place --no-push --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --forge github');
    expect(s).not.toMatch(/GITHUB_TOKEN|CHANT_RUNNER_KEY|credential\.helper/);
    expect(s).toContain('cp -R "$p" "$ARTIFACTS/"');
  });

  test("the record is a postsubmit on the trusted cluster with the token from its Secret, measured from the branch", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "prod", prLoop: {} });
    expect(jobs(r.yaml).map((j) => `${j.type} ${j.job.name}`)).toEqual(["presubmit chant-plan-prod", "postsubmit chant-record-prod"]);
    const record = byName(r.yaml, "chant-record-prod");
    expect(record.job.cluster).toBe("trusted");
    expect(secrets(record)).toEqual(["GITHUB_TOKEN<-chant-github-token", "CHANT_RUNNER_KEY<-chant-runner-key"]);
    expect(container(record).env!.find((e) => e.name === "CHANT_RUNNER_KEY")!.valueFrom!.secretKeyRef.optional).toBe(true);
    const s = script(record);
    expect(s).toContain('GITHUB_SHA="$(git rev-parse HEAD)"; export GITHUB_SHA');
    expect(s).toContain("export BASE_SHA=''");
    expect(s).toContain('git merge-base FETCH_HEAD "$GITHUB_SHA"');
    expect(s).toContain("chant ci run record --in-place");
    expect(s).toContain("credential.helper");
  });

  test("the apply on merge is a postsubmit; with a gate per wave it runs the waves in order on the commit wave 1 took", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "prod", prLoop: { applyOnMerge: true }, gatedWaves: { gate: "pr-apply" }, prow: { serviceAccounts: { apply: "chant-apply" } } });
    const apply = byName(r.yaml, "chant-apply-prod");
    expect(apply.type).toBe("postsubmit");
    expect(apply.job.max_concurrency).toBe(1);
    expect((apply.job.spec as Record<string, unknown>).serviceAccountName).toBe("chant-apply");
    const s = script(apply);
    expect([1, 2, 3].map((w) => s.includes(`--wave-gate pr-apply --wave ${w}`))).toEqual([true, true, true]);
    expect(s.indexOf('GREEN_SHA="$(chant ci last-green)"')).toBeLessThan(s.indexOf('test -n "$GREEN_SHA"'));
    expect(r.jobs.map((j) => j.jobName)).toEqual(["chant-plan-prod", "chant-record-prod", "chant-apply-prod"]);
  });

  test("the check job is a presubmit with no credential, and stale notes a postsubmit", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "prod", prLoop: { checkJob: { env: { DB_URL: "postgres://db" } }, staleNotes: true } });
    const check = byName(r.yaml, "chant-check-prod");
    expect(check.type).toBe("presubmit");
    expect(secrets(check)).toEqual([]);
    expect(script(check)).toContain('chant ci check --base "$BASE_SHA"');
    expect(script(check)).toContain("export DB_URL=postgres://db");
    const stale = byName(r.yaml, "chant-stale-notes-prod");
    expect(stale.type).toBe("postsubmit");
    expect(script(stale)).toContain('export TIP_SHA="$(git rev-parse HEAD)"');
    expect(secrets(stale)).toEqual(["GITHUB_TOKEN<-chant-github-token"]);
  });

  test("a workspace member's jobs carry its name and run in its directory", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "prod", prLoop: {}, member: { name: "infra", dir: "stacks/infra" } });
    expect(jobs(r.yaml).map((j) => j.job.name)).toEqual(["chant-infra-plan-prod", "chant-infra-record-prod"]);
    expect(script(byName(r.yaml, "chant-infra-plan-prod"))).toContain("cd stacks/infra\n");
    // chant ci run finds the member from the directory it runs in.
    const s = script(byName(r.yaml, "chant-infra-plan-prod"));
    expect(s.indexOf("cd stacks/infra")).toBeLessThan(s.indexOf("chant ci run plan"));
  });

  test("the settings move the clusters and the Secrets", () => {
    const r = generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", env: "prod", prLoop: {}, prow: { untrustedCluster: "pr", trustedCluster: "infra", tokenSecret: { name: "gh", key: "t" } } });
    expect(jobs(r.yaml).map((j) => `${j.job.name} ${j.job.cluster}`)).toEqual(["chant-plan-prod pr", "chant-record-prod infra"]);
    expect(secrets(byName(r.yaml, "chant-record-prod"))[0]).toBe("GITHUB_TOKEN<-gh");
    expect(r.yaml).toContain("# Presubmits run on pr and hold no credential.\n# Postsubmits run on infra and read the GitHub token from the Secret gh.\n");
  });

  test("the repository comes from the forge, and is required", () => {
    expect(() => generateProwPipeline(COMPONENTS, { env: "prod" })).toThrow(/pass --repo <owner\/name>/);
    expect(() => generateProwPipeline(COMPONENTS, { forgeRepo: "acme", env: "prod" })).toThrow(/owner\/name/);
    expect(Object.keys(parseJobConfig(generateProwPipeline(COMPONENTS, { forgeRepo: "acme/other", env: "prod" }).yaml)!.postsubmits as object)).toEqual(["acme/other"]);
  });

  test("a dependency cycle is refused as the forge generators refuse it", () => {
    const cyclic = [
      { name: "a", dependsOn: ["b"], deploy: [] },
      { name: "b", dependsOn: ["a"], deploy: [] },
    ];
    expect(() => generateProwPipeline(cyclic, { forgeRepo: "acme/app", prLoop: {} })).toThrow(/cycle/i);
  });
});

describe("what has no Prow form is refused by name", () => {
  test.each([
    ["applyBeforeMerge", { applyBeforeMerge: true }],
    ["previewComment", { previewComment: true }],
    ["actionJob", { actionJob: true }],
    ["locks", { locks: "plan" as const }],
    ["prEnvironment", { prEnvironment: true }],
    ["refGateStatus", { refGateStatus: true }],
    ["evidence", { evidence: { runnerKeySecret: "CHANT_RUNNER_KEY" } }],
    ["identity", { identity: { plan: {}, apply: {} } }],
    ["runners", { runners: { plan: "big" } }],
    ["secrets", { secrets: { AWS_KEY: "AWS_KEY" } }],
  ])("prLoop.%s", (key, loop) => {
    const problem = prowLoopProblem(loop as never);
    expect(problem).toContain(`prLoop.${key}`);
    expect(() => generateProwPipeline(COMPONENTS, { forgeRepo: "acme/app", prLoop: loop as never })).toThrow(`prLoop.${key}`);
  });

  test("an empty map adds nothing, and the check job's services are refused", () => {
    expect(prowLoopProblem({ secrets: {} })).toBeUndefined();
    expect(prowLoopProblem({ checkJob: { services: [{ name: "db", image: "postgres:17" }] } })).toMatch(/no service containers/);
  });

  test("one cluster for both is refused, since presubmits would run where credentials are held", () => {
    expect(() => resolveProwSettings({ untrustedCluster: "c", trustedCluster: "c" })).toThrow(/PROW105/);
  });

  test("the renderer refuses a presubmit that would hold a credential", () => {
    const render = { settings: resolveProwSettings(), repo: "acme/app", branch: "main", image: "node:22", variables: {} };
    expect(() => renderProwJob({ kind: "presubmit", name: "p", description: "d", lines: ["true"], env: { GITHUB_TOKEN: "${{ github.token }}" } }, render)).toThrow(/PROW104/);
    expect(() => renderProwJob({ kind: "presubmit", name: "p", description: "d", lines: ["true"], serviceAccount: "sa" }, render)).toThrow(/PROW104/);
  });

  test("a GitHub expression with no Prow form is refused", () => {
    expect(prowValue("X", "${{ github.event.pull_request.base.sha }}")).toEqual({ shell: '"$PULL_BASE_SHA"' });
    expect(() => prowValue("AWS", "${{ secrets.AWS }}")).toThrow(/no Prow form/);
  });
});

describe("chant run --generate prow", () => {
  const ops = generateProwOpPipeline(
    [
      { name: "driftCheck", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue" },
      { name: "applyOnPush", trigger: { kind: "push", branches: ["main", "release"] } },
      { name: "lintPr", trigger: { kind: "pull_request" } },
    ],
    { forgeRepo: "acme/app" },
  );

  test("one file holds a periodic, a postsubmit and a presubmit", () => {
    expect(ops.files.map((f) => f.name)).toEqual(["chant-ops.yaml"]);
    expect(prowOpsFileName("infra")).toBe("chant-infra-ops.yaml");
    const all = jobs(ops.files[0]!.yaml);
    expect(all.map((j) => `${j.type} ${j.job.name} ${j.job.cluster}`)).toEqual([
      "presubmit chant-op-lint-pr untrusted",
      "postsubmit chant-op-apply-on-push trusted",
      "periodic chant-op-drift-check trusted",
    ]);
    expect(ops.jobs.map((j) => j.op)).toEqual(["driftCheck", "applyOnPush", "lintPr"]);
  });

  test("a schedule is a periodic with its cron and the repository's branch", () => {
    const drift = jobs(ops.files[0]!.yaml).find((j) => j.type === "periodic")!;
    expect(drift.job.cron).toBe("0 6 * * *");
    expect(drift.job.extra_refs).toEqual([{ org: "acme", repo: "app", base_ref: "main", workdir: true }]);
    expect(secrets(drift)).toEqual(["GITHUB_TOKEN<-chant-github-token", "GH_TOKEN<-chant-github-token"]);
    expect(script(drift)).toContain("chant run driftCheck");
  });

  test("a push is a postsubmit on its branches, and a pull request a presubmit with no credential", () => {
    const all = jobs(ops.files[0]!.yaml);
    expect(all.find((j) => j.type === "postsubmit")!.job.branches).toEqual(["^main$", "^release$"]);
    const pr = all.find((j) => j.type === "presubmit")!;
    expect(pr.job.branches).toBeUndefined();
    expect(secrets(pr)).toEqual([]);
  });

  test("what a pull request's job would hold is refused", () => {
    expect(() => generateProwOpPipeline([{ name: "x", trigger: { kind: "pull_request" }, findingMode: "comment" }], { forgeRepo: "acme/app" })).toThrow(/findingMode "comment"/);
    expect(() => generateProwOpPipeline([{ name: "x", trigger: { kind: "pull_request" }, variables: { K: "v" } }], { forgeRepo: "acme/app" })).toThrow(/variables on a pull_request trigger/);
    expect(() => generateProwOpPipeline([{ name: "x", trigger: { kind: "cron", schedule: "@daily" }, cloud: { aws: { roleArn: "r" } } as never }], { forgeRepo: "acme/app" })).toThrow(/sets cloud/);
    expect(() => generateProwOpPipeline([{ name: "x", trigger: { kind: "cron", schedule: "@daily" }, setup: [{ uses: "a/b@v1" }] }], { forgeRepo: "acme/app" })).toThrow(/GitHub action/);
  });
});

describe("every generated config", () => {
  const configs = generatedConfigs();

  test.each(configs)("%s: passes every PROW check, with no PROW104 or PROW105 finding", (_what, yaml) => {
    for (const c of postSynthChecks) expect({ id: c.id, diags: c.check(ctx(yaml)) }).toEqual({ id: c.id, diags: [] });
    expect(prow104.check(ctx(yaml))).toEqual([]);
    expect(prow105.check(ctx(yaml))).toEqual([]);
  });

  test.each(configs)("%s: no job that holds a credential is a presubmit", (_what, yaml) => {
    for (const j of jobs(yaml)) {
      const holds = secrets(j).length > 0 || (j.job.spec as Record<string, unknown>).serviceAccountName !== undefined;
      if (holds) expect({ name: j.job.name, type: j.type }).not.toEqual({ name: j.job.name, type: "presubmit" });
    }
  });

  test.each(configs)("%s: carries no GitHub expression and is the same text each time", (what, yaml) => {
    expect(yaml).not.toContain("${{");
    expect(generatedConfigs().find(([w]) => w === what)![1]).toBe(yaml);
  });

  test("a credential-holding job is in the set, so the PROW104 and PROW105 checks above see one", () => {
    const held = configs.flatMap(([, yaml]) => jobs(yaml).filter((j) => secrets(j).length > 0 || (j.job.spec as Record<string, unknown>).serviceAccountName));
    expect(held.length).toBeGreaterThan(0);
    expect(new Set(held.map((j) => j.type))).toEqual(new Set(["postsubmit", "periodic"]));
  });
});
