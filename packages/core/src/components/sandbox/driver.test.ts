import { describe, test, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { generateComponentDriverSource } from "./driver";
import { setBuildParams } from "../../params";

/**
 * chant #1108 — same re-binding the entity driver does (../../discovery/
 * sandbox/driver.test.ts): a `*.component.ts` file imported in the sandboxed
 * child must see the parent's resolved build-time parameters, not `{}`.
 */
describe("generateComponentDriverSource — build-time parameters (#1108)", () => {
  afterEach(() => {
    setBuildParams({});
  });

  test("embeds a snapshot of the parent's current params, bound before any component import", () => {
    setBuildParams({ stage: "prod" });
    const source = generateComponentDriverSource({ files: ["proj/svc.component.ts"] });

    expect(source).toContain("import { setBuildParams } from ");
    const bindAt = source.indexOf(`setBuildParams(${JSON.stringify({ stage: "prod" })});`);
    const firstImportAt = source.indexOf(`await import(${JSON.stringify(resolve("proj/svc.component.ts"))})`);
    expect(bindAt).toBeGreaterThan(-1);
    expect(firstImportAt).toBeGreaterThan(-1);
    expect(bindAt).toBeLessThan(firstImportAt);
  });
});
