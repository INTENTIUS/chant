import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldProject } from "../index";
import type { IntrinsicDef } from "../lexicon";

/**
 * chant#2441 — `F-Div-Depth` is a refusal, and a refusal must not be
 * papered over by invoking instead.
 *
 * `divergence.md`'s L3.16 says a `new`, tagged template, helper call,
 * intrinsic call or `.step` is not foldable inside a folded function body.
 * `fold()` has always guarded this, and the guard fires: `callFoldableFunction`
 * raises `functionBodyDepth` and `insideFunctionBody` throws.
 *
 * What went wrong was downstream. `resolveCallExpression` catches a fold
 * failure on an imported callee and falls back to importing and invoking it —
 * right when the body merely did not fold, wrong here, because the folder has
 * DECLINED and invoking produces the envelope the fixture's own note warns
 * about: a value the file's own declarators never produced.
 *
 * That direction is the whole point. Every other `F-Div` row is a fallback and
 * `divergence.md` says so outright, which is what makes the direction safe.
 * This one was not: chant produced a value where the specification says it must
 * decline, the one outcome the fold path exists never to have.
 */
describe("a refusal at depth is not rescued by invoking (chant#2441)", () => {
  let root: string;
  const ref: IntrinsicDef = { name: "ref", lexicon: "shapes", foldsAsCall: true } as unknown as IntrinsicDef;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-div-depth-"));
    const pkg = join(root, "node_modules", "@tsad", "shapes");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@tsad/shapes", version: "0.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), 'export function ref(x) { return { Ref: x }; }\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (name: string, source: string): string => {
    const p = join(root, name);
    writeFileSync(p, source);
    return p;
  };

  test("an intrinsic call inside a project-local function refuses, rather than folding to a revived envelope", async () => {
    const fn = write("fn.ts", 'import { ref } from "@tsad/shapes";\nexport function r() { return ref("x"); }\n');
    const app = write("app.ts", 'import { r } from "./fn";\nexport const v = r();\n');

    const verdicts = await foldProject([app, fn], [ref], { lexiconPackages: ["@tsad/shapes"] });

    // Before the fix this was `fold` with v = {"Ref":"x"} — the host's `ref`
    // actually invoked, its result revived, and the envelope surfacing in a
    // file whose own declarators never produced one.
    expect(verdicts.get(app)!.verdict).toBe("run");
    expect(verdicts.get(app)!.reason).toMatch(/inside a folded function body is not foldable/);
  });

  test("the reason names the callee and the position inside it, not just the call site", async () => {
    const fn = write("fn.ts", 'import { ref } from "@tsad/shapes";\nexport function r() { return ref("x"); }\n');
    const app = write("app.ts", 'import { r } from "./fn";\nexport const v = r();\n');

    const reason = (await foldProject([app, fn], [ref], { lexiconPackages: ["@tsad/shapes"] })).get(app)!.reason!;

    // The point of the re-anchoring in `callFoldableFunction`: the `[fold:run]`
    // line says which function to fix and where, not merely that this call
    // failed.
    expect(reason).toContain('call to "r"');
    expect(reason).toContain("fn.ts");
    expect(reason).toContain("intrinsic call `ref(...)`");
  });

  test("the same intrinsic call at the top level still folds, so the guard is about depth and nothing else", async () => {
    // The refusal must not spread to the direct case, which is the ordinary way
    // an intrinsic reaches a declarator and is exactly what should keep working.
    const app = write("app.ts", 'import { ref } from "@tsad/shapes";\nexport const v = ref("x");\n');

    const verdict = (await foldProject([app], [ref], { lexiconPackages: ["@tsad/shapes"] })).get(app)!;

    expect(verdict.verdict).toBe("fold");
    expect(JSON.parse(JSON.stringify(Object.fromEntries(verdict.exports!)))).toEqual({ v: { Ref: "x" } });
  });

  test("an ordinary fold failure in an imported callee still falls back to invoking it", async () => {
    // The fallback that #2441 narrowed is otherwise load-bearing: a helper whose
    // body simply does not fold keeps folding by invocation, as it did before.
    // Narrowing it to depth refusals only is the whole of the change.
    const fn = write(
      "fn.ts",
      'export function r() {\n  const parts = ["a", "b"];\n  return { joined: parts.join("-") };\n}\n',
    );
    const app = write("app.ts", 'import { r } from "./fn";\nexport const v = r();\n');

    const verdict = (await foldProject([app, fn], [], {})).get(app)!;

    expect(verdict.verdict).toBe("fold");
    expect(JSON.parse(JSON.stringify(Object.fromEntries(verdict.exports!)))).toEqual({ v: { joined: "a-b" } });
  });
});
