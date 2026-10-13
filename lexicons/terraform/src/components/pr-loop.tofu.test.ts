/**
 * The pull-request loop (#3183) over five real Terraform roots, through the
 * commands the generated CI runs: `chant components pr-plan` on the pull
 * request and `chant components pr-apply` on the merge, each talking to a
 * fake GitHub.
 *
 * The issue's "done when": a pull request touching one of five roots plans
 * only that root and its dependents, applies on merge with the approved
 * digest, and refuses with a clear message if the plan changed after review.
 *
 * The roots use `terraform_data`, which is built into `tofu` and `terraform`,
 * with local state, so nothing downloads a provider or reaches a cloud. The
 * estate is net -> a, b and a -> app, with dns on its own; a and b read net's
 * output and app reads a's, through `stackOutput()`. Skipped when neither
 * binary is on the PATH.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ParsedArgs } from "@intentius/chant/cli/registry";
import type { PrReport } from "@intentius/chant/pr-loop";
import { terraformPlugin } from "../plugin";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

function which(bin: string): boolean {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const BINARY = which("tofu") ? "tofu" : which("terraform") ? "terraform" : undefined;

const ROOTS: Record<string, string> = {
  net: 'resource "terraform_data" "vpc" {\n  input = "10.0.0.0/16"\n}\n\noutput "cidr" {\n  value = terraform_data.vpc.output\n}\n',
  a: 'variable "cidr" {\n  type = string\n}\n\nresource "terraform_data" "subnet" {\n  input = "${var.cidr}/a-v1"\n}\n\noutput "id" {\n  value = terraform_data.subnet.output\n}\n',
  b: 'variable "cidr" {\n  type = string\n}\n\nresource "terraform_data" "subnet" {\n  input = "${var.cidr}/b-v1"\n}\n',
  app: 'variable "subnet" {\n  type = string\n}\n\nresource "terraform_data" "app" {\n  input = "app on ${var.subnet}"\n}\n',
  dns: 'resource "terraform_data" "zone" {\n  input = "example.test"\n}\n',
};

const COMPONENTS = `import { phase, stackOutput, type Component } from "@intentius/chant/components";

const apply = (root: string, vars?: Record<string, unknown>) =>
  [phase("Apply", [{ kind: "terraform-apply", root, ...(vars ? { vars } : {}) }])];

export const net: Component = { name: "net", dependsOn: [], deploy: apply("net") };
export const a: Component = { name: "a", dependsOn: ["net"], deploy: apply("a", { cidr: stackOutput("net", "cidr") }) };
export const b: Component = { name: "b", dependsOn: ["net"], deploy: apply("b", { cidr: stackOutput("net", "cidr") }) };
export const app: Component = { name: "app", dependsOn: ["a"], deploy: apply("app", { subnet: stackOutput("a", "id") }) };
export const dns: Component = { name: "dns", dependsOn: [], deploy: apply("dns") };
`;

/** GitHub as far as the loop uses it: comments, statuses, reviews and the merged pull request of a commit. */
class FakeGithub {
  comments: Array<{ id: number; pr: number; body: string }> = [];
  statuses: Array<{ sha: string; state: string; context: string; description: string }> = [];
  reviews: Record<number, Array<{ user: { login: string }; state: string }>> = {};
  mergedBy: Record<string, number> = {};
  private nextId = 1;

