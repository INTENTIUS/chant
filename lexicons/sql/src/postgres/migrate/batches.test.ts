/**
 * The backfill's batches (#3322), the parts that need no server: which keys
 * batch by arithmetic, and the conditions between recorded boundaries.
 * `batches.e2e.test.ts` runs them against the pinned server.
 */

import { describe, expect, test } from "vitest";
import { boundaryBatches, isIntegerKey, keyText } from "./batches";

describe("batches", () => {
  test("one integer column batches by arithmetic; anything else by recorded boundaries", () => {
    expect(isIntegerKey([{ name: "id", type: "bigint" }])).toBe(true);
    expect(isIntegerKey([{ name: "id", type: "uuid" }])).toBe(false);
    expect(isIntegerKey([{ name: "tenant_id", type: "integer" }, { name: "id", type: "integer" }])).toBe(false);
    expect(keyText([{ name: "tenant_id", type: "integer" }, { name: "id", type: "bigint" }])).toBe("(tenant_id, id)");
  });

  test("between boundaries: the first batch has no lower bound and the last no upper one, in the key's own order", () => {
    const keys = [
      { name: "tenant_id", type: "integer" },
      { name: "id", type: "uuid" },
    ];
    const batches = boundaryBatches(keys, [
      ["1", "00000000-0000-0000-0000-000000000001"],
      ["2", "00000000-0000-0000-0000-000000000005"],
      ["3", "00000000-0000-0000-0000-000000000002"],
    ]);
    expect(batches.map((b) => [b.id, b.where, b.params])).toEqual([
      ["k0", "(tenant_id, id) < ($1::integer, $2::uuid)", ["2", "00000000-0000-0000-0000-000000000005"]],
      ["k1", "(tenant_id, id) >= ($1::integer, $2::uuid) AND (tenant_id, id) < ($3::integer, $4::uuid)", ["2", "00000000-0000-0000-0000-000000000005", "3", "00000000-0000-0000-0000-000000000002"]],
      ["k2", "(tenant_id, id) >= ($1::integer, $2::uuid)", ["3", "00000000-0000-0000-0000-000000000002"]],
    ]);
    expect(boundaryBatches([{ name: "code", type: "text" }], [["a"]]).map((b) => [b.where, b.params])).toEqual([["true", []]]);
    expect(boundaryBatches([{ name: "code", type: "text" }], [])).toEqual([]);
  });
});
