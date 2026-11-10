/**
 * #4921: a root build of a sql project (no `sourceDir`) leaves its
 * `migrations/` out without opening a file there, the way it leaves out
 * `scripts/` (#4794). Every file the build opens is recorded.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const openSync = ((path: string, ...rest: unknown[]) => {
    opened.push(String(path));
    return (fs.openSync as (...a: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync;
  const readFileSync = ((path: string, ...rest: unknown[]) => {
    opened.push(String(path));
    return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, openSync, readFileSync }, openSync, readFileSync };
});

const { sqlFilesBuildRoot } = await import("./build-root");

const write = (file: string, body: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
};

describe("a root build of a sql project (#4921)", () => {
  test("opens no file under migrations/, at the top or deeper, and still reads the schema", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-4921-sql-")));
    write(join(dir, "chant.config.json"), '{ "lexicons": ["sql"] }\n');
    write(join(dir, "schema.sql"), "CREATE TABLE app.users (id bigint);\n");
    for (const f of ["migrations/0001-add-email/migration.sql", "db/migrations/0002/migration.sql"]) write(join(dir, f), "ALTER TABLE app.users ADD COLUMN email text;\n");
    opened.length = 0;
    const { entities } = await sqlFilesBuildRoot({ projectRoot: dir, config: { sql: { dialect: "postgres" } } });
    expect(entities.size).toBe(1);
    expect(opened.filter((f) => f.startsWith(dir) && f.includes("/migrations/"))).toEqual([]);
    expect(opened).toContain(join(dir, "schema.sql"));
  });
});
