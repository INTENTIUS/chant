/**
 * A demo project driven through the pull-request loop in process (#4448):
 * the example copied into a temporary git repository, its base applied root
 * by root, then one scenario's `pull/` overlaid on a branch, `chant
 * components pr-plan`, an approval of the plan's digest, the merge and
 * `chant components pr-apply`, each against a fake GitHub.
 *
 * It is the loop of `lexicons/terraform/src/components/pr-loop.tofu.test.ts`
 * over a directory under `examples/` instead of roots written by the test,
 * so the CloudFormation and Terraform demos are run the way their scenarios
 * are played: a scenario's `pull/` replaces files of the base, and the next
 * scenario starts from a fresh base.
 *
 * The caller's `describe` gates on the binaries and emulators; nothing here
 * checks for them.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import type { ParsedArgs } from "@intentius/chant/cli/registry";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { PrReport } from "@intentius/chant/pr-loop";

/** GitHub as far as the loop uses it: comments, statuses, reviews and the merged pull request of a commit. */
export class FakeGithub {
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
      this.statuses.push({ sha: m[1]!, ...body });
      return ok({});
    }
    if ((m = path.match(/^\/pulls\/(\d+)\/reviews$/))) return ok(this.reviews[Number(m[1])] ?? []);
    // #4000: the author and committers, whose own approval never counts.
    if ((m = path.match(/^\/pulls\/(\d+)$/))) return ok({ number: Number(m[1]), user: { login: "ci" } });
    if ((m = path.match(/^\/pulls\/(\d+)\/commits$/))) return ok([{ author: { login: "ci" }, committer: { login: "ci" } }]);
    if ((m = path.match(/^\/commits\/([0-9a-f]+)\/pulls$/))) {
      const pr = this.mergedBy[m[1]!];
      return ok(pr ? [{ number: pr, merged_at: "2026-10-25T00:00:00Z", merge_commit_sha: m[1] }] : []);
    }
    return { ok: false, status: 404, text: async () => "" };
  };
}

export interface ScenarioLoopOptions {
  /** The example directory. Copied without `scenarios/`, `.forgejo/`, `node_modules`, `dist` and `.chant`. */
  example: string;
  /** The checkout whose `node_modules` the project links. */
  repo: string;
  /** The lexicon plugins the commands run with. */
  plugins: LexiconPlugin[];
  /** The chant environment (`--env`). */
  env: string;
  /** Each copied file's text, by its path relative to the project, before it is written. Base and overlays alike. */
  rewrite?: (rel: string, text: string) => string;
  /** Run in the project once the base or an overlay is written, before its commit: a template build, say. */
  prepare?: (dir: string) => void;
  /** Set on `process.env` for the run and taken off after: credentials and an endpoint. */
  processEnv?: Record<string, string>;
  /** The graph ids pr-apply maps its stored change set onto. Default: an empty graph, so no `chant graph` is started. */
  graphIds?: (dir: string) => Promise<{ ids: string[] }>;
  /**
   * Discover components in a child process on each command (`--sandbox`).
   * Default true: a scenario overlays `*.component.ts` files at the paths the
   * base imported, and an in-process `import()` returns the base's module
   * from its cache, so pr-plan would plan the base's inputs.
   */
  sandbox?: boolean;
}

export interface ScenarioLoop {
  dir: string;
  github: FakeGithub;
  git(...a: string[]): string;
  /** `.chant/pr/pr-<stage>.json`. */
  report(stage: "plan" | "apply"): PrReport;
  /** Apply every component, root by root, as the demo host applies the base: every unit their steps deploy, marked changed. Exit code of the fan-out. */
  applyBase(): Promise<number>;
  /** Branch `pr-<pr>`, overlay the scenario's `pull/`, commit, and run pr-plan. */
  open(pr: number, scenario: string): Promise<{ code: number; report: PrReport }>;
  /** A review of `pr` and a recorded approval of `digest` on `gate`. */
  approve(pr: number, gate: string, digest: string): Promise<void>;
  /** Merge `pr-<pr>` into main and run pr-apply. Its exit code. */
  merge(pr: number): Promise<number>;
  /** Run pr-apply again from its resume record. */
  again(): Promise<number>;
  /** Put the process back and remove the project. */
  close(): Promise<void>;
}

const SKIP = new Set(["scenarios", ".forgejo", "node_modules", "dist", ".chant", ".git"]);

/** Every file under `from`, by path relative to it, less what {@link SKIP} names at the top. */
function filesOf(from: string, top = true): string[] {
  const out: string[] = [];
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (top && SKIP.has(e.name)) continue;
    const path = join(from, e.name);
    if (e.isDirectory()) out.push(...filesOf(path, false).map((f) => join(e.name, f)));
    else if (e.isFile()) out.push(e.name);
  }
  return out.sort();
}

