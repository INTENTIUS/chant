/**
 * The `dogwood` CLI adapter (#1659).
 *
 * Every test here injects a runner. Nothing in the gating suite executes a
 * real binary — the epic's own rule ("nothing in gating CI executes the
 * dogwood binary"), and the reason the adapter takes a runner at all. The
 * JSON fixtures are upstream's two report shapes, read from the pinned
 * `dogwood-cli/src/ops.rs` and `dogwood-cli/src/error.rs` structs rather than
 * from the human text, which is the surface most likely to be retuned by a
 * sync.
 */
import { describe, test, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  DOGWOOD_BINARY_ENV,
  configureDogwoodCli,
  findDogwoodBinary,
  formatDogwoodDiagnostic,
  parseLowerOutput,
  parseReplayOutput,
  parseValidateOutput,
  resetDogwoodCli,
  runDogwoodLower,
  runDogwoodReplay,
  runDogwoodValidate,
  type DogwoodRun,
  type DogwoodRunner,
} from "./cli";

const TESTDATA = join(fileURLToPath(new URL(".", import.meta.url)), "testdata");

/**
 * A real `dogwood lower --format json` artifact set, adapted from
 * dogwood-policy/dogwood@5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c (Apache-2.0),
 * `dogwood-docs/examples/read_after_login`.
 */
const LOWERED_READ_AFTER_LOGIN: unknown = JSON.parse(
  readFileSync(join(TESTDATA, "lowered-read-after-login.json"), "utf-8"),
);

afterEach(() => {
  resetDogwoodCli();
  delete process.env[DOGWOOD_BINARY_ENV];
});

function run(over: Partial<DogwoodRun>): DogwoodRun {
  return { status: 0, stdout: "", stderr: "", ...over };
}

function json(value: unknown, status = 0): DogwoodRun {
  return run({ status, stdout: JSON.stringify(value) });
}

// ── The validate report shape ──────────────────────────────────────

describe("parseValidateOutput — the ValidateReport shape", () => {
  test("a clean report is a pass", () => {
    const result = parseValidateOutput(
      json({ passed: true, passed_without_warnings: true, errors: [], warnings: [] }),
    );
    expect(result).toEqual({ kind: "passed", warnings: [] });
  });

  test("warnings do not fail the report, and are carried through", () => {
    const result = parseValidateOutput(
      json({
        passed: true,
        passed_without_warnings: false,
        errors: [],
        warnings: [{ severity: "warning", message: "policy is impossible", spanned: false }],
      }),
    );
    expect(result.kind).toBe("passed");
    if (result.kind !== "passed") return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toBe("policy is impossible");
  });

  test("a rejection carries every finding, with its code, help and byte spans", () => {
    const result = parseValidateOutput(
      json(
        {
          passed: false,
          passed_without_warnings: false,
          errors: [
            {
              severity: "error",
              code: "extension",
              message:
                'predicate `Drupe::Action::"NoSuchAction"::request` does not name a declared event',
              labels: [{ start: 120, len: 42, message: "here" }],
              spanned: true,
            },
            {
              severity: "error",
              code: "cedar",
              message: "attribute `input.nosuchfield` in context for Drupe::Action::\"Read\" not found",
              labels: [],
              help: "did you mean `user`?",
              spanned: false,
            },
          ],
          warnings: [],
        },
        2,
      ),
    );
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].code).toBe("extension");
    expect(result.errors[0].labels).toEqual([{ start: 120, len: 42, message: "here" }]);
    expect(result.errors[1].help).toBe("did you mean `user`?");
  });

  test("the report wins over the exit code — passed:false at exit 0 is still a rejection", () => {
    const result = parseValidateOutput(
      json({
        passed: false,
        passed_without_warnings: false,
        errors: [{ severity: "error", message: "nope", spanned: false }],
        warnings: [],
      }),
    );
    expect(result.kind).toBe("rejected");
  });

  test("and in the other direction — a clean report at a non-zero exit is still a pass", () => {
    const result = parseValidateOutput(
      json({ passed: true, passed_without_warnings: true, errors: [], warnings: [] }, 2),
    );
    expect(result.kind).toBe("passed");
  });
});

// ── The fatal OpError shape ────────────────────────────────────────

