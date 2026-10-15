/**
 * The e2b opRuntime provider.
 *
 * Every test drives the real provider through its two seams: a fake
 * `StewardSandboxes` that records what it was asked and answers each script by
 * what kind it is (prepare, run, finish, ledger read, stop), and a fake `git`
 * for the local checkout. No network, no sandbox, no repository.
 */

import { describe, expect, it } from "vitest";
import type { ChantConfig } from "@intentius/chant/config";
import type { OpConfig, StepRecord } from "@intentius/chant/op";
import {
  createE2bOpRuntime,
  httpsRemote,
  ledgerScript,
  parseLedger,
  prepareScript,
  repoName,
  runScript,
  shellQuote,
  stopScript,
} from "./runtime";
import {
  RUN_ID_ENV,
  RUN_OP_ENV,
  RUN_STARTED_ENV,
  type CommandResult,
  type RunCommandOptions,
  type SandboxProcess,
  type StewardSandbox,
  type StewardSandboxes,
} from "./sandbox";

// ── fixtures ──────────────────────────────────────────────────────────────

const OP = { name: "deploy", overview: "Deploy", phases: [] } as unknown as OpConfig;

function record(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "local-1",
    op: "deploy",
    env: "local",
    started: "2026-10-15T10:00:00.000Z",
    ended: "2026-10-15T10:01:00.000Z",
    status: "ok",
    labels: {},
    outcomes: {},
    phases: [],
    ...over,
  };
}

const STEP: StepRecord = { phase: "Apply", fn: "shellCmd", status: "ok", durationMs: 5 };

type ScriptKind = "prepare" | "run" | "finish" | "ledger" | "stop" | "other";

function kindOf(script: string): ScriptKind {
  if (script.includes("git clone")) return "prepare";
  if (script.includes("exec node_modules/.bin/chant run")) return "run";
  if (script.includes("git ls-tree")) return "ledger";
  if (script.startsWith("kill -TERM")) return "stop";
  if (script.includes("ledger_sync")) return "finish";
  return "other";
}

interface Call {
  kind: ScriptKind;
  script: string;
  envs: Record<string, string>;
}

interface FakeOptions {
  /** The steward's sandbox already exists, in this state. */
  existing?: string;
  processes?: SandboxProcess[];
  answers?: Partial<Record<ScriptKind, Partial<CommandResult> & { chunks?: string[] }>>;
}

function fakeSandboxes(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  const sandbox: StewardSandbox = {
    id: "sb-1",
    async run(script: string, runOpts: RunCommandOptions = {}) {
      const kind = kindOf(script);
      calls.push({ kind, script, envs: runOpts.envs ?? {} });
      runOpts.onStart?.(42);
      const answer = opts.answers?.[kind] ?? {};
      for (const chunk of answer.chunks ?? []) runOpts.onStdout?.(chunk);
      if (answer.stderr) runOpts.onStderr?.(answer.stderr);
      return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    },
    async processes() {
      return opts.processes ?? [];
    },
    async kill(pid) {
      events.push(`kill ${pid}`);
    },
    async keepAwake(ms) {
      events.push(`awake ${ms}`);
    },
    async pause() {
      events.push("pause");
    },
  };
  const sandboxes: StewardSandboxes = {
    async find(steward) {
      events.push(`find ${steward}`);
      return opts.existing ? { id: "sb-1", state: opts.existing } : undefined;
    },
    async create(steward, createOpts) {
      events.push(`create ${steward} ${createOpts.template}`);
      return sandbox;
    },
    async connect(id) {
      events.push(`connect ${id}`);
      return sandbox;
    },
  };
  return { sandboxes, calls, events };
}

function fakeGit(over: Record<string, string> = {}) {
  const answers: Record<string, string> = {
    "remote get-url origin": "git@github.com:acme/infra.git",
    "rev-parse HEAD": "0123456789abcdef0123456789abcdef01234567",
    "status --porcelain --untracked-files=no": "",
    ...over,
  };
  return async (args: string[]) => {
    const key = args.join(" ");
    if (!(key in answers)) throw new Error(`unexpected git ${key}`);
    return answers[key];
  };
}

