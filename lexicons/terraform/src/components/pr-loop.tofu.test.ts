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
 *
 * Below it, composed runs (#4447) over a chain of three roots, with and
 * without `terraform.compose`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ParsedArgs } from "@intentius/chant/cli/registry";
import type { PrReport } from "@intentius/chant/pr-loop";
import { buildGraphIr } from "@intentius/chant/graph-ir";
import { terraformPlugin } from "../plugin";
import { renderTerraformRoots } from "../hcl/roots";

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

// The source passes `chant lint`, since `chant graph --format ir`, which maps
// the stored change set onto nodes (#4022), refuses source that does not.
/**
 * The estate's graph node ids, read in process with the pair `chant graph
 * --format ir` runs for terraform roots (`renderTerraformRoots`, then
 * `buildGraphIr`), so pr-apply maps its stored change set without starting a
 * chant child process. `change-set-graph.e2e.test.ts` holds these ids equal
 * to the spawned `chant graph --format ir`'s.
 */
async function estateGraphIds(projectRoot: string): Promise<{ ids: string[] }> {
  const config = JSON.parse(readFileSync(join(projectRoot, "chant.config.json"), "utf8")) as { terraform: { binary?: string; roots: Record<string, { dir: string }> } };
  const rendered = await renderTerraformRoots({ projectRoot, roots: config.terraform.roots, ...(config.terraform.binary ? { binary: config.terraform.binary } : {}) });
  return { ids: buildGraphIr(rendered.entities).nodes.map((n) => n.id) };
}

