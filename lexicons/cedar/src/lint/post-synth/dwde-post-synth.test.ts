/**
 * The CLI-gated DWDE checks (#1659).
 *
 * Every case injects a runner, and the absent-binary case forces absence
 * rather than hoping the machine has none — a developer with `dogwood` built
 * locally must see the same result as CI. The one test that touches a real
 * binary is opt-in and skipped by default; nothing in gating depends on it.
 *
 * The lowered fixture is adapted from
 * dogwood-policy/dogwood@5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c (Apache-2.0),
 * `dogwood-docs/examples/read_after_login` — the same bundle the #1657
 * verification put through this exact path.
 */
import { describe, test, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { postSynthChecks } from "./index";
import { dwde010 } from "./dwde010";
import { dwde011 } from "./dwde011";
import { looksLikeMacroLibrary, planDogwoodRuns } from "./dogwood-helpers";
import { cedarAuditCatalog } from "../audit-catalog";
import { configureDogwoodCli, findDogwoodBinary, resetDogwoodCli, type DogwoodRun } from "../../dogwood/cli";

const TESTDATA = join(fileURLToPath(new URL("../..", import.meta.url)), "dogwood/testdata");

const POLICIES = readFileSync(join(TESTDATA, "read-after-login.dw"), "utf-8");
const ACTION_SCHEMA = readFileSync(join(TESTDATA, "read-after-login.cedarschema"), "utf-8");
const EVENT_SCHEMA = readFileSync(join(TESTDATA, "pinned.dwschema"), "utf-8");
const MACROS = readFileSync(join(TESTDATA, "default-macros.dw"), "utf-8");
const LOWERED = JSON.parse(readFileSync(join(TESTDATA, "lowered-read-after-login.json"), "utf-8")) as Record<
  string,
  unknown
>;

afterEach(() => resetDogwoodCli());

function ctxOf(files: Record<string, string>): PostSynthContext {
  const output: SerializerResult = { primary: "", files };
  const outputs = new Map<string, string | SerializerResult>([["cedar", output]]);
  return {
    outputs,
    entities: new Map(),
    buildResult: { outputs, entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

/** The shape a real build emits: policies, action schema, event schema, macros. */
function fullBuild(): PostSynthContext {
  return ctxOf({
    "policies.dw": POLICIES,
    "macros.dw": MACROS,
    "app.cedarschema": ACTION_SCHEMA,
    "events.dwschema": EVENT_SCHEMA,
  });
}

function run(over: Partial<DogwoodRun>): DogwoodRun {
  return { status: 0, stdout: "", stderr: "", ...over };
}

const PASSING = run({
  status: 0,
  stdout: JSON.stringify({ passed: true, passed_without_warnings: true, errors: [], warnings: [] }),
});

/** Answer `validate` one way and `lower` another, from the subcommand argv[0]. */
function bySubcommand(answers: Record<string, DogwoodRun>) {
  return (_binary: string, args: string[]): DogwoodRun => answers[args[0]] ?? run({ status: 0, stdout: "" });
}

// ── The planner ────────────────────────────────────────────────────

describe("planning what to run", () => {
  test("a macro library is told from a policy set by structure, not by filename", () => {
    expect(looksLikeMacroLibrary(MACROS)).toBe(true);
    expect(looksLikeMacroLibrary(POLICIES)).toBe(false);
    // A library under a non-default filename is still a library.
    expect(looksLikeMacroLibrary("def temporal once(?w, ?s) { formerly within ?w ?s };")).toBe(true);
  });

  test("one bundle per policy set, with the macro libraries folded into one --macros file", () => {
    const plan = planDogwoodRuns(fullBuild());
    expect(plan.hasPolicies).toBe(true);
    expect(plan.bundles).toHaveLength(1);
    const [only] = plan.bundles;
    expect(only.source).toBe("policies.dw");
    expect(only.policySchemaSource).toBe("app.cedarschema");
    expect(only.eventSchemaSource).toBe("events.dwschema");
    expect(only.bundle.macros).toContain("def temporal");
  });

  test("several event schemas mean several runs, each naming its own schema", () => {
    const ctx = ctxOf({
      "policies.dw": POLICIES,
      "app.cedarschema": ACTION_SCHEMA,
      "events.dwschema": EVENT_SCHEMA,
      "gateway.dwschema": EVENT_SCHEMA,
    });
    const plan = planDogwoodRuns(ctx);
    expect(plan.bundles.map((b) => b.eventSchemaSource)).toEqual(["events.dwschema", "gateway.dwschema"]);
  });

  test("no .dw policy set means nothing to plan, even with a schema emitted", () => {
    expect(planDogwoodRuns(ctxOf({ "events.dwschema": EVENT_SCHEMA })).hasPolicies).toBe(false);
    expect(planDogwoodRuns(ctxOf({ "macros.dw": MACROS })).hasPolicies).toBe(false);
  });

  test("policies with no action schema are blocked, because --policy-schema is not optional", () => {
    const plan = planDogwoodRuns(ctxOf({ "policies.dw": POLICIES }));
    expect(plan.hasPolicies).toBe(true);
    expect(plan.bundles).toEqual([]);
    expect(plan.blocked).toContain("--policy-schema");
  });
});

// ── DWDE010 ────────────────────────────────────────────────────────

describe("DWDE010 — full .dw validation, when the binary is there", () => {
  test("a passing validate is silent", () => {
    configureDogwoodCli({ binary: "/opt/dogwood", runner: () => PASSING });
    expect(dwde010.check(fullBuild())).toEqual([]);
  });

  test("a rejection becomes one error per finding, with the code and the byte span", () => {
    const rejected = run({
      status: 2,
      stdout: JSON.stringify({
        passed: false,
        passed_without_warnings: false,
        errors: [
          {
            severity: "error",
            code: "extension",
            message:
              'predicate `Drupe::Action::"NoSuchAction"::request` does not name a declared event (no event kind `request` derived for action `NoSuchAction`)',
            labels: [{ start: 210, len: 46 }],
            spanned: true,
          },
        ],
        warnings: [],
      }),
    });
    configureDogwoodCli({ binary: "/opt/dogwood", runner: () => rejected });

    const [finding, ...rest] = dwde010.check(fullBuild());
    expect(rest).toEqual([]);
    expect(finding.severity).toBe("error");
    expect(finding.checkId).toBe("DWDE010");
    expect(finding.message).toContain("[extension]");
    expect(finding.message).toContain("bytes 210-256");
    expect(finding.message).toContain('"policies.dw"');
    expect(finding.message).toContain('against "app.cedarschema"');
    expect(finding.entity).toBe("policies.dw");
  });

  test("a fatal parse error comes through the other JSON shape and is still an error", () => {
    const fatal = run({
      status: 2,
      stdout: JSON.stringify({
        severity: "error",
        message: "unknown macro `once`",
        labels: [{ start: 12, len: 4 }],
        spanned: true,
        related: [{ severity: "error", message: "a second parse error", spanned: false }],
      }),
    });
    configureDogwoodCli({ binary: "/opt/dogwood", runner: () => fatal });

    const findings = dwde010.check(fullBuild());
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === "error")).toBe(true);
    expect(findings[0].message).toContain("could not be parsed or lowered");
    expect(findings[0].message).toContain("unknown macro `once`");
  });

  test("upstream's warnings ride along at warning severity and do not fail the build", () => {
    const warned = run({
      status: 0,
      stdout: JSON.stringify({
        passed: true,
        passed_without_warnings: false,
        errors: [],
        warnings: [{ severity: "warning", message: "policy is impossible", labels: [], spanned: false }],
      }),
    });
    configureDogwoodCli({ binary: "/opt/dogwood", runner: () => warned });

    const [finding] = dwde010.check(fullBuild());
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("policy is impossible");
  });

  test("the exit-2 ambiguity is a warning about the run, never an error about the policy", () => {
    // An unknown flag and a rejected policy set share exit 2. Reading the code
    // alone would turn a flag rename in an upstream sync into a failed build.
    const usage = run({
      status: 2,
      stdout: "",
      stderr: "error: unexpected argument '--nosuchflag' found",
    });
    configureDogwoodCli({ binary: "/opt/dogwood", runner: () => usage });

    const [finding, ...rest] = dwde010.check(fullBuild());
    expect(rest).toEqual([]);
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("neither accepted nor rejected");
  });

  test("no binary is exactly one info advisory naming the binary and the issue", () => {
    configureDogwoodCli({ binary: null });
    const [finding, ...rest] = dwde010.check(fullBuild());
    expect(rest).toEqual([]);
    expect(finding.severity).toBe("info");
    expect(finding.message).toContain("dogwood");
    expect(finding.message).toContain("chant #1659");
    expect(finding.message).toContain("CHANT_DOGWOOD_BINARY");
    expect(finding.lexicon).toBe("cedar");
  });

  test("the advisory does not fire on a build with no .dw output at all", () => {
    configureDogwoodCli({ binary: null });
    expect(dwde010.check(ctxOf({ "policies.cedar.json": "{}" }))).toEqual([]);
  });

  test("a binary with nothing to validate against says so rather than passing quietly", () => {
    configureDogwoodCli({ binary: "/opt/dogwood", runner: () => PASSING });
    const [finding] = dwde010.check(ctxOf({ "policies.dw": POLICIES }));
    expect(finding.severity).toBe("info");
    expect(finding.message).toContain("--policy-schema");
  });
});

// ── DWDE011 ────────────────────────────────────────────────────────

describe("DWDE011 — the lowered Cedar through Cedar's own validator", () => {
  test("the lowered read_after_login bundle validates clean end to end", () => {
    configureDogwoodCli({
      binary: "/opt/dogwood",
      runner: bySubcommand({
        validate: PASSING,
        lower: run({ status: 0, stdout: JSON.stringify(LOWERED) }),
      }),
    });
    expect(dwde011.check(fullBuild())).toEqual([]);
  });

  test("a lowered body naming a slot the augmented schema lacks fails Cedar validation", () => {
    // The same artifacts with the policy pointed at a context field the
    // augmented schema never grew — what a lowering/schema mismatch looks like
    // from Cedar's side.
    const drifted = {
      ...LOWERED,
      cedar_policies: (LOWERED.cedar_policies as string).replace(
        "policy_0__temporal_0",
        "policy_9__temporal_9",
      ),
    };
    configureDogwoodCli({
      binary: "/opt/dogwood",
      runner: bySubcommand({ validate: PASSING, lower: run({ status: 0, stdout: JSON.stringify(drifted) }) }),
    });

    const findings = dwde011.check(fullBuild());
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].checkId).toBe("DWDE011");
    expect(findings[0].message).toContain("fails Cedar validation");
    expect(findings[0].entity).toBe("policies.dw");
  });

  test("findings are sorted, so a build's output does not shuffle between runs", () => {
    const twoBad = {
      ...LOWERED,
      cedar_policies: `permit (principal, action == Drupe::Action::"Read", resource) when { context.zzz };\npermit (principal, action == Drupe::Action::"Read", resource) when { context.aaa };\n`,
    };
    configureDogwoodCli({
      binary: "/opt/dogwood",
      runner: bySubcommand({ validate: PASSING, lower: run({ status: 0, stdout: JSON.stringify(twoBad) }) }),
    });

    const messages = dwde011.check(fullBuild()).map((f) => f.message);
    expect(messages).toEqual([...messages].sort());
  });

  test("silent when the binary is absent — DWDE010's advisory covers that once", () => {
    configureDogwoodCli({ binary: null });
    expect(dwde011.check(fullBuild())).toEqual([]);
  });

  test("silent when no action schema was emitted, for the same reason", () => {
    configureDogwoodCli({ binary: "/opt/dogwood", runner: () => PASSING });
    expect(dwde011.check(ctxOf({ "policies.dw": POLICIES }))).toEqual([]);
  });

  test("a fatal lower stays quiet — the validate leg owns the parse/lower channel", () => {
    configureDogwoodCli({
      binary: "/opt/dogwood",
      runner: bySubcommand({
        validate: PASSING,
        lower: run({
          status: 2,
          stdout: JSON.stringify({ severity: "error", message: "unknown macro `once`", spanned: false }),
        }),
      }),
    });
    expect(dwde011.check(fullBuild())).toEqual([]);
  });

  test("a lower that could not be run is a warning about the run", () => {
    configureDogwoodCli({
      binary: "/opt/dogwood",
      runner: bySubcommand({ validate: PASSING, lower: run({ status: 2, stdout: "", stderr: "usage" }) }),
    });
    const [finding] = dwde011.check(fullBuild());
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("not checked by Cedar's validator");
  });
});

