/**
 * Generated-output compile-smoke (#162).
 *
 * Type-checks the serializer's emitted workflow.ts / worker.ts / activities.ts
 * against the REAL activity signatures and the @temporalio types. The runtime
 * harness (runtime.test.ts) proves the emitted control flow runs; this proves
 * the emitted code still type-checks — so an activity signature change that the
 * serializer or its callers don't track is caught as a compile error rather
 * than drifting silently.
 *
 * Each op is serialized into a temp project laid out exactly as `chant build`
 * writes it (chant.config.ts at the root, files under ops/<name>/), then run
 * through the TypeScript compiler API. Expectation: zero diagnostics.
 */
import { describe, test, expect, afterAll } from "vitest";
import ts from "typescript";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeOps } from "./serializer";
import { ApplyOp } from "../composites/apply-op";
import { ReconcileOp } from "../composites/reconcile-op";
import type { Declarable } from "@intentius/chant/declarable";

const ROOT = fileURLToPath(new URL("./__compile__", import.meta.url));

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// Minimal chant.config.ts so the generated worker's `../../chant.config.js`
// import resolves. The worker reads it dynamically, so the shape only needs to
// type-check.
const CHANT_CONFIG = `import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";
// Annotated (not \`satisfies\`) so \`profiles\` keeps its Record type and the
// generated worker can index it by a runtime profile name.
const temporal: TemporalChantConfig = {
  profiles: { local: { address: "localhost:7233", namespace: "default", taskQueue: "tq" } },
  defaultProfile: "local",
};
export default { temporal };
`;

/** Serialize `ops` into a temp project and return any type diagnostics. */
function compileGenerated(label: string, ops: Map<string, Declarable>): string[] {
  const projectDir = join(ROOT, label);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "chant.config.ts"), CHANT_CONFIG);

  const files = serializeOps(ops);
  const targets: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(projectDir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content as string);
    targets.push(abs);
  }

  const program = ts.createProgram(targets, {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    // Bundler resolution mirrors how chant resolves its `.js`-suffixed ESM
    // imports back to the `.ts` sources (the same model tsx uses at runtime).
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    types: [],
  });

  // Only assert on diagnostics in the GENERATED files. The program transitively
  // pulls in chant + @temporalio source; their diagnostics aren't what this test
  // is about (they're checked by their own builds).
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && d.file.fileName.startsWith(projectDir))
    .map((d) => {
      const where = d.file!.fileName.split("/").slice(-2).join("/");
      return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
}

function opMap(...resources: Array<{ op: unknown }>): Map<string, Declarable> {
  const m = new Map<string, Declarable>();
  for (const r of resources) {
    const op = r.op as Declarable & { props?: { name?: string } };
    m.set(op.props?.name ?? String(m.size), op);
  }
  return m;
}

describe("generated output compile-smoke (#162)", () => {
  test("ApplyOp output (build → plan → gate → apply, onFailure rollback) type-checks", () => {
    const diags = compileGenerated(
      "apply",
      opMap(ApplyOp({ name: "prod-apply", env: "prod", target: "cloudformation", delete: "gated" })),
    );
    expect(diags).toEqual([]);
  });

  test("ReconcileOp output (snapshot → plan → reconcile PR) type-checks", () => {
    const diags = compileGenerated(
      "reconcile",
      opMap(ReconcileOp({ name: "prod-reconcile", env: "prod", scope: { owned: true } })),
    );
    expect(diags).toEqual([]);
  });

  test("workflow.ts calls activities with their declared argument types", () => {
    // A hand-built Op that passes a WRONG arg shape must surface as a type
    // error — guards the smoke itself against false greens.
    const bad: Map<string, Declarable> = new Map([
      ["bad", {
        props: {
          name: "bad", overview: "o", taskQueue: "bad",
          phases: [{ name: "P", steps: [{ kind: "activity", fn: "chantBuild", args: { nope: 1 } }] }],
        },
      } as unknown as Declarable],
    ]);
    const diags = compileGenerated("bad", bad);
    expect(diags.some((d) => d.includes("workflow.ts"))).toBe(true);
  });
});