describe("parseValidateOutput — the OpError shape", () => {
  test("a fatal parse error is its own arm, not an entry in errors[]", () => {
    const result = parseValidateOutput(
      json(
        {
          severity: "error",
          message: "expected `within` after `formerly`",
          labels: [{ start: 64, len: 8 }],
          spanned: true,
          related: [{ severity: "error", message: "and a second parse error", spanned: false }],
        },
        2,
      ),
    );
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") return;
    expect(result.error.message).toBe("expected `within` after `formerly`");
    expect(result.error.labels).toEqual([{ start: 64, len: 8 }]);
    expect(result.related).toHaveLength(1);
  });

  test("a span-less fatal (the OpError::message path) still parses", () => {
    const result = parseValidateOutput(
      json({ severity: "error", message: "rhai implementation has no script", spanned: false }, 2),
    );
    expect(result.kind).toBe("fatal");
  });

  test("an internal `at line N column M` tail is not passed through", () => {
    const result = parseValidateOutput(
      json({ severity: "error", message: "missing field `policies` at line 1 column 42", spanned: false }, 2),
    );
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") return;
    expect(result.error.message).toBe("missing field `policies`");
  });
});

// ── The exit-2 ambiguity ───────────────────────────────────────────

describe("parseValidateOutput — exit 2 is not a verdict", () => {
  test("an unknown flag exits 2 with nothing on stdout, and is unusable rather than rejected", () => {
    // clap's own usage error. The published guide claims exit 1 for a bad
    // flag; the binary spends 2 on it, the same code a rejected policy set
    // gets. Reading the code alone would fail the build over a flag rename.
    const result = parseValidateOutput(
      run({
        status: 2,
        stdout: "",
        stderr: "error: unexpected argument '--nosuchflag' found\n\nUsage: dogwood validate <POLICIES> --policy-schema <FILE>",
      }),
    );
    expect(result.kind).toBe("unusable");
    if (result.kind !== "unusable") return;
    expect(result.reason).toContain("without a JSON report on stdout");
    expect(result.reason).toContain("--nosuchflag");
  });

  test("a spawn failure is unusable, not a verdict", () => {
    const result = parseValidateOutput(run({ status: null, error: "spawnSync dogwood ENOENT" }));
    expect(result.kind).toBe("unusable");
    if (result.kind !== "unusable") return;
    expect(result.reason).toContain("ENOENT");
  });

  test("output that is not JSON at all is unusable", () => {
    const result = parseValidateOutput(run({ status: 0, stdout: "OK: validation passed with no errors." }));
    expect(result.kind).toBe("unusable");
  });

  test("JSON in neither shape is unusable", () => {
    const result = parseValidateOutput(json({ something: "else" }, 2));
    expect(result.kind).toBe("unusable");
    if (result.kind !== "unusable") return;
    expect(result.reason).toContain("neither the report nor the error shape");
  });
});

// ── Rendering ──────────────────────────────────────────────────────

describe("formatDogwoodDiagnostic", () => {
  test("renders code, message, help and byte ranges on one line", () => {
    const text = formatDogwoodDiagnostic({
      severity: "error",
      code: "extension",
      message: "temporal window `48h` exceeds the maximum allowed window `24h`",
      labels: [{ start: 100, len: 20, message: "this window" }],
      help: "raise max_window",
      spanned: true,
    });
    expect(text).toBe(
      "[extension] temporal window `48h` exceeds the maximum allowed window `24h` (raise max_window) at bytes 100-120: this window",
    );
  });

  test("a span-less finding renders as just its message", () => {
    expect(formatDogwoodDiagnostic({ severity: "error", message: "bare", labels: [], spanned: false })).toBe(
      "bare",
    );
  });
});

// ── lower ──────────────────────────────────────────────────────────

describe("parseLowerOutput", () => {
  test("reads the artifact shape, including the JSON schema as a string", () => {
    const result = parseLowerOutput(run({ status: 0, stdout: JSON.stringify(LOWERED_READ_AFTER_LOGIN) }));
    expect(result.kind).toBe("lowered");
    if (result.kind !== "lowered") return;
    expect(result.value.cedarPolicies).toContain("context.policy_0__temporal_0");
    expect(result.value.temporalFields).toEqual(["policy_0__temporal_0"]);
    // False because a temporal field was hoisted — the lowered Cedar needs
    // dogwood at authorize time to fill the slot.
    expect(result.value.selfContained).toBe(false);
    expect(JSON.parse(result.value.cedarSchemaJson)).toHaveProperty("Drupe");
  });

  test("a failed lower comes back through the fatal channel", () => {
    const result = parseLowerOutput(
      json({ severity: "error", message: "unknown macro `once`", labels: [], spanned: false }, 2),
    );
    expect(result.kind).toBe("fatal");
  });
});

// ── replay ─────────────────────────────────────────────────────────

