/**
 * Engine detection (chant#4559): the member's config, plywood.yml,
 * PULUMI_BACKEND_URL, Pulumi.yaml, in that order.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pulumiMemberEngine, readPlywoodEngine } from "./member-engine";

/** A repo root (with `.git`) holding `infra/`, so the plywood.yml search stops inside the temp dir. */
function repo(files: { plywood?: string; pulumi?: string } = {}): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "member-engine-"));
  mkdirSync(join(root, ".git"));
  const dir = join(root, "infra");
  mkdirSync(dir);
  if (files.plywood !== undefined) writeFileSync(join(root, "plywood.yml"), files.plywood);
  if (files.pulumi !== undefined) writeFileSync(join(dir, "Pulumi.yaml"), files.pulumi);
  return { root, dir };
}

const PLUNGE_YAML = "name: site\nruntime: nodejs\nbackend:\n  url: plunge+file:///var/lib/plunge/site\n";
const STOCK_YAML = "name: site\nruntime: nodejs\n";

describe("pulumiMemberEngine", () => {
  test("nothing names plunge: pulumi, source default", () => {
    const { dir } = repo({ pulumi: STOCK_YAML });
    expect(pulumiMemberEngine(dir, undefined, { env: {} })).toEqual({ engine: "pulumi", because: "nothing names plunge", source: "default" });
  });

  test("Pulumi.yaml backend.url with a plunge scheme", () => {
    const { dir } = repo({ pulumi: PLUNGE_YAML });
    const got = pulumiMemberEngine(dir, undefined, { env: {} });
    expect(got.engine).toBe("plunge");
    expect(got.source).toBe("Pulumi.yaml");
  });

  test("PULUMI_BACKEND_URL with a plunge+ URL means plunge when Pulumi.yaml names no backend", () => {
    const { dir } = repo({ pulumi: STOCK_YAML });
    const got = pulumiMemberEngine(dir, undefined, { env: { PULUMI_BACKEND_URL: "plunge+s3://bucket/state" } });
    expect(got).toEqual({
      engine: "plunge",
      because: "PULUMI_BACKEND_URL names the plunge backend plunge+s3://bucket/state",
      source: "PULUMI_BACKEND_URL",
    });
  });

  test("a stock PULUMI_BACKEND_URL does not mean plunge", () => {
    const { dir } = repo({ pulumi: STOCK_YAML });
    expect(pulumiMemberEngine(dir, undefined, { env: { PULUMI_BACKEND_URL: "file:///tmp/state" } }).engine).toBe("pulumi");
    expect(pulumiMemberEngine(dir, undefined, { env: { PULUMI_BACKEND_URL: "s3://bucket" } }).engine).toBe("pulumi");
  });

  test("PULUMI_BACKEND_URL beats Pulumi.yaml", () => {
    const { dir } = repo({ pulumi: PLUNGE_YAML });
    const got = pulumiMemberEngine(dir, undefined, { env: { PULUMI_BACKEND_URL: "plunge://host/x" } });
    expect(got.source).toBe("PULUMI_BACKEND_URL");
  });

  test("plywood.yml engine: plunge, found in a parent of the member directory", () => {
    const { dir, root } = repo({ plywood: "engine: plunge\nstacks:\n  shop/dev: { dir: infra }\n", pulumi: STOCK_YAML });
    const got = pulumiMemberEngine(dir, undefined, { env: {} });
    expect(got.engine).toBe("plunge");
    expect(got.source).toBe("plywood.yml");
    expect(got.because).toBe(`${join(root, "plywood.yml")} says engine: plunge`);
  });

  test("plywood.yml engine: pulumi beats a plunge PULUMI_BACKEND_URL and Pulumi.yaml", () => {
    const { dir } = repo({ plywood: "engine: pulumi\n", pulumi: PLUNGE_YAML });
    const got = pulumiMemberEngine(dir, undefined, { env: { PULUMI_BACKEND_URL: "plunge+file:///x" } });
    expect(got.engine).toBe("pulumi");
    expect(got.source).toBe("plywood.yml");
  });

  test("plywood.yml without engine but with a plunge+ backend means plunge", () => {
    const { dir } = repo({ plywood: "backend: plunge+s3://bucket/state\n" });
    const got = pulumiMemberEngine(dir, undefined, { env: {} });
    expect(got.engine).toBe("plunge");
    expect(got.source).toBe("plywood.yml");
  });

  test("plywood.yml with neither key falls through to the environment", () => {
    const { dir } = repo({ plywood: "gate: always\n" });
    expect(pulumiMemberEngine(dir, undefined, { env: { PULUMI_BACKEND_URL: "plunge+file:///x" } }).source).toBe("PULUMI_BACKEND_URL");
  });

  test("the member's config beats everything", () => {
    const { dir } = repo({ plywood: "engine: plunge\n", pulumi: PLUNGE_YAML });
    const got = pulumiMemberEngine(dir, "pulumi", { env: { PULUMI_BACKEND_URL: "plunge+file:///x" } });
    expect(got).toEqual({ engine: "pulumi", because: "the member's config says engine: pulumi", source: "member-config" });
  });

  test("an unreadable plywood.yml names no engine", () => {
    const { dir } = repo({ plywood: "engine: [unclosed\n", pulumi: STOCK_YAML });
    expect(pulumiMemberEngine(dir, undefined, { env: {} }).engine).toBe("pulumi");
  });

  test("the search stops at the repository root", () => {
    const outer = mkdtempSync(join(tmpdir(), "member-engine-outer-"));
    writeFileSync(join(outer, "plywood.yml"), "engine: plunge\n");
    const root = join(outer, "repo");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "infra"));
    expect(pulumiMemberEngine(join(root, "infra"), undefined, { env: {} }).engine).toBe("pulumi");
  });

  test("plywoodRoot bounds the search", () => {
    const { dir, root } = repo({ plywood: "engine: plunge\n" });
    expect(readPlywoodEngine(dir, dir)).toBeUndefined();
    expect(readPlywoodEngine(dir, root)?.engine).toBe("plunge");
  });
});
