/**
 * The new migration files of a pull request (#4407): which files count as
 * new, and who classifies them. The trees are in memory; the classes come
 * from the lexicon (`lexicons/sql/src/migration-classify.test.ts`).
 */

import { describe, expect, test } from "vitest";
import { LINK_READERS, type KindLinkRead } from "./kind-link-readers";
import { classifyNewMigrations, newMigrationGroups } from "./new-migrations";
import type { WorkspaceTree } from "./tree";

function memoryTree(files: Record<string, string>): WorkspaceTree {
  const dirs = new Set([""]);
  for (const f of Object.keys(files)) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    label: "",
    stat: (p) => (p in files ? "file" : dirs.has(p) ? "dir" : undefined),
    list(p) {
      if (!dirs.has(p)) return undefined;
      const prefix = p === "" ? "" : `${p}/`;
      const seen = new Map<string, "file" | "dir">();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        seen.set(rest.split("/")[0]!, rest.includes("/") ? "dir" : "file");
      }
      return [...seen].map(([name, type]) => ({ name, type }));
    },
    read(p) {
      if (!(p in files)) throw new Error(`no such file ${p}`);
      return files[p]!;
    },
  };
}

const GOOSE = (sql: string) => `-- +goose Up\n${sql}\n-- +goose Down\nSELECT 1;\n`;
const baseFiles = { "db/00001_init.sql": GOOSE("CREATE TABLE t (id bigint);") };
const headFiles = { ...baseFiles, "db/00002_idx.sql": GOOSE("CREATE INDEX i ON t (id);") };

const readGoose = (tree: WorkspaceTree): Map<string, KindLinkRead> =>
  new Map([["ledger", LINK_READERS["goose-dir"]({ member: { name: "ledger" } as never, dir: "db", fields: { dialect: "postgres" }, tree })]]);
const members = [{ name: "ledger", dir: "db" }];

describe("newMigrationGroups", () => {
  test("keeps the files the base lacks, in apply order", () => {
    const groups = newMigrationGroups(members, readGoose(memoryTree(headFiles)), memoryTree(baseFiles));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ member: "ledger", dir: "db", reader: "goose-dir", dialect: "postgres" });
    expect(groups[0]!.migrations.map((m) => m.file)).toEqual(["db/00002_idx.sql"]);
  });

  test("a changed file that the base has is not new", () => {
    const head = { ...headFiles, "db/00001_init.sql": GOOSE("CREATE TABLE t (id bigint, a int);") };
    expect(newMigrationGroups(members, readGoose(memoryTree(head)), memoryTree(baseFiles)).flatMap((g) => g.migrations.map((m) => m.file))).toEqual(["db/00002_idx.sql"]);
  });

  test("nothing new, no group; no base tree means every migration is new; --member limits", () => {
    expect(newMigrationGroups(members, readGoose(memoryTree(baseFiles)), memoryTree(baseFiles))).toEqual([]);
    expect(newMigrationGroups(members, readGoose(memoryTree(headFiles)), undefined)[0]!.migrations).toHaveLength(2);
    expect(newMigrationGroups(members, readGoose(memoryTree(headFiles)), memoryTree(baseFiles), "other")).toEqual([]);
  });
});

describe("classifyNewMigrations", () => {
  const groups = () => newMigrationGroups(members, readGoose(memoryTree(headFiles)), memoryTree(baseFiles));

  test("asks the lexicon for the new files only, with the head tree and the member's directory", async () => {
    const asked: unknown[] = [];
    const out = await classifyNewMigrations(groups(), memoryTree(headFiles), [
      {
        name: "fake",
        classifyMigrations(o) {
          asked.push({ reader: o.reader, dialect: o.dialect, dir: o.dir, files: o.files });
          return o.files.map((file) => ({ file, statements: [] }));
        },
      },
    ]);
    expect(asked).toEqual([{ reader: "goose-dir", dialect: "postgres", dir: "db", files: ["db/00002_idx.sql"] }]);
    expect(out).toMatchObject([{ member: "ledger", reader: "goose-dir", version: "2", name: "idx", type: "versioned", dialect: "postgres", file: "db/00002_idx.sql" }]);
  });

  test("a file no lexicon answers for is listed with the reason, and a throwing lexicon does not stop the note", async () => {
    const none = await classifyNewMigrations(groups(), memoryTree(headFiles), []);
    expect(none[0]!.error).toBe("no installed lexicon classifies postgres migrations");
    const threw = await classifyNewMigrations(groups(), memoryTree(headFiles), [
      {
        name: "fake",
        classifyMigrations() {
          throw new Error("boom");
        },
      },
    ]);
    expect(threw[0]!.error).toBe("the fake lexicon could not classify it: boom");
  });
});