describe("parseReplayOutput", () => {
  /** The stream #1657 recorded for `read_after_login`, exit 0. */
  const RECORDED = {
    verdicts: [
      { index: 0, timestamp: 0, verdict: "deny", determining_rules: [], errors: [] },
      { index: 1, timestamp: 10, verdict: "allow", determining_rules: [0], errors: [] },
      { index: 2, timestamp: 7200, verdict: "deny", determining_rules: [], errors: [] },
    ],
  };

  test("reads the verdict stream, rules included", () => {
    const result = parseReplayOutput(json(RECORDED));
    expect(result.kind).toBe("replayed");
    if (result.kind !== "replayed") return;
    expect(result.verdicts).toHaveLength(3);
    expect(result.verdicts[1]).toEqual({
      index: 1,
      timestamp: 10,
      verdict: "allow",
      determiningRules: [0],
      errors: [],
    });
  });

  test("every verdict DENY at exit 0 is a result, not a failure", () => {
    // The sharpest edge in the replay contract: a nonzero exit means the trace
    // or the policy set failed to load, never that a policy denied.
    const allDeny = { verdicts: RECORDED.verdicts.map((v) => ({ ...v, verdict: "deny" })) };
    const result = parseReplayOutput(json(allDeny));
    expect(result.kind).toBe("replayed");
  });

  test("an unrecognised verdict reads as a deny rather than being dropped", () => {
    // Dropping it would shift every later index; treating it as a permit would
    // be a permission upstream never granted.
    const result = parseReplayOutput(json({ verdicts: [{ index: 0, timestamp: 0, verdict: "maybe" }] }));
    expect(result.kind).toBe("replayed");
    if (result.kind !== "replayed") return;
    expect(result.verdicts[0].verdict).toBe("deny");
  });

  test("a malformed trace line comes back through the fatal channel", () => {
    const result = parseReplayOutput(
      json({ severity: "error", message: "trace parse: line 1: timepoint must start with `@`", spanned: false }, 2),
    );
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") return;
    expect(result.error.message).toMatch(/timepoint must start with/);
  });

  test("no JSON at all is unusable, never a verdict", () => {
    const result = parseReplayOutput(run({ status: 2, stderr: "error: unexpected argument '--nope'" }));
    expect(result.kind).toBe("unusable");
  });

  test("per-evaluation errors are carried through in either shape", () => {
    const result = parseReplayOutput(
      json({
        verdicts: [
          { index: 0, timestamp: 0, verdict: "deny", determining_rules: [], errors: ["no script"] },
          {
            index: 1,
            timestamp: 1,
            verdict: "deny",
            determining_rules: [],
            errors: [{ message: "provider failed at line 1 column 4" }],
          },
        ],
      }),
    );
    expect(result.kind).toBe("replayed");
    if (result.kind !== "replayed") return;
    expect(result.verdicts[0].errors).toEqual(["no script"]);
    // The internal position is scrubbed for the same reason as everywhere else.
    expect(result.verdicts[1].errors).toEqual(["provider failed"]);
  });
});

describe("runDogwoodReplay", () => {
  test("passes the trace as --trace beside the bundle, and asks for JSON", () => {
    let seen: { args: string[]; trace: string } | undefined;
    const runner: DogwoodRunner = (_binary, args) => {
      const at = args.indexOf("--trace");
      seen = { args, trace: readFileSync(args[at + 1], "utf-8") };
      return run({ status: 0, stdout: JSON.stringify({ verdicts: [] }) });
    };
    configureDogwoodCli({ runner });

    const result = runDogwoodReplay("/bin/dogwood", { policies: "p", policySchema: "s" }, "@0 A::Action::\"B\"::request()");
    expect(result.kind).toBe("replayed");
    expect(seen?.args[0]).toBe("replay");
    expect(seen?.args.slice(-2)).toEqual(["--format", "json"]);
    expect(seen?.trace).toBe('@0 A::Action::"B"::request()');
  });

  test("the scratch directory, trace included, does not outlive the run", () => {
    let tracePath = "";
    const runner: DogwoodRunner = (_binary, args) => {
      tracePath = args[args.indexOf("--trace") + 1];
      return run({ status: 0, stdout: JSON.stringify({ verdicts: [] }) });
    };
    configureDogwoodCli({ runner });
    runDogwoodReplay("/bin/dogwood", { policies: "p", policySchema: "s" }, "@0 A::Action::\"B\"::request()");
    expect(existsSync(tracePath)).toBe(false);
  });

  test("a throwing runner is an unusable run, not an exception", () => {
    configureDogwoodCli({
      runner: () => {
        throw new Error("spawn blew up");
      },
    });
    const result = runDogwoodReplay("/bin/dogwood", { policies: "p", policySchema: "s" }, "@0 x");
    expect(result.kind).toBe("unusable");
  });
});

// ── Invocation ─────────────────────────────────────────────────────

