/**
 * The security profiles (#5464): what a profile turns on, its numbers, the
 * control table it reads, and the profile page printed from them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_RETENTION } from "../lifecycle/retention-policy";
import { parseDeclaration } from "./declaration";
import { SECURITY_GROUPS, securityGroupsOf } from "./security";
import { CONTROLS_OUTSIDE_BOTH_BASELINES, SECURITY_CONTROLS, securityControl } from "./security-controls";
import {
  controlTable,
  outsideTable,
  PROFILE_CHECKS,
  PROFILE_FINDING_CODES,
  PROFILE_SPECS,
  profileCheckTable,
  profileControls,
  profilesOf,
  profileTable,
  retentionUnderProfiles,
  scanDatabaseBound,
  scanDatabaseStale,
  SECURITY_PROFILES,
} from "./security-profiles";

const DOCS = fileURLToPath(new URL("../../../../docs/src/content/docs/", import.meta.url));

describe("a profile in security", () => {
  test("turns on every group, and a reader that asks for a group needs nothing more", () => {
    for (const p of SECURITY_PROFILES) expect([...securityGroupsOf({ security: [p], members: [] } as never)]).toEqual([...SECURITY_GROUPS]);
    expect([...securityGroupsOf({ security: ["supply-chain", "fedramp-moderate"], members: [] } as never)]).toEqual(["supply-chain", "verified-releases", "who-ran-it", "review-rules", "isolated-runners"]);
    expect(profilesOf({ security: ["supply-chain", "cccs-medium"] })).toEqual(["cccs-medium"]);
  });

  test("the declaration takes a profile at the top level and refuses one on a member", () => {
    const base = { name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "x" }] };
    expect(parseDeclaration(JSON.stringify({ ...base, security: ["fedramp-moderate"] }), "chant.workspace.json").security).toEqual(["fedramp-moderate"]);
    expect(() => parseDeclaration(JSON.stringify({ ...base, members: [{ ...base.members[0], security: ["cccs-medium"] }] }), "chant.workspace.json")).toThrow();
  });
});

describe("the profile's numbers", () => {
  test("gc keeps change sets and releases for at least the profile's days, and a longer retention stays", () => {
    const { policy, raised } = retentionUnderProfiles(structuredClone(DEFAULT_RETENTION), ["fedramp-moderate"]);
    expect([policy.changeSets.days, policy.releases.days, policy.runEvents.days]).toEqual([90, 90, DEFAULT_RETENTION.runEvents.days]);
    expect(raised.map((r) => [r.kind, r.declared, r.kept])).toEqual([["changeSets", 14, 90], ["releases", 14, 90]]);
    const longer = { ...structuredClone(DEFAULT_RETENTION), releases: { days: 400, keep: 10 } };
    expect(retentionUnderProfiles(longer, ["cccs-medium"]).policy.releases.days).toBe(400);
    expect(retentionUnderProfiles(structuredClone(DEFAULT_RETENTION), []).raised).toEqual([]);
  });

  test("the database bound is the shorter of dbMaxAgeHours and the profile's hours, and none without either", () => {
    expect(scanDatabaseBound(undefined, [])).toBeNull();
    expect(scanDatabaseBound(48, [])).toEqual({ maxHours: 48, from: "release.scan.dbMaxAgeHours" });
    expect(scanDatabaseBound(48, ["fedramp-moderate"])).toEqual({ maxHours: 24, from: "the fedramp-moderate security profile" });
    expect(scanDatabaseBound(6, ["fedramp-moderate"])).toEqual({ maxHours: 6, from: "release.scan.dbMaxAgeHours" });
  });

  test("a database older than the bound, or with no build time, is stale", () => {
    const bound = { maxHours: 24, from: "the fedramp-moderate security profile" };
    const now = new Date("2026-11-21T12:00:00Z");
    expect(scanDatabaseStale({ version: "v6", built: "2026-11-21T00:00:00Z" }, bound, now)).toBeNull();
    expect(scanDatabaseStale({ version: "v6", built: "2026-11-20T06:00:00Z" }, bound, now)).toContain("30 hours before the scan");
    expect(scanDatabaseStale({ version: "v6" }, bound, now)).toContain("did not say when its database was built");
    expect(scanDatabaseStale(null, bound, now)).toContain("did not say");
  });
});

describe("the control table", () => {
  test("holds the 36 controls once each, none of those found in neither baseline", () => {
    const ids = SECURITY_CONTROLS.map((c) => c.id);
    expect(ids).toHaveLength(36);
    expect(new Set(ids).size).toBe(36);
    for (const o of CONTROLS_OUTSIDE_BOTH_BASELINES) expect(ids, o.id).not.toContain(o.id);
  });

  test("keeps the baselines apart: CCCS Medium follows Rev. 4, with no SR family", () => {
    for (const c of SECURITY_CONTROLS.filter((r) => r.id.startsWith("SR-"))) expect(c.baselines["cccs-medium"], c.id).toBe("not-in-catalogue");
    expect(securityControl("CM-3(2)")?.baselines).toEqual({ "fedramp-moderate": "selected", "cccs-medium": "not-selected" });
    expect(securityControl("CM-3(6)")?.baselines).toEqual({ "fedramp-moderate": "not-selected", "cccs-medium": "selected" });
    expect(securityControl("SA-10(1)")?.baselines).toEqual({ "fedramp-moderate": "not-selected", "cccs-medium": "selected" });
  });

  test("each profile check and the rows it names agree, and a finding names only its baseline's ids", () => {
    expect(PROFILE_CHECKS.map((c) => c.code)).toEqual([...PROFILE_FINDING_CODES]);
    for (const check of PROFILE_CHECKS) {
      for (const id of check.controls) expect(securityControl(id)?.codes, `${check.code} ${id}`).toContain(check.code);
    }
    for (const row of SECURITY_CONTROLS) {
      for (const code of row.codes.filter((c) => c.startsWith("profile-"))) expect(PROFILE_CHECKS.find((c) => c.code === code)?.controls, `${row.id} ${code}`).toContain(row.id);
    }
    const signing = PROFILE_CHECKS.find((c) => c.code === "profile-signing-off")!.controls;
    expect(profileControls("fedramp-moderate", signing)).toEqual(["SI-7", "SR-11"]);
    expect(profileControls("cccs-medium", signing)).toEqual(["SA-10(1)", "SI-7"]);
  });

  test("each profile names its own check", () => {
    expect(SECURITY_PROFILES.map((p) => PROFILE_SPECS[p].check)).toEqual(["WSP166", "WSP167"]);
  });
});

describe("the profile page", () => {
  test("carries the tables the profiles, checks and controls print", () => {
    const page = readFileSync(join(DOCS, "reference", "security-profiles.mdx"), "utf-8");
    const table = (header: string) => new RegExp(`^\\| ${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|[^\\n]*\\n(?:\\|[^\\n]*\\n)*`, "m").exec(page)?.[0].trimEnd();
    expect(table("Profile"), "regenerate from profileTable()").toBe(profileTable());
    expect(table("Code"), "regenerate from profileCheckTable()").toBe(profileCheckTable());
    expect(table("Control | Title | FedRAMP Moderate"), "regenerate from controlTable()").toBe(controlTable());
    expect(table("Control | Title | Why it is in neither"), "regenerate from outsideTable()").toBe(outsideTable());
  });
});
