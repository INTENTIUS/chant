/**
 * LSP completions tests (#2088). Root-name completion needs a reachable
 * `chant.config.*`, so those cases write one to a temp directory rather than
 * mocking `./context` — the point of the feature is reading a real file.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CompletionContext } from "@intentius/chant/lsp/types";
import { completions } from "./completions";

function ctx(overrides: Partial<CompletionContext>): CompletionContext {
  return {
    uri: "untitled:Untitled-1",
    content: "",
    position: { line: 0, character: 0 },
    wordAtCursor: "",
    linePrefix: "",
    ...overrides,
  };
}

describe("LSP completions", () => {
  it("returns an array for an empty context", () => {
    expect(Array.isArray(completions(ctx({})))).toBe(true);
  });

  it("completes root names inside a builder's positional root argument, from a reachable config", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      writeFileSync(
        join(dir, "chant.config.ts"),
        `export default { terraform: { roots: { app: { dir: "./terraform" }, db: { dir: "./db" } } } };`,
      );
      const uri = pathToFileURL(join(dir, "infra.op.ts")).toString();
      const linePrefix = 'terraformPlan("';
      const items = completions(ctx({ uri, linePrefix }));
      expect(items.map((i) => i.label).sort()).toEqual(["app", "db"]);
      expect(items[0].kind).toBe("value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("completes root names inside a named `root:` field", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      writeFileSync(join(dir, "chant.config.ts"), `export default { terraform: { roots: { app: { dir: "./tf" } } } };`);
      const uri = pathToFileURL(join(dir, "infra.op.ts")).toString();
      const items = completions(ctx({ uri, linePrefix: '  root: "a' }));
      expect(items.map((i) => i.label)).toEqual(["app"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters root names by the prefix already typed", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      writeFileSync(
        join(dir, "chant.config.ts"),
        `export default { terraform: { roots: { app: { dir: "./a" }, api: { dir: "./b" }, db: { dir: "./c" } } } };`,
      );
      const uri = pathToFileURL(join(dir, "infra.op.ts")).toString();
      const items = completions(ctx({ uri, linePrefix: 'terraformApply("ap' }));
      expect(items.map((i) => i.label).sort()).toEqual(["api", "app"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offers no root names when no chant.config.* is reachable, rather than fabricating any", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      const uri = pathToFileURL(join(dir, "infra.op.ts")).toString();
      const items = completions(ctx({ uri, linePrefix: 'terraformPlan("' }));
      expect(items).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("completes TerraformApplyOp's own config keys inside its argument object", () => {
    const content = 'export const { op } = TerraformApplyOp({\n  name: "app-apply",\n  ';
    const items = completions(
      ctx({ content, position: { line: 2, character: 2 }, uri: "untitled:Untitled-1" }),
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("gate");
    expect(labels).toContain("compensate");
    expect(labels).toContain("gateTimeout");
    expect(labels).not.toContain("taskQueue");
  });

  it("completes a builder's own opts keys inside its second argument", () => {
    const content = 'terraformPlan("app", {\n  ';
    const items = completions(ctx({ content, position: { line: 1, character: 2 } }));
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["planFile", "destroy", "cwd", "id"]));
  });

  it("completes root-entry keys inside chant.config.ts's terraform.roots.<name>", () => {
    const content = "export default {\n  terraform: {\n    roots: {\n      app: {\n        ";
    const items = completions(ctx({ content, position: { line: 4, character: 8 } }));
    expect(items.map((i) => i.label).sort()).toEqual(["backendConfig", "delete", "dir", "varFiles", "workspace"]);
  });

  it("completes the terraform namespace's own top-level keys", () => {
    const content = "export default {\n  terraform: {\n    ";
    const items = completions(ctx({ content, position: { line: 1, character: 4 } }));
    expect(items.map((i) => i.label).sort()).toEqual(["binary", "roots"]);
  });

  it("completes compensate's own key", () => {
    const content = 'TerraformApplyOp({\n  compensate: {\n    ';
    const items = completions(ctx({ content, position: { line: 2, character: 4 } }));
    expect(items.map((i) => i.label)).toEqual(["command"]);
  });
});
