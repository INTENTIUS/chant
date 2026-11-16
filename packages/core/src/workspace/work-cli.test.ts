import { describe, expect, test } from "vitest";
import { WORK_LEASE_REFUSALS } from "../lifecycle/work-lease";
import { CHANT_EXIT } from "../exit-codes";
import { EXIT_LEASE_REFUSED, leaseRefusedExit } from "./work-cli";

describe("leaseRefusedExit (#4585)", () => {
  test("a lease another worker holds or another writer won exits held, 5", () => {
    expect(EXIT_LEASE_REFUSED).toBe(5);
    for (const code of ["lease-held", "lease-race", "lease-push-rejected"]) expect(leaseRefusedExit(code)).toBe(CHANT_EXIT.held);
  });

  test("a lease nobody holds, or a stale token, exits failed, 1", () => {
    for (const code of ["lease-not-held", "lease-token-mismatch"]) expect(leaseRefusedExit(code)).toBe(CHANT_EXIT.failed);
  });

  test("every refusal maps to 1 or 5", () => {
    for (const code of WORK_LEASE_REFUSALS) expect([1, 5]).toContain(leaseRefusedExit(code));
  });
});
