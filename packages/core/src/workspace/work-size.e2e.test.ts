/**
 * The slice-tier point's sizes and the understand point (#3150): chant
 * measures a work item the same way for every orchestrator, the decide
 * activity reads the sizes with the item, and the reference workspace
 * declares understand.
 */

import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readInputs } from "../op/decide-read-inputs";
import { cleanScratch, git, REPO, scratchDir } from "./__fixtures__/contract-repo";
import { parsePoints } from "./points";
import { DEFAULT_TIER_LIMITS, fitsTier, measureWorkItem, sizeFields } from "./work-size";

afterAll(cleanScratch);

const SIZES = ["work-item.criteria", "work-item.files", "work-item.words", "work-item.fits_small", "work-item.fits_medium"];

describe("measuring a work item (#3150)", () => {
  test("criteria, backticked paths and words from the ask, the body without headings and the criteria", () => {
    const data = {
      source: { ask: { said: "Make `app/server.ts` answer on `/healthz` and note it in `README.md`.", by: "alice" } },
      acceptance: [{ id: "AC-1", text: "`app/server.ts` answers 200" }, { id: "AC-2", text: "the README says so" }],
    };
    const body = "# Heading words are not counted\n\nThe body names `app/server.ts` again and `docs/`.\n";
    const size = measureWorkItem(data, body);
    // `docs/` and `/healthz` have no part on both sides of a slash, so they are not paths.
    expect(size).toEqual({ criteria: 2, files: 2, words: 24 });
    expect(measureWorkItem({ source: { intent: { answer: "a garden planner" } } }, "")).toEqual({ criteria: 0, files: 0, words: 3 });
    expect(measureWorkItem(null, "")).toEqual({ criteria: 0, files: 0, words: 0 });
  });

  test("fits_<tier> for each tier with limits, against the defaults or the kind's own", () => {
    expect(sizeFields({ criteria: 11, files: 2, words: 40 })).toEqual({ criteria: 11, files: 2, words: 40, fits_small: false, fits_medium: true });
    expect(sizeFields({ criteria: 1, files: 1, words: 400 })).toMatchObject({ fits_small: false, fits_medium: false });
    expect(sizeFields({ criteria: 1, files: 1, words: 40 }, { tiny: { words: 30 } })).toEqual({ criteria: 1, files: 1, words: 40, fits_tiny: false });
    expect(fitsTier({ criteria: 10, files: 5, words: 150 }, DEFAULT_TIER_LIMITS.small)).toBe(true);
    expect(fitsTier({ criteria: 0, files: 0, words: 0 }, undefined)).toBe(false);
  });
});

describe("the reference workspace (#3150)", () => {
  const ref = join(REPO, "reference-workspace");

  test("declares understand: four answers, a table that proceeds on an open item, then people", () => {
    const points = parsePoints(readFileSync(join(ref, "decisions", "points.json"), "utf-8"), "points.json");
    const u = points.understand;
    expect(Object.keys(u.question.criteria ?? {})).toEqual(["proceed", "redraft", "ask", "refuse"]);
    expect(Object.keys(u.inputs)).toEqual(["work-item.state", "work-item.title", "work-item.source.ask.said", "work-item.source.ask.by", "work-item.source.ask.via", "work-item.acceptance"]);
    expect(u.deciders.map((d) => d.kind)).toEqual(["table", "quorum"]);
  });

  test("the decide activity reads a work item's sizes with it, and the work kind's limits win", async () => {
    const copy = (): string => {
      const root = scratchDir("chant-work-size-");
      cpSync(ref, root, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)$/.test(src) });
      git(root, "init", "-q");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "the workspace");
      return root;
    };
    let root = copy();
    const read = await readInputs(SIZES, { "work-item": "W-001" }, root);
    expect(read.missing).toEqual([]);
    expect(read.inputs).toMatchObject({ "work-item.criteria": 2, "work-item.fits_small": true, "work-item.fits_medium": true });
    expect(typeof read.inputs["work-item.words"]).toBe("number");

    // A fresh copy: a kind file is loaded once per path.
    root = copy();
    const kind = join(root, "work", "work.kind.mjs");
    writeFileSync(kind, readFileSync(kind, "utf-8").replace('tier: { field: "tier", tiers: ["small", "medium", "large"] }', 'tier: { field: "tier", tiers: ["small", "medium", "large"], limits: { small: { criteria: 1 } } }'));
    const narrow = await readInputs(SIZES, { "work-item": "W-001" }, root);
    expect(narrow.inputs["work-item.fits_small"]).toBe(false);
    expect(narrow.missing).toEqual(["work-item.fits_medium"]);
  });
});