describe("the invocation itself", () => {
  test("materializes the bundle and passes every schema half by path", () => {
    let seen: { args: string[]; files: Record<string, string> } | undefined;
    const runner: DogwoodRunner = (_binary, args) => {
      const files: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        const value = args[i];
        if (value.startsWith("/") || value.includes("chant-dogwood-")) {
          try {
            files[value.replace(/^.*\//, "")] = readFileSync(value, "utf-8");
          } catch {
            // not a path we wrote
          }
        }
      }
      seen = { args, files };
      return json({ passed: true, passed_without_warnings: true, errors: [], warnings: [] });
    };
    configureDogwoodCli({ runner });

    const result = runDogwoodValidate("/opt/dogwood", {
      policies: "permit (principal, action, resource);",
      policySchema: "namespace Ns {}",
      eventSchema: "decision event <A>::request {}",
      macros: "def temporal once(?w, ?s) { formerly within ?w ?s };",
    });

    expect(result.kind).toBe("passed");
    expect(seen?.args[0]).toBe("validate");
    expect(seen?.args).toContain("--policy-schema");
    expect(seen?.args).toContain("--event-schema");
    expect(seen?.args).toContain("--macros");
    expect(seen?.args.slice(-2)).toEqual(["--format", "json"]);
    expect(seen?.files["policies.dw"]).toBe("permit (principal, action, resource);");
    expect(seen?.files["events.dwschema"]).toBe("decision event <A>::request {}");
  });

  test("omits the service-schema flags a bundle does not carry", () => {
    let args: string[] = [];
    configureDogwoodCli({
      runner: (_b, a) => {
        args = a;
        return json({ passed: true, passed_without_warnings: true, errors: [], warnings: [] });
      },
    });
    runDogwoodValidate("dogwood", { policies: "// none", policySchema: "namespace Ns {}" });
    expect(args).not.toContain("--event-schema");
    expect(args).not.toContain("--macros");
    expect(args).not.toContain("--providers");
  });

  test("never passes --emit, which the CLI ignores under --format json", () => {
    let args: string[] = [];
    configureDogwoodCli({
      runner: (_b, a) => {
        args = a;
        return run({ status: 0, stdout: JSON.stringify(LOWERED_READ_AFTER_LOGIN) });
      },
    });
    runDogwoodLower("dogwood", { policies: "// none", policySchema: "namespace Ns {}" });
    expect(args[0]).toBe("lower");
    expect(args).not.toContain("--emit");
  });

  test("a throwing runner is an unusable result, not an exception", () => {
    configureDogwoodCli({
      runner: () => {
        throw new Error("boom");
      },
    });
    const result = runDogwoodValidate("dogwood", { policies: "", policySchema: "" });
    expect(result.kind).toBe("unusable");
  });
});

// ── Locating the binary ────────────────────────────────────────────

describe("findDogwoodBinary", () => {
  test("an explicit override wins and is reported as such", () => {
    configureDogwoodCli({ binary: "/opt/dogwood/bin/dogwood" });
    expect(findDogwoodBinary()).toEqual({ path: "/opt/dogwood/bin/dogwood", source: "override" });
  });

  test("a null override forces absence, so a machine that has one still tests the advisory", () => {
    configureDogwoodCli({ binary: null });
    expect(findDogwoodBinary()).toBeUndefined();
  });

  test("the environment variable is honoured when it names something executable", () => {
    // `process.execPath` is a real executable on every platform the suite runs
    // on, and standing in for the binary here costs nothing — resolution is an
    // access check, not a run.
    process.env[DOGWOOD_BINARY_ENV] = process.execPath;
    expect(findDogwoodBinary()).toEqual({ path: process.execPath, source: "env" });
  });

  test("an environment variable pointing at nothing resolves past it", () => {
    process.env[DOGWOOD_BINARY_ENV] = "/nonexistent/dogwood";
    const found = findDogwoodBinary();
    expect(found?.source).not.toBe("env");
  });

  test("cedar.dogwood.binary in a chant.config.json is read, walking up from the start directory", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-dogwood-config-"));
    try {
      writeFileSync(
        join(root, "chant.config.json"),
        JSON.stringify({ cedar: { dogwood: { binary: process.execPath } } }),
      );
      const nested = join(root, "src", "stack");
      mkdirSync(nested, { recursive: true });
      expect(findDogwoodBinary(nested)).toEqual({ path: process.execPath, source: "config" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unparseable chant.config.json is walked past rather than thrown from", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-dogwood-config-"));
    try {
      writeFileSync(join(root, "chant.config.json"), "{ not json");
      expect(() => findDogwoodBinary(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
