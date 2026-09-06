/**
 * Tests for the shared LSP context helpers (#2088): parsing `terraform.roots`
 * out of a `chant.config.ts`/`.json`'s raw text (never executing it), and the
 * call/field detectors `completions.ts` uses to place the cursor.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  contentUpToCursor,
  enclosingCallName,
  enclosingKeyPath,
  innermostObjectKey,
  parseTerraformRoots,
  resolveRootsForUri,
} from "./context";

describe("parseTerraformRoots (.ts)", () => {
  it("extracts dir, workspace and varFiles per root", () => {
    const text = `
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

export default {
  lexicons: ["terraform"],
  terraform: {
    binary: "tofu",
    roots: {
      app: { dir: "./terraform/app", workspace: "prod", varFiles: ["prod.tfvars", "shared.tfvars"] },
      db: {
        dir: "./terraform/db",
      },
    },
  },
} satisfies ChantConfig;
`;
    const roots = parseTerraformRoots(text, "ts");
    expect(roots).toEqual({
      app: { dir: "./terraform/app", workspace: "prod", varFiles: ["prod.tfvars", "shared.tfvars"] },
      db: { dir: "./terraform/db", workspace: undefined, varFiles: undefined },
    });
  });

  it("returns undefined when the config declares no terraform namespace", () => {
    expect(parseTerraformRoots(`export default { lexicons: ["k3s"] };`, "ts")).toBeUndefined();
  });

  it("returns undefined when terraform.roots is empty", () => {
    expect(parseTerraformRoots(`export default { terraform: { roots: {} } };`, "ts")).toBeUndefined();
  });
});

describe("parseTerraformRoots (.json)", () => {
  it("reads a plain object, no brace-matching needed", () => {
    const json = JSON.stringify({ terraform: { roots: { app: { dir: "./tf" } } } });
    expect(parseTerraformRoots(json, "json")).toEqual({
      app: { dir: "./tf", workspace: undefined, varFiles: undefined },
    });
  });

  it("returns undefined for invalid JSON rather than throwing", () => {
    expect(parseTerraformRoots("{ not json", "json")).toBeUndefined();
  });
});

describe("resolveRootsForUri", () => {
  it("walks up from the document's directory to the nearest chant.config.ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      writeFileSync(
        join(dir, "chant.config.ts"),
        `export default { terraform: { roots: { app: { dir: "./tf" } } } };`,
      );
      const nested = join(dir, "src");
      const uri = pathToFileURL(join(nested, "infra.op.ts")).toString();
      expect(resolveRootsForUri(uri)).toEqual({ app: { dir: "./tf", workspace: undefined, varFiles: undefined } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a non-file:// uri", () => {
    expect(resolveRootsForUri("untitled:Untitled-1")).toBeUndefined();
  });

  it("returns undefined when no chant.config.* is reachable", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-terraform-lsp-"));
    try {
      const uri = pathToFileURL(join(dir, "infra.op.ts")).toString();
      expect(resolveRootsForUri(uri)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("enclosingCallName", () => {
  it("finds the call whose sole argument object holds the cursor", () => {
    const text = 'export const { op } = TerraformApplyOp({\n  name: "x",\n  ';
    expect(enclosingCallName(text)).toBe("TerraformApplyOp");
  });

  it("finds the call when the object is a later positional argument", () => {
    const text = 'terraformPlan("app", {\n  ';
    expect(enclosingCallName(text)).toBe("terraformPlan");
  });

  it("returns undefined outside any call", () => {
    expect(enclosingCallName("const x = {\n  ")).toBeUndefined();
  });

  it("returns undefined when the cursor is not inside an object literal at all", () => {
    expect(enclosingCallName("terraformPlan(")).toBeUndefined();
  });
});

describe("enclosingKeyPath", () => {
  it("names the chain of enclosing object keys", () => {
    const text = "export default {\n  terraform: {\n    roots: {\n      app: {\n        ";
    expect(enclosingKeyPath(text)).toEqual(["terraform", "roots", "app"]);
  });

  it("returns undefined once a call sits in the chain", () => {
    const text = "foo({\n  bar: {\n    ";
    expect(enclosingKeyPath(text)).toBeUndefined();
  });

  it("contributes nothing for the top-level object literal, which no key precedes", () => {
    const text = "export default {\n  ";
    expect(enclosingKeyPath(text)).toEqual([]);
  });
});

describe("innermostObjectKey", () => {
  it("names the immediate enclosing key even when a call sits further out", () => {
    const text = "TerraformApplyOp({\n  compensate: {\n    ";
    expect(innermostObjectKey(text)).toBe("compensate");
  });

  it("returns undefined when the cursor is not inside any object literal", () => {
    expect(innermostObjectKey("terraformPlan(")).toBeUndefined();
  });
});

describe("contentUpToCursor", () => {
  it("joins every line through the cursor's own line", () => {
    expect(contentUpToCursor("a\nb\nc", 1)).toBe("a\nb");
  });
});
