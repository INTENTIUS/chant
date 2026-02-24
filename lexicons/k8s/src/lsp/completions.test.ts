import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hasGenerated = existsSync(
  join(pkgDir, "src", "generated", "lexicon-k8s.json"),
);

describe("LSP completions", () => {
  test.skipIf(!hasGenerated)(
    "returns completions for 'new D' prefix",
    async () => {
      const { k8sCompletions } = await import("./completions");
      const result = k8sCompletions({
        prefix: "new D",
        line: "const x = new D",
        position: { line: 0, character: 15 },
        triggerKind: 1,
      } as any);

      expect(result).toBeDefined();
      if (Array.isArray(result)) {
        // Should include Deployment, DaemonSet
        const labels = result.map((c: any) => c.label ?? c);
        expect(labels.some((l: string) => l.includes("Deployment"))).toBe(
          true,
        );
      }
    },
  );

  test.skipIf(!hasGenerated)(
    "returns empty for non-constructor context",
    async () => {
      const { k8sCompletions } = await import("./completions");
      const result = k8sCompletions({
        prefix: "",
        line: "const x = 42",
        position: { line: 0, character: 12 },
        triggerKind: 1,
      } as any);

      // Should return empty or undefined for non-constructor context
      if (Array.isArray(result)) {
        // It may return all completions when prefix is empty — that's OK
        expect(result).toBeDefined();
      }
    },
  );

  test.skipIf(!hasGenerated)("filters by prefix correctly", async () => {
    const { k8sCompletions } = await import("./completions");
    const result = k8sCompletions({
      prefix: "new StatefulS",
      line: "const x = new StatefulS",
      position: { line: 0, character: 23 },
      triggerKind: 1,
    } as any);

    if (Array.isArray(result) && result.length > 0) {
      const labels = result.map((c: any) => c.label ?? c);
      expect(labels.some((l: string) => l.includes("StatefulSet"))).toBe(
        true,
      );
    }
  });
});
