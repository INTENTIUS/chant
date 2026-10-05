/**
 * The attempt record keeps what steps carried per member (#3459), so the
 * next attempt, in this process or in the next CI job, hands it back. It
 * also keeps the change set a pull request's apply approved (#3464), so a
 * re-run finishes it under that approval.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFanOutAttempt, writeFanOutAttempt, type PrApplyRecord } from "./fan-out-record";
import { composeChangeSet } from "../change-set";

describe("carried", () => {
  test("round-trips through the record", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fan-out-record-")), "fan-out.json");
    const carried = { e01: { kind: "choudoufu-wave-resume", setDigest: "sha256:set", resume: { set_digest: "sha256:set", roots: [] } } };
    writeFanOutAttempt(path, { digest: "d", completed: [], failed: ["e01"], outputs: {}, carried });
    expect(readFanOutAttempt(path)?.carried).toEqual(carried);
  });

  test("a record without it, or with something that is not an object, reads as none", () => {
    const dir = mkdtempSync(join(tmpdir(), "fan-out-record-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ digest: "d", completed: [], failed: [], outputs: {} }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ digest: "d", completed: [], failed: [], outputs: {}, carried: ["x"] }));
    expect(readFanOutAttempt(join(dir, "a.json"))?.carried).toBeUndefined();
    expect(readFanOutAttempt(join(dir, "b.json"))?.carried).toBeUndefined();
  });
});

describe("prApply (#3464)", () => {
  const changeSet = composeChangeSet([
    {
      member: { member: "net", lexicon: "terraform", planner: "tofu", status: "planned", planDigest: `jcs1-sha256:${"1".repeat(64)}`, holes: [] },
      entries: [],
    },
  ]);
  const prApply: PrApplyRecord = {
    op: "pr-12",
    gate: "pr-apply",
    head: "2".repeat(40),
    digest: changeSet.digest,
    approvedBy: ["github:alice"],
    members: [
      {
        member: "net",
        component: "net",
        planDigest: `jcs1-sha256:${"1".repeat(64)}`,
        status: "planned",
        counts: { create: 0, update: 0, replace: 0, delete: 0 },
      },
    ],
    changeSet,
    planOutputs: { net: { cidr: "10.0.0.0/16" } },
  };

  test("round-trips through the record", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fan-out-record-")), "pr-apply.json");
    writeFanOutAttempt(path, { digest: "d", completed: ["net"], failed: [], outputs: { net: { cidr: "10.0.0.0/16" } }, prApply });
    expect(readFanOutAttempt(path)?.prApply).toEqual(prApply);
  });

  test("an entry whose change set does not carry its digest, or that misses a field, reads as none", () => {
    const dir = mkdtempSync(join(tmpdir(), "fan-out-record-"));
    const base = { digest: "d", completed: [], failed: [], outputs: {} };
    writeFileSync(join(dir, "a.json"), JSON.stringify({ ...base, prApply: { ...prApply, digest: `jcs1-sha256:${"9".repeat(64)}` } }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ ...base, prApply: { ...prApply, head: undefined } }));
    writeFileSync(join(dir, "c.json"), JSON.stringify({ ...base, prApply: "pr-12" }));
    for (const name of ["a.json", "b.json", "c.json"]) expect(readFanOutAttempt(join(dir, name))?.prApply).toBeUndefined();
  });
});