function runtime(fake: ReturnType<typeof fakeSandboxes>, extra: { config?: ChantConfig; env?: NodeJS.ProcessEnv; git?: Record<string, string> } = {}) {
  const stderr: string[] = [];
  const provider = createE2bOpRuntime({
    config: extra.config ?? ({ lexicons: ["e2b"] } as ChantConfig),
    sandboxes: fake.sandboxes,
    git: fakeGit(extra.git),
    env: extra.env ?? {},
    stderr: (chunk) => void stderr.push(chunk),
    now: () => new Date("2026-10-15T10:00:00.000Z"),
  });
  return { provider, stderr };
}

// ── start ─────────────────────────────────────────────────────────────────

describe("start", () => {
  it("makes the steward, runs the op in its clone, streams the steps and pauses it", async () => {
    const fake = fakeSandboxes({
      answers: { run: { chunks: [`${JSON.stringify(STEP)}\n${JSON.stringify(record()).slice(0, 20)}`, `${JSON.stringify(record()).slice(20)}\n`] } },
    });
    const { provider } = runtime(fake);
    const steps: StepRecord[] = [];
    const handle = await provider.start(OP, { env: "prod", params: { region: "us east" }, progress: (s) => void steps.push(s) });
    const status = await handle.result();

    expect(status).toMatchObject({ op: "deploy", runId: "local-1", state: "completed" });
    expect(steps).toEqual([STEP]);
    expect(fake.events).toEqual(["find infra", "create infra base", "pause"]);
    expect(fake.calls.map((c) => c.kind)).toEqual(["prepare", "run", "finish"]);

    const [prepare, run] = fake.calls;
    expect(prepare.script).toContain("git clone --quiet --no-checkout https://github.com/acme/infra.git");
    expect(prepare.script).toContain("git checkout --quiet --force --detach 0123456789abcdef0123456789abcdef01234567");
    expect(run.script).toContain("chant run deploy --env prod --param 'region=us east' --on local --json --progress-json");
    expect(run.envs[RUN_OP_ENV]).toBe("deploy");
    expect(run.envs[RUN_ID_ENV]).toBe(handle.runId);
    expect(run.envs[RUN_STARTED_ENV]).toBe("2026-10-15T10:00:00.000Z");
  });

  it("wakes an existing steward rather than making one", async () => {
    const fake = fakeSandboxes({ existing: "paused", answers: { run: { chunks: [`${JSON.stringify(record())}\n`] } } });
    const { provider } = runtime(fake);
    await (await provider.start(OP, {})).result();
    expect(fake.events.slice(0, 2)).toEqual(["find infra", "connect sb-1"]);
  });

  it("refuses a steward that is already running an op", async () => {
    const fake = fakeSandboxes({ existing: "running", processes: [{ pid: 7, envs: { [RUN_OP_ENV]: "migrate", [RUN_ID_ENV]: "r-9" } }] });
    const { provider } = runtime(fake);
    await expect(provider.start(OP, {})).rejects.toThrow(/steward "infra" \(sb-1\) is running op "migrate" \(run r-9\)/);
    expect(fake.calls).toEqual([]);
  });

  it("reports a gated run with its gate", async () => {
    const gate = { name: "approve", since: "2026-10-15T10:00:30.000Z" };
    const fake = fakeSandboxes({ answers: { run: { exitCode: 3, chunks: [`${JSON.stringify(record({ status: "gated", gate }))}\n`] } } });
    const { provider } = runtime(fake);
    const status = await (await provider.start(OP, {})).result();
    expect(status).toMatchObject({ state: "gated", gate });
  });

  it("fails without running the op when the clone cannot be prepared, and still pauses", async () => {
    const fake = fakeSandboxes({ answers: { prepare: { exitCode: 2, stderr: "e2b runtime: commit 0123 is not on https://x; push it first" } } });
    const { provider } = runtime(fake);
    const status = await (await provider.start(OP, {})).result();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("push it first");
    expect(fake.calls.map((c) => c.kind)).toEqual(["prepare"]);
    expect(fake.events.at(-1)).toBe("pause");
  });

  it("reports a run killed before it wrote a record as cancelled", async () => {
    const fake = fakeSandboxes({ answers: { run: { exitCode: -1 } } });
    const { provider } = runtime(fake);
    expect((await (await provider.start(OP, {})).result()).state).toBe("cancelled");
  });

  it("reports a run that exited without a record as failed, with its output", async () => {
    const fake = fakeSandboxes({ answers: { run: { exitCode: 1, stderr: "Op \"deploy\" not found" } } });
    const { provider } = runtime(fake);
    const status = await (await provider.start(OP, {})).result();
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/chant exited 1 in steward "infra" without a run record:\nOp "deploy" not found/);
  });

  it("stops the run in the sandbox when the caller aborts", async () => {
    const fake = fakeSandboxes({ answers: { run: { exitCode: -1 } } });
    const { provider } = runtime(fake);
    const controller = new AbortController();
    controller.abort();
    const status = await (await provider.start(OP, { signal: controller.signal })).result();
    expect(status.state).toBe("cancelled");
    expect(fake.calls.map((c) => c.kind)).toEqual(["prepare"]);
  });

  it("hands the git token to the sandbox's commands only", async () => {
    const fake = fakeSandboxes({ answers: { run: { chunks: [`${JSON.stringify(record())}\n`] } } });
    const { provider } = runtime(fake, { env: { CHANT_GIT_TOKEN: "s3cret" } });
    await (await provider.start(OP, {})).result();
    for (const call of fake.calls) {
      expect(call.envs.CHANT_GIT_TOKEN).toBe("s3cret");
      expect(call.script).not.toContain("s3cret");
    }
  });

  it("warns that uncommitted changes don't travel", async () => {
    const fake = fakeSandboxes({ answers: { run: { chunks: [`${JSON.stringify(record())}\n`] } } });
    const { provider, stderr } = runtime(fake, { git: { "status --porcelain --untracked-files=no": " M src/app.ts" } });
    await (await provider.start(OP, {})).result();
    expect(stderr.join("")).toContain("uncommitted changes; the steward runs commit 0123456789ab without them");
  });
});