const COMPONENTS = `import { phase, stackOutput, type Component } from "@intentius/chant/components";

const apply = (root: string, vars?: Record<string, unknown>) =>
  [phase("Apply", [{ kind: "terraform-apply", root, noRollback: "test roots with local state", vars: vars ?? {} }])];

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
    // #4000: the author and committers, whose own approval never counts.
    if ((m = path.match(/^\/pulls\/(\d+)$/))) return ok({ number: Number(m[1]), user: { login: "ci" } });
    if ((m = path.match(/^\/pulls\/(\d+)\/commits$/))) return ok([{ author: { login: "ci" }, committer: { login: "ci" } }]);
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
    (await import("@intentius/chant/lifecycle/gate-change-set")).setGraphIdReader(estateGraphIds);
    ({ recordGateApproval } = await import("@intentius/chant/cli/handlers/operator"));

    // Every root applied once, so each has state and outputs to read.
    const { runComponentsFanOut } = await import("@intentius/chant/cli/handlers/fan-out");
    write("all.json", JSON.stringify({ changed: ["net", "dns"] }));
    expect(await runComponentsFanOut(ctx({ fromAffected: "all.json" }) as never)).toBe(0);
  }, 240_000);

  afterAll(async () => {
    (await import("@intentius/chant/lifecycle/gate-change-set")).setGraphIdReader(undefined);
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

  /** The commit before the last merge, which a re-run of its apply measures from. */
  let mergedFrom = "";
  const RESUME = ".chant/pr-resume/pr-apply.json";

  async function merge(pr: number): Promise<number> {
    git("checkout", "-q", "main");
    mergedFrom = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-ff", `pr-${pr}`, "-m", `Merge pull request #${pr}`);
    github.mergedBy[git("rev-parse", "HEAD")] = pr;
    return handlers.runComponentsPrApply(ctx({ base: mergedFrom, forge: "github", requireReview: true, resume: RESUME }) as never);
  }

  test("a change to one root plans that root and its dependent, and nothing else", async () => {
    const plan = await openPullRequest(1, "a-v2");

    expect(plan.status).toBe("planned");
    expect(plan.selection).toMatchObject({ changed: ["a"], dependents: ["app"], waves: [["a"], ["app"]] });
    // a's id is terraform_data's output, which tofu knows only after apply,
    // so app is not planned against the id a has now (#3999): the note says
    // the approval does not cover what app does with it.
    expect(plan.members.map((m) => [m.member, m.counts.update, m.unknownInputs])).toEqual([
      ["a", 1, undefined],
      ["app", 0, ["a.id"]],
    ]);
    expect(plan.changeSet.members.find((m) => m.member === "app")?.holes).toEqual([
      { address: "app", type: "terraform_root", reason: "inputs from a; planned again once they apply" },
    ]);
    expect(plan.plannedOutputs).toEqual({ a: [] });
    expect(plan.deployedOutputs).toEqual({ net: ["cidr"] });
    expect(plan.changeSet.digest).toBe(plan.digest);
    expect(plan.approval).toEqual({ status: "pending" });

    const note = github.comments.find((c) => c.pr === 1)!;
    expect(note.body.startsWith("<!-- chant-pr:local -->")).toBe(true);
    expect(note.body).toContain(`chant approve pr-1 pr-apply --plan ${plan.digest} --approver github:<your-login> --sign`);
    expect(note.body).toContain("Known only after apply: `app` reads `a.id`.");
    expect(github.statuses.at(-1)).toMatchObject({ context: "chant/plan", state: "success", sha: plan.head });
  }, 240_000);

  test("on merge it applies the plan the reviewer approved, and plans the dependent again once its upstream applied (#3999)", async () => {
    const plan = report("plan");
    github.reviews[1] = [{ user: { login: "alice" }, state: "APPROVED" }];
    expect((await recordGateApproval("pr-1", "pr-apply", { actor: "github:alice", plan: plan.digest })).ok).toBe(true);

    // a applies; app, planned now against the id a applied as, waits on its own gate.
    expect(await merge(1)).toBe(3);
    const waiting = report("apply");
    expect(waiting.digest).toBe(plan.digest);
    expect(waiting.status).toBe("waiting");
    expect(waiting.members.map((m) => [m.member, m.status, m.round])).toEqual([
      ["a", "applied", undefined],
      ["app", "waiting", 2],
    ]);
    const round = waiting.rounds![0]!;
    expect(round).toMatchObject({ round: 2, gate: "pr-apply-round-2", components: ["app"], status: "waiting", approval: { status: "pending" } });
    expect(round.changeSet.entries.map((e) => [e.member, e.address, e.action])).toEqual([["app", "terraform_data.app", "update"]]);
    // #4436: the round's fresh plan carries a Terraform shape, and adds a resource the first plan (a hole) did not preview, so the first approval does not cover it and the reason names the address.
    expect(round.covered).toBeUndefined();
    expect(round.notCovered).toContain("terraform_data.app");
    expect(state("a")).toContain("10.0.0.0/16/a-v2");
    expect(state("app")).not.toContain("a-v2");
    expect(github.statuses.at(-1)).toMatchObject({ context: "chant/apply", state: "pending" });
    expect(github.comments.find((c) => c.pr === 1)!.body).toContain(`chant approve pr-1 pr-apply-round-2 --plan ${round.digest}`);
  }, 240_000);

  test("once the reviewer approves the round's plan, the same apply carries on from its record and applies the dependent (#3999)", async () => {
    const plan = report("plan");
    const round = report("apply").rounds![0]!;
    expect((await recordGateApproval("pr-1", "pr-apply-round-2", { actor: "github:alice", plan: round.digest })).ok).toBe(true);
    expect(await handlers.runComponentsPrApply(ctx({ base: mergedFrom, forge: "github", requireReview: true, resume: RESUME }) as never)).toBe(0);
    const applied = report("apply");
    expect(applied.digest).toBe(plan.digest);
    expect(applied.status).toBe("applied");
    expect(applied.approval).toEqual({ status: "approved", approvedBy: ["github:alice"] });
    expect(applied.resumed).toEqual({ applied: ["a"] });
    expect(applied.members.map((m) => [m.member, m.status, m.round])).toEqual([
      ["a", "applied", undefined],
      ["app", "applied", 2],
    ]);
    expect(applied.rounds?.map((r) => [r.digest, r.status, r.approval.approvedBy])).toEqual([[round.digest, "applied", ["github:alice"]]]);
    expect(state("app")).toContain("app on 10.0.0.0/16/a-v2");
    // The same note, now with the apply's outcome.
    expect(github.comments.filter((c) => c.pr === 1)).toHaveLength(1);
    expect(github.comments.find((c) => c.pr === 1)!.body).toContain("### chant apply for `local`");
    expect(github.statuses.at(-1)).toMatchObject({ context: "chant/apply", state: "success", sha: applied.head });
  }, 240_000);

  test("the change set the approval bound is stored by its digest, each entry on its graph node (#4022)", async () => {
    const applied = report("apply");
    const { changeSetShowDocument } = await import("@intentius/chant/workspace/change-set-show");
    const shown = await changeSetShowDocument({ cwd: dir, digest: applied.digest });
    if ("error" in shown) throw new Error(shown.error.message);
    expect(shown).toMatchObject({ member: null, digest: applied.digest, reason: null });
    const stored = shown.changeSet!;
    expect(stored.digest).toBe(applied.digest);
    expect(stored.graph).toEqual({ member: null, at: applied.head });
    // The plan's addresses, each on the block the terraform lexicon's graph names `<root>/<address>`.
    // app's plan had a hole for a's id, and no entries.
    expect(stored.entries.map((e) => [e.member, e.address, e.action, e.node])).toEqual([
      ["a", "terraform_data.subnet", "update", "a/terraform_data.subnet"],
    ]);
    // And those are ids the estate's graph has.
    const graph = await estateGraphIds(dir);
    for (const e of stored.entries) expect(graph.ids).toContain(e.node);
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

    // The gate now waits on the plan it was refused, and workspace status links it to that change set (#4022).
    const { readMemberGates } = await import("@intentius/chant/workspace/status-gates");
    const { gates } = await readMemberGates("_gates", "flat", git("rev-parse", "chant/lifecycle"), [], dir, new Date().toISOString());
    const gate = gates.find((g) => g.component === "pr-2")!;
    expect(gate).toMatchObject({ state: "pending", planDigest: refused.digest, changeSet: refused.digest });
  }, 240_000);
});

