import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldProject, foldExecutionCounts, resetFoldExecutionCounts } from "../index";

/**
 * chant#2453 — a declared function is judged by its body, never invoked.
 *
 * `resolveCallExpression` used to catch a fold failure on an imported callee
 * and fall back to importing and invoking it. chant#2441 stopped that rescuing
 * a depth refusal. The external corpus then showed what the rest of it did, in
 * a project nobody here maintains (jhgaylor/infisical-chant, via
 * INTENTIUS/typescript-as-data#129):
 *
 *     export const namingParams = namingParamsFromEnv();
 *
 * whose body reads `process.env`. `F-Eval-Ident` step 4 rejects `process`, so
 * the body does not fold — and chant imported the module and ran it, folding
 * the file to whatever the FOLDING PROCESS's environment held.
 *
 * The reason this is a correctness bug and not only a conformance divergence:
 * the file reported `fold`, which reads as "determined statically". Two people
 * folding the same source got different output, and nothing said so. `--fold`
 * is the value you would get by running, without running. This ran.
 */
describe("a declared function is folded or refused, never invoked (chant#2453)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-no-invoke-"));
    resetFoldExecutionCounts();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (name: string, source: string): string => {
    const p = join(root, name);
    writeFileSync(p, source);
    return p;
  };

  test("an ambient read inside an imported function refuses, rather than folding the shell's environment in", async () => {
    const params = write(
      "params.ts",
      'export function namingParamsFromEnv() {\n  return { prefix: process.env.CHANT_TEST_PREFIX ?? "fallback" };\n}\n',
    );
    const app = write(
      "app.ts",
      'import { namingParamsFromEnv } from "./params";\nexport const namingParams = namingParamsFromEnv();\n',
    );

    process.env.CHANT_TEST_PREFIX = "leaked-from-the-test-runner";
    try {
      const verdict = (await foldProject([app, params], [], {})).get(app)!;

      // Before the fix this was `fold` with prefix "leaked-from-the-test-runner".
      expect(verdict.verdict).toBe("run");
      expect(verdict.reason).toContain("namingParamsFromEnv");

      // The counter is the direct evidence: nothing of the project was run.
      expect(foldExecutionCounts().projectFactoryInvocations).toBe(0);
    } finally {
      delete process.env.CHANT_TEST_PREFIX;
    }
  });

  test("the folded output never depends on the environment, which is the property at stake", async () => {
    const params = write(
      "params.ts",
      'export function fromEnv() {\n  return { v: process.env.CHANT_TEST_SWING ?? "d" };\n}\n',
    );
    const app = write("app.ts", 'import { fromEnv } from "./params";\nexport const c = fromEnv();\n');

    // Fold the same source twice under different environments. Before the fix
    // these disagreed, which is the part no reader of a `fold` verdict could
    // have known.
    process.env.CHANT_TEST_SWING = "one";
    const first = (await foldProject([app, params], [], {})).get(app)!;
    process.env.CHANT_TEST_SWING = "two";
    const second = (await foldProject([app, params], [], {})).get(app)!;
    delete process.env.CHANT_TEST_SWING;

    expect(first.verdict).toBe(second.verdict);
    expect(first.verdict).toBe("run");
  });

  test("a function whose body does fold still folds, so this narrows nothing it should not", async () => {
    const helper = write(
      "helper.ts",
      'export function joined() {\n  const parts = ["a", "b"];\n  return { joined: parts.join("-") };\n}\n',
    );
    const app = write("app.ts", 'import { joined } from "./helper";\nexport const v = joined();\n');

    const verdict = (await foldProject([app, helper], [], {})).get(app)!;

    expect(verdict.verdict).toBe("fold");
    expect(JSON.parse(JSON.stringify(Object.fromEntries(verdict.exports!)))).toEqual({
      v: { joined: "a-b" },
    });
    // Folded by interpretation, not by running it.
    expect(foldExecutionCounts().projectFactoryInvocations).toBe(0);
  });

  test("a same-file callee behaves the same as an imported one", async () => {
    // Before the fix these two differed for no reason a reader could defend: a
    // same-file callee had nothing to import, so its rejection was the verdict,
    // while the identical function one file over got invoked instead.
    const app = write(
      "app.ts",
      'function fromEnv() {\n  return { v: process.env.CHANT_TEST_SAME ?? "d" };\n}\nexport const c = fromEnv();\n',
    );

    const verdict = (await foldProject([app], [], {})).get(app)!;

    expect(verdict.verdict).toBe("run");
  });
});
