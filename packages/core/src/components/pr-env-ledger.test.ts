import { describe, expect, test } from "vitest";
import { appendPrEnvRecord, PrEnvRecordError } from "./pr-env-ledger";
import type { PrEnvRecord } from "./pr-environment";

describe("appendPrEnvRecord (#4551)", () => {
  test("refuses a record the reader would skip, before any git runs", async () => {
    await expect(appendPrEnvRecord({ version: 1, kind: "up", env: "pr-1" } as unknown as PrEnvRecord, { cwd: "/nonexistent" })).rejects.toBeInstanceOf(PrEnvRecordError);
  });
});