// ── profiles ──────────────────────────────────────────────────────────────

describe("profiles", () => {
  const config = {
    lexicons: ["e2b"],
    e2b: {
      profiles: {
        prod: { steward: "prod-steward", template: "chant", repo: "https://git.example.com/acme/infra.git", gitToken: { env: "PROD_GIT" } },
      },
      defaultProfile: "prod",
    },
  } as unknown as ChantConfig;

  it("takes the steward, template and repository from the default profile", async () => {
    const fake = fakeSandboxes({ answers: { run: { chunks: [`${JSON.stringify(record())}\n`] } } });
    const { provider } = runtime(fake, { config, env: { PROD_GIT: "t" } });
    await (await provider.start(OP, {})).result();
    expect(fake.events.slice(0, 2)).toEqual(["find prod-steward", "create prod-steward chant"]);
    expect(fake.calls[0].script).toContain("git clone --quiet --no-checkout https://git.example.com/acme/infra.git");
  });

  it("refuses a profile name that is not declared", async () => {
    const { provider } = runtime(fakeSandboxes(), { config });
    await expect(provider.start(OP, { profile: "staging" })).rejects.toThrow(/no profile "staging" under e2b.profiles/);
  });

  it("refuses a declared git token variable that is not set", async () => {
    const { provider } = runtime(fakeSandboxes(), { config });
    await expect(provider.start(OP, {})).rejects.toThrow(/git token variable PROD_GIT is not set/);
  });

  it("asks for an API key when no seam is injected", async () => {
    const provider = createE2bOpRuntime({ config: { lexicons: ["e2b"] } as ChantConfig, git: fakeGit(), env: {} });
    await expect(provider.start(OP, {})).rejects.toThrow(/E2B_API_KEY is not set/);
  });
});

// ── status, log, list, cancel ─────────────────────────────────────────────

