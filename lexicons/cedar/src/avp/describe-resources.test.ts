/**
 * The AVP observation, against a mocked client layer.
 *
 * Every scenario drives the real `listPolicies`/`getPolicy` code through an
 * injected {@link AvpHttp}; nothing here touches the network, and nothing stubs
 * the readers themselves. The conformance suite at the bottom is the part that
 * matters most — it runs these same results through core's own
 * `buildChangeSet`, so a well-shaped result that still proposes a spurious
 * `create` fails here rather than in somebody's account.
 */

import { describe, expect, it } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import { CEDAR_POLICY_TYPE } from "../serializer";
import { cedarPlugin } from "../plugin";
import { describeAvpResources } from "./describe-resources";
import {
  markedDescription,
  mockAvpTransport,
  statementFor,
  MOCK_ENV,
  type MockStore,
} from "./testdata/mock-transport";

const STORE = "PS-abc123";

function entities(names: Record<string, Record<string, unknown>>) {
  return new Map(
    Object.entries(names).map(([name, props]) => [name, { entityType: CEDAR_POLICY_TYPE, props }]),
  );
}

function run(store: MockStore, options: Partial<Parameters<typeof describeAvpResources>[0]> = {}) {
  const { http } = mockAvpTransport(store);
  return describeAvpResources({
    environment: "prod",
    entityNames: ["ownerRead", "requireMfa"],
    entities: entities({ ownerRead: {}, requireMfa: {} }),
    policyStoreId: STORE,
    client: { http, region: "us-west-2" },
    env: MOCK_ENV,
    ...options,
  });
}

/** A store holding both declared policies, both chant-stamped. */
const healthy: MockStore = {
  policyStoreId: STORE,
  policies: [
    {
      policyId: "p-1",
      statement: statementFor("owner-read"),
      description: markedDescription("owner-read", "Owners read their own documents."),
      lastUpdatedDate: "2026-08-01T00:00:00Z",
    },
    {
      policyId: "p-2",
      statement: statementFor("require-mfa", "forbid (\n  principal,\n  action,\n  resource\n)"),
      description: markedDescription("require-mfa"),
    },
  ],
};

