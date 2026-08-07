/**
 * Runner integration — warden's runReconcile (the chant harness + Forgejo diff
 * + guardrails) driven with a fake cycle and a mock client.
 */

import { describe, it, expect } from "vitest";
import { runReconcile, type Cycle } from "./runner.js";
import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";
import type { GovernanceConfig } from "../config/types.js";

const mockClient = (): ForgejoClient => ({ async request<T = unknown>(): Promise<T> {
  return {} as T;
} });

/** A members cycle: fetchLive returns the given live; buildDesired passes members through. */
function membersCycle(live: LiveOrgState, applied: string[]): Cycle {
  return {
    name: "members",
    async fetchLive() {
      return live;
    },
    buildDesired(config: OrgConfig) {
      return { members: config.members };
    },
    async apply(_client, entry) {
      applied.push(entry.key);
    },
  };
}

const cfg = (members: string[]): GovernanceConfig => ({
  orgs: { acme: { members: members.map((username) => ({ username })) } },
});

describe("runReconcile (Forgejo adapter)", () => {
  it("dry-run reports creates and applies nothing", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["a", "b", "c"]),
      client: mockClient(),
      cycles: [membersCycle({}, applied)], // empty live → all creates
      mode: "dry-run",
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(3);
    expect(applied).toHaveLength(0);
  });

  it("apply applies each entry", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["a", "b"]),
      client: mockClient(),
      cycles: [membersCycle({}, applied)],
      mode: "apply",
    });
    expect(result.completed).toBe(true);
    expect(applied.sort()).toEqual(["a", "b"]);
  });

  it("removalDeltaCap blocks a mass-delete apply (guardrail reused from chant)", async () => {
    const applied: string[] = [];
    const live: LiveOrgState = { members: Array.from({ length: 10 }, (_, i) => ({ username: `m${i}` })) };
    const result = await runReconcile({
      config: cfg(["m0"]), // keep 1, would delete 9 of 10 → 90% > 25%
      client: mockClient(),
      cycles: [membersCycle(live, applied)],
      mode: "apply",
      diffOptions: { isOwned: () => true }, // make the unmanaged members deletable
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrailBlocked).toBe(true);
    expect(cr.guardrails.ok).toBe(false);
    expect(applied).toHaveLength(0);
  });
});
