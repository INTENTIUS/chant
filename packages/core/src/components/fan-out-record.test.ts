/**
 * The attempt record keeps what steps carried per member (#3459), so the
 * next attempt, in this process or in the next CI job, hands it back.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFanOutAttempt, writeFanOutAttempt } from "./fan-out-record";

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