// ── Composed runs (#4447) ─────────────────────────────────────────────────
//
// Three roots in a chain: b reads a's id and c reads b's, through
// `stackOutput()` in `vars`. With `terraform.compose.enabled` the pull
// request plans them as one group (ws-107), so b and c are not holes, and the
// merge applies the three in one apply with no round in between. Without the
// setting the loop behaves as above: b is a hole and its round waits on an
// approval of its own.

const CHAIN: Record<string, string> = {
  a: 'resource "terraform_data" "subnet" {\n  input = "a-v1"\n}\n\noutput "id" {\n  value = terraform_data.subnet.output\n}\n',
  b: 'variable "a_id" {\n  type = string\n}\n\nresource "terraform_data" "link" {\n  input = "${var.a_id}/b"\n}\n\noutput "id" {\n  value = terraform_data.link.output\n}\n',
  c: 'variable "b_id" {\n  type = string\n}\n\nresource "terraform_data" "edge" {\n  input = "${var.b_id}/c"\n}\n\noutput "id" {\n  value = terraform_data.edge.output\n}\n',
};

/** The chain's components; with `reader`, d, a shell step outside the group, writes c's id to `d.out`. */
const chainComponents = (reader: boolean) => `import { phase, stackOutput, type Component } from "@intentius/chant/components";

const apply = (root: string, vars?: Record<string, unknown>) =>
  [phase("Apply", [{ kind: "terraform-apply", root, noRollback: "test roots with local state", vars: vars ?? {} }])];

export const a: Component = { name: "a", dependsOn: [], deploy: apply("a") };
export const b: Component = { name: "b", dependsOn: ["a"], deploy: apply("b", { a_id: stackOutput("a", "id") }) };
export const c: Component = { name: "c", dependsOn: ["b"], deploy: apply("c", { b_id: stackOutput("b", "id") }) };
${
  reader
    ? `export const d: Component = {
  name: "d",
  dependsOn: ["c"],
  deploy: [phase("Apply", [{ kind: "shell", cmd: "printenv C_ID > d.out", env: { C_ID: stackOutput("c", "id") }, reason: "reads c's applied id from outside the group" }])],
};
`
    : ""
}`;

/** What a composed suite's tests reach. */
interface ChainLoop {
  dir: string;
  github: FakeGithub;
  report(stage: "plan" | "apply"): PrReport;
  state(root: string): string;
  git(...a: string[]): string;
  /** A pull request that rewrites root a's input to `version`. */
  open(pr: number, version: string): Promise<PrReport>;
  /** Merge it and run pr-apply. */
  merge(pr: number): Promise<number>;
  /** Run pr-apply again from its resume record, as after a round's approval. */
  again(): Promise<number>;
  approve(pr: number, gate: string, digest: string): Promise<void>;
  /** Lock files, kept states and composed-root files left in the checkout. */
  leftovers(): string[];
}

