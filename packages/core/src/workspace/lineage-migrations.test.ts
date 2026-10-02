import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lineage } from "./lineage-lock";
import { mergeFile } from "./lineage-merge";
import { planMigrations, runMigration, splitMigrations, type LoadedMigration } from "./lineage-migrations";
import { applyUpstream } from "./lineage-update";
import { compareVersions, parseVersion, satisfies } from "./lineage-version";

function lineage(ref: string | undefined, migrations: string[] = []): Lineage {
  return {
    kind: "template",
    template: "github.com/acme/starter",
    source: { type: "git", repo: "acme/starter", url: "https://github.com/acme/starter.git" },
    ...(ref ? { ref } : {}),
    address: null,
    parameters: {},
    migrations,
    files: {},
    manualSteps: [],
  };
}

function migration(id: string, versions: string, to: string, template?: string): LoadedMigration {
  return {
    file: `.chant/migrations/${id}.json`,
    migration: { id, from: { versions, ...(template ? { template } : {}) }, to, body: { type: "declarative", steps: [{ op: "delete", path: "x" }] }, post: [] },
  };
}

describe("versions", () => {
  test("a version is read from a tag, with or without a prefix", () => {
    expect(parseVersion("v1.4.0")).toEqual({ major: 1, minor: 4, patch: 0, pre: "" });
    expect(parseVersion("2")).toEqual({ major: 2, minor: 0, patch: 0, pre: "" });
    expect(parseVersion("chant-v0.80.0")).toEqual({ major: 0, minor: 80, patch: 0, pre: "" });
    expect(parseVersion("v2.0.0-rc.1")?.pre).toBe("rc.1");
    expect(parseVersion("main")).toBeNull();
    expect(parseVersion("4624a0b6ca83")).toBeNull();
  });

  test("ranges", () => {
    const v = (s: string) => parseVersion(s)!;
    expect(satisfies(v("1.5.0"), ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfies(v("2.0.0"), ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfies(v("1.9.3"), "^1.2")).toBe(true);
    expect(satisfies(v("0.3.1"), "^0.3.0")).toBe(true);
    expect(satisfies(v("0.4.0"), "^0.3.0")).toBe(false);
    expect(satisfies(v("1.2.9"), "~1.2.0")).toBe(true);
    expect(satisfies(v("1.3.0"), "~1.2.0")).toBe(false);
    expect(satisfies(v("1.7.0"), "1.x")).toBe(true);
    expect(satisfies(v("3.0.0"), "1.x || >=3")).toBe(true);
    expect(satisfies(v("1.2.3"), "1.2.3")).toBe(true);
    expect(satisfies(v("1.2.9"), "<=1.2")).toBe(true);
    expect(satisfies(v("2.0.0-rc.1"), ">=1.0.0")).toBe(false);
    expect(satisfies(v("7.0.0"), "*")).toBe(true);
    expect(compareVersions(v("2.0.0-rc.1"), v("2.0.0"))).toBe(-1);
  });
});

describe("planMigrations", () => {
  test("orders the chain by the version each migration brings the scope to", () => {
    const plan = planMigrations(lineage("v1.0.0"), "v3.1.0", [
      migration("b", ">=2.0.0 <3.0.0", "3.0.0"),
      migration("a", "1.x", "2.0.0"),
      migration("future", ">=3.0.0", "4.0.0"),
      migration("past", "0.x", "1.0.0"),
    ]);
    expect(plan.chain.map((m) => m.migration.id)).toEqual(["a", "b"]);
  });

  test("skips migrations already applied and those for another template", () => {
    const plan = planMigrations(lineage("v1.0.0", ["a"]), "v2.0.0", [
      migration("a", "1.x", "2.0.0"),
      migration("other", "1.x", "2.0.0", "github.com/someone/else"),
      migration("mine", "1.x", "2.0.0", "github.com/acme/starter"),
    ]);
    expect(plan.chain.map((m) => m.migration.id)).toEqual(["mine"]);
  });

  test("refuses a gap, a downgrade, and a chain it cannot compute", () => {
    expect(() => planMigrations(lineage("v1.0.0"), "v3.0.0", [migration("b", ">=2.0.0 <3.0.0", "3.0.0")])).toThrow(/gap in the migration chain/);
    expect(() => planMigrations(lineage("v2.0.0"), "v1.0.0", [])).toThrow(/only goes forward/);
    expect(() => planMigrations(lineage("main"), "v2.0.0", [migration("a", "1.x", "2.0.0")])).toThrow(/not a version/);
    // With nothing to run, no version is needed.
    expect(planMigrations(lineage("main"), "main", []).chain).toEqual([]);
  });

  // #2551 — moving a scope to another template starts the chain with a bridge.
  test("a switch starts with the bridge from the scope's template, then the new template's own migrations", () => {
    const upstream = "github.com/acme/upstream";
    const plan = planMigrations(lineage("v1.4.0"), "v3.0.0", [
      migration("bridge-old", "<1.0.0", "1.0.0", "github.com/acme/starter"),
      migration("bridge", ">=1.0.0 <2.0.0", "2.0.0", "github.com/acme/starter"),
      migration("own-2", ">=1.0.0 <2.0.0", "2.0.0"),
      migration("own-3", "2.x", "3.0.0"),
      migration("other-bridge", "1.x", "2.0.0", "github.com/someone/else"),
    ], upstream);
    // own-2 lands where the bridge already did, so it does not run; the fork's version 1.4.0 means nothing to upstream.
    expect(plan.chain.map((m) => m.migration.id)).toEqual(["bridge", "own-3"]);
    // No downgrade check across templates: the fork's v5 can bridge to upstream's v3.
    expect(planMigrations(lineage("v5.0.0"), "v3.0.0", [migration("b", ">=5.0.0", "3.0.0", "github.com/acme/starter")], upstream).chain.map((m) => m.migration.id)).toEqual(["b"]);
  });

  test("a switch without a bridge is refused when the new template has migrations, and allowed when it has none", () => {
    const upstream = "github.com/acme/upstream";
    expect(() => planMigrations(lineage("v1.0.0"), "v2.0.0", [migration("own", "1.x", "2.0.0")], upstream)).toThrow(/needs a bridge migration/);
    expect(() => planMigrations(lineage("v1.0.0"), "v2.0.0", [migration("b", ">=3.0.0", "2.0.0", "github.com/acme/starter"), migration("own", "1.x", "2.0.0")], upstream)).toThrow(
      /needs a bridge migration.*found b: >=3\.0\.0/,
    );
    expect(planMigrations(lineage("v1.0.0"), "v2.0.0", [], upstream).chain).toEqual([]);
    // The same id is no switch.
    expect(planMigrations(lineage("v1.0.0"), "v2.0.0", [migration("a", "1.x", "2.0.0")], "github.com/acme/starter").chain.map((m) => m.migration.id)).toEqual(["a"]);
  });
});

describe("migration files", () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o));
  test("are split out of the template's files and validated", () => {
    const files = new Map<string, Buffer>([
      ["src/a.ts", Buffer.from("a")],
      [".chant/migrations/one.json", enc({ id: "one", from: { versions: "1.x" }, to: "2.0.0", body: { type: "declarative", steps: [{ op: "delete", path: "a" }] } })],
      [".chant/migrations/two.mjs", Buffer.from("export default () => {}")],
    ]);
    const split = splitMigrations(files);
    expect([...split.files.keys()]).toEqual(["src/a.ts"]);
    expect(split.migrations.map((m) => m.migration.id)).toEqual(["one"]);
    expect([...split.modules.keys()]).toEqual(["two.mjs"]);
  });

  test("refuse an unknown step, a bad range, an escaping path and a missing code module", () => {
    const one = (m: unknown) => splitMigrations(new Map([[".chant/migrations/m.json", enc(m)]]));
    const base = { id: "m", from: { versions: "1.x" }, to: "2.0.0" };
    expect(() => one({ ...base, body: { type: "declarative", steps: [{ op: "chmod", path: "a" }] } })).toThrow(/invalid migration/);
    expect(() => one({ ...base, from: { versions: ">>1" }, body: { type: "declarative", steps: [{ op: "delete", path: "a" }] } })).toThrow(/not a version range/);
    expect(() => one({ ...base, body: { type: "declarative", steps: [{ op: "delete", path: "../a" }] } })).toThrow(/inside the scope/);
    expect(() => one({ ...base, body: { type: "code", module: "gone.mjs" } })).toThrow(/is not in the template/);
  });
});

