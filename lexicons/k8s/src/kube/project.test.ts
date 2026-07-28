/**
 * `loadKubeProjectContext` exercised for real (chant #1079) — real
 * `chant.config.ts` discovery, a real `build()`, and real `getProvenance()`
 * results. Every verb test elsewhere injects a fake `KubeProjectContext`
 * (`./testing.ts`); this file is what proves the real implementation these
 * tests are all standing in for actually resolves a project and its
 * provenance, and — the specific thing chant #1079 asks for — genuinely
 * returns `undefined` outside one rather than treating an arbitrary
 * directory as a chant project rooted right there.
 */
import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadKubeProjectContext, findDeclaredMatch, relativeProvenance } from "./project";

const GETTING_STARTED = resolve(import.meta.dirname, "../../../../examples/getting-started");

describe("loadKubeProjectContext (chant #1079)", () => {
  test("outside a chant project (no chant.config.ts anywhere): undefined, and fast — no build is attempted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-kube-no-project-"));
    try {
      const ctx = await loadKubeProjectContext(dir);
      expect(ctx).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a real project: builds, resolves a declared entity, and its provenance names the source file (relative to the project root)", async () => {
    const ctx = await loadKubeProjectContext(GETTING_STARTED);
    expect(ctx).toBeDefined();
    if (!ctx) return;

    const deploymentEntry = [...ctx.entities].find(([, e]) => e.entityType === "K8s::Apps::Deployment");
    expect(deploymentEntry).toBeDefined();
    const [entityName, entity] = deploymentEntry!;

    const props = (entity as { props: { metadata?: { name?: string; namespace?: string } } }).props;
    const match = findDeclaredMatch(ctx.entities, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: props.metadata!.name!,
      namespace: props.metadata?.namespace,
    });
    expect(match?.entityName).toBe(entityName);

    // Entity-level provenance (chant #1064): the declaring file, relativized
    // to the project root. This fixture re-exports the composite's own
    // members individually (`export const deployment = web.deployment`)
    // rather than exporting the composite call itself, so `composite` isn't
    // stamped here — `./describe.test.ts` and `./source.test.ts` cover that
    // field directly against a fake entity that does carry it.
    const prov = relativeProvenance(ctx, entity);
    expect(prov?.sourceFile).toBe("src/web.ts");
  });
});
