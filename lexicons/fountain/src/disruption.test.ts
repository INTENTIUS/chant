/**
 * What a pending fountain update costs (#2128).
 *
 * The interesting assertions run end to end — two thin observations of the same
 * estate, a change set built from them by core, then core's own
 * `annotateDisruption` with the plugin's classifier — because the classifier
 * reads `attributes.<key>` paths that only exist if `describeResources` put the
 * key there. A unit test of the table alone would pass with the attribute
 * missing and the plan would still say `unknown`.
 */

import { describe, expect, it } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import { buildChangeSet } from "@intentius/chant/lifecycle/change-set";
import { annotateDisruption } from "@intentius/chant/lifecycle/disruption";
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import { describeResources } from "./describe-resources";
import { classifyFountainChange, propertyOf } from "./disruption";
import { fountainPlugin } from "./plugin";
import type { FountainHttp } from "./op/activities/fountain-apply";

const AGENT = { id: "agent-1", name: "steward", metadata: { "managed-by": "chant" } };

function team(conversation: Record<string, unknown>, schedule: Record<string, unknown>): FountainHttp {
  return async (_method, path) => {
    if (path === "/api/team") {
      return {
        status: 200,
        json: { data: [{ agent_id: "agent-1", name: "ops-steward", agent: AGENT, conversation }] },
      };
    }
    if (path === "/api/team/schedules") {
      return {
        status: 200,
        json: {
          data: [
            {
              id: "sched-1",
              agent_id: "agent-1",
              name: "nightly-converge",
              prompt: "chant lifecycle converge",
              one_off: false,
              enabled: true,
              ...schedule,
            },
          ],
        },
      };
    }
    throw new Error(`unrouted ${path}`);
  };
}

const ENTITIES = new Map<string, { entityType: string; props: Record<string, unknown> }>([
  ["opsSteward", { entityType: "Fountain::V1::Teammate", props: { name: "ops-steward", agent: "steward" } }],
  [
    "nightly",
    {
      entityType: "Fountain::V1::Schedule",
      props: {
        name: "nightly-converge",
        teammate: "ops-steward",
        cron: "0 3 * * *",
        prompt: "chant lifecycle converge",
      },
    },
  ],
]);

async function observe(http: FountainHttp): Promise<Record<string, ResourceMetadata>> {
  return normalizeObservation(
    await describeResources(
      { environment: "local", buildOutput: "", entityNames: [...ENTITIES.keys()], entities: ENTITIES },
      http,
    ),
  ).resources;
}

/** Two reads of the same estate, classified the way `chant lifecycle diff --live` does. */
async function verdicts(before: FountainHttp, after: FountainHttp) {
  const observedThen = await observe(before);
  const observedNow = await observe(after);
  const cs = buildChangeSet(
    "local",
    { declared: new Set(ENTITIES.keys()), observedNow, observedThen },
    { lexicon: "fountain" },
  );
  const annotated = await annotateDisruption(cs, "local", fountainPlugin.classifyDisruption);
  return new Map(annotated.entries.map((e) => [e.name, e]));
}

const STEADY = team({ environment_id: "env-1", vault_id: "vault-1" }, { cron: "0 3 * * *" });

describe("a teammate rebound to another vault", () => {
  it("is a replace — fountain retires the persistent sandbox", async () => {
    const moved = team({ environment_id: "env-1", vault_id: "vault-2" }, { cron: "0 3 * * *" });
    const entry = (await verdicts(STEADY, moved)).get("opsSteward");

    expect(entry?.action).toBe("update");
    expect(entry?.disruption).toBe("replace");
    expect(entry?.disruptionBecause).toEqual(["attributes.vault_id"]);
    expect(entry?.disruptionDetail).toContain("persistent sandbox");
  });

  it("so is one moved to another environment", async () => {
    const moved = team({ environment_id: "env-2", vault_id: "vault-1" }, { cron: "0 3 * * *" });
    expect((await verdicts(STEADY, moved)).get("opsSteward")?.disruption).toBe("replace");
  });
});

describe("a schedule the UI edited", () => {
  it("changes its cron in place — nothing running is disturbed", async () => {
    const edited = team({ environment_id: "env-1", vault_id: "vault-1" }, { cron: "0 5 * * *" });
    const entry = (await verdicts(STEADY, edited)).get("nightly");

    expect(entry?.action).toBe("update");
    expect(entry?.disruption).toBe("in-place");
    expect(entry?.disruptionDetail).toContain("next tick");
  });

  it("is in-place when paused too", async () => {
    const paused = team({ environment_id: "env-1", vault_id: "vault-1" }, { cron: "0 3 * * *", enabled: false });
    expect((await verdicts(STEADY, paused)).get("nightly")?.disruption).toBe("in-place");
  });
});

describe("the table itself", () => {
  it("reads a property off either vocabulary a delta path can arrive in", () => {
    expect(propertyOf("attributes.vault_id")).toBe("vault_id");
    expect(propertyOf("vault")).toBe("vault");
    expect(propertyOf("attributes.event_types[0]")).toBe("event_types");
  });

  it("says unknown for a kind it publishes no semantics for, rather than guessing", () => {
    const verdict = classifyFountainChange({
      name: "conciergeEnv",
      type: "Fountain::V1::Environment",
      deltas: [{ path: "attributes.networking_type", oldValue: "limited", newValue: "unrestricted" }],
    });
    expect(verdict.disruption).toBe("unknown");
    expect(verdict.detail).toContain("Fountain::V1::Environment");
  });

  it("patches a webhook in place — the id and the signing secret survive it", () => {
    expect(
      classifyFountainChange({
        name: "hook",
        type: "Fountain::V1::Webhook",
        deltas: [{ path: "attributes.event_types", oldValue: ["a"], newValue: ["a", "b"] }],
      }).disruption,
    ).toBe("in-place");
  });

  it("does not read a moved timestamp as a reconfiguration", () => {
    const verdict = classifyFountainChange({
      name: "nightly",
      type: "Fountain::V1::Schedule",
      deltas: [{ path: "lastUpdated", oldValue: "a", newValue: "b" }],
    });
    expect(verdict.disruption).toBe("in-place");
    expect(verdict.detail).toContain("only the record's identity or timestamps");
  });
});
