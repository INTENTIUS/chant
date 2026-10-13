/**
 * chant #3648 — a project with no `chant.config.ts` that imports a lexicon only
 * through a subpath (`@intentius/chant-lexicon-sql/clickhouse`, as every sql
 * project does) failed with "No lexicon detected in infrastructure files", and
 * `--lexicon sql` did not help. These tests build the issue's repro for both
 * sql dialects, and check that `--lexicon` is honoured when resolving the
 * project's lexicons.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectLexicons } from "./plugins";
import { runCommandInProcess } from "./main";
import { captureRun } from "../workspace/member-run";

const repoNodeModules = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../node_modules");

const REPRO = {
  clickhouse: {
    source:
      'import { table } from "@intentius/chant-lexicon-sql/clickhouse";\n' +
      "export const events = table`CREATE TABLE events (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY (id, ts)`;\n",
    ddl: "clickhouse.sql",
  },
  postgres: {
    source:
      'import { table } from "@intentius/chant-lexicon-sql/postgres";\n' +
      "export const events = table`CREATE TABLE events (id bigint PRIMARY KEY, ts timestamptz NOT NULL)`;\n",
    ddl: "postgres.sql",
  },
} as const;

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-3648-")));
  // A package.json stops the config walk at the project root.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "repro", private: true, type: "module" }));
  mkdirSync(join(root, "src"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSource(source: string): void {
  writeFileSync(join(root, "src", "infra.ts"), source);
}

describe("resolveProjectLexicons with --lexicon (#3648)", () => {
  test("a config-less project with no lexicon import resolves to the named lexicon", async () => {
    writeSource("export const nothing = 1;\n");

    await expect(resolveProjectLexicons(join(root, "src"))).rejects.toThrow("No lexicon detected");
    expect(await resolveProjectLexicons(join(root, "src"), { lexicon: "sql" })).toEqual(["sql"]);
  });

  test("the named lexicon joins the detected ones", async () => {
    writeSource('import { Deployment } from "@intentius/chant-lexicon-k8s";\nexport const x = 1;\n');

    expect(await resolveProjectLexicons(join(root, "src"), { lexicon: "sql" })).toEqual(["k8s", "sql"]);
    expect(await resolveProjectLexicons(join(root, "src"), { lexicon: "k8s" })).toEqual(["k8s"]);
  });

  test("the named lexicon joins the config's lexicons", async () => {
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    writeSource("export const nothing = 1;\n");

    expect(await resolveProjectLexicons(join(root, "src"), { lexicon: "sql" })).toEqual(["aws", "sql"]);
  });

  test("a subpath import resolves with no config and no flag", async () => {
    writeSource(REPRO.postgres.source);

    expect(await resolveProjectLexicons(join(root, "src"))).toEqual(["sql"]);
  });
});

describe("chant build on the #3648 repro", () => {
  beforeEach(() => {
    // The repro imports the workspace's sql lexicon, as an installed project would.
    symlinkSync(repoNodeModules, join(root, "node_modules"), "dir");
  });

  for (const [dialect, { source, ddl }] of Object.entries(REPRO)) {
    for (const flags of [[], ["--lexicon", "sql"]]) {
      test(`${dialect}, ${flags.length ? "--lexicon sql" : "no flag"}: builds with no chant.config`, async () => {
        writeSource(source);
        const out = join(root, "dist", "schema.json");

        const run = await captureRun(() => runCommandInProcess(["build", join(root, "src"), ...flags, "-o", out]));

        expect(run.stderr).not.toContain("No lexicon detected");
        expect(run.exitCode).toBe(0);
        expect(existsSync(out)).toBe(true);
        expect(readFileSync(join(root, "dist", ddl), "utf-8")).toContain("CREATE TABLE");
      }, 60_000);
    }

    // chant #3738 — the DDL is verbatim but not a secret, so a build with no
    // --output prints it rather than refusing as if it were ciphertext.
    test(`${dialect}: builds to stdout with no --output (#3738)`, async () => {
      writeSource(source);
      // The build prints through console, which vitest intercepts before it
      // reaches the stream captureRun replaces.
      const out: string[] = [];
      const err: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
      const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
      let run: Awaited<ReturnType<typeof captureRun>>;
      try {
        run = await captureRun(() => runCommandInProcess(["build", join(root, "src")]));
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
      const stderr = run.stderr + err.join("\n");

      expect(stderr).not.toContain("committed-encrypted");
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(out.join("\n"))).toMatchObject({ dialect });
      expect(stderr).toContain(`--- ${ddl} ---`);
      expect(stderr).toContain("CREATE TABLE events");
      expect(existsSync(join(root, ddl))).toBe(false);
    }, 60_000);
  }
});
