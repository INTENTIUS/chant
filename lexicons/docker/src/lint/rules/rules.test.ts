import { describe, test, expect } from "vitest";
import { noLatestTagRule } from "./no-latest-tag";
import { perKindOrderRule } from "./per-kind-order";
import { dockerSerializer } from "../../serializer";
import { Dockerfile } from "../../generated/index";
import type { Declarable } from "@intentius/chant/declarable";
import type { LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

function makeContext(code: string): LintContext {
  const sourceFile = ts.createSourceFile(
    "test.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return {
    sourceFile,
    entities: [],
    filePath: "test.ts",
    lexicon: "docker",
  };
}

// ── DKRS001: no-latest-tag ────────────────────────────────────────

describe("DKRS001: no-latest-tag", () => {
  test("has correct id and severity", () => {
    expect(noLatestTagRule.id).toBe("DKRS001");
    expect(noLatestTagRule.severity).toBe("warning");
    expect(noLatestTagRule.category).toBe("correctness");
  });

  test("flags :latest tag", () => {
    const ctx = makeContext(`
      import { Service } from "@intentius/chant-lexicon-docker";
      export const api = new Service({ image: "nginx:latest" });
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].ruleId).toBe("DKRS001");
    expect(diags[0].message).toContain("nginx:latest");
  });

  test("flags untagged image (no colon)", () => {
    const ctx = makeContext(`
      const svc = { image: "nginx" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain("nginx");
  });

  test("does not flag explicitly versioned image", () => {
    const ctx = makeContext(`
      const svc = { image: "nginx:1.25-alpine" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag digest-pinned image", () => {
    const ctx = makeContext(`
      const svc = { image: "nginx@sha256:abc123" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag env() interpolation", () => {
    const ctx = makeContext(`
      const svc = { image: "\${APP_IMAGE:-myapp:latest}" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-image string properties", () => {
    const ctx = makeContext(`
      const svc = { restart: "latest" };
    `);
    const diags = noLatestTagRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── DKRS002: per-kind fields in a different order ─────────────────

/** Apply a rule's fixes the way `chant lint --fix` does: last range first. */
function applyFixes(code: string, fixes: Array<{ range: [number, number]; replacement: string }>): string {
  for (const f of [...fixes].sort((a, b) => b.range[0] - a.range[0])) {
    code = code.slice(0, f.range[0]) + f.replacement + code.slice(f.range[1]);
  }
  return code;
}

/** Run a module's `export const x = new Dockerfile(...)` and serialize what it declares. */
function build(code: string): string {
  const body = code.replace(/^\s*import .*$/m, "").replace(/export const (\w+) =/g, "out.$1 =");
  const out: Record<string, Declarable> = {};
  new Function("Dockerfile", "out", body)(Dockerfile, out);
  const result = dockerSerializer.serialize(new Map(Object.entries(out))) as { files: Record<string, string> };
  return Object.values(result.files).join("---\n");
}

describe("DKRS002: per-kind-order", () => {
  const reordered = `import { Dockerfile } from "@intentius/chant-lexicon-docker";
export const app = new Dockerfile({
  stages: [
    {
      from: "node:20-alpine",
      as: "build",
      workdir: "/app",
      copy: ["package*.json ./", ". ."],
      run: ["npm ci", "npm run build"],
    },
    {
      from: "node:20-alpine",
      workdir: "/app",
      user: "node",
      cmd: "node dist/index.js",
    },
  ],
});
`;

  test("flags a stage whose fields read in a different order than they are written", () => {
    const diags = perKindOrderRule.check(makeContext(reordered));
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("DKRS002");
    expect(diags[0].line).toBe(7);
    expect(diags[0].message).toContain("declared as workdir, copy, run are written in the fixed order workdir, run, copy");
  });

  test("flags USER declared after RUN, on a single-stage Dockerfile", () => {
    const diags = perKindOrderRule.check(makeContext(`new Dockerfile({ from: "debian:12", run: ["useradd app"], user: "app" });`));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("run, user");
  });

  test("does not flag fields already in the fixed order, steps, or other objects", () => {
    expect(perKindOrderRule.check(makeContext(`new Dockerfile({ from: "a:1", workdir: "/app", user: "node", run: ["x"], copy: [". ."], cmd: "y" });`))).toHaveLength(0);
    expect(perKindOrderRule.check(makeContext(`new Dockerfile({ from: "a:1", steps: [{ copy: ". ." }, { run: "x" }] });`))).toHaveLength(0);
    expect(perKindOrderRule.check(makeContext(`const o = { copy: ["a"], run: ["b"] };`))).toHaveLength(0);
  });

  test("the fix rewrites the fields as steps and the output does not change", () => {
    const fixes = perKindOrderRule.fix!(makeContext(reordered));
    expect(fixes).toHaveLength(1);
    const fixed = applyFixes(reordered, fixes);
    expect(fixed).toContain(`      // Written by the DKRS002 fix`);
    expect(fixed).toContain(`      steps: [
        { workdir: "/app" },
        { run: "npm ci" },
        { run: "npm run build" },
        { copy: "package*.json ./" },
        { copy: ". ." },
      ],
    },`);
    expect(build(fixed)).toBe(build(reordered));
    expect(perKindOrderRule.check(makeContext(fixed))).toHaveLength(0);
  });

  test("no fix when a list value can't be split into steps", () => {
    const diags = perKindOrderRule.check(makeContext(`new Dockerfile({ from: "a:1", copy: files, run: ["x"] });`));
    expect(diags).toHaveLength(1);
    expect(diags[0].fix).toBeUndefined();
  });
});
