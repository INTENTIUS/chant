import { describe, expect, it } from "vitest";
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import { CEDAR_POLICY_TYPE } from "../serializer";
import { AVP_AMBIENT_KINDS, observeAvpAmbient } from "./ambient";
import {
  markedDescription,
  mockAvpTransport,
  statementFor,
  MOCK_ENV,
  type MockStore,
} from "./testdata/mock-transport";

const STORE = "PS-abc123";

/** One declared-and-observed policy, plus two nobody declared. */
const store: MockStore = {
  policyStoreId: STORE,
  policies: [
    { policyId: "p-1", statement: statementFor("owner-read"), description: markedDescription("owner-read") },
    {
      policyId: "p-99",
      statement: '@id("console-grant")\npermit (\n  principal,\n  action,\n  resource\n);',
      description: "temporary, added during the incident",
    },
    {
      policyId: "p-100",
      statement: 'forbid (\n  principal,\n  action,\n  resource is App::Document\n)\nwhen { resource.classification == "secret" };',
    },
  ],
};

const observed: Record<string, ResourceMetadata> = {
  ownerRead: { type: CEDAR_POLICY_TYPE, status: "STATIC", physicalId: "p-1", ownership: "owned" },
};

function run(options: Partial<Parameters<typeof observeAvpAmbient>[0]> = {}) {
  const { http } = mockAvpTransport(store);
  return observeAvpAmbient({
    environment: "prod",
    kinds: [CEDAR_POLICY_TYPE],
    observed,
    policyStoreId: STORE,
    client: { http },
    env: MOCK_ENV,
    ...options,
  });
}

describe("ambientKinds", () => {
  it("names the one kind cedar deploys", () => {
    expect([...AVP_AMBIENT_KINDS]).toEqual([CEDAR_POLICY_TYPE]);
  });
});

describe("observeAvpAmbient", () => {
  it("finds the policies nothing declares and excludes the one that is managed", async () => {
    const ambient = await run();
    expect(Object.keys(ambient).sort()).toEqual(["policy/p-100", "policy/p-99"]);
    expect(ambient["policy/p-99"].ambient).toBe(true);
    expect(ambient["policy/p-99"].type).toBe(CEDAR_POLICY_TYPE);
  });

  it("carries the statement and its effect, and stops short of a verdict", async () => {
    const ambient = await run();

    // The standing grant: a bare permit nobody declared.
    expect(ambient["policy/p-99"].attributes?.effect).toBe("permit");
    expect(ambient["policy/p-99"].attributes?.statement).toContain("permit");
    expect(ambient["policy/p-100"].attributes?.effect).toBe("forbid");

    // Nothing in the metadata calls it dangerous — that is the consumer's call.
    expect(Object.keys(ambient["policy/p-99"])).not.toContain("standingGrant");
  });

  it("reports the ownership verdict it can read from the description", async () => {
    const ambient = await run();
    expect(ambient["policy/p-99"].ownership).toBe("foreign");
  });

  it("does not call a declared-but-unobserved policy ambient", async () => {
    // ownerRead's read failed, so it has no physicalId in `observed` — the
    // declared-id exclusion is what stops a hole becoming a security finding.
    const ambient = await run({ observed: {}, declaredPolicyIds: ["owner-read"] });
    expect(Object.keys(ambient).sort()).toEqual(["policy/p-100", "policy/p-99"]);
  });

  it("returns nothing when the project declares no policies", async () => {
    expect(await run({ kinds: ["App::User"] })).toEqual({});
  });

  it("degrades to empty rather than sinking a managed observation that succeeded", async () => {
    const broken = await run({
      client: { http: mockAvpTransport({ ...store, listFails: { code: "ThrottlingException", message: "Rate exceeded", status: 429 } }).http },
    });
    expect(broken).toEqual({});
  });

  it("returns nothing when nothing binds the environment to a store", async () => {
    const { http } = mockAvpTransport(store);
    const ambient = await observeAvpAmbient({
      environment: "prod",
      kinds: [CEDAR_POLICY_TYPE],
      observed,
      client: { http },
      env: MOCK_ENV,
    });
    expect(ambient).toEqual({});
  });

  it("returns nothing when there are no credentials", async () => {
    expect(await run({ env: {} })).toEqual({});
  });
});
