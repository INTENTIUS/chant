import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { renderClassifierPage } from "./classifier-page";

test("the committed classifier page is what the rules render (run npm run docs)", () => {
  const committed = readFileSync(join(import.meta.dirname, "..", "..", "docs", "pages", "change-classifier.mdx"), "utf-8");
  expect(committed).toBe(renderClassifierPage());
});
