import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { renderClassifierPage } from "./classifier-page";
import { renderPostgresClassifierPage } from "./postgres-classifier-page";
import { renderCoveragePage } from "./coverage-page";

test("the committed classifier page is what the rules render (run npm run docs)", () => {
  const committed = readFileSync(join(import.meta.dirname, "..", "..", "docs", "pages", "change-classifier.mdx"), "utf-8");
  expect(committed).toBe(renderClassifierPage());
});


test("the committed Postgres classifier page is what the rules render (run npm run docs)", () => {
  const committed = readFileSync(join(import.meta.dirname, "..", "..", "docs", "pages", "postgres-change-classifier.mdx"), "utf-8");
  expect(committed).toBe(renderPostgresClassifierPage());
});

test("the committed object coverage page is what the coverage tables render (run npm run docs)", () => {
  const committed = readFileSync(join(import.meta.dirname, "..", "..", "docs", "pages", "object-coverage.mdx"), "utf-8");
  expect(committed).toBe(renderCoveragePage());
});
