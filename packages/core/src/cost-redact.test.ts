/**
 * The cost estimate runs on a redacted plan without the forge tokens (#5416).
 * The estimators here are real shell commands, so what they print is what a
 * process given the plan document and the environment can see.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COST_REDACTED, costEnv, estimateCosts, priceRuns, redactPlanJson } from "./cost-estimate";
import { opWaveCostVerdict, opWaveCosts } from "./op/op-waves-capability";
import { opWaveHoldsProblems } from "./op/op-waves-capability-spec";
import { COST_REDACTED_FLOOR } from "./ci-product";
import { FORGE_TOKEN_VARS } from "./ci-handover";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cost-redact-")));
  scratch.push(d);
  return d;
};

const SECRET = "hunter2-db-password";
const COPY = "copy-of-the-secret-in-an-unmarked-place";
const TOKEN = "ghs_forgeTokenValue0123456789";

/** A terraform `show -json` that marks one value sensitive and repeats another unmarked. */
const terraformPlan = () => ({
  format_version: "1.2",
  resource_changes: [
    {
      address: "aws_db_instance.main",
      change: { actions: ["create"], before: null, after: { password: SECRET, note: `uses ${SECRET} twice`, size: "db.t3.small" }, after_sensitive: { password: true } },
    },
    { address: "terraform_data.x", change: { actions: ["create"], before: { input: COPY, output: COPY }, after: { input: COPY, output: COPY }, before_sensitive: { input: true }, after_sensitive: { input: true } } },
  ],
  planned_values: { outputs: { dsn: { sensitive: true, value: `postgres://u:${SECRET}@h/db` }, region: { sensitive: false, value: "eu-west-1" } }, root_module: { resources: [{ address: "aws_db_instance.main", values: { password: SECRET, size: "db.t3.small" }, sensitive_values: { password: true } }] } },
  variables: { token: { value: TOKEN } },
});

const pulumiPreview = () => ({
  steps: [{ op: "create", newState: { inputs: { password: { "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", ciphertext: "v1:abc" }, size: "small" } } }],
});

describe("redactPlanJson (#5416)", () => {
  test("a value terraform marks sensitive is replaced where it is marked and wherever the document repeats it", () => {
    const text = JSON.stringify(redactPlanJson(terraformPlan()));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(COPY);
    expect(text).toContain(COST_REDACTED);
    expect(text).toContain("db.t3.small");
    expect(text).toContain("eu-west-1");
  });

  test("a Pulumi secret is replaced, and what is not secret stays", () => {
    const text = JSON.stringify(redactPlanJson(pulumiPreview()));
    expect(text).not.toContain("1b47061264138c4ac30d75fd1eb44270");
    expect(text).not.toContain("v1:abc");
    expect(text).toContain('"size":"small"');
  });

  test("the values in `extra` are cut out, and the input is not changed", () => {
    const plan = terraformPlan();
    const text = JSON.stringify(redactPlanJson(plan, [TOKEN]));
    expect(text).not.toContain(TOKEN);
    expect(JSON.stringify(plan)).toContain(TOKEN);
  });
});

describe("costEnv (#5416)", () => {
  test("drops every forge token by name, and a variable that holds one by value, and keeps the rest", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/h", INFRACOST_API_KEY: "ic-1", ALIAS_FOR_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN };
    for (const name of FORGE_TOKEN_VARS) env[name] = name === "GITHUB_TOKEN" ? TOKEN : `v-${name}`;
    const clean = costEnv(env);
    expect(Object.keys(clean).sort()).toEqual(["HOME", "INFRACOST_API_KEY", "PATH"]);
    expect(Object.values(clean)).not.toContain(TOKEN);
  });
});

