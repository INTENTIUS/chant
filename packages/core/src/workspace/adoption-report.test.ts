import { describe, expect, test } from "vitest";
import { parseLiveImportReport } from "./adoption-report";

// The text choudoufu's LiveImportHuman.Ratification prints
// (choudoufu internal/command/views/live_import.go), one group per status.
const REPORT = [
  "",
  'Ratifying /work/prod.tfstate for estate "prod" against the live system. This was read-only: nothing was written.',
  "",
  "VERIFIED (1) - verified against the live system:",
  "  aws_vpc.main                               aws_vpc                  live id: vpc-0a1b",
  "    every attribute matched the live system",
  "",
  "DRIFTED (1) - verified, but drifted from the live system:",
  '  module.api.aws_sqs_queue.work["a b"]       aws_sqs_queue            live id: https://sqs/work',
  "    2 attribute(s) differ: visibility_timeout_seconds, delay_seconds",
  "",
  "MISSING (1) - could not be verified:",
  "  aws_s3_bucket.gone                         aws_s3_bucket            live id: -",
  "    the live system has no bucket gone-123",
  "",
  "UNTAGGABLE (1) - outside the taggable subset:",
  "  aws_s3_bucket_versioning.artifacts         aws_s3_bucket_versioning live id: artifacts",
  "    the provider schema has no tags argument",
  "",
  "UNADMITTED_TYPE (1) - outside the admitted type set:",
  "  aws_kms_alias.estate                       aws_kms_alias            live id: alias/estate",
  "    aws_kms_alias has no row in the admission table",
  "",
  "2 of 5 resource instance(s) are eligible for stamping (VERIFIED or DRIFTED).",
  "",
  "/work/prod.tfstate was opened once, read-only, and will not be opened again by this run - not to write it, and not to read it a second time.",
  "No tag has been written. Rerun with -approve to stamp tofu-estate and tofu-address onto every eligible resource above.",
].join("\n");

describe("parseLiveImportReport (behold#999)", () => {
  test("every resource, with its status, live id, reason and whether -approve stamps it", () => {
    const r = parseLiveImportReport(REPORT)!;
    expect(r.estate).toBe("prod");
    expect(r.state).toBe("/work/prod.tfstate");
    expect(r.total).toBe(5);
    expect(r.claimed).toBe(2);
    expect(r.entries.map((e) => [e.address, e.type, e.status, e.liveId, e.claimed])).toEqual([
      ["aws_vpc.main", "aws_vpc", "VERIFIED", "vpc-0a1b", true],
      ['module.api.aws_sqs_queue.work["a b"]', "aws_sqs_queue", "DRIFTED", "https://sqs/work", true],
      ["aws_s3_bucket.gone", "aws_s3_bucket", "MISSING", null, false],
      ["aws_s3_bucket_versioning.artifacts", "aws_s3_bucket_versioning", "UNTAGGABLE", "artifacts", false],
      ["aws_kms_alias.estate", "aws_kms_alias", "UNADMITTED_TYPE", "alias/estate", false],
    ]);
    expect(r.entries[2].detail).toBe("the live system has no bucket gone-123");
  });

  test("a state with no managed resources is a report with no entries", () => {
    const r = parseLiveImportReport('\nRatifying s for estate "e" against the live system. This was read-only: nothing was written.\n\nThe state file names no managed resource instances. Nothing to ratify.\n');
    expect(r).toEqual({ estate: "e", state: "s", entries: [], claimed: 0, total: 0 });
  });

  test("text with no report in it is undefined", () => {
    expect(parseLiveImportReport("Error: no such file\n")).toBeUndefined();
  });
});
