import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("hcl2json loader", () => {
  // A bundle that only reads HCL must not load the graph, the state reader or
  // the carve tables behind them.
  test("imports nothing from the graph, state or carve modules", () => {
    const src = readFileSync(join(__dirname, "hcl2json.ts"), "utf-8");
    const local = [...src.matchAll(/from "(\.\/[^"]+)"/g)].map((m) => m[1]);
    expect(local.every((p) => p === "./types")).toBe(true);
  });

  test("parse.ts still re-exports the loader API", async () => {
    const parse = await import("./parse");
    const loader = await import("./hcl2json");
    expect(parse.loadHcl2json).toBe(loader.loadHcl2json);
    expect(parse.Hcl2JsonNotInstalled).toBe(loader.Hcl2JsonNotInstalled);
    expect(parse.HCL2JSON_RECORD_ENV).toBe(loader.HCL2JSON_RECORD_ENV);
  });
});
