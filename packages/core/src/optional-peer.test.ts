import { describe, expect, test } from "vitest";
import { importOptionalPeer, missingPeerError, requireOptionalPeer } from "./optional-peer";

describe("optional peers", () => {
  test("a missing esbuild is one line that names the install command", async () => {
    const notFound = Object.assign(new Error("Cannot find package 'esbuild' imported from /x/bundle.js"), { code: "ERR_MODULE_NOT_FOUND" });
    const err = await importOptionalPeer("esbuild", "bundle a TypeScript project", () => Promise.reject(notFound)).catch((e: Error) => e);
    expect((err as Error).message).toBe("chant needs esbuild to bundle a TypeScript project; install it with: npm i -D esbuild");
    expect((err as Error).message).not.toContain("\n");
  });

  test("a missing tsx names its own command", () => {
    expect(missingPeerError("tsx", "run TypeScript").message).toBe("chant needs tsx to run TypeScript; install it with: npm i -D tsx");
  });

  test("an error from inside the peer is not rewritten", async () => {
    const inner = Object.assign(new Error("Cannot find package 'left-pad' imported from /x/esbuild/lib/main.js"), { code: "ERR_MODULE_NOT_FOUND" });
    await expect(importOptionalPeer("esbuild", "bundle", () => Promise.reject(inner))).rejects.toBe(inner);
  });

  test("require of a peer that is not installed", () => {
    expect(() => requireOptionalPeer("tsx", "tsx-not-installed-here/cjs/api", "run TypeScript", import.meta.url)).toThrow(/^chant needs tsx to run TypeScript; install it with: npm i -D tsx$/);
  });

  test("a peer that is installed loads", async () => {
    const esbuild = await importOptionalPeer("esbuild", "bundle", () => import("esbuild"));
    expect(typeof esbuild.build).toBe("function");
  });
});