const args = (env: string, overrides: Partial<ParsedArgs>): ParsedArgs => ({
  command: "components",
  path: ".",
  format: "",
  fix: false,
  watch: false,
  verbose: false,
  help: false,
  live: false,
  env,
  noReleaseRecord: true,
  ...overrides,
});

/** Copy the example into a new git repository, cd into it and stub `fetch`. Call `close()` in `afterAll`. */
export async function openScenarioLoop(o: ScenarioLoopOptions): Promise<ScenarioLoop> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-demo-loop-")));
  const github = new FakeGithub();
  const saved = { ...process.env };
  const cwd = process.cwd();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  const copy = (from: string): void => {
    for (const rel of filesOf(from)) {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      const source = join(from, rel);
      if (o.rewrite && statSync(source).size < 1_000_000) writeFileSync(target, o.rewrite(rel, readFileSync(source, "utf8")));
      else cpSync(source, target);
    }
  };
  const ctx = (overrides: Partial<ParsedArgs>) => ({ args: args(o.env, { sandbox: o.sandbox ?? true, ...overrides }), plugins: o.plugins, serializers: o.plugins.map((p) => p.serializer) });
  const RESUME = ".chant/pr-resume/pr-apply.json";
  let mergedFrom = "";

  symlinkSync(join(o.repo, "node_modules"), join(dir, "node_modules"));
  copy(o.example);
  o.prepare?.(dir);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.test");
  git("config", "user.name", "ci");
  git("add", "-A");
  git("commit", "-qm", "base");

  process.chdir(dir);
  Object.assign(process.env, {
    GITHUB_REPOSITORY: "acme/infra",
    GITHUB_TOKEN: "t0k",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "1",
    ...(o.processEnv ?? {}),
  });
  vi.stubGlobal("fetch", github.fetch);
  const handlers = await import("@intentius/chant/cli/handlers/pr");
  const { runComponentsFanOut } = await import("@intentius/chant/cli/handlers/fan-out");
  const { recordGateApproval } = await import("@intentius/chant/cli/handlers/operator");
  const gateChangeSet = await import("@intentius/chant/lifecycle/gate-change-set");
  gateChangeSet.setGraphIdReader(o.graphIds ?? (async () => ({ ids: [] })));

  const loop: ScenarioLoop = {
    dir,
    github,
    git,
    report: (stage) => JSON.parse(readFileSync(join(dir, ".chant", "pr", `pr-${stage}.json`), "utf8")) as PrReport,
    async applyBase() {
      const { discoverComponents } = await import("@intentius/chant/components");
      const { deployUnits } = await import("@intentius/chant/components/deploy-units");
      const found = await discoverComponents(dir, { sandbox: o.sandbox ?? true });
      // The fan-out selects by the units the steps deploy (a stack, a root),
      // which a rewrite may have renamed away from the component's name.
      const units = [...found.components.values()].flatMap(({ component }) => {
        const own = deployUnits(component.deploy).map((u) => u.unit);
        return own.length > 0 ? own : [component.name];
      });
      writeFileSync(join(dir, ".chant-base.json"), JSON.stringify({ changed: [...new Set(units)] }));
      try {
        return await runComponentsFanOut(ctx({ fromAffected: ".chant-base.json" }) as never);
      } finally {
        rmSync(join(dir, ".chant-base.json"), { force: true });
      }
    },
    async open(pr, scenario) {
      git("checkout", "-qb", `pr-${pr}`);
      copy(join(o.example, "scenarios", scenario, "pull"));
      o.prepare?.(dir);
      git("add", "-A");
      git("commit", "-qm", scenario);
      const code = await handlers.runComponentsPrPlan(ctx({ base: "main", pr, forge: "github" }) as never);
      return { code, report: loop.report("plan") };
    },
    async approve(pr, gate, digest) {
      github.reviews[pr] = [{ user: { login: "alice" }, state: "APPROVED" }];
      const r = await recordGateApproval(`pr-${pr}`, gate, { actor: "github:alice", plan: digest });
      if (!r.ok) throw new Error(`the approval of ${gate} on pr-${pr} was not recorded`);
    },
    async merge(pr) {
      git("checkout", "-q", "main");
      mergedFrom = git("rev-parse", "HEAD");
      git("merge", "-q", "--no-ff", `pr-${pr}`, "-m", `Merge pull request #${pr}`);
      github.mergedBy[git("rev-parse", "HEAD")] = pr;
      return handlers.runComponentsPrApply(ctx({ base: mergedFrom, forge: "github", requireReview: true, resume: RESUME }) as never);
    },
    again: () => handlers.runComponentsPrApply(ctx({ base: mergedFrom, forge: "github", requireReview: true, resume: RESUME }) as never),
    async close() {
      gateChangeSet.setGraphIdReader(undefined);
      vi.unstubAllGlobals();
      process.chdir(cwd);
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return loop;
}
