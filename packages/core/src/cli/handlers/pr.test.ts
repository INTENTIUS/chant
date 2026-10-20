/**
 * `chant components pr-plan` and `pr-apply` with `--events-json` (#4041,
 * #4007): the planning as a `plan` phase, the gate's decision as a `gate`
 * phase, and on pr-apply the waves and components of the apply, all on one
 * schema-valid stream. Git, the change signal, the derivation and the gate
 * ledger are fakes; the planning and the apply are the real ones.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DriverComponent } from "../../components/driver";
import type { DeployContext } from "../../components/capability";
import type { ParsedArgs } from "../registry";
import { forgePrincipalOf } from "../../pr-forge";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

vi.mock("../../components/changed-files", () => ({
  resolveCommit: async () => HEAD,
  resolveMergeBase: async () => BASE,
}));

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
});

vi.mock("./fan-out", () => ({
  resolveChangedUnits: async () => ({ units: { changed: ["net"], indeterminate: [] } }),
}));

// #4022: pr-apply stores the change set its gate binds on chant/lifecycle and
// pushes it. These tests run in the chant checkout, so the store is replaced:
// it must never write or push the real repository's lifecycle branch.
vi.mock("../../lifecycle/gate-change-set", () => ({
  storeGateChangeSet: async () => ({ written: false }),
  readGraphIds: async () => ({ ids: [] }),
  setGraphIdReader: () => {},
  gateGraphReader: () => async () => ({ ids: [] }),
}));
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr.test must not push chant/lifecycle"); } };
});

vi.mock("./run", () => ({
  GATED_EXIT_CODE: 3,
  autoReleaseRun: (id: string) => ({ runId: id, runOrigin: { forge: "local" } }),
  recordAutoReleasesForRun: async () => [],
}));

let gateLedger: ReturnType<typeof import("../../op/gate").memoryGateLedgerPort>;
vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  return { ...actual, gitGateLedgerPort: () => gateLedger, gateIsSealed: async () => false };
});

const failing = new Set<string>();
/** Called as a component's apply starts, before it can fail. */
let onRun: (root: string) => void = () => {};
vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: { root: string }) {
      const planDigest = computePlanDigest("fake-root", { root: input.root });
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        changeSet: { member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] }, entries: [] },
      };
    },
    async outputs() {
      return {};
    },
    async run(_ctx: DeployContext, input: { root: string }) {
      onRun(input.root);
      if (failing.has(input.root)) throw new Error(`${input.root} failed`);
      return { outputs: {} };
    },
  } as never);
  return {
    fanOutRegistry: async () => registry,
    deriveFanOut: async () => ({
      success: true,
      components: ESTATE,
      plan: planFanOut({ components: ESTATE, changed: ["net"] }),
      signal: { changed: ["net"], indeterminate: [], unclaimed: [] },
    }),
  };
});

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: name }] }],
});
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"])];

const { memoryGateLedgerPort } = await import("../../op/gate");
const { runComponentsPrApply, runComponentsPrPlan } = await import("./pr");
const { checkRunEventLines, stepTrail } = await import("../../workspace/__fixtures__/run-event-check");

let dir: string;
let out: string[];
let errors: string[];

const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-apply", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, eventsJson: true, ...a } as ParsedArgs, plugins: [] }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-events-"));
  out = [];
  errors = [];
  failing.clear();
  onRun = () => {};
  gateLedger = memoryGateLedgerPort();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
  vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.map(String).join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The digest pr-plan printed, read back from its report. */
async function plannedDigest(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")).digest as string;
}

