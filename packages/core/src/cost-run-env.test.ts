/**
 * The cost hold redacts and drops what a product sets in a run's own
 * environment (#5433), beside the job's. The estimators are real shell
 * commands, so what they report is what a process given the plan copy and
 * the command's environment can see.
 */
import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { costEnv, priceRuns } from "./cost-estimate";
import { opWaveCosts } from "./op/op-waves-capability";
import { runOpWave, type OpWaveShowAtBase } from "./op/op-waves-run";
import { memoryGateLedgerPort } from "./op/gate";
import type { OpWavesSpec } from "./op/op-waves";
import { CapabilityRegistry, type Capability } from "./components/capability";
import { COST_RUN_ENV_FLOOR } from "./ci-product";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cost-run-env-")));
  scratch.push(d);
  return d;
};

// Set only in the run's own environment, never in the job's (process.env).
const VAR = "TG_ROOT_DB_PASSWORD_5433";
const SECRET = "root-only-secret-5433-value";

/** A plan document that repeats the run's secret where no engine marks it. */
const unmarked = () => ({ resource_changes: [{ address: "aws_db_instance.main", change: { actions: ["create"], after: { dsn: `postgres://app:${SECRET}@db/app`, size: "db.t3.small" } } }] });

/** Writes what it saw to `$2`: the secret in the plan copy, the secret anywhere in its environment, the variable by name. */
const SEES = `
  seen=""
  case "$(cat "$1")" in *${SECRET}*) seen="$seen value-in-plan";; esac
  env | grep -q "${SECRET}" && seen="$seen value-in-env"
  env | grep -q "^${VAR}=" && seen="$seen variable-in-env"
  printf '%s' "$seen" > "$2"
  printf '{"monthlyDelta": 1}'
`;

function planned(): { dir: string; artifact: { planFile: string; planJson: string }; seen: string } {
  const dir = tmp();
  const planJson = join(dir, "plan.json");
  writeFileSync(planJson, JSON.stringify(unmarked()));
  return { dir, artifact: { planFile: join(dir, "plan"), planJson }, seen: join(dir, "seen.txt") };
}