  fetch = async (url: string, init: { method: string; body?: string }) => {
    const path = new URL(url).pathname.replace(/^\/repos\/acme\/infra/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/issues\/(\d+)\/comments$/))) {
      const pr = Number(m[1]);
      if (init.method === "GET") return ok(this.comments.filter((c) => c.pr === pr));
      const c = { id: this.nextId++, pr, body: body.body };
      this.comments.push(c);
      return ok(c);
    }
    if ((m = path.match(/^\/issues\/comments\/(\d+)$/))) {
      const c = this.comments.find((x) => x.id === Number(m![1]))!;
      c.body = body.body;
      return ok(c);
    }
    if ((m = path.match(/^\/statuses\/([0-9a-f]+)$/))) {
      this.statuses.push({ sha: m[1], ...body });
      return ok({});
    }
    if ((m = path.match(/^\/pulls\/(\d+)\/reviews$/))) return ok(this.reviews[Number(m[1])] ?? []);
    if ((m = path.match(/^\/commits\/([0-9a-f]+)\/pulls$/))) {
      const pr = this.mergedBy[m[1]];
      return ok(pr ? [{ number: pr, merged_at: "2026-10-03T00:00:00Z", merge_commit_sha: m[1] }] : []);
    }
    return { ok: false, status: 404, text: async () => "" };
  };
}

const args = (overrides: Partial<ParsedArgs>): ParsedArgs => ({
  command: "components",
  path: ".",
  format: "",
  fix: false,
  watch: false,
  verbose: false,
  help: false,
  live: false,
  env: "local",
  noReleaseRecord: true,
  ...overrides,
});