describe("declarative steps", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-migration-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("json-set and json-delete edit a JSON file at a pointer", async () => {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ a: { b: 1, gone: true } }));
    const l = lineage("v1");
    await runMigration(
      {
        file: "m.json",
        migration: {
          id: "json",
          from: { versions: "*" },
          to: "2.0.0",
          body: {
            type: "declarative",
            steps: [
              { op: "json-set", path: "c.json", pointer: "/a/c~1d", value: [1] },
              { op: "json-delete", path: "c.json", pointer: "/a/gone" },
            ],
          },
          post: [{ check: "contains", path: "c.json", text: '"c/d"' }],
        },
      },
      { dir, lineage: l, modules: new Map(), allowCode: false, scratch: dir },
    );
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf-8"))).toEqual({ a: { b: 1, "c/d": [1] } });
    expect(l.migrations).toEqual(["json"]);
  });
});

describe("applyUpstream class rules", () => {
  test("seed and generated files are never written or merged", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-classes-"));
    try {
      mkdirSync(join(dir, "skills/x"), { recursive: true });
      writeFileSync(join(dir, ".mcp.json"), "{}");
      writeFileSync(join(dir, "skills/x/SKILL.md"), "old");
      const l = lineage("v1");
      l.files = {
        ".mcp.json": { class: "seed", sha256: `sha256:${"1".repeat(64)}` },
        "skills/x/SKILL.md": { class: "generated", sha256: `sha256:${"2".repeat(64)}`, command: "chant update" },
      };
      const result = applyUpstream(dir, l, new Map([[".mcp.json", Buffer.from("{ new }")], ["skills/x/SKILL.md", Buffer.from("new")]]), { base: new Map(), merge: mergeFile });
      expect(result.written).toEqual([]);
      expect(result.skipped).toEqual([
        { path: ".mcp.json", class: "seed" },
        { path: "skills/x/SKILL.md", class: "generated", command: "chant update" },
      ]);
      expect(readFileSync(join(dir, ".mcp.json"), "utf-8")).toBe("{}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mergeFile refuses a conflicting hunk and a binary file", () => {
    const b = Buffer.from("a\nb\nc\n");
    expect(mergeFile(b, Buffer.from("A\nb\nc\n"), Buffer.from("a\nb\nC\n"))?.toString()).toBe("A\nb\nC\n");
    expect(mergeFile(b, Buffer.from("a\nX\nc\n"), Buffer.from("a\nY\nc\n"))).toBeNull();
    expect(mergeFile(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]))).toBeNull();
  });
});
