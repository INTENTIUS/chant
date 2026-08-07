import { describe, expect, it } from "vitest";
import type { ChangeSet } from "@intentius/chant/reconcile";
import type { AwsGovernanceConfig } from "../config/types.js";
import { breakGlassAdmin, ouDeletionCap, rootScpFloor, runAwsGuardrails } from "./guardrails.js";
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

  it("break-glass admin: neither the named assignment nor its permission set may be removed", () => {
    const config: AwsGovernanceConfig = {
      organization: {},
      ous: {},
      scps: {},
      identity: {
        permissionSets: { admin: {} },
        breakGlass: { principal: "BreakGlass", principalType: "GROUP", permissionSet: "admin", accounts: ["management"] },
      },
    };
    const dropAssignment = cs([
      {
        kind: "delete",
        resourceType: "assignment",
        key: "admin/management/GROUP:BreakGlass",
        before: { permissionSetName: "admin", principalName: "BreakGlass", principalType: "GROUP" },
      },
    ]);
    expect(breakGlassAdmin(dropAssignment, config)?.guardrail).toBe("breakGlassAdmin");

    const dropSet = cs([{ kind: "delete", resourceType: "permission-set", key: "admin", before: { arn: "ps-1" } }]);
    expect(breakGlassAdmin(dropSet, config)?.guardrail).toBe("breakGlassAdmin");

    // A different principal's assignment on the same set removes freely.
    const dropOther = cs([
      {
        kind: "delete",
        resourceType: "assignment",
        key: "admin/management/GROUP:Platform",
        before: { permissionSetName: "admin", principalName: "Platform", principalType: "GROUP" },
      },
    ]);
    expect(breakGlassAdmin(dropOther, config)).toBeNull();
    // No break-glass named → nothing to protect.
    expect(breakGlassAdmin(dropAssignment, { ...config, identity: undefined })).toBeNull();
    expect(breakGlassAdmin(dropAssignment, undefined)).toBeNull();
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