/** Every path under `dir` (outside `node_modules` and `.git`) a composed run must not leave behind. */
function leftoversIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const path = join(at, e.name);
      if (e.name === ".chant-compose" || e.name === "chant_compose.tf" || e.name.endsWith(".tflock") || e.name.endsWith(".chant-unwritten")) out.push(path.slice(dir.length + 1));
      if (e.isDirectory() && e.name !== ".terraform") walk(path);
    }
  };
  walk(dir);
  return out.sort();
}

function chainSuite(title: string, opts: { compose: boolean; files?: Record<string, string>; reader?: boolean }, tests: (loop: ChainLoop) => void): void {
  describe.skipIf(!BINARY)(`${title} (${BINARY ?? "terraform"})`, () => {
    const loop = {} as ChainLoop;
    let dir = "";
    let cwd = "";
    let mergedFrom = "";
    const env = { ...process.env };
    const github = new FakeGithub();
    const RESUME = ".chant/pr-resume/pr-apply.json";
    const ctx = (overrides: Partial<ParsedArgs>) => ({ args: args(overrides), plugins: [terraformPlugin], serializers: [terraformPlugin.serializer] });
    let handlers: typeof import("@intentius/chant/cli/handlers/pr");
    let recordGateApproval: typeof import("@intentius/chant/cli/handlers/operator").recordGateApproval;

    beforeAll(async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-pr-compose-")));
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      };
      symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
      for (const [name, text] of Object.entries(CHAIN)) write(`roots/${name}/main.tf`, text);
      for (const [path, text] of Object.entries(opts.files ?? {})) write(path, text);
      const terraform = {
        binary: BINARY,
        ...(opts.compose ? { compose: { enabled: true } } : {}),
        roots: Object.fromEntries(Object.keys(CHAIN).map((r) => [r, { dir: `roots/${r}` }])),
      };
      write("chant.config.json", JSON.stringify({ lexicons: ["terraform"], terraform }, null, 2));
      write("chain.component.ts", chainComponents(opts.reader === true));
      write(".gitignore", "node_modules\n.terraform\n.terraform.lock.hcl\n*.tfstate*\nchant.tfplan\n.chant\nd.out\n");
      git("init", "-q", "-b", "main");
      git("config", "user.email", "ci@example.test");
      git("config", "user.name", "ci");
      git("add", "-A");
      git("commit", "-qm", "three roots");

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
      (await import("@intentius/chant/lifecycle/gate-change-set")).setGraphIdReader(estateGraphIds);
      ({ recordGateApproval } = await import("@intentius/chant/cli/handlers/operator"));

      // Every root applied once, root by root (a fan-out never composes), so each has state and outputs.
      const { runComponentsFanOut } = await import("@intentius/chant/cli/handlers/fan-out");
      write("all.json", JSON.stringify({ changed: ["a"] }));
      expect(await runComponentsFanOut(ctx({ fromAffected: "all.json" }) as never)).toBe(0);
      rmSync(join(dir, "all.json"));

      Object.assign(loop, {
        dir,
        github,
        git,
        report: (stage: "plan" | "apply"): PrReport => JSON.parse(readFileSync(join(dir, ".chant", "pr", `pr-${stage}.json`), "utf8")),
        state: (root: string) => readFileSync(join(dir, "roots", root, "terraform.tfstate"), "utf8"),
        async open(pr: number, version: string) {
          git("checkout", "-qb", `pr-${pr}`);
          write("roots/a/main.tf", CHAIN.a!.replace("a-v1", version));
          git("commit", "-qam", `a ${version}`);
          expect(await handlers.runComponentsPrPlan(ctx({ base: "main", pr, forge: "github" }) as never)).toBe(0);
          return loop.report("plan");
        },
        async merge(pr: number) {
          git("checkout", "-q", "main");
          mergedFrom = git("rev-parse", "HEAD");
          git("merge", "-q", "--no-ff", `pr-${pr}`, "-m", `Merge pull request #${pr}`);
          github.mergedBy[git("rev-parse", "HEAD")] = pr;
          return handlers.runComponentsPrApply(ctx({ base: mergedFrom, forge: "github", requireReview: true, resume: RESUME }) as never);
        },
        again: () => handlers.runComponentsPrApply(ctx({ base: mergedFrom, forge: "github", requireReview: true, resume: RESUME }) as never),
        async approve(pr: number, gate: string, digest: string) {
          github.reviews[pr] = [{ user: { login: "alice" }, state: "APPROVED" }];
          expect((await recordGateApproval(`pr-${pr}`, gate, { actor: "github:alice", plan: digest })).ok).toBe(true);
        },
        leftovers: () => leftoversIn(dir),
      } satisfies ChainLoop);
    }, 240_000);

    afterAll(async () => {
      (await import("@intentius/chant/lifecycle/gate-change-set")).setGraphIdReader(undefined);
      vi.unstubAllGlobals();
      if (cwd) process.chdir(cwd);
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    tests(loop);
  });
}