describe("describeAvpResources", () => {
  it("keys live policies by chant entity name, through the @id the serializer assigns", async () => {
    const { resources } = normalizeObservation(await run(healthy));

    expect(Object.keys(resources).sort()).toEqual(["ownerRead", "requireMfa"]);
    expect(resources.ownerRead.physicalId).toBe("p-1");
    expect(resources.ownerRead.type).toBe(CEDAR_POLICY_TYPE);
    expect(resources.ownerRead.lastUpdated).toBe("2026-08-01T00:00:00Z");
    expect(resources.ownerRead.attributes?.policyStoreId).toBe(STORE);
  });

  it("honours an explicit annotations.id over the derived one", async () => {
    const store: MockStore = {
      policyStoreId: STORE,
      policies: [{ policyId: "p-9", statement: statementFor("legacy-name"), description: markedDescription("legacy-name") }],
    };
    const { resources } = normalizeObservation(
      await run(store, {
        entityNames: ["ownerRead"],
        entities: entities({ ownerRead: { annotations: { id: "legacy-name" } } }),
      }),
    );
    expect(resources.ownerRead?.physicalId).toBe("p-9");
  });

  it("says where it looked, including the region and the store", async () => {
    const { queried } = normalizeObservation(await run(healthy));
    expect(queried.ownerRead).toBe(
      `avp://us-west-2/policy-store/${STORE}/policy?@id=owner-read`,
    );
  });

  it("reports a policy the store does not hold as absent, not as a hole", async () => {
    const partial: MockStore = { ...healthy, policies: [healthy.policies[0]] };
    const { resources, unobserved, queried } = normalizeObservation(await run(partial));

    expect(Object.keys(resources)).toEqual(["ownerRead"]);
    expect(unobserved.requireMfa).toBeUndefined();
    // Absence is spelled "in neither map", so `queried` is the only record it gets.
    expect(queried.requireMfa).toContain("@id=require-mfa");
  });

  it("resolves an unmarked policy by reading its statement", async () => {
    const consoleEdited: MockStore = {
      policyStoreId: STORE,
      policies: [
        { policyId: "p-1", statement: statementFor("owner-read") },
        { policyId: "p-2", statement: statementFor("require-mfa") },
      ],
    };
    const { resources } = normalizeObservation(await run(consoleEdited));

    expect(Object.keys(resources).sort()).toEqual(["ownerRead", "requireMfa"]);
    expect(resources.ownerRead.ownership).toBe("foreign");
  });

  it("does not pay for a GetPolicy on a policy whose marker already names it", async () => {
    const { http, calls } = mockAvpTransport(healthy);
    await describeAvpResources({
      environment: "prod",
      entityNames: ["ownerRead", "requireMfa"],
      entities: entities({ ownerRead: {}, requireMfa: {} }),
      policyStoreId: STORE,
      client: { http },
      env: MOCK_ENV,
    });
    expect(calls.filter((c) => c.operation === "GetPolicy")).toHaveLength(0);
  });

  it("paginates the enumeration to exhaustion", async () => {
    const many: MockStore = {
      policyStoreId: STORE,
      pageSize: 1,
      policies: healthy.policies,
    };
    const { resources } = normalizeObservation(await run(many));
    expect(Object.keys(resources).sort()).toEqual(["ownerRead", "requireMfa"]);
  });

  it("reports a store that does not exist yet as an empty estate", async () => {
    const missing = await run({ ...healthy, policyStoreId: "PS-other" });
    const { resources, unobserved } = normalizeObservation(missing);
    expect(resources).toEqual({});
    expect(unobserved).toEqual({});
  });

  it("marks every entity not-observed when the enumeration fails on credentials", async () => {
    const denied: MockStore = {
      ...healthy,
      listFails: { code: "AccessDeniedException", message: "not authorized to perform ListPolicies", status: 403 },
    };
    const { unobserved } = normalizeObservation(await run(denied));

    expect(Object.keys(unobserved).sort()).toEqual(["ownerRead", "requireMfa"]);
    expect(unobserved.ownerRead.reason).toBe("no-credentials");
  });

  it("distinguishes a throttle from a credential problem", async () => {
    const throttled: MockStore = {
      ...healthy,
      listFails: { code: "ThrottlingException", message: "Rate exceeded", status: 429 },
    };
    const { unobserved } = normalizeObservation(await run(throttled));
    expect(unobserved.ownerRead.reason).toBe("read-failed");
  });

  it("never throws when there are no credentials at all", async () => {
    const { http } = mockAvpTransport(healthy);
    const result = await describeAvpResources({
      environment: "prod",
      entityNames: ["ownerRead", "requireMfa"],
      entities: entities({ ownerRead: {}, requireMfa: {} }),
      policyStoreId: STORE,
      client: { http },
      env: {},
    });
    const { resources, unobserved } = normalizeObservation(result);
    expect(resources).toEqual({});
    expect(unobserved.ownerRead.reason).toBe("no-credentials");
    expect(unobserved.requireMfa.reason).toBe("no-credentials");
  });

  it("reports no-binding when nothing names a policy store", async () => {
    const { http } = mockAvpTransport(healthy);
    const result = await describeAvpResources({
      environment: "prod",
      entityNames: ["ownerRead"],
      entities: entities({ ownerRead: {} }),
      client: { http },
      env: MOCK_ENV,
    });
    expect(normalizeObservation(result).unobserved.ownerRead.reason).toBe("no-binding");
  });

  it("takes the store from an entity prop when the caller names none", async () => {
    const { http } = mockAvpTransport(healthy);
    const result = await describeAvpResources({
      environment: "prod",
      entityNames: ["ownerRead"],
      entities: entities({ ownerRead: { policyStoreId: STORE } }),
      client: { http },
      env: MOCK_ENV,
    });
    expect(Object.keys(normalizeObservation(result).resources)).toEqual(["ownerRead"]);
  });

  it("takes the store from a per-environment env var", async () => {
    const { http } = mockAvpTransport(healthy);
    const result = await describeAvpResources({
      environment: "prod",
      entityNames: ["ownerRead"],
      entities: entities({ ownerRead: {} }),
      client: { http },
      env: { ...MOCK_ENV, CEDAR_AVP_POLICY_STORE_ID_PROD: STORE, CEDAR_AVP_POLICY_STORE_ID: "PS-wrong" },
    });
    expect(Object.keys(normalizeObservation(result).resources)).toEqual(["ownerRead"]);
  });

  it("calls a non-policy entity type unsupported, never absent", async () => {
    const { http } = mockAvpTransport(healthy);
    const result = await describeAvpResources({
      environment: "prod",
      entityNames: ["appUser"],
      entities: new Map([["appUser", { entityType: "App::User", props: {} }]]),
      policyStoreId: STORE,
      client: { http },
      env: MOCK_ENV,
    });
    expect(normalizeObservation(result).unobserved.appUser.reason).toBe("unsupported-kind");
  });

  it("withholds a foreign policy under owned:true rather than calling it absent", async () => {
    const mixed: MockStore = {
      policyStoreId: STORE,
      policies: [
        { policyId: "p-1", statement: statementFor("owner-read"), description: markedDescription("owner-read") },
        { policyId: "p-2", statement: statementFor("require-mfa"), description: "added in the console" },
      ],
    };
    const { resources, unobserved } = normalizeObservation(await run(mixed, { owned: true }));

    expect(Object.keys(resources)).toEqual(["ownerRead"]);
    expect(resources.ownerRead.ownership).toBe("owned");
    expect(unobserved.requireMfa.reason).toBe("filtered");
  });

  it("leaves a policy whose GetPolicy failed unmatched, not misattributed", async () => {
    const flaky: MockStore = {
      policyStoreId: STORE,
      policies: [
        { policyId: "p-1", statement: statementFor("owner-read"), getFails: true },
        { policyId: "p-2", statement: statementFor("require-mfa"), description: markedDescription("require-mfa") },
      ],
    };
    const { resources } = normalizeObservation(await run(flaky));
    // p-1's `@id` was unreadable, so ownerRead is absent rather than being
    // matched onto whichever policy happened to be next in the list.
    expect(Object.keys(resources)).toEqual(["requireMfa"]);
  });
});

