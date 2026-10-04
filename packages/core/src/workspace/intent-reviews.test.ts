/**
 * From a commit back to the review that asked for it (#3154, E21 in
 * arugula-salad/hud#823): a review session's comments[].follow_ups name a
 * work item, a builder's commit carries that item with `Chant-Record:
 * work:<id>`, and `graph --intent` lists the session on the work node.
 *
 * The workspace is a copy of the reference workspace, where W-001
 * constrains design/screens/home.json, with one open review session added.
 */

import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, scratchDir } from "./__fixtures__/contract-repo";
import { intentGraph, type CommitNode, type WorkNode } from "./intent";
import intentSchema from "./intent.schema.json";

afterAll(cleanScratch);

const intent = contract(intentSchema);

const SESSION = `---
${JSON.stringify(
  {
    schema: 1,
    id: "S-0002",
    title: "Review of the home page",
    state: "open",
    agenda: [{ text: "The home page as built" }],
    attendance: [{ principal: "alice", class: "person" }],
    opened: "2026-10-03T10:00:00Z",
    closed: null,
    verdicts: [],
    comments: [
      { text: "The header is cut off." },
      { text: "The hero image should follow the spec.", follow_ups: ["work:W-001"] },
      { text: "Same for the footer.", follow_ups: ["work:W-001", "work:W-404"] },
    ],
  },
  null,
  2,
)}
---

# Review of the home page
`;

function workspace(): string {
  const root = scratchDir("chant-intent-reviews-");
  cpSync(join(REPO, "reference-workspace"), root, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)$/.test(src) });
  writeFileSync(join(root, "design", "sessions", "S-0002-review-of-the-home-page.md"), SESSION);
  const g = (...a: string[]) => git(root, ...a);
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "the workspace");
  g("branch", "-M", "main");
  writeFileSync(join(root, "design", "screens", "home.json"), `${JSON.stringify({ regions: ["header", "hero", "footer"] }, null, 2)}\n`);
  g("add", "-A");
  g("commit", "-q", "-m", "the hero follows the spec", "-m", "Chant-Record: work:W-001");
  return root;
}

describe("graph --intent joins a work item back to the review that asked for it (#3154, E21)", () => {
  test("the work node lists the session and the comments whose follow_ups name it, and the builder's commit carries the item", async () => {
    const root = workspace();
    const head = git(root, "rev-parse", "HEAD");
    const { doc } = await intentGraph({ cwd: root, region: "design/screens/home.json" });
    intent.expectValid(doc);
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    const w = doc.nodes.find((n) => n.id === "record:work/W-001") as WorkNode;
    expect(w.reviews).toEqual([{ id: "record:session/S-0002", recordKind: "session", record: "S-0002", path: "design/sessions/S-0002-review-of-the-home-page.md", state: "open", comments: [2, 3] }]);
    const c = doc.nodes.find((n) => n.id === `commit:${head}`) as CommitNode;
    expect(c).toBeDefined();
    expect(doc.edges).toContainEqual({ kind: "carries", from: c.id, to: w.id });
  });
});