describe("pr-plan --events-json", () => {
  test("plans each component in a plan phase, then says where the approval stands; the run settles ok", async () => {
    expect(await runComponentsPrPlan(ctx({ pr: 12 }))).toBe(0);
    const events = checkRunEventLines(out);
    expect(events[0]).toMatchObject({ type: "run-start", kind: "component", name: "pr-plan pr-12", waves: [["net"], ["app"]] });
    expect(stepTrail(events)).toEqual([
      ["step-start", "plan"], ["step-settle", "plan", "ok"],
      ["step-start", "plan"], ["step-settle", "plan", "ok"],
      ["step-start", "gate:pr-apply"], ["gate-waiting", "gate:pr-apply"], ["step-settle", "gate:pr-apply", "gated"],
    ]);
    expect(events.filter((e) => e.type === "step-start" && e.phase === "plan").map((e) => (e as { component: string }).component)).toEqual(["net", "app"]);
    // The plan stage reads the ledger and writes nothing to it.
    expect(gateLedger.appended).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "ok" });
  });
});

describe("pr-apply --events-json", () => {
  test("refused: the gate phase settles gated with the reason, nothing applies, and the run is gated", async () => {
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(3);
    const events = checkRunEventLines(out);
    expect(events[0]).toMatchObject({ name: "pr-apply pr-12" });
    expect(events.find((e) => e.type === "gate-waiting")).toMatchObject({ op: "pr-12", gate: "pr-apply", message: expect.stringMatching(/No approval stands for this plan/) });
    expect(events.some((e) => e.type === "wave-start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "gated" });
  });

  test("approved: the gate resolves, then each wave and component applies; a failure settles the run failed", async () => {
    await runComponentsPrPlan(ctx({ pr: 12 }));
    const digest = await plannedDigest();
    gateLedger = memoryGateLedgerPort({
      resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: "github:alice", timestamp: new Date().toISOString(), planDigest: digest }],
    });
    out = [];
    failing.add("app");
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(1);
    const events = checkRunEventLines(out);
    expect(events.map((e) => e.type).filter((t) => t !== "step-start" && t !== "step-settle")).toEqual([
      "run-start",
      "phase-start", "phase-settle",
      "phase-start", "gate-resolved", "phase-settle",
      "wave-start", "component-start", "phase-start", "phase-settle", "component-settle", "wave-settle",
      "wave-start", "component-start", "phase-start", "phase-settle", "component-settle", "wave-settle",
      "run-settle",
    ]);
    expect(events.find((e) => e.type === "gate-resolved")).toMatchObject({ resolvedBy: "github:alice" });
    expect(events.find((e) => e.type === "component-settle" && e.component === "app")).toMatchObject({ status: "failed" });
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "failed" });
  });
});

/** Plan pull request 12 and approve its digest, as a reviewer would. */
async function planAndApprove(): Promise<void> {
  await runComponentsPrPlan(ctx({ pr: 12 }));
  const digest = await plannedDigest();
  gateLedger = memoryGateLedgerPort({
    resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: "github:alice", timestamp: new Date().toISOString(), planDigest: digest }],
  });
  out = [];
  errors = [];
}