chainSuite("with terraform.compose, three roots plan and apply as one group", { compose: true }, (loop) => {
  test("one plan: b's read of a's new id is no hole, one digest binds the three, and the plan leaves nothing behind", async () => {
    const plan = await loop.open(1, "a-v2");

    expect(plan.status).toBe("planned");
    expect(plan.selection).toMatchObject({ changed: ["a"], dependents: ["b", "c"] });
    // The group is one unit in a's wave; the waves it emptied stay, so wave numbers keep their meaning.
    expect(plan.selection.waves.filter((w) => w.length > 0)).toEqual([["a", "b", "c"]]);
    expect(plan.groups).toEqual([expect.objectContaining({ capability: "terraform-apply", components: ["a", "b", "c"], wave: 1 })]);
    expect(plan.groups![0]!.digest).toEqual(expect.any(String));
    expect(plan.fallbacks ?? []).toEqual([]);
    for (const m of ["b", "c"]) {
      const member = plan.changeSet.members.find((x) => x.member === m)!;
      expect(member.holes).toEqual([]);
      // Ruling 4: the reads the group's apply computes are marked, so the change set never passes as empty.
      expect(member.group?.digest).toBe(plan.groups![0]!.digest);
      expect(member.group?.reads).toEqual([m === "b" ? "a.id" : "b.id"]);
    }
    expect(plan.members.map((m) => [m.member, m.status])).toEqual([
      ["a", "planned"],
      ["b", "planned"],
      ["c", "planned"],
    ]);
    expect(plan.changeSet.digest).toBe(plan.digest);
    expect(plan.approval).toEqual({ status: "pending" });

    // The plan waits on its approval: no lock is held, and the composed root and every rewritten file are gone.
    expect(loop.leftovers()).toEqual([]);
    expect(loop.git("status", "--porcelain")).toBe("");
  }, 240_000);

  test("one approval and one apply: pr-apply exits 0 and no round gate is asked", async () => {
    const plan = loop.report("plan");
    await loop.approve(1, "pr-apply", plan.digest);
    expect(await loop.merge(1)).toBe(0);

    const applied = loop.report("apply");
    expect(applied.digest).toBe(plan.digest);
    expect(applied.status).toBe("applied");
    expect(applied.rounds ?? []).toEqual([]);
    expect(applied.members.map((m) => [m.member, m.status, m.groupOutcome])).toEqual([
      ["a", "applied", "applied"],
      ["b", "applied", "applied"],
      ["c", "applied", "applied"],
    ]);
    // a's new id reached b, and b's reached c, inside the one apply.
    expect(loop.state("a")).toContain('"a-v2"');
    expect(loop.state("b")).toContain('"a-v2/b"');
    expect(loop.state("c")).toContain('"a-v2/b/c"');
    const note = loop.github.comments.find((c) => c.pr === 1)!.body;
    expect(note).not.toContain("pr-apply-round-2");
    expect(loop.github.statuses.at(-1)).toMatchObject({ context: "chant/apply", state: "success", sha: applied.head });
    expect(loop.leftovers()).toEqual([]);
    expect(loop.git("status", "--porcelain")).toBe("");
  }, 240_000);

  test("a plan that changed after review is refused, nothing applies, and no lock or file is left", async () => {
    const reviewed = await loop.open(2, "a-v3");
    await loop.approve(2, "pr-apply", reviewed.digest);
    // Pushed after the review.
    writeFileSync(join(loop.dir, "roots/a/main.tf"), CHAIN.a!.replace("a-v1", "a-v4"));
    loop.git("commit", "-qam", "a v4");

    expect(await loop.merge(2)).toBe(3);
    const refused = loop.report("apply");
    expect(refused.status).toBe("refused");
    expect(refused.refusal).toBe("plan-changed");
    expect(loop.state("a")).toContain('"a-v2"');
    expect(loop.state("c")).toContain('"a-v2/b/c"');
    expect(loop.leftovers()).toEqual([]);
    expect(loop.git("status", "--porcelain")).toBe("");
  }, 240_000);
});

