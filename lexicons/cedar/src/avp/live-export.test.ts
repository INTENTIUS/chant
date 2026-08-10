import { describe, expect, it } from "vitest";
import { checkParsePolicySet } from "@cedar-policy/cedar-wasm/nodejs";
import { CEDAR_POLICY_TYPE, type CedarPolicyProps } from "../serializer";
import { avpStatement } from "./embed";
import { exportAvpResources, policyToResourceIR } from "./live-export";
import {
  markedDescription,
  mockAvpTransport,
  MOCK_ENV,
  type MockStore,
} from "./testdata/mock-transport";

const STORE = "PS-abc123";

const OWNER_READ = `@id("owner-read")
@doc("Owners always read their own documents.")
permit (
  principal is App::User,
  action in [App::Action::"read", App::Action::"list"],
  resource is App::Document
)
when { resource.owner == principal }
unless { context.mfa == false };`;

const RESTRICT_DELETE = `@id("restrict-delete")
forbid (
  principal,
  action == App::Action::"delete",
  resource is App::Document
)
when { resource.classification == "confidential" };`;

const store: MockStore = {
  policyStoreId: STORE,
  policies: [
    {
      policyId: "p-2",
      statement: RESTRICT_DELETE,
      description: "added in the console",
      createdDate: "2026-01-01T00:00:00Z",
    },
    {
      policyId: "p-1",
      statement: OWNER_READ,
      description: markedDescription("owner-read", "Owners read their own."),
      lastUpdatedDate: "2026-08-01T00:00:00Z",
    },
  ],
};

function run(options: Partial<Parameters<typeof exportAvpResources>[0]> = {}) {
  const { http } = mockAvpTransport(store);
  return exportAvpResources({
    environment: "prod",
    policyStoreId: STORE,
    client: { http },
    env: MOCK_ENV,
    ...options,
  });
}

/** A live policy through `policyToResourceIR`, which is the import parser's reading of it. */
function irFor(statement: string, verbatim = false) {
  return policyToResourceIR(
    {
      policyId: "p-x",
      policyStoreId: STORE,
      policyType: "STATIC",
      statement,
      authoredDescription: "",
      marked: false,
    },
    { verbatim },
  );
}

describe("reading a live statement back", () => {
  it("goes through the import parser, so the id is the Cedar policy id", () => {
    // Not `ownerRead`: turning a policy id into a TypeScript identifier is
    // CedarGenerator's job downstream, and doing it here too applies it twice.
    expect(irFor(OWNER_READ)?.logicalId).toBe("owner-read");
    expect(irFor(OWNER_READ)?.type).toBe(CEDAR_POLICY_TYPE);
  });

  it("recovers effect and all three scopes", () => {
    const props = irFor(OWNER_READ)!.properties;
    expect(props.effect).toBe("permit");
    expect(props.principal).toEqual({ is: "App::User" });
    expect(props.action).toEqual({ in: ['App::Action::"read"', 'App::Action::"list"'] });
    expect(props.resource).toEqual({ is: "App::Document" });
    expect(irFor(RESTRICT_DELETE)!.properties.action).toEqual({ eq: 'App::Action::"delete"' });
  });

  it("keeps the author's own condition text rather than a re-printed tree", () => {
    const props = irFor(OWNER_READ)!.properties;
    expect(props.when).toEqual(["resource.owner == principal"]);
    expect(props.unless).toEqual(["context.mfa == false"]);
  });

  it("does not let a record literal or a quoted brace end a clause early", () => {
    const statement = `@id("tricky")
permit (principal, action, resource)
when { context == { mfa: true, note: "}" } };`;
    expect(irFor(statement)!.properties.when).toEqual(['context == { mfa: true, note: "}" }']);
  });

  it("files a slotted policy as a template, which is Cedar's call and not this reader's", () => {
    const templated = `@id("linked")\npermit (principal == ?principal, action, resource);`;
    expect(irFor(templated)?.type).toBe("Cedar::Template");
  });

  it("refuses text the parser rejects rather than half-exporting it", () => {
    expect(irFor("this is not cedar")).toBeUndefined();
    expect(irFor("")).toBeUndefined();
  });

  it("round-trips: live statement → props → statement the parser still accepts", () => {
    const props = irFor(OWNER_READ)!.properties as CedarPolicyProps;
    const rerendered = avpStatement("ownerRead", props);

    expect(checkParsePolicySet({ staticPolicies: rerendered }).type).toBe("success");
    expect(irFor(rerendered)!.properties).toEqual(props);
  });
});

