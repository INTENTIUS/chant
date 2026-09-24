/**
 * The commit-join hook's data form and its export checks, with no git
 * (#2651, #2663).
 */

import { describe, expect, test } from "vitest";
import { joinByData, readCommitJoins, trailerValue, trailerValues, type CommitJoinContext, type IntentCommit } from "./intent-joins";

const commit = (trailers: Record<string, string[]>): IntentCommit => ({ sha: "a".repeat(40), subject: "s", body: "", author: { name: "t", email: "t@example.com" }, date: "2026-09-24T00:00:00Z", trailers });

const files: Record<string, string> = {
  "evidence/E-1.json": JSON.stringify({ id: "ignored", kind: "test-run" }),
  "evidence/E-3.json": JSON.stringify({ kind: "review" }),
  "units/U-1.json": JSON.stringify({ role: "implement" }),
};
const context: CommitJoinContext = { read: (p) => files[p], list: () => undefined, at: null };

describe("the data form reads every trailer value (#2663)", () => {
  test("each value of the evidence trailer, under any case of its key, is one piece of evidence", () => {
    const data = { trailers: { unit: "Unit", evidence: "Evidence" }, records: { unit: "units/{id}.json", evidence: "evidence/{id}.json" } };
    const out = joinByData(data, commit({ Unit: ["U-1"], Evidence: ["E-1", " E-2 ", "E-1"], evidence: ["E-3", ""] }), context);
    expect(out).toEqual({
      unit: { id: "U-1", role: "implement" },
      evidence: [
        { id: "E-1", kind: "test-run" },
        { id: "E-2" },
        { id: "E-3", kind: "review" },
      ],
    });
  });

  test("a unit or contract trailer gives its first value, since a commit has one of each", () => {
    const out = joinByData({ trailers: { unit: "Unit", contract: "Contract" } }, commit({ Unit: ["U-1", "U-2"], contract: ["C-1"], Contract: ["C-2"] }), context);
    expect(out.unit).toEqual({ id: "U-1" });
    expect(out.contract?.id).toBe(trailerValue({ contract: ["C-1"], Contract: ["C-2"] }, "Contract"));
  });

  test("trailerValues keeps git's order, trims, and drops empty values and repeats", () => {
    expect(trailerValues({ "Chud-Evidence": ["h1", "h2"], "chud-evidence": ["h2", " h3", "  "] }, "CHUD-EVIDENCE")).toEqual(["h1", "h2", "h3"]);
    expect(trailerValues({}, "X")).toEqual([]);
    expect(trailerValue({ X: ["  "] }, "x")).toBeUndefined();
  });
});

describe("commitJoinsName (#2663)", () => {
  test("names the findings of either form, and leaves the data form's own keys alone", () => {
    const join = () => undefined;
    expect(readCommitJoins({ commitJoins: join, commitJoinsName: "chud" })).toEqual({ form: "function", join, name: "chud" });
    expect(readCommitJoins({ commitJoins: { trailers: { unit: "Unit" } }, commitJoinsName: "chud" })).toEqual({ form: "data", data: { trailers: { unit: "Unit" } }, name: "chud" });
    expect(readCommitJoins({ commitJoins: join })).toEqual({ form: "function", join });
    // A name inside the data form is still a key the data form does not have.
    expect(readCommitJoins({ commitJoins: { name: "chud", trailers: {} } })).toMatch(/Unrecognized key/);
  });

  test("a name that can't be a plugin:<name>: segment, or one with no joins, is refused", () => {
    for (const bad of ["a:b", "a b", "", 7]) expect(readCommitJoins({ commitJoins: () => undefined, commitJoinsName: bad }), String(bad)).toMatch(/^commitJoinsName:/);
    expect(readCommitJoins({ commitJoinsName: "chud" })).toMatch(/no commitJoins/);
    expect(readCommitJoins({})).toBeUndefined();
  });
});
