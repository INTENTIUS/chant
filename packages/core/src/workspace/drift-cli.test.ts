/**
 * `chant workspace drift` (behold#995): the document it prints holds to the
 * drift schema with the read contract's head, for a read and for a failure,
 * and each member kind answers the reads the table says.
 */

import { describe, expect, test } from "vitest";
import { driftRecord, driftRecordLine, driftSettle, driftStart, type DriftRecord } from "../drift-record";
import { readContractSchema } from "./conformance";
import { DRIFT_CONTRACT_VERSION, DRIFT_ERROR_CODES, DRIFT_READS_BY_KIND, driftReadDocument } from "./drift-cli";

const at = "2026-10-25T09:00:00Z";

function record(address: string, status: DriftRecord["status"]): DriftRecord {
  return driftRecord({
    member: "infra",
    engine: "terraform",
    address,
    node: `infra/infra/${address}`,
    observedAt: at,
    read: "state",
    status,
    ...(status === "not-observed" ? { unobserved: { reason: "read-failed" as const } } : {}),
    evidence: { tool: "terraform" },
  });
}

describe("chant workspace drift's document", () => {
  test("a read folds its stream into one document with contract, chant and member", () => {
    const records = [record("aws_s3_bucket.a", "recorded"), record("aws_s3_bucket.b", "pending")];
    const start = driftStart({ member: "infra", engine: "terraform", read: "state", at, expected: ["aws_s3_bucket.a", "aws_s3_bucket.b", "aws_s3_bucket.c"] });
    const settled = driftSettle(start, records, at);
    const doc = driftReadDocument("infra", { lines: [start, ...records.map(driftRecordLine), settled.line] });
    expect(doc.contract).toBe(DRIFT_CONTRACT_VERSION);
    expect(doc.member).toBe("infra");
    expect(doc.records.map((r) => [r.address, r.status])).toEqual([
      ["aws_s3_bucket.a", "recorded"],
      ["aws_s3_bucket.b", "pending"],
      ["aws_s3_bucket.c", "not-observed"],
    ]);
    expect(doc.records[2].unobserved?.reason).toBe("not-reached");
    const { validate } = readContractSchema("drift");
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  test("a failure is an empty document carrying the error, and validates", () => {
    const doc = driftReadDocument("app", { error: { code: "no-drift-read", message: "app is kind app" } });
    expect(doc.records).toEqual([]);
    expect(doc.error).toEqual({ code: "no-drift-read", message: "app is kind app" });
    expect(Object.values(doc.counts).every((n) => n === 0)).toBe(true);
    const { validate } = readContractSchema("drift");
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  test("each kind's reads, the first its default; state is never a chant member's", () => {
    expect(DRIFT_READS_BY_KIND.chant).toEqual(["live-read"]);
    expect(DRIFT_READS_BY_KIND.terraform).toEqual(["state", "plan"]);
    expect(DRIFT_READS_BY_KIND.choudoufu).toEqual(["ownership", "plan"]);
    expect(DRIFT_READS_BY_KIND.pulumi).toBeUndefined();
    expect(DRIFT_ERROR_CODES).toContain("no-drift-read");
  });
});