describe("exportAvpResources", () => {
  it("returns import IR keyed by the Cedar policy id", async () => {
    const ir = await run();
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["owner-read", "restrict-delete"]);
    expect(ir.resources[0].type).toBe(CEDAR_POLICY_TYPE);
    expect(ir.parameters).toEqual([]);
    expect(ir.metadata?.policyStoreId).toBe(STORE);
  });

  it("strips the server-written record by default", async () => {
    const ir = await run();
    const owner = ir.resources.find((r) => r.logicalId === "owner-read")!;

    expect(owner.properties.avp).toBeUndefined();
    expect(Object.keys(owner.properties).sort()).toEqual([
      "action",
      "annotations",
      "effect",
      "principal",
      "resource",
      "unless",
      "when",
    ]);
    // The marker in particular: baking one environment's ownership stamp into
    // regenerated source would make every environment claim to be that one.
    expect(JSON.stringify(owner.properties)).not.toContain("chant:managed-by");
  });

  it("keeps the whole server record under verbatim", async () => {
    const ir = await run({ verbatim: true });
    const owner = ir.resources.find((r) => r.logicalId === "owner-read")!;
    const avp = owner.properties.avp as Record<string, unknown>;

    expect(avp.policyId).toBe("p-1");
    expect(avp.policyStoreId).toBe(STORE);
    expect(avp.lastUpdatedDate).toBe("2026-08-01T00:00:00Z");
    expect(String(avp.description)).toContain("chant:managed-by");
    expect(avp.statement).toBe(OWNER_READ);
  });

  it("filters to chant-owned policies on owned:true", async () => {
    const ir = await run({ owned: true });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["owner-read"]);
  });

  it("applies a name selector", async () => {
    expect((await run({ selector: { name: "restrict-delete" } })).resources.map((r) => r.logicalId)).toEqual([
      "restrict-delete",
    ]);
  });

  it("applies a type selector, and yields nothing for another lexicon's type", async () => {
    expect((await run({ selector: { type: CEDAR_POLICY_TYPE } })).resources).toHaveLength(2);
    expect((await run({ selector: { type: "AWS::S3::Bucket" } })).resources).toEqual([]);
  });

  it("orders resources deterministically, whatever order the store enumerates", async () => {
    const ids = (await run()).resources.map((r) => r.logicalId);
    expect(ids).toEqual([...ids].sort());
  });

  it("exports a store that does not exist yet as an empty template", async () => {
    const ir = await run({ policyStoreId: "PS-other" });
    expect(ir.resources).toEqual([]);
  });

  it("throws rather than reporting an empty estate when the read fails", async () => {
    const { http } = mockAvpTransport({
      ...store,
      listFails: { code: "ThrottlingException", message: "Rate exceeded", status: 429 },
    });
    await expect(
      exportAvpResources({ environment: "prod", policyStoreId: STORE, client: { http }, env: MOCK_ENV }),
    ).rejects.toThrow(/Rate exceeded/);
  });

  it("throws when nothing binds the environment to a store", async () => {
    const { http } = mockAvpTransport(store);
    await expect(
      exportAvpResources({ environment: "prod", client: { http }, env: MOCK_ENV }),
    ).rejects.toThrow(/no AVP policy store/);
  });

  it("throws when there are no credentials", async () => {
    const { http } = mockAvpTransport(store);
    await expect(
      exportAvpResources({ environment: "prod", policyStoreId: STORE, client: { http }, env: {} }),
    ).rejects.toThrow(/no AWS credentials/);
  });

  it("drops a policy whose statement could not be read rather than exporting a hole", async () => {
    const flaky = mockAvpTransport({
      policyStoreId: STORE,
      policies: [
        { policyId: "p-1", statement: OWNER_READ, getFails: true },
        { policyId: "p-2", statement: RESTRICT_DELETE },
      ],
    });
    const ir = await exportAvpResources({
      environment: "prod",
      policyStoreId: STORE,
      client: { http: flaky.http },
      env: MOCK_ENV,
    });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["restrict-delete"]);
  });
});