describe("the estimator a cost hold runs, with a real shell (#5416)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of [...FORGE_TOKEN_VARS, "TG_TOKEN_ALIAS"]) saved[name] = process.env[name];
    for (const name of FORGE_TOKEN_VARS) process.env[name] = name === "GITHUB_TOKEN" ? TOKEN : `forge-${name}`;
    process.env.TG_TOKEN_ALIAS = TOKEN;
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** A plan document on disk the way a capability's artifact names it. */
  function planned(plan: unknown) {
    const dir = tmp();
    const planJson = join(dir, "plan.json");
    writeFileSync(planJson, JSON.stringify(plan));
    return { dir, planJson, artifact: { planFile: join(dir, "plan"), planDigest: "d", planJson } };
  }

  // The estimator prints what it saw as the estimate's currency, so the test reads it back from `error`-free output.
  const SEES = `
    doc="$(cat "$1")"
    seen=""
    case "$doc" in *${SECRET}*) seen="$seen secret";; esac
    case "$doc" in *${COPY}*) seen="$seen copy";; esac
    case "$doc" in *${TOKEN}*) seen="$seen token-in-plan";; esac
    env | grep -q "${TOKEN}" && seen="$seen token-in-env"
    env | grep -q '^GITHUB_TOKEN=\\|^GH_TOKEN=\\|^CHANT_FORGE_TOKEN=\\|^CI_JOB_TOKEN=' && seen="$seen token-name"
    printf '{"monthlyDelta": 1, "currency": "%s"}' "$(echo "$seen" | tr ' ' '_')"
  `;

  test("a command run by holds.cost sees no secret value and no forge token", () => {
    const { dir, artifact } = planned(terraformPlan());
    const hold = { command: ["sh", "-c", SEES, "estimator", "{planJson}", "{target}"], approveAbove: 100, format: "chant" as const };
    const costs = opWaveCosts(hold, [{ target: "prod", plan: "p", artifact, empty: false }], dir);
    expect(costs).toEqual([{ target: "prod", monthlyDelta: 1, currency: "" }]);
    expect(opWaveCostVerdict(hold, costs).hold).toBeUndefined();
  });

  test("terragucci's argv form keeps working: the command gets the redacted copy as its first argument and the target as its second", () => {
    const { dir, artifact } = planned(terraformPlan());
    const script = 'printf \'{"monthlyDelta": 5, "currency": "%s"}\' "$(basename "$1")-$2-$(grep -c redacted "$1")"';
    const costs = opWaveCosts({ command: ["sh", "-c", script, "price", "{planJson}", "{target}"], approveAbove: 1, format: "chant" }, [{ target: "envs/prod", plan: "p", artifact, empty: false }], dir);
    expect(costs).toEqual([{ target: "envs/prod", monthlyDelta: 5, currency: "plan.json-envs/prod-1" }]);
  });

  test("the plan note's estimate, the same command, sees the same thing", () => {
    const { dir, artifact } = planned(terraformPlan());
    const estimate = estimateCosts({ command: ["sh", "-c", SEES, "estimator", "{planJson}"], format: "chant" }, [{ member: "a", artifact, empty: false }], dir);
    expect(estimate.currency).toBe("USD");
    expect(estimate.members).toEqual([{ member: "a", monthlyDelta: 1, currency: "" }]);
  });

  test("a Pulumi preview reaches the command with its secret replaced", () => {
    const { dir, artifact } = planned(pulumiPreview());
    const seenSecret = 'case "$(cat "$1")" in *1b47061264138c4ac30d75fd1eb44270*) s=leaked;; *) s=clean;; esac; printf \'{"monthlyDelta": 1, "currency": "%s"}\' "$s"';
    const costs = opWaveCosts({ command: ["sh", "-c", seenSecret, "price", "{planJson}"], approveAbove: 1, format: "chant" }, [{ target: "stack", plan: "p", artifact, empty: false }], dir);
    expect(costs).toEqual([{ target: "stack", monthlyDelta: 1, currency: "clean" }]);
  });

  test("the plan document on disk is untouched, and the copy is gone once the estimate is done", () => {
    const { dir, planJson, artifact } = planned(terraformPlan());
    const before = readFileSync(planJson, "utf-8");
    let copy = "";
    const exec = (argv: string[]) => {
      copy = argv[1]!;
      expect(copy).not.toBe(planJson);
      expect(readFileSync(copy, "utf-8")).not.toContain(SECRET);
      return { status: 0, stdout: '{"monthlyDelta": 2}', stderr: "" };
    };
    const priced = priceRuns({ command: ["price", "{planJson}"], format: "chant" }, [{ member: "a", artifact, empty: false }], dir, exec);
    expect(priced).toEqual([{ member: "a", monthlyDelta: 2 }]);
    expect(readFileSync(planJson, "utf-8")).toBe(before);
    expect(() => readFileSync(copy, "utf-8")).toThrow();
  });

  test("a plan document that is not JSON is not priced, and says why", () => {
    const dir = tmp();
    const planJson = join(dir, "plan.json");
    writeFileSync(planJson, "not json");
    const priced = priceRuns({ command: ["price", "{planJson}"] }, [{ member: "a", artifact: { planJson }, empty: false }], dir, () => {
      throw new Error("not run");
    });
    expect(priced).toEqual([{ member: "a", error: expect.stringMatching(/^the plan document could not be read to redact it: /) }]);
  });

  describe("redactEnv and dropEnv", () => {
    const STORE = "store-secret-value-not-in-any-mark";
    const OWN_TOKEN = "own-product-token-0123456789";
    beforeEach(() => {
      saved.TG_STORE_KEY = process.env.TG_STORE_KEY;
      saved.TG_TOKEN = process.env.TG_TOKEN;
      saved.TG_MERGE_TOKEN = process.env.TG_MERGE_TOKEN;
      process.env.TG_STORE_KEY = STORE;
      process.env.TG_TOKEN = OWN_TOKEN;
      process.env.TG_MERGE_TOKEN = OWN_TOKEN;
    });

    const unmarked = () => ({ resource_changes: [{ address: "x", change: { actions: ["create"], after: { dsn: `db://${STORE}@h`, owner: OWN_TOKEN, size: "small" } } }] });
    const SEES_STORE = `
      doc="$(cat "$1")"
      seen=""
      case "$doc" in *${STORE}*) seen="$seen store-in-plan";; esac
      case "$doc" in *${OWN_TOKEN}*) seen="$seen token-in-plan";; esac
      env | grep -q "${STORE}" && seen="$seen store-in-env"
      env | grep -q "${OWN_TOKEN}" && seen="$seen token-in-env"
      printf '{"monthlyDelta": 1, "currency": "%s"}' "$(echo "$seen" | tr ' ' '_')"
    `;

    test("without either option the values stay where they were, as before", () => {
      const { dir, artifact } = planned(unmarked());
      const costs = opWaveCosts({ command: ["sh", "-c", SEES_STORE, "e", "{planJson}"], approveAbove: 1, format: "chant" }, [{ target: "a", plan: "p", artifact, empty: false }], dir);
      expect(costs).toEqual([{ target: "a", monthlyDelta: 1, currency: "_store-in-plan_token-in-plan_store-in-env_token-in-env" }]);
    });

    test("redactEnv replaces a value the plan does not mark, and leaves the variable out of the command's environment", () => {
      const { dir, artifact } = planned(unmarked());
      const hold = { command: ["sh", "-c", SEES_STORE, "e", "{planJson}"], approveAbove: 1, format: "chant" as const, redactEnv: ["TG_STORE_KEY"] };
      const costs = opWaveCosts(hold, [{ target: "a", plan: "p", artifact, empty: false }], dir);
      expect(costs).toEqual([{ target: "a", monthlyDelta: 1, currency: "_token-in-plan_token-in-env" }]);
    });

    test("dropEnv leaves the named variables out by name and by value, and redacts their value in the plan copy", () => {
      const { dir, artifact } = planned(unmarked());
      const hold = { command: ["sh", "-c", SEES_STORE, "e", "{planJson}"], approveAbove: 1, format: "chant" as const, dropEnv: ["TG_TOKEN", "TG_MERGE_TOKEN"] };
      const costs = opWaveCosts(hold, [{ target: "a", plan: "p", artifact, empty: false }], dir);
      expect(costs).toEqual([{ target: "a", monthlyDelta: 1, currency: "_store-in-plan_store-in-env" }]);
    });

    test("a variable that is not set is not an error", () => {
      delete process.env.TG_STORE_KEY;
      const { dir, artifact } = planned(unmarked());
      const costs = opWaveCosts({ command: ["sh", "-c", SEES_STORE, "e", "{planJson}"], approveAbove: 1, format: "chant", redactEnv: ["TG_STORE_KEY"], dropEnv: ["NOT_SET_ANYWHERE"] }, [{ target: "a", plan: "p", artifact, empty: false }], dir);
      expect(costs).toHaveLength(1);
      expect(costs[0]).toMatchObject({ monthlyDelta: 1 });
    });

    test("priceRuns hands the command's environment to the exec, and the settings' names shape it", () => {
      const { dir, artifact } = planned(unmarked());
      let env: NodeJS.ProcessEnv | undefined;
      priceRuns({ command: ["price", "{planJson}"], format: "chant", redactEnv: ["TG_STORE_KEY"], dropEnv: ["TG_TOKEN"] }, [{ member: "a", artifact, empty: false }], dir, (_argv, _cwd, e) => {
        env = e;
        return { status: 0, stdout: '{"monthlyDelta": 2}', stderr: "" };
      });
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("TG_STORE_KEY");
      expect(env).not.toHaveProperty("TG_TOKEN");
      expect(env).not.toHaveProperty("TG_MERGE_TOKEN");
    });

    test("costEnv with names drops them and any variable holding their value, and keeps the rest", () => {
      const clean = costEnv({ PATH: "/bin", A: "secret-a-value", B: "secret-a-value", C: "c", D: "d" }, { redactEnv: ["A"], dropEnv: ["D"] });
      expect(clean).toEqual({ PATH: "/bin", C: "c" });
    });

    test("redactPlanJson takes the values of extra the plan does not mark", () => {
      const text = JSON.stringify(redactPlanJson(unmarked(), [STORE]));
      expect(text).not.toContain(STORE);
      expect(text).toContain(OWN_TOKEN);
    });

    test("the spec checks that the options are names", () => {
      expect(opWaveHoldsProblems({ cost: { command: ["x"], approveAbove: 1, redactEnv: ["TG_STORE_KEY"], dropEnv: ["TG_TOKEN", "TG_MERGE_TOKEN"] } })).toEqual([]);
      expect(opWaveHoldsProblems({ cost: { command: ["x"], approveAbove: 1, redactEnv: ["hunter2 is a value"] } })).toEqual(["`holds.cost.redactEnv` must be a list of environment variable names, never their values"]);
      expect(opWaveHoldsProblems({ cost: { command: ["x"], approveAbove: 1, dropEnv: "TG_TOKEN" } })).toEqual(["`holds.cost.dropEnv` must be a list of environment variable names, never their values"]);
    });
  });

  test("the floor is exported", () => {
    expect(COST_REDACTED_FLOOR).toBeTypeOf("string");
  });
});
