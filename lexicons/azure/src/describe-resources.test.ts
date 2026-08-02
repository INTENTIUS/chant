import { describe, test, expect, vi } from "vitest";

const { describeResources } = await import("./describe-resources");

/** An ARM response, in place of the CLI stdout this used to fake (#1212). */
const armOk = (body: unknown) => ({ status: 200, text: JSON.stringify(body) });
/** ARM's error envelope: the code is the signal, the message is for the human. */
const armError = (status: number, code: string, message: string) => ({
  status,
  text: JSON.stringify({ error: { code, message } }),
});

/** Records every ARM URL the reader asked for, so a test can assert the address. */
function httpFake(respond: (url: string) => { status: number; text: string }) {
  const urls: string[] = [];
  const http = async (_method: string, url: string) => {
    urls.push(url);
    return respond(url);
  };
  return { http, urls };
}

function makeEntities(records: Array<{ name: string; entityType: string; props: Record<string, unknown> }>) {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

describe("azure describeResources", () => {
  test("queries az resource show with rg + name + type and maps response", async () => {
    const fake = httpFake(() =>
      armOk({
          id: "/subscriptions/sub/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/mydata",
          name: "mydata",
          type: "Microsoft.Storage/storageAccounts",
          location: "eastus",
          properties: { provisioningState: "Succeeded" },
        tags: { env: "prod" },
      }),
    );

    const entities = makeEntities([
      { name: "dataAccount", entityType: "Microsoft.Storage/storageAccounts", props: { name: "mydata" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["dataAccount"], entities, http: fake.http });

    // The resource group is the environment, and the type and name address the
    // resource — the same URL shape the applier PUTs to.
    expect(fake.urls[0]).toContain("/resourceGroups/prod-rg/");
    expect(fake.urls[0]).toContain("/providers/Microsoft.Storage/storageAccounts/mydata");
    expect(fake.urls[0]).toContain("api-version=");

    expect(result.resources["dataAccount"]).toMatchObject({
      type: "Microsoft.Storage/storageAccounts",
      physicalId: "/subscriptions/sub/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/mydata",
      status: "Succeeded",
      attributes: expect.objectContaining({ location: "eastus", tags: { env: "prod" } }),
    });
  });

  test("missing provisioningState falls back to PRESENT", async () => {
    const fake = httpFake(() =>
      armOk({ id: "id", name: "x", type: "Microsoft.Network/virtualNetworks", location: "eastus", properties: {} }),
    );

    const entities = makeEntities([
      { name: "vnet", entityType: "Microsoft.Network/virtualNetworks", props: { name: "x" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["vnet"], entities, http: fake.http });

    expect(result.resources["vnet"].status).toBe("PRESENT");
  });

  test("az failure (resource not found) leaves entity out — a confirmed absence", async () => {
    const fake = httpFake(() => armError(404, "ResourceNotFound", "The Resource was not found."));

    const entities = makeEntities([
      { name: "missing", entityType: "Microsoft.Storage/storageAccounts", props: { name: "missing" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["missing"], entities, http: fake.http });

    expect(result.resources).toEqual({});
    expect(result.unobserved ?? {}).toEqual({});
  });

  test("a refused credential is unobserved, not absent (#1089)", async () => {
    const fake = httpFake(() =>
      armError(401, "AuthenticationFailed", "Authentication failed. The 'Authorization' header is missing."),
    );

    const entities = makeEntities([
      { name: "acct", entityType: "Microsoft.Storage/storageAccounts", props: { name: "acct" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["acct"], entities, http: fake.http });

    expect(result.resources).toEqual({});
    expect(result.unobserved?.acct?.reason).toBe("no-credentials");
  });

  test("nested-type entities are unobserved, not absent (#1089)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = httpFake(() => armOk({}));
    const entities = makeEntities([
      { name: "nested", entityType: "Microsoft.Storage/storageAccounts/blobServices", props: { name: "x" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["nested"], entities, http: fake.http });

    expect(result.resources).toEqual({});
    expect(result.unobserved?.nested).toMatchObject({
      type: "Microsoft.Storage/storageAccounts/blobServices",
      reason: "unsupported-kind",
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nested-type"));
    expect(fake.urls).toEqual([]);
    warnSpy.mockRestore();
  });

  test("non-Azure entity types are unobserved — no ARM type to query", async () => {
    const fake = httpFake(() => armOk({}));
    const entities = makeEntities([
      { name: "x", entityType: "AWS::S3::Bucket", props: { name: "x" } },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["x"], entities, http: fake.http });

    expect(result.resources).toEqual({});
    expect(result.unobserved?.x?.reason).toBe("unsupported-kind");
    expect(fake.urls).toEqual([]);
  });

  test("entity without name is unobserved — nothing was queried", async () => {
    const fake = httpFake(() => armOk({}));
    const entities = makeEntities([
      { name: "broken", entityType: "Microsoft.Storage/storageAccounts", props: {} },
    ]);

    const result = await describeResources({ environment: "prod-rg", buildOutput: "", entityNames: ["broken"], entities, http: fake.http });

    expect(result.resources).toEqual({});
    expect(result.unobserved?.broken?.reason).toBe("read-failed");
    expect(fake.urls).toEqual([]);
  });
});