/** The job log's wave and component lines, without colour. */
const logLines = (): string[] =>
  errors.map((l) => l.replace(/\u001b\[[0-9;]*m/g, "")).filter((l) => /^wave \d|^ {2}\S+: /.test(l));

describe("pr-apply's job log (#4007)", () => {
  test("without --events-json, a line as each wave starts and as each component settles, in order", async () => {
    await planAndApprove();
    expect(await runComponentsPrApply(ctx({ pr: 12, eventsJson: false }))).toBe(0);
    expect(out).toEqual([]);
    expect(logLines()).toEqual(["wave 1/2: net", "  net: applied", "wave 2/2: app", "  app: applied"]);
  });

  test("a failed dependency: the component behind it settles blocked, naming it, in the log and the stream", async () => {
    await planAndApprove();
    failing.add("net");
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(1);
    expect(logLines()).toEqual(["wave 1/2: net", "  net: failed", "  app: blocked by net, not run"]);
    const events = checkRunEventLines(out);
    const blocked = events.find((e) => e.type === "component-settle" && e.component === "app");
    expect(blocked).toMatchObject({ type: "component-settle", wave: 2, component: "app", status: "blocked", blockedBy: "net" });
    expect(events.some((e) => e.type === "component-start" && e.component === "app")).toBe(false);
    expect(events.some((e) => e.type === "wave-start" && e.wave === 2)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "failed" });
  });

  test("a resumed apply settles what the earlier attempt applied as already-applied, before the gate", async () => {
    await planAndApprove();
    const resume = join(dir, "attempt.json");
    failing.add("app");
    expect(await runComponentsPrApply(ctx({ pr: 12, resume, eventsJson: false }))).toBe(1);
    failing.clear();
    out = [];
    errors = [];
    expect(await runComponentsPrApply(ctx({ pr: 12, resume }))).toBe(0);
    const events = checkRunEventLines(out);
    const settles = events.filter((e) => e.type === "component-settle").map((e) => [e.component, (e as { status: string }).status, (e as { wave: number }).wave]);
    expect(settles).toEqual([["net", "already-applied", 1], ["app", "ok", 1]]);
    const gate = events.findIndex((e) => e.type === "phase-start" && e.phase === "gate");
    expect(events.findIndex((e) => e.type === "component-settle" && e.component === "net")).toBeLessThan(gate);
    expect(logLines()).toEqual(["  net: already applied in an earlier attempt", "wave 1/1: app", "  app: applied"]);
  });
});

describe("--resume carries only an unchanged input (#4081)", () => {
  test("a component whose input moved since the attempt runs again, and says why", async () => {
    await planAndApprove();
    const resume = join(dir, "attempt.json");
    failing.add("app");
    expect(await runComponentsPrApply(ctx({ pr: 12, resume, eventsJson: false }))).toBe(1);
    expect(JSON.parse(readFileSync(resume, "utf8")).inputs).toEqual({ net: expect.stringMatching(/^jcs1-sha256:/) });
    failing.clear();
    errors = [];
    const step = ESTATE[0]!.deploy[0]!.steps[0] as Record<string, unknown>;
    step.note = "a different change of the same shape";
    const ran: string[] = [];
    onRun = (name) => ran.push(name);
    try {
      expect(await runComponentsPrApply(ctx({ pr: 12, resume, eventsJson: false }))).toBe(0);
    } finally {
      delete step.note;
    }
    expect(ran).toEqual(["net", "app"]);
    expect(errors.join("\n")).toContain("net: changed since the earlier attempt, so it runs again");
  });

  test("a record without input digests does not carry", async () => {
    await planAndApprove();
    const resume = join(dir, "attempt.json");
    failing.add("app");
    expect(await runComponentsPrApply(ctx({ pr: 12, resume, eventsJson: false }))).toBe(1);
    const { writeFileSync } = await import("node:fs");
    const record = JSON.parse(readFileSync(resume, "utf8"));
    delete record.inputs;
    writeFileSync(resume, JSON.stringify(record));
    failing.clear();
    errors = [];
    const ran: string[] = [];
    onRun = (name) => ran.push(name);
    expect(await runComponentsPrApply(ctx({ pr: 12, resume, eventsJson: false }))).toBe(0);
    expect(ran).toEqual(["net", "app"]);
    expect(errors.join("\n")).toMatch(/does not carry: it does not record what each component applied/);
  });
});

