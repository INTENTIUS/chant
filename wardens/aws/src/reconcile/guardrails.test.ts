import { describe, expect, it } from "vitest";
import type { ChangeSet } from "@intentius/chant/reconcile";
import { ouDeletionCap, rootScpFloor, runAwsGuardrails } from "./guardrails.js";
import type { LiveOrgState } from "./live.js";

const DOC = { Version: "2012-10-17", Statement: [] };

const live: LiveOrgState = {
  rootId: "r-1",
  scps: [
    { id: "p-1", name: "guard-a", description: undefined, document: DOC, targetIds: ["r-1"], awsManaged: false, owned: true },
    { id: "p-2", name: "guard-b", description: undefined, document: DOC, targetIds: ["ou-x"], awsManaged: false, owned: true },
  ],
};

const cs = (entries: ChangeSet["entries"]): ChangeSet => ({ org: "organization", entries });

describe("aws guardrails (#792)", () => {
  it("blocks the plan that drops the last root SCP", () => {
    const detachLast = cs([
      { kind: "update", resourceType: "scp", key: "guard-a", after: { targets: ["Security"] }, fields: [] },
    ]);
    expect(rootScpFloor(detachLast, live)?.guardrail).toBe("rootScpFloor");

    const deleteLast = cs([{ kind: "delete", resourceType: "scp", key: "guard-a" }]);
    expect(rootScpFloor(deleteLast, live)?.guardrail).toBe("rootScpFloor");
  });

  it("allows dropping a root SCP while another remains", () => {
    const withTwo: LiveOrgState = {
      ...live,
      scps: [...live.scps!, { id: "p-3", name: "guard-c", description: undefined, document: DOC, targetIds: ["r-1"], awsManaged: false, owned: true }],
    };
    const dropOne = cs([{ kind: "delete", resourceType: "scp", key: "guard-a" }]);
    expect(rootScpFloor(dropOne, withTwo)).toBeNull();
  });

  it("tolerates an org with no root SCP yet (nothing to protect)", () => {
    const bare: LiveOrgState = { rootId: "r-1", scps: [] };
    expect(rootScpFloor(cs([]), bare)).toBeNull();
  });

  it("caps OU deletions", () => {
    const three = cs([
      { kind: "delete", resourceType: "ou", key: "A" },
      { kind: "delete", resourceType: "ou", key: "B" },
      { kind: "delete", resourceType: "ou", key: "C" },
    ]);
    expect(ouDeletionCap(three)?.guardrail).toBe("ouDeletionCap");
    expect(ouDeletionCap(three, 3)).toBeNull();
  });

  it("runAwsGuardrails aggregates diagnostics", () => {
    const bad = cs([
      { kind: "delete", resourceType: "scp", key: "guard-a" },
      { kind: "delete", resourceType: "ou", key: "A" },
      { kind: "delete", resourceType: "ou", key: "B" },
      { kind: "delete", resourceType: "ou", key: "C" },
    ]);
    const res = runAwsGuardrails(bad, live);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.map((d) => d.guardrail)).toEqual(["rootScpFloor", "ouDeletionCap"]);
  });
});
