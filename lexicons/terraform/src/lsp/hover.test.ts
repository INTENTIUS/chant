/**
 * LSP hover tests (#2088). Root hover needs a reachable `chant.config.*`,
 * same as completions — written to a temp directory rather than mocked.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HoverContext } from "@intentius/chant/lsp/types";
import { hover } from "./hover";

function ctx(overrides: Partial<HoverContext>): HoverContext {
  return {
    uri: "untitled:Untitled-1",
    content: "",
    position: { line: 0, character: 0 },
    word: "",
    lineText: "",
    ...overrides,
  };
}

describe("LSP hover", () => {
  it("returns undefined for an empty context", () => {
    expect(hover(ctx({}))).toBeUndefined();
  });

  it("shows a root's dir/workspace/varFiles when the word is quoted next to a known root", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      writeFileSync(
        join(dir, "chant.config.ts"),
        `export default { terraform: { roots: { app: { dir: "./terraform/app", workspace: "prod", varFiles: ["prod.tfvars"] } } } };`,
      );
      const uri = pathToFileURL(join(dir, "infra.op.ts")).toString();
      const info = hover(ctx({ uri, word: "app", lineText: 'terraformPlan("app")' }));
      expect(info?.contents).toContain("app");
      expect(info?.contents).toContain("./terraform/app");
      expect(info?.contents).toContain("prod");
      expect(info?.contents).toContain("prod.tfvars");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat a bare identifier as a root reference, even if it matches a root name", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      writeFileSync(join(dir, "chant.config.ts"), `export default { terraform: { roots: { app: { dir: "./tf" } } } };`);
      const uri = pathToFileURL(join(dir, "infra.op.ts")).toString();
      const info = hover(ctx({ uri, word: "app", lineText: "const app = 1;" }));
      expect(info).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a quoted word that names no declared root", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      writeFileSync(join(dir, "chant.config.ts"), `export default { terraform: { roots: { app: { dir: "./tf" } } } };`);
      const uri = pathToFileURL(join(dir, "infra.op.ts")).toString();
      const info = hover(ctx({ uri, word: "ghost", lineText: 'terraformPlan("ghost")' }));
      expect(info).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("documents a known option key even with no reachable config", () => {
    const info = hover(ctx({ word: "gate", lineText: '  gate: "always",' }));
    expect(info?.contents).toContain("gate");
    expect(info?.contents).toContain("on-destroy");
  });

  it("returns undefined for a word that is neither a reachable root nor a known option key", () => {
    const info = hover(ctx({ word: "somethingElse", lineText: "somethingElse" }));
    expect(info).toBeUndefined();
  });
});
