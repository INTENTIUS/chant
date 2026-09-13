import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldProject, foldExecutionCounts, resetFoldExecutionCounts } from "../index";

/**
 * chant#2455 — `ι = executing`, the third isolation mode (spec `1.8`).
 *
 * chant#2453 made the default strict: a declarator call to a declared project
 * function whose body cannot fold refuses the file rather than importing and
 * invoking it. That closed a real leak — the fold of a file reading
 * `process.env` carried the folding shell's environment, under a `fold`
 * verdict that read as "determined statically".
 *
 * The old behaviour is worth having when the caller means it, so it comes back
 * as a mode. What it cannot be is implicit. `open` is the default and is
 * strict; a build that wants what a run would compute has to ask, and the
 * asking is what makes the environment dependence visible.
 */
describe("the executing isolation mode (chant#2455)", () => {
  let root: string;
  let app: string;
  let params: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-executing-"));
    params = join(root, "params.ts");
    app = join(root, "app.ts");
    writeFileSync(
      params,
      'export function fromEnv() {\n  return { prefix: process.env.CHANT_TEST_MODE ?? "fallback" };\n}\n',
    );
    writeFileSync(app, 'import { fromEnv } from "./params";\nexport const v = fromEnv();\n');
    resetFoldExecutionCounts();
    process.env.CHANT_TEST_MODE = "from-the-environment";
  });

  afterEach(() => {
    delete process.env.CHANT_TEST_MODE;
    rmSync(root, { recursive: true, force: true });
  });

  test("the default refuses, and nothing of the project runs", async () => {
    const verdict = (await foldProject([app, params], [], {})).get(app)!;

    expect(verdict.verdict).toBe("run");
    expect(foldExecutionCounts().projectFactoryInvocations).toBe(0);
  });

  test("executing invokes it, and the fold carries what a run would compute", async () => {
    const verdict = (await foldProject([app, params], [], { executing: true })).get(app)!;

    expect(verdict.verdict).toBe("fold");
    expect(JSON.parse(JSON.stringify(Object.fromEntries(verdict.exports!)))).toEqual({
      v: { prefix: "from-the-environment" },
    });
    // The counter is how the mode is observable from outside: this is a
    // project-owned invocation, which is what F-Call step 6 counts.
    expect(foldExecutionCounts().projectFactoryInvocations).toBe(1);
  });

  test("the environment dependence is real, which is why the mode has to be asked for", async () => {
    process.env.CHANT_TEST_MODE = "one";
    const first = (await foldProject([app, params], [], { executing: true })).get(app)!;
    process.env.CHANT_TEST_MODE = "two";
    const second = (await foldProject([app, params], [], { executing: true })).get(app)!;

    // Under `executing` the same source folds to different values in different
    // environments. That is the mode behaving as specified, not a defect — and
    // it is exactly what must not happen by default.
    expect(JSON.stringify([...first.exports!])).not.toBe(JSON.stringify([...second.exports!]));
  });

  test("sandbox still refuses, and is unchanged by the new mode", async () => {
    const verdict = (await foldProject([app, params], [], { sandbox: true })).get(app)!;

    expect(verdict.verdict).toBe("run");
    expect(foldExecutionCounts().projectFactoryInvocations).toBe(0);
  });

  test("asking for both sandbox and executing is refused rather than resolved", async () => {
    // Not a preference between two readings — a contradiction. One refuses to
    // import project code, the other exists to invoke it, and silently picking
    // either would make the fold's meaning depend on which.
    await expect(foldProject([app, params], [], { sandbox: true, executing: true })).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  test("the default's reason names the mode that would have folded it", async () => {
    const reason = (await foldProject([app, params], [], {})).get(app)!.reason!;

    // The body's own diagnostic is kept — it is the actionable half, and here
    // it says to use a build parameter rather than reach for the new mode.
    expect(reason).toContain('ambient "process" read is not foldable');
    expect(reason).toContain("executing");
  });

  test("a function whose body folds is untouched by the mode", async () => {
    const helper = join(root, "helper.ts");
    writeFileSync(helper, 'export function j() {\n  return { j: ["a", "b"].join("-") };\n}\n');
    const caller = join(root, "caller.ts");
    writeFileSync(caller, 'import { j } from "./helper";\nexport const v = j();\n');

    for (const options of [{}, { executing: true }]) {
      resetFoldExecutionCounts();
      const verdict = (await foldProject([caller, helper], [], options)).get(caller)!;
      expect(verdict.verdict).toBe("fold");
      // Interpreted in both modes: `executing` is a fallback for a body that
      // did NOT fold, not a shortcut past interpretation.
      expect(foldExecutionCounts().projectFactoryInvocations).toBe(0);
    }
  });
});
