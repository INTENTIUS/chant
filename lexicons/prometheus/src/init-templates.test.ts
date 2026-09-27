import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { initTemplates } from "./init-templates";
import { prometheusSerializer } from "./serializer";
import { postSynthChecks } from "./lint/post-synth";
import { runPostSynthChecks } from "@intentius/chant/lint/post-synth";

describe("init templates", () => {
  test.each([undefined, "rules", "slo-style"])("%s builds, lints clean and passes every check", async (name) => {
    const dir = mkdtempSync(join(import.meta.dirname, "..", ".init-template-"));
    try {
      mkdirSync(join(dir, "src"));
      for (const [file, text] of Object.entries(initTemplates(name).src)) writeFileSync(join(dir, "src", file), text);
      const result = await build(join(dir, "src"), [prometheusSerializer]);
      expect(result.errors).toEqual([]);
      expect(result.outputs.get("prometheus")).toBeTruthy();
      const diags = runPostSynthChecks(postSynthChecks, result);
      expect(diags).toEqual([]);
      const lint = await lintCommand({ path: join(dir, "src"), format: "stylish", fix: false });
      expect(lint.errorCount + lint.warningCount, lint.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
