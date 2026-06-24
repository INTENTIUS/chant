import { describe, test, expect } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { env, unknownEnvError, ENV_VAR } from "./env";
import { discover } from "./discovery/index";

const withEnv = async (value: string | undefined, fn: () => void | Promise<void>): Promise<void> => {
  const prev = process.env[ENV_VAR];
  try {
    if (value === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = value;
    await fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
};

describe("env()", () => {
  test("reads CHANT_ENV, with a fallback", async () => {
    await withEnv(undefined, () => {
      expect(env()).toBeUndefined();
      expect(env("dev")).toBe("dev");
    });
    await withEnv("prod", () => {
      expect(env()).toBe("prod");
      expect(env("dev")).toBe("prod");
    });
  });
});

describe("unknownEnvError", () => {
  test("accepts a declared env, and any env when none are declared", () => {
    expect(unknownEnvError("prod", ["dev", "prod"])).toBeUndefined();
    expect(unknownEnvError("prod", undefined)).toBeUndefined();
    expect(unknownEnvError("prod", [])).toBeUndefined();
    expect(unknownEnvError(undefined, ["dev"])).toBeUndefined();
  });
  test("rejects an undeclared env with a clear message", () => {
    expect(unknownEnvError("stage", ["dev", "prod"])).toMatch(/Unknown environment "stage".*dev, prod/);
  });
});

describe("env-aware discovery (#505)", () => {
  // Env is a build-context switch: the same source, discovered under a different
  // CHANT_ENV, yields a different entity set (here a prod-only resource).
  const src = `
    export const base = { entityType: "Base", [Symbol.for("chant.declarable")]: true };
    export const prodOnly = process.env.CHANT_ENV === "prod"
      ? { entityType: "ProdOnly", [Symbol.for("chant.declarable")]: true }
      : undefined;
  `;

  test("re-evaluates the project under the active environment", async () => {
    // Distinct dirs → distinct module URLs → fresh import per env (import() caches by path).
    const prodDir = join(tmpdir(), `chant-env-prod-${Date.now()}-${Math.random()}`);
    const devDir = join(tmpdir(), `chant-env-dev-${Date.now()}-${Math.random()}`);
    await mkdir(prodDir, { recursive: true });
    await mkdir(devDir, { recursive: true });
    await writeFile(join(prodDir, "app.ts"), src);
    await writeFile(join(devDir, "app.ts"), src);
    try {
      let prod!: Awaited<ReturnType<typeof discover>>;
      let dev!: Awaited<ReturnType<typeof discover>>;
      await withEnv("prod", async () => { prod = await discover(prodDir); });
      await withEnv("dev", async () => { dev = await discover(devDir); });
      expect(prod.entities.has("base")).toBe(true);
      expect(dev.entities.has("base")).toBe(true);
      expect(prod.entities.has("prodOnly")).toBe(true); // present under prod
      expect(dev.entities.has("prodOnly")).toBe(false); // absent under dev
    } finally {
      await rm(prodDir, { recursive: true, force: true });
      await rm(devDir, { recursive: true, force: true });
    }
  });
});