describe("the cost hold reads redactEnv and dropEnv in a run's own environment (#5433)", () => {
  test("a secret set only in the run's environment reaches the estimator in neither the plan copy nor its environment", () => {
    expect(process.env[VAR]).toBeUndefined();
    const { dir, artifact, seen } = planned();
    const hold = { command: ["sh", "-c", SEES, "estimator", "{planJson}", seen], approveAbove: 100, format: "chant" as const, redactEnv: [VAR] };
    const costs = opWaveCosts(hold, [{ target: "envs/prod/db", plan: "p", artifact, empty: false, env: { [VAR]: SECRET } }], dir);
    expect(costs).toEqual([{ target: "envs/prod/db", monthlyDelta: 1 }]);
    expect(readFileSync(seen, "utf-8")).toBe("");
  });

  test("dropEnv reads the run's environment too", () => {
    const { dir, artifact, seen } = planned();
    const hold = { command: ["sh", "-c", SEES, "estimator", "{planJson}", seen], approveAbove: 100, format: "chant" as const, dropEnv: [VAR] };
    opWaveCosts(hold, [{ target: "a", plan: "p", artifact, empty: false, env: { [VAR]: SECRET } }], dir);
    expect(readFileSync(seen, "utf-8")).toBe("");
  });

  test("without a run environment the hold behaves as before: a value the job does not hold stays in the plan copy", () => {
    const { dir, artifact, seen } = planned();
    const hold = { command: ["sh", "-c", SEES, "estimator", "{planJson}", seen], approveAbove: 100, format: "chant" as const, redactEnv: [VAR] };
    opWaveCosts(hold, [{ target: "a", plan: "p", artifact, empty: false }], dir);
    expect(readFileSync(seen, "utf-8")).toBe(" value-in-plan");
  });

  test("a job variable that holds the run's secret under another name is left out of the command's environment", () => {
    const other = "TG_JOB_COPY_5433";
    process.env[other] = SECRET;
    try {
      const { dir, artifact, seen } = planned();
      const hold = { command: ["sh", "-c", SEES, "estimator", "{planJson}", seen], approveAbove: 100, format: "chant" as const, redactEnv: [VAR] };
      opWaveCosts(hold, [{ target: "a", plan: "p", artifact, empty: false, env: { [VAR]: SECRET } }], dir);
      expect(readFileSync(seen, "utf-8")).toBe("");
    } finally {
      delete process.env[other];
    }
  });

  test("one run's environment redacts that run only", () => {
    const dir = tmp();
    const runs = ["a", "b"].map((member) => {
      const planJson = join(dir, `${member}.json`);
      writeFileSync(planJson, JSON.stringify({ values: { a: "value-of-a", b: "value-of-b" } }));
      return { member, artifact: { planJson }, empty: false, env: { [VAR]: `value-of-${member}` } };
    });
    const copies: Record<string, string> = {};
    priceRuns({ command: ["price", "{planJson}", "{target}"], format: "chant", redactEnv: [VAR] }, runs, dir, (argv) => {
      copies[argv[2]!] = readFileSync(argv[1]!, "utf-8");
      return { status: 0, stdout: '{"monthlyDelta": 1}', stderr: "" };
    });
    expect(JSON.parse(copies.a!)).toEqual({ values: { a: "[redacted]", b: "value-of-b" } });
    expect(JSON.parse(copies.b!)).toEqual({ values: { a: "value-of-a", b: "[redacted]" } });
  });

  test("costEnv drops a job variable holding a value the run's environment names", () => {
    expect(costEnv({ PATH: "/bin", COPY: SECRET, KEEP: "k" }, { redactEnv: [VAR] }, { [VAR]: SECRET })).toEqual({ PATH: "/bin", KEEP: "k" });
    expect(costEnv({ PATH: "/bin", COPY: SECRET }, { redactEnv: [VAR] })).toEqual({ PATH: "/bin", COPY: SECRET });
  });

  test("an op wave's cost hold redacts the env a product's runHooks.beforePlan gives the run", async () => {
    const cwd = tmp();
    const seen = join(cwd, "seen.txt");
    // The capability's engine plans with the run's environment, so its plan document repeats the secret unmarked.
    const cap: Capability<Record<string, unknown>, unknown> = {
      kind: "fake-apply",
      async plan(ctx, input) {
        const root = String(input.root);
        const planJson = join(cwd, `${root}.tfplan.json`);
        writeFileSync(planJson, JSON.stringify({ resource_changes: [{ address: "x", change: { actions: ["create"], after: { dsn: `db://${ctx.processEnv?.[VAR] ?? "none"}@h` } } }] }));
        return { member: root, planDigest: `sha256:${"1".repeat(64)}`, artifact: { planFile: `${root}.tfplan`, planJson } };
      },
      async run() {
        return {};
      },
    };
    const registry = new CapabilityRegistry().register(cap);
    const wave = (redactEnv?: string[]): OpWavesSpec => ({
      name: "roots",
      op: "tf-apply",
      step: { kind: "fake-apply", root: "{target}" },
      holds: { cost: { command: ["sh", "-c", SEES, "estimator", "{planJson}", seen], approveAbove: 100, format: "chant", ...(redactEnv ? { redactEnv } : {}) } },
      waves: [{ name: "prod", runs: [{ target: "db" }], gate: "never" }],
    });
    const runHooks = { name: "product", beforePlan: () => ({ env: { [VAR]: SECRET } }) };
    const go = async (spec: OpWavesSpec) => {
      const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
      return runOpWave({ spec, specFile: "waves.json", wave: 1, cwd, show, gates: memoryGateLedgerPort(), capabilities: registry, runHooks });
    };

    // Without redactEnv the copy keeps the value, so the estimator below would have seen it.
    expect((await go(wave())).exitCode).toBe(0);
    expect(readFileSync(seen, "utf-8")).toBe(" value-in-plan");

    const result = await go(wave([VAR]));
    expect(result).toMatchObject({ exitCode: 0, applied: ["db"] });
    expect(readFileSync(seen, "utf-8")).toBe("");
  });

  test("the floor is exported", () => {
    expect(COST_RUN_ENV_FLOOR).toBeTypeOf("string");
  });
});