describe("reads", () => {
  const ledger = [record({ id: "a", started: "2026-10-15T09:00:00.000Z" }), record({ id: "b", started: "2026-10-15T11:00:00.000Z", status: "fail" })]
    .map((r) => JSON.stringify(r))
    .join("\n");

  it("has nothing to say when the steward has never been made", async () => {
    const fake = fakeSandboxes();
    const { provider } = runtime(fake);
    expect(await provider.status("deploy")).toBeUndefined();
    expect(await provider.log("deploy")).toEqual([]);
    expect(fake.events).not.toContain("create infra base");
  });

  it("reports the run in progress from the sandbox's processes", async () => {
    const fake = fakeSandboxes({
      existing: "running",
      processes: [{ pid: 7, envs: { [RUN_OP_ENV]: "deploy", [RUN_ID_ENV]: "r-1", [RUN_STARTED_ENV]: "2026-10-15T10:00:00.000Z" } }],
    });
    const { provider } = runtime(fake);
    expect(await provider.status("deploy")).toEqual({ op: "deploy", runId: "r-1", state: "running", startedAt: "2026-10-15T10:00:00.000Z" });
  });

  it("reads the latest settled run from the steward's ledger", async () => {
    const fake = fakeSandboxes({ existing: "paused", answers: { ledger: { stdout: ledger } } });
    const { provider } = runtime(fake);
    expect(await provider.status("deploy")).toMatchObject({ runId: "b", state: "failed" });
    expect((await provider.log("deploy", { limit: 1 })).map((r) => r.id)).toEqual(["b"]);
  });

  it("lists the latest state per op, the live run over its record", async () => {
    const fake = fakeSandboxes({
      existing: "running",
      processes: [{ pid: 7, envs: { [RUN_OP_ENV]: "migrate", [RUN_ID_ENV]: "m-2" } }],
      answers: { ledger: { stdout: `${ledger}\n${JSON.stringify(record({ id: "m-1", op: "migrate" }))}` } },
    });
    const { provider } = runtime(fake);
    const states = await provider.list([OP, { ...OP, name: "migrate" }, { ...OP, name: "never" }] as OpConfig[]);
    expect(states.get("deploy")).toMatchObject({ runId: "b" });
    expect(states.get("migrate")).toMatchObject({ runId: "m-2", state: "running" });
    expect(states.get("never")).toBeUndefined();
  });

  it("cancels only the op that is running", async () => {
    const fake = fakeSandboxes({ existing: "running", processes: [{ pid: 7, envs: { [RUN_OP_ENV]: "deploy" } }] });
    const { provider } = runtime(fake);
    await expect(provider.cancel("migrate", { force: true })).rejects.toThrow(/is not running op "migrate"/);
    await provider.cancel("deploy", { force: true });
    expect(fake.calls.at(-1)).toMatchObject({ kind: "stop", script: expect.stringContaining("kill -TERM 7") });
  });

  it("kills a run that ignores SIGTERM", async () => {
    const fake = fakeSandboxes({ existing: "running", processes: [{ pid: 7, envs: { [RUN_OP_ENV]: "deploy" } }], answers: { stop: { exitCode: 1 } } });
    const { provider } = runtime(fake);
    await provider.cancel("deploy", { force: true });
    expect(fake.events).toContain("kill 7");
  });
});

// ── pure helpers ──────────────────────────────────────────────────────────

describe("helpers", () => {
  it("rewrites an ssh remote to https", () => {
    expect(httpsRemote("git@github.com:acme/infra.git")).toBe("https://github.com/acme/infra.git");
    expect(httpsRemote("ssh://git@git.example.com:2222/acme/infra")).toBe("https://git.example.com/acme/infra");
    expect(httpsRemote("https://github.com/acme/infra.git")).toBe("https://github.com/acme/infra.git");
  });

  it("names a steward after its repository", () => {
    expect(repoName("https://github.com/acme/infra.git")).toBe("infra");
    expect(repoName("git@github.com:acme/infra")).toBe("infra");
  });

  it("quotes only what needs it", () => {
    expect(shellQuote("region=us-east-1")).toBe("region=us-east-1");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("spells the run's command line", () => {
    expect(runScript("deploy", { work: { item: "w-1", holder: "ci" } })).toBe(
      `cd "$HOME/chant-steward" && exec node_modules/.bin/chant run deploy --work w-1 --holder ci --on local --json --progress-json`,
    );
  });

  it("refuses to fold a stray value into the stop script", () => {
    expect(stopScript(12.7)).toMatch(/^kill -TERM 12 /);
  });

  it("reads ledger lines newest first, skipping what isn't a record", () => {
    const text = [JSON.stringify(record({ id: "old", started: "2026-01-01T00:00:00Z" })), "not json", "{}", JSON.stringify(record({ id: "new" }))].join("\n");
    expect(parseLedger(text).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("reads only the asked ops' ledgers", () => {
    expect(ledgerScript(["deploy", "migrate"])).toContain("for p in runs__deploy.jsonl runs__migrate.jsonl;");
    expect(ledgerScript([])).toContain("for p in runs__*.jsonl;");
  });

  it("prepares from the commit, keeping ignored files", () => {
    const script = prepareScript("https://github.com/acme/infra.git", "abc");
    expect(script).toContain("git clean -fdq");
    expect(script).not.toContain("clean -fdx");
    expect(script.indexOf("ledger_sync\n")).toBeLessThan(script.indexOf("git checkout"));
  });
});
