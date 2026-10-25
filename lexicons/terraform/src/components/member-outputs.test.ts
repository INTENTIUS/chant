/**
 * The choudoufu engine's member outputs (#4455): what a choudoufu member's
 * set plan says its outputs will be, for core's `member-outputs`, and the
 * plugin contributing the source. The commands themselves need a choudoufu
 * binary and an estate, which the maintainer runs.
 */

import { describe, expect, test } from "vitest";
import { choudoufuMemberPlannedOutputs, choudoufuOutputSource, terraformCapabilityPlugin } from "./capability-plugin";
import { parseChoudoufuPlanSet } from "../op/activities/terraform";

/** The azure site's plan, as `live-plan-set` embeds it: the Container App new, so its FQDN is unknown. */
const newApp = {
  format_version: "1.2",
  planned_values: { outputs: { azureEndpoint: { sensitive: false }, resourceGroup: { sensitive: false, value: "local" } } },
  output_changes: {
    azureEndpoint: { actions: ["create"], before: null, after_unknown: true },
    resourceGroup: { actions: ["no-op"], before: "local", after: "local", after_unknown: false },
  },
  resource_changes: [
    {
      address: "azurerm_container_app.web",
      mode: "managed",
      type: "azurerm_container_app",
      name: "web",
      change: { actions: ["create"], before: null, after: { name: "web" }, after_unknown: { ingress: [{ fqdn: true }] } },
    },
  ],
};

/** The same site with nothing to change: the FQDN is the one applied. */
const settled = {
  format_version: "1.2",
  planned_values: { outputs: { azureEndpoint: { sensitive: false, value: "web.local.azurecontainerapps.io" } } },
  output_changes: { azureEndpoint: { actions: ["no-op"], before: "web.local.azurecontainerapps.io", after: "web.local.azurecontainerapps.io", after_unknown: false } },
  resource_changes: [],
};

function setDocument(plan: unknown, changes: boolean): string {
  return JSON.stringify({
    format_version: "1",
    roots: [{ root: "azure", estate: "three-cloud-azure", status: "planned", error: "", changes, plan, digest: "sha256:root" }],
    summary: { roots: 1, planned: 1, changed: changes ? 1 : 0, failed: 0 },
    digest: "sha256:set",
    exit_code: changes ? 2 : 0,
  });
}

describe("choudoufuMemberPlannedOutputs", () => {
  test("an output unknown after apply is named unknown; the rest are known, with chant's digest of the plan and its changes", () => {
    const set = parseChoudoufuPlanSet(setDocument(newApp, true), { member: "azure", root: "azure" });
    expect(choudoufuMemberPlannedOutputs(set)).toEqual({
      known: { resourceGroup: "local" },
      unknown: ["azureEndpoint"],
      planDigest: set.planDigest,
      changes: true,
    });
  });

  test("a settled member's output is known, as applied, and it has nothing to apply", () => {
    const set = parseChoudoufuPlanSet(setDocument(settled, false), { member: "azure", root: "azure" });
    expect(choudoufuMemberPlannedOutputs(set)).toEqual({
      known: { azureEndpoint: "web.local.azurecontainerapps.io" },
      unknown: [],
      planDigest: set.planDigest,
      changes: false,
    });
  });
});

describe("the plugin's engine output sources", () => {
  test("contributes the choudoufu source, for members of kind choudoufu", () => {
    expect(terraformCapabilityPlugin.engineOutputSources?.()).toEqual([choudoufuOutputSource]);
    expect(choudoufuOutputSource.kinds).toEqual(["choudoufu"]);
  });
});