chainSuite("without terraform.compose, the same three roots plan as on main", { compose: false }, (loop) => {
  test("b is a hole, the setting's fallback is recorded and not printed, and b's round waits on its own approval", async () => {
    const plan = await loop.open(1, "a-v2");
    expect(plan.groups ?? []).toEqual([]);
    expect((plan.fallbacks ?? []).map((f) => [f.component, f.kind])).toEqual([
      ["a", "off"],
      ["b", "off"],
      ["c", "off"],
    ]);
    expect(plan.changeSet.members.find((m) => m.member === "b")?.holes).toEqual([
      { address: "b", type: "terraform_root", reason: "inputs from a; planned again once they apply" },
    ]);
    expect(plan.members.find((m) => m.member === "b")?.unknownInputs).toEqual(["a.id"]);
    const note = loop.github.comments.find((c) => c.pr === 1)!.body;
    expect(note).not.toContain("terraform.compose");

    await loop.approve(1, "pr-apply", plan.digest);
    expect(await loop.merge(1)).toBe(3);
    const waiting = loop.report("apply");
    expect(waiting.status).toBe("waiting");
    expect(waiting.members.find((m) => m.member === "a")?.status).toBe("applied");
    const round = waiting.rounds![0]!;
    expect(round).toMatchObject({ round: 2, gate: "pr-apply-round-2", status: "waiting" });
    expect(round.components).toContain("b");
    expect(round.covered).toBeUndefined();
    expect(loop.state("a")).toContain('"a-v2"');
    expect(loop.state("b")).not.toContain("a-v2");
  }, 240_000);
});

chainSuite(
  "with terraform.compose, a group #4438 refuses plans root by root",
  { compose: true, files: { "roots/c/paths.tf": 'locals {\n  here = path.root\n}\n' } },
  (loop) => {
    test("the report's fallbacks name the kind, and b is a hole as without the setting", async () => {
      const plan = await loop.open(1, "a-v2");
      expect(plan.groups ?? []).toEqual([]);
      expect((plan.fallbacks ?? []).map((f) => [f.component, f.capability, f.kind])).toEqual([
        ["a", "terraform-apply", "path"],
        ["b", "terraform-apply", "path"],
        ["c", "terraform-apply", "path"],
      ]);
      expect(plan.fallbacks![0]!.reason).toContain("`c` uses `path.root` or `path.cwd`");
      expect(plan.changeSet.members.find((m) => m.member === "b")?.holes).toHaveLength(1);
      expect(plan.selection.waves).toEqual([["a"], ["b"], ["c"]]);
      expect(loop.leftovers()).toEqual([]);
    }, 240_000);
  },
);

chainSuite("with terraform.compose, a component outside the group reads c", { compose: true, reader: true }, (loop) => {
  test("d gets c's applied output", async () => {
    const plan = await loop.open(1, "a-v2");
    expect(plan.groups?.map((g) => g.components)).toEqual([["a", "b", "c"]]);
    await loop.approve(1, "pr-apply", plan.digest);
    let code = await loop.merge(1);
    // d read c's id before c applied: a round plans it once the group applied, and waits on an approval unless the first covers it.
    if (code === 3) {
      const round = loop.report("apply").rounds!.find((r) => r.status === "waiting")!;
      await loop.approve(1, round.gate, round.digest);
      code = await loop.again();
    }
    expect(code).toBe(0);
    expect(loop.report("apply").members.find((m) => m.component === "d")?.status).toBe("applied");
    expect(readFileSync(join(loop.dir, "d.out"), "utf8").trim()).toBe("a-v2/b/c");
  }, 240_000);
});