describe.skipIf(!BINARY)(`the pull-request loop over five ${BINARY ?? "terraform"} roots`, () => {
  let dir: string;
  let cwd: string;
  const github = new FakeGithub();
  const env = { ...process.env };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const report = (stage: "plan" | "apply"): PrReport => JSON.parse(readFileSync(join(dir, ".chant", "pr", `pr-${stage}.json`), "utf8"));
  const state = (root: string) => readFileSync(join(dir, "roots", root, "terraform.tfstate"), "utf8");
  const ctx = (overrides: Partial<ParsedArgs>) => ({ args: args(overrides), plugins: [terraformPlugin], serializers: [terraformPlugin.serializer] });
  let handlers: typeof import("@intentius/chant/cli/handlers/pr");
  let recordGateApproval: typeof import("@intentius/chant/cli/handlers/operator").recordGateApproval;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-pr-loop-")));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
    for (const [name, text] of Object.entries(ROOTS)) write(`roots/${name}/main.tf`, text);
    write(
      "chant.config.json",
      JSON.stringify({ lexicons: ["terraform"], terraform: { binary: BINARY, roots: Object.fromEntries(Object.keys(ROOTS).map((r) => [r, { dir: `roots/${r}` }])) } }, null, 2),
    );
    write("estate.component.ts", COMPONENTS);
    write(".gitignore", "node_modules\n.terraform\n.terraform.lock.hcl\n*.tfstate*\nchant.tfplan\n.chant\n");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.test");
    git("config", "user.name", "ci");
    git("add", "-A");
    git("commit", "-qm", "five roots");

    cwd = process.cwd();
    process.chdir(dir);
    Object.assign(process.env, {
      GITHUB_REPOSITORY: "acme/infra",
      GITHUB_TOKEN: "t0k",
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "1",
    });
    vi.stubGlobal("fetch", github.fetch);
    handlers = await import("@intentius/chant/cli/handlers/pr");
    ({ recordGateApproval } = await import("@intentius/chant/cli/handlers/operator"));

    // Every root applied once, so each has state and outputs to read.
    const { runComponentsFanOut } = await import("@intentius/chant/cli/handlers/fan-out");
    write("all.json", JSON.stringify({ changed: ["net", "dns"] }));
    expect(await runComponentsFanOut(ctx({ fromAffected: "all.json" }) as never)).toBe(0);
  }, 240_000);

  afterAll(() => {
    vi.unstubAllGlobals();
    if (cwd) process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A pull request that rewrites root a's subnet to `version`, merged by `merge`. */
  async function openPullRequest(pr: number, version: string): Promise<PrReport> {
    git("checkout", "-qb", `pr-${pr}`);
    write("roots/a/main.tf", ROOTS.a.replace("a-v1", version));
    git("commit", "-qam", `a ${version}`);
    expect(await handlers.runComponentsPrPlan(ctx({ base: "main", pr, forge: "github" }) as never)).toBe(0);
    return report("plan");
  }

  async function merge(pr: number): Promise<number> {
    git("checkout", "-q", "main");
    const before = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-ff", `pr-${pr}`, "-m", `Merge pull request #${pr}`);
    github.mergedBy[git("rev-parse", "HEAD")] = pr;
    return handlers.runComponentsPrApply(ctx({ base: before, forge: "github", requireReview: true }) as never);
  }

  test("a change to one root plans that root and its dependent, and nothing else", async () => {
    const plan = await openPullRequest(1, "a-v2");

    expect(plan.status).toBe("planned");
    expect(plan.selection).toMatchObject({ changed: ["a"], dependents: ["app"], waves: [["a"], ["app"]] });
    expect(plan.members.map((m) => [m.member, m.counts.update])).toEqual([
      ["a", 1],
      ["app", 0],
    ]);
    expect(plan.changeSet.digest).toBe(plan.digest);
    expect(plan.approval).toEqual({ status: "pending" });

    const note = github.comments.find((c) => c.pr === 1)!;
    expect(note.body.startsWith("<!-- chant-pr:local -->")).toBe(true);
    expect(note.body).toContain(`chant approve pr-1 pr-apply --plan ${plan.digest} --approver github:<your-login> --sign`);
    expect(github.statuses.at(-1)).toMatchObject({ context: "chant/plan", state: "success", sha: plan.head });
  }, 240_000);

  test("on merge it applies the plan the reviewer approved", async () => {
    const plan = report("plan");
    github.reviews[1] = [{ user: { login: "alice" }, state: "APPROVED" }];
    expect((await recordGateApproval("pr-1", "pr-apply", { actor: "github:alice", plan: plan.digest })).ok).toBe(true);

    expect(await merge(1)).toBe(0);
    const applied = report("apply");
    expect(applied.digest).toBe(plan.digest);
    expect(applied.status).toBe("applied");
    expect(applied.approval).toEqual({ status: "approved", approvedBy: ["github:alice"] });
    expect(applied.members.map((m) => [m.member, m.status, m.inputsMoved])).toEqual([
      ["a", "applied", undefined],
      ["app", "applied", ["a"]],
    ]);
    expect(state("a")).toContain("10.0.0.0/16/a-v2");
    // The same note, now with the apply's outcome.
    expect(github.comments.filter((c) => c.pr === 1)).toHaveLength(1);
    expect(github.comments.find((c) => c.pr === 1)!.body).toContain("### chant apply for `local`");
    expect(github.statuses.at(-1)).toMatchObject({ context: "chant/apply", state: "success", sha: applied.head });
  }, 240_000);

  test("a plan that changed after review is refused, naming both digests, and nothing applies", async () => {
    const reviewed = await openPullRequest(2, "a-v3");
    github.reviews[2] = [{ user: { login: "alice" }, state: "APPROVED" }];
    expect((await recordGateApproval("pr-2", "pr-apply", { actor: "github:alice", plan: reviewed.digest })).ok).toBe(true);
    // Pushed after the review.
    write("roots/a/main.tf", ROOTS.a.replace("a-v1", "a-v4"));
    git("commit", "-qam", "a v4");

    expect(await merge(2)).toBe(3);
    const refused = report("apply");
    expect(refused.status).toBe("refused");
    expect(refused.refusal).toBe("plan-changed");
    expect(refused.approval).toEqual({ status: "changed", approved: reviewed.digest });
    expect(refused.message).toContain(`approved: ${reviewed.digest}; planned now: ${refused.digest}`);
    expect(refused.message).toContain("nothing was applied");
    expect(state("a")).toContain("a-v2");
    expect(state("a")).not.toContain("a-v4");
    expect(github.statuses.at(-1)).toMatchObject({ context: "chant/apply", state: "failure", description: "refused: the plan changed after review" });
  }, 240_000);
});