describe("--report-url (#4007)", () => {
  test("refuses a URL it can't upload to, before anything plans", async () => {
    expect(await runComponentsPrPlan(ctx({ pr: 12, reportUrl: "https://example.invalid/reports" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/takes an s3:\/\/<bucket>\/<prefix> or file:\/\/<directory> URL/);
    expect(out).toEqual([]);
  });

  test("file://: the report, the change set and the events land under <pr>/<commit>/, the events as each wave settles", async () => {
    const { pathToFileURL } = await import("node:url");
    const { readFile } = await import("node:fs/promises");
    const reports = join(dir, "reports");
    const reportUrl = pathToFileURL(reports).href;
    await runComponentsPrPlan(ctx({ pr: 12, reportUrl }));
    const at = join(reports, "12", HEAD);
    expect(JSON.parse(await readFile(join(at, "pr-plan.json"), "utf8"))).toMatchObject({ stage: "plan", pr: 12, status: "planned" });
    expect(checkRunEventLines((await readFile(join(at, "pr-plan.events.jsonl"), "utf8")).split(/(?<=\n)/))[0]).toMatchObject({ type: "run-start" });

    await planAndApprove();
    // What a reader of the URL sees while wave 2 applies: wave 1 settled.
    let seenMidRun: string[] = [];
    onRun = (root) => {
      if (root === "app") seenMidRun = readFileSync(join(at, "pr-apply.events.jsonl"), "utf8").split(/(?<=\n)/);
    };
    expect(await runComponentsPrApply(ctx({ pr: 12, reportUrl }))).toBe(0);
    const mid = seenMidRun.map((l) => JSON.parse(l) as { type: string; wave?: number; status?: string });
    expect(mid.some((e) => e.type === "wave-settle" && e.wave === 1 && e.status === "ok")).toBe(true);
    expect(mid.some((e) => e.type === "run-settle")).toBe(false);

    const final = checkRunEventLines((await readFile(join(at, "pr-apply.events.jsonl"), "utf8")).split(/(?<=\n)/));
    expect(final.at(-1)).toMatchObject({ type: "run-settle", status: "ok" });
    expect(final.map((e) => e.type).join("\n")).toBe(out.map((l) => JSON.parse(l).type).join("\n"));
    expect(JSON.parse(await readFile(join(at, "pr-apply.json"), "utf8"))).toMatchObject({ stage: "apply", status: "applied" });
    expect(JSON.parse(await readFile(join(at, "change-set.json"), "utf8"))).toHaveProperty("digest");
    expect(errors.join("\n")).toContain(`report  : ${reportUrl}/12/${HEAD}/`);
  });

  test("without --events-json, only the report and the change set are copied", async () => {
    const { pathToFileURL } = await import("node:url");
    const { readdir } = await import("node:fs/promises");
    const reports = join(dir, "reports");
    await runComponentsPrPlan(ctx({ pr: 12, reportUrl: pathToFileURL(reports).href, eventsJson: false }));
    expect((await readdir(join(reports, "12", HEAD))).sort()).toEqual(["change-set.json", "pr-plan.json"]);
  });
});

describe("--events-json beside --json", () => {
  test("is refused on pr-plan and pr-apply before anything plans, since both print to stdout", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.join(" ")); });
    expect(await runComponentsPrPlan(ctx({ pr: 12, json: true }))).toBe(1);
    expect(await runComponentsPrApply(ctx({ pr: 12, json: true }))).toBe(1);
    expect(errors.filter((e) => /--events-json and --json both stream to stdout/.test(e))).toHaveLength(2);
    expect(out).toEqual([]);
  });
});

