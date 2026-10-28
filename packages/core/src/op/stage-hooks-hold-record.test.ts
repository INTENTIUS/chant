/**
 * The hold file's `record` and `attachment`, and the finished file a
 * recorded hold's re-run writes (#4623).
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { holdFinishedPath, readHoldFinished, readHoldRequest } from "./stage-hooks";

describe("recorded holds (#4623)", () => {
  test("a hold file's record and attachment are read; a record that is not a boolean is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "hold-record-"));
    const logs: string[] = [];
    const at = join(dir, "hold.json");
    writeFileSync(at, JSON.stringify({ op: "tf-migrate", gate: "g", digest: "sha256:aa", record: true, attachment: "{}\n" }));
    expect(readHoldRequest(at, (l) => logs.push(l), "hook")).toEqual({ op: "tf-migrate", gate: "g", digest: "sha256:aa", record: true, attachment: "{}\n" });
    writeFileSync(at, JSON.stringify({ gate: "g", digest: "sha256:aa", record: "yes" }));
    expect(readHoldRequest(at, (l) => logs.push(l), "hook")).toBeUndefined();
    expect(logs.join("\n")).toContain("its record is not true or false");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the finished file keeps flat detail values and drops the rest; a missing or bad file reads as nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hold-finished-"));
    const logs: string[] = [];
    const at = join(dir, "hold-finished.json");
    expect(readHoldFinished(at, (l) => logs.push(l), "hook")).toBeUndefined();
    writeFileSync(at, JSON.stringify({ result: "failed", detail: { result: "failed", n: 2, ok: false, roots: ["a"], nested: { x: 1 } } }));
    expect(readHoldFinished(at, (l) => logs.push(l), "hook")).toEqual({ result: "failed", detail: { result: "failed", n: 2, ok: false } });
    expect(logs.join("\n")).toContain("roots, nested are not a string, number or boolean");
    writeFileSync(at, JSON.stringify({ result: "done" }));
    expect(readHoldFinished(at, (l) => logs.push(l), "hook")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the finished file sits beside the hold file", () => {
    expect(holdFinishedPath(".chant/op-waves/tf-apply/wave-1/hold.json")).toBe(".chant/op-waves/tf-apply/wave-1/hold-finished.json");
    expect(holdFinishedPath("custom-hold")).toBe("custom-hold.finished.json");
  });
});
