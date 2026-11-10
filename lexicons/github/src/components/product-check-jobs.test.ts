/**
 * #4964: the check, check evidence and ref gate jobs render in a product's
 * own workflow, beside its own jobs, with the product's service containers
 * on the check job: sql-yodeler's lint job and its throwaway `replay`
 * server, terragucci's own report directory.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { emitWorkflowYAML } from "./ci-jobs";
import { productCheckJobs } from "./product-check-jobs";

const yodel = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const replay = { name: "replay-postgres", image: "postgres:18.6", env: { POSTGRES_PASSWORD: "replay" }, health: "pg_isready -h 127.0.0.1 -U postgres" };
const checkJob = { services: [replay], env: { REPLAY_POSTGRES_URL: "postgres://replay-postgres:5432/postgres" }, before: ["node wait-for.js replay-postgres 5432"] };
type Job = { needs?: string[]; services?: unknown; permissions?: Record<string, string>; steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> };

describe("the check jobs in a product's own workflow (#4964)", () => {
  test("github: the jobs merge into the product's own, the check job with its service and the ref gate after the product's plan jobs", () => {
    const { jobsDoc } = productCheckJobs("github", "default", { words: yodel, checkJob, refGateStatus: true, evidence: { runnerKeySecret: "K" }, refGateNeeds: ["plan-staging"], beforeScript: ["npm ci"] });
    const own = { lint: { "runs-on": "ubuntu-latest", steps: [{ run: "yodel lint" }] }, "plan-staging": { "runs-on": "ubuntu-latest", steps: [{ run: "yodel plan staging --comment" }] } };
    const doc = parseYAML(emitWorkflowYAML({ name: "yodel-pr", on: { pull_request: { branches: ["main"] } }, jobsDoc: { ...own, ...jobsDoc } })) as { jobs: Record<string, Job> };
    expect(Object.keys(doc.jobs)).toEqual(["lint", "plan-staging", "check", "check-evidence", "ref-gate"]);
    expect(doc.jobs.check!.services).toEqual({ "replay-postgres": { image: "postgres:18.6", env: { POSTGRES_PASSWORD: "replay" }, options: '--health-cmd "pg_isready -h 127.0.0.1 -U postgres" --health-interval 2s --health-timeout 5s --health-retries 45' } });
    const last = doc.jobs.check!.steps.at(-1)!;
    expect(last.env!.REPLAY_POSTGRES_URL).toBe("postgres://replay-postgres:5432/postgres");
    expect(last.run!.trimEnd().split("\n").slice(-2)).toEqual(["node wait-for.js replay-postgres 5432", 'yodel chant ci check --base "$BASE_SHA"']);
    expect(doc.jobs["ref-gate"]!.needs).toEqual(["plan-staging", "check-evidence"]);
    expect(doc.jobs["check-evidence"]!.permissions).toEqual({ contents: "write" });
  });

  test("a check job's variable that the job sets or drops itself is refused", () => {
    expect(() => productCheckJobs("github", "default", { words: yodel, checkJob: { env: { GITHUB_TOKEN: "x" } } })).toThrow(/cannot name it/);
    expect(() => productCheckJobs("github", "default", { words: yodel, checkJob: { dir: "../out" } })).toThrow(/not a relative path/);
    expect(() => productCheckJobs("github", "default", { words: yodel })).toThrow(/needs checkJob or refGateStatus/);
  });

  test("a report directory of the product's own: ci check writes it, and the evidence job signs from it", () => {
    const { jobsDoc } = productCheckJobs("github", "default", { words: { ...yodel, bin: "npx --no-install terragucci" }, checkJob: { dir: "terragucci-check/hooks" }, evidence: { identity: "oidc" } });
    const doc = jobsDoc as Record<string, Job>;
    expect(doc.check!.steps.at(-1)!.run!.trimEnd().split("\n").at(-1)).toBe('npx --no-install terragucci ci check --base "$BASE_SHA" --output terragucci-check/hooks');
    expect(doc["check-evidence"]!.steps.find((s) => s.name?.startsWith("Sign"))!.run).toContain("ci evidence sign --from-report terragucci-check/hooks ");
  });
});