describe("--require-review: whoever wrote the change never counts (#4000)", () => {
  type Kind = "github" | "forgejo" | "gitlab";
  const ENV: Record<Kind, Record<string, string>> = {
    github: { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t0k", GITHUB_API_URL: "https://api.github.test", GITHUB_SERVER_URL: "https://github.com" },
    forgejo: { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t0k", GITHUB_API_URL: "https://code.example.test/api/v1", GITHUB_SERVER_URL: "https://code.example.test" },
    gitlab: { CI_API_V4_URL: "https://gitlab.example.test/api/v4", CI_PROJECT_ID: "42", CHANT_FORGE_TOKEN: "t0k", CI_SERVER_HOST: "gitlab.example.test" },
  };
  const HOST: Record<Kind, string> = { github: "github.com", forgejo: "code.example.test", gitlab: "gitlab.example.test" };

  /**
   * Pull request 12 as each forge serves it: carol opened it, dave pushed a
   * commit to it, and `approver` approved it. GitLab names a commit's people
   * by email, which the users search maps to an account.
   */
  function serve(kind: Kind, approver: string): string[] {
    const asked: string[] = [];
    const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
    vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
      const { pathname, searchParams } = new URL(url);
      asked.push(`${init.method} ${pathname}`);
      if (init.method !== "GET") return ok({ id: 1 });
      if (kind === "gitlab") {
        const mr = "/api/v4/projects/42/merge_requests/12";
        if (pathname === `${mr}/approvals`) return ok({ approved_by: [{ user: { username: approver } }] });
        if (pathname === mr) return ok({ iid: 12, author: { username: "carol" } });
        if (pathname === `${mr}/commits`)
          return ok([
            { author_email: "carol@example.test", committer_email: "carol@example.test" },
            { author_email: "Dave@example.test", committer_email: "dave@example.test" },
          ]);
        if (pathname === "/api/v4/users") return ok({ "carol@example.test": [{ username: "carol" }], "dave@example.test": [{ username: "dave" }] }[searchParams.get("search")!] ?? []);
        return ok([]);
      }
      const pull = `${kind === "github" ? "" : "/api/v1"}/repos/acme/infra/pulls/12`;
      if (pathname === `${pull}/reviews`) return ok([{ user: { login: approver }, state: "APPROVED" }]);
      if (pathname === pull) return ok({ number: 12, user: { login: "carol" } });
      if (pathname === `${pull}/commits`)
        return ok([
          { author: { login: "carol" }, committer: { login: "carol" } },
          { author: null, committer: { login: "dave" } },
        ]);
      return ok([]);
    });
    return asked;
  }

  async function approveAs(kind: Kind, login: string): Promise<void> {
    await runComponentsPrPlan(ctx({ pr: 12 }));
    const digest = await plannedDigest();
    gateLedger = memoryGateLedgerPort({
      resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: forgePrincipalOf(kind, HOST[kind], login), timestamp: new Date().toISOString(), planDigest: digest }],
    });
    out = [];
    errors = [];
  }

  const applyReport = async () => {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(join(dir, "pr-apply.json"), "utf8")) as { status: string; refusal?: string; message?: string };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const kind of ["github", "forgejo", "gitlab"] as const) {
    describe(kind, () => {
      beforeEach(() => {
        for (const [k, v] of Object.entries(ENV[kind])) vi.stubEnv(k, v);
      });

      test("the author approves: refused as author-approved, naming them, and nothing applies", async () => {
        serve(kind, "carol");
        await approveAs(kind, "carol");
        let ran = false;
        onRun = () => { ran = true; };
        expect(await runComponentsPrApply(ctx({ pr: 12, forge: kind, requireReview: true, eventsJson: false }))).toBe(3);
        const report = await applyReport();
        expect(report).toMatchObject({ status: "refused", refusal: "author-approved" });
        expect(report.message).toContain(`approved by ${forgePrincipalOf(kind, HOST[kind], "carol")}, who wrote #12`);
        expect(report.message).toContain("never counts");
        expect(ran).toBe(false);
      });

      test("a co-author who pushed a commit approves: refused as author-approved", async () => {
        serve(kind, "dave");
        await approveAs(kind, "dave");
        expect(await runComponentsPrApply(ctx({ pr: 12, forge: kind, requireReview: true, eventsJson: false }))).toBe(3);
        const report = await applyReport();
        expect(report).toMatchObject({ status: "refused", refusal: "author-approved" });
        expect(report.message).toContain(`approved by ${forgePrincipalOf(kind, HOST[kind], "dave")}, who wrote #12`);
      });

      test("an outside reviewer approves: the plan applies", async () => {
        serve(kind, "erin");
        await approveAs(kind, "erin");
        expect(await runComponentsPrApply(ctx({ pr: 12, forge: kind, requireReview: true, eventsJson: false }))).toBe(0);
        expect(await applyReport()).toMatchObject({ status: "applied" });
      });
    });
  }
});