// ── Registration ───────────────────────────────────────────────────

describe("registration", () => {
  test("both checks reach the committed barrel", () => {
    const ids = postSynthChecks.map((c) => c.id);
    expect(ids).toContain("DWDE010");
    expect(ids).toContain("DWDE011");
  });

  test("both are catalogued, so `chant audit` can title them", () => {
    for (const id of ["DWDE010", "DWDE011"]) {
      const meta = cedarAuditCatalog[id];
      expect(meta, `${id} is catalogued`).toBeDefined();
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.remediation.length).toBeGreaterThan(0);
    }
  });

  test("the helper module contributes no check of its own", () => {
    // `dogwood-helpers.ts` is excluded from discovery by the "helper" filename
    // filter, the same way `wasm-helpers.ts` is.
    expect(postSynthChecks.filter((c) => c.id.startsWith("DWD"))).toHaveLength(6);
  });
});

// ── Opt-in: a real binary ──────────────────────────────────────────

/**
 * Runs only when `CHANT_DOGWOOD_E2E=1` *and* a binary resolves. Never gates:
 * the epic's rule is that nothing in gating CI executes the dogwood binary,
 * and this exists so someone who has built one can confirm the adapter reads
 * the real thing the way the fixtures say it does.
 */
const haveRealBinary = process.env.CHANT_DOGWOOD_E2E === "1" && findDogwoodBinary() !== undefined;

describe.skipIf(!haveRealBinary)("against a real dogwood binary (opt-in)", () => {
  test("the upstream read_after_login bundle validates clean", () => {
    resetDogwoodCli();
    expect(dwde010.check(fullBuild())).toEqual([]);
  });

  test("and its lowered Cedar validates clean through cedar-wasm", () => {
    resetDogwoodCli();
    expect(dwde011.check(fullBuild())).toEqual([]);
  });
});