describeObservationConformance({
  lexicon: "cedar",
  ownershipChannel: cedarPlugin.ownershipChannel,
  scenarios: [
    {
      name: "a healthy policy store",
      declared: ["ownerRead", "requireMfa"],
      expectPresent: ["ownerRead", "requireMfa"],
      run: () => run(healthy),
    },
    {
      name: "a store missing one declared policy",
      declared: ["ownerRead", "requireMfa"],
      expectPresent: ["ownerRead"],
      expectAbsent: ["requireMfa"],
      run: () => run({ ...healthy, policies: [healthy.policies[0]] }),
    },
    {
      name: "an enumeration that fails on credentials",
      declared: ["ownerRead", "requireMfa"],
      expectUnobserved: ["ownerRead", "requireMfa"],
      run: () =>
        run({
          ...healthy,
          listFails: { code: "AccessDeniedException", message: "not authorized", status: 403 },
        }),
    },
    {
      name: "an environment bound to no policy store",
      declared: ["ownerRead", "requireMfa"],
      expectUnobserved: ["ownerRead", "requireMfa"],
      run: () => {
        const { http } = mockAvpTransport(healthy);
        return describeAvpResources({
          environment: "prod",
          entityNames: ["ownerRead", "requireMfa"],
          entities: entities({ ownerRead: {}, requireMfa: {} }),
          client: { http },
          env: MOCK_ENV,
        });
      },
    },
    {
      name: "an owned read on the path that declares a marker channel",
      declared: ["ownerRead", "requireMfa"],
      expectPresent: ["ownerRead", "requireMfa"],
      owned: true,
      run: () => run(healthy, { owned: true }),
    },
  ],
});
