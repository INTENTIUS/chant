/**
 * The docs page still says what the table says (#2357).
 *
 * A coverage table's whole value is that it is current. `docs/pages/coverage.mdx`
 * is the page a reader consults before asking why a figure is missing, and a
 * page transcribed from `mapping.ts` stops being true the first time somebody
 * adds a row and does not open the docs.
 *
 * Same construction as `packages/core/src/lexicon-doc-coverage.test.ts`, which
 * fails the build for an optional plugin member with no row in the authoring
 * overview, and for the same reason: the alternative to a check here is a
 * convention nobody is reminded of.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mappedMarkdown,
  terraformMappedMarkdown,
  terraformUnmappedMarkdown,
  unmappedMarkdown,
} from "./coverage-doc";
import {
  byCodeUnit,
  DECLARED_UNMAPPED,
  DECLARED_UNMAPPED_TERRAFORM,
  ENGINE_KINDS_BY_ENTITY_TYPE,
  ENGINE_KINDS_BY_TERRAFORM_TYPE,
} from "./mapping";

const page = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "pages", "coverage.mdx"),
  "utf-8",
);

describe("the coverage docs page", () => {
  it("carries the mapped table as the code renders it", () => {
    expect(page).toContain(mappedMarkdown());
  });

  it("carries the declared-unmapped table as the code renders it", () => {
    expect(page).toContain(unmappedMarkdown());
  });

  it("carries the terraform half, both tables, as the code renders it (#2360)", () => {
    expect(page).toContain(terraformMappedMarkdown());
    expect(page).toContain(terraformUnmappedMarkdown());
  });

  it("gives every entity type in either half exactly one row on the page", () => {
    for (const type of [
      ...Object.keys(ENGINE_KINDS_BY_ENTITY_TYPE),
      ...Object.keys(DECLARED_UNMAPPED),
      ...Object.keys(ENGINE_KINDS_BY_TERRAFORM_TYPE),
      ...Object.keys(DECLARED_UNMAPPED_TERRAFORM),
    ]) {
      const rows = page.split("\n").filter((line) => line.startsWith(`| \`${type}\` |`));
      expect(rows.length, `${type} appears on ${rows.length} rows`).toBe(1);
    }
  });
});

describe("the rendered tables", () => {
  it("gives every row the column count its header promises", () => {
    // A reason is ordinary English prose, and the first one to contain a pipe
    // would silently split its row in half — the cell would render as two
    // columns and every column after it would shift.
    for (const [table, columns] of [
      [mappedMarkdown(), 5],
      [unmappedMarkdown(), 2],
      [terraformMappedMarkdown(), 5],
      [terraformUnmappedMarkdown(), 2],
    ] as const) {
      for (const line of table.split("\n")) {
        const cells = line.split(/(?<!\\)\|/).slice(1, -1);
        expect(cells.length, `"${line.slice(0, 60)}…" has ${cells.length} columns`).toBe(columns);
      }
    }
  });

  it("sorts both halves by entity type", () => {
    const types = (table: string) =>
      table
        .split("\n")
        .slice(2)
        .map((line) => line.split("|")[1].trim().replace(/`/g, ""));
    for (const table of [mappedMarkdown(), unmappedMarkdown(), terraformMappedMarkdown(), terraformUnmappedMarkdown()]) {
      const rows = types(table);
      expect(rows).toEqual([...rows].sort(byCodeUnit));
    }
  });
});
