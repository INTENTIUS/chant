import { describe, test, expect, afterEach } from "vitest";
import { generateDriverSource } from "./driver";
import { setBuildParams } from "../../params";

/**
 * chant #1108 — the generated child driver must re-bind the parent's resolved
 * build-time parameters BEFORE importing any project file: the child process
 * starts with its own empty copy of ../../params.ts's `params` object, so
 * without this a run-fallback file reading `params.<name>` saw `undefined`
 * under `--sandbox` while the fold path (substituting in the parent) saw the
 * resolved value.
 */
describe("generateDriverSource — build-time parameters (#1108)", () => {
  afterEach(() => {
    setBuildParams({});
  });

  test("embeds a snapshot of the parent's current params, bound before any project import", () => {
    setBuildParams({ tier: "production-ha", replicas: 3, ha: true });
    const source = generateDriverSource({ files: ["/tmp/project/a.ts"], buildRoot: "/tmp/project" });

    expect(source).toContain("import { setBuildParams } from ");
    const bindAt = source.indexOf(`setBuildParams(${JSON.stringify({ tier: "production-ha", replicas: 3, ha: true })});`);
    const firstImportAt = source.indexOf(`await import("/tmp/project/a.ts")`);
    expect(bindAt).toBeGreaterThan(-1);
    expect(firstImportAt).toBeGreaterThan(-1);
    expect(bindAt).toBeLessThan(firstImportAt);
  });

  test("an unset optional parameter is absent from the snapshot, not carried as null (#1371)", () => {
    // The snapshot crosses into the child as JSON. JSON has no `undefined`,
    // so "unset" must be expressed by omitting the key — a `null` here would
    // bind `params.<name>` to a value in the child while the parent's fold
    // path reads `undefined`.
    setBuildParams({ tier: "light" });
    const source = generateDriverSource({ files: ["/tmp/project/a.ts"], buildRoot: "/tmp/project" });
    expect(source).toContain(`setBuildParams(${JSON.stringify({ tier: "light" })});`);
    expect(source).not.toContain("null");
  });

  test("with no params resolved, binds an empty snapshot (explicit, not absent)", () => {
    const source = generateDriverSource({ files: ["/tmp/project/a.ts"], buildRoot: "/tmp/project" });
    expect(source).toContain("setBuildParams({});");
  });
});
