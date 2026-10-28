/**
 * template-request/v1 and template.yml/v1 (#4651): the schemas, one test per
 * refusal code, the branch, and the pull request body's golden and
 * round trip.
 */
import { describe, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import requestSchema from "./template-request.schema.json";
import templateSchema from "./template.schema.json";
import pkg from "../../package.json";
import { buildReleaseCatalog } from "../lifecycle/release-catalog";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import { NEXT_RELEASE } from "../release-floors";
import { resolveProductWords } from "../ci-product-words";
import {
  checkTemplateRequest,
  inputKindProblem,
  isAppOutputRef,
  makeTemplateRequest,
  parseRequestBody,
  parseTemplateSpec,
  requestBody,
  requestBranch,
  TEMPLATE_INPUT_KINDS,
  TEMPLATE_REQUEST_FLOOR,
  TEMPLATE_REQUEST_SCHEMA_ID,
  TEMPLATE_SPEC_SCHEMA_ID,
  TemplateSpecError,
  templateName,
  templateSpecProblems,
  validateTemplateRequest,
  type TemplateRequest,
  type TemplateRequestRefusalCode,
} from "./index";

const rec = (over: Partial<ReleaseRecord>): ReleaseRecord => ({
  version: 1,
  component: "acme/bucket/aws",
  env: "registry",
  digest: "sha256:aaa",
  gitSha: "1111111111111111111111111111111111111111",
  runId: "run-1",
  timestamp: "2026-10-01T00:00:00.000Z",
  actor: "ci",
  ...over,
});

const catalog = buildReleaseCatalog(
  {
    releases: [
      rec({ releaseVersion: "1.0.0", digest: "sha256:v1", timestamp: "2026-10-01T00:00:00.000Z" }),
      rec({ releaseVersion: "1.1.0", digest: "sha256:v11", timestamp: "2026-10-05T00:00:00.000Z" }),
      rec({ releaseVersion: "1.2.0", digest: "sha256:v12", timestamp: "2026-10-09T00:00:00.000Z" }),
      rec({ releaseVersion: "2.0.0", digest: "sha256:v2", timestamp: "2026-10-10T00:00:00.000Z" }),
    ],
    statuses: [{ component: "acme/bucket/aws", digest: "sha256:v11", status: "yanked", reason: "leaks", replacement: "1.2.0", actor: "ops", timestamp: "2026-10-06T00:00:00.000Z" }],
    attestations: [
      { component: "acme/bucket/aws", digest: "sha256:v1", state: "signed" },
      { component: "acme/bucket/aws", digest: "sha256:v11", state: "signed" },
      { component: "acme/bucket/aws", digest: "sha256:v2", state: "verified" },
    ],
  },
  { generatedAt: "2026-10-27T00:00:00.000Z", chant: "0.0.0-test" },
);

const TEMPLATE_YML = `contract: 1
description: An object store bucket for one app.
inputs:
  - name: bucket_name
    kind: string
    label: Bucket name
  - name: versioning
    kind: bool
    default: true
  - name: retention_days
    kind: number
    default: 30
  - name: tags
    kind: map
    of: string
    default: {}
  - name: readers
    kind: list
    of: string
    required: false
  - name: kms_key
    kind: string
    sensitive: true
`;

const spec = parseTemplateSpec(TEMPLATE_YML);

const base = (over: Partial<TemplateRequest> = {}): TemplateRequest =>
  ({
    ...makeTemplateRequest({
      kind: "app",
      template: "acme/bucket/aws",
      version: "1.0.0",
      app: "orders",
      inputs: { bucket_name: "orders-data", tags: { team: "payments" } },
      requestedBy: "alice",
      via: "form",
    }),
    ...over,
  }) as TemplateRequest;

describe("schemas", () => {
  test("both are valid draft 2020-12 documents under template-request/v1", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(ajv.validateSchema(requestSchema)).toBe(true);
    expect(ajv.validateSchema(templateSchema)).toBe(true);
    expect(requestSchema.$id).toBe(TEMPLATE_REQUEST_SCHEMA_ID);
    expect(TEMPLATE_REQUEST_SCHEMA_ID.endsWith("template-request/v1/template-request.schema.json")).toBe(true);
    expect(TEMPLATE_SPEC_SCHEMA_ID.endsWith("template-request/v1/template.schema.json")).toBe(true);
    expect(Object.keys(requestSchema.properties).sort()).toEqual(["$schema", "addon", "app", "claimedBy", "contract", "inputs", "kind", "requestedBy", "template", "version", "via"]);
  });

  test("the input kinds are the schema's, and each is documented there", () => {
    expect(templateSchema.$defs.kind.enum).toEqual([...TEMPLATE_INPUT_KINDS]);
    for (const k of TEMPLATE_INPUT_KINDS) expect(templateSchema.$defs.kind.description).toContain(`${k}:`);
  });

  test("the floor is the next release", () => {
    expect(TEMPLATE_REQUEST_FLOOR).toBe(NEXT_RELEASE);
  });

  test("the package exports ./template-request and its schemas", () => {
    const exports = pkg.exports as Record<string, unknown>;
    expect(exports["./template-request"]).toMatchObject({ development: "./src/template-request/index.ts", import: "./dist/template-request/index.js" });
    expect(exports["./template-request/*.schema.json"]).toBe("./src/template-request/*.schema.json");
  });
});

describe("template.yml", () => {
  test("parses, with required read from the default", () => {
    expect(spec.inputs.map((i) => i.name)).toEqual(["bucket_name", "versioning", "retention_days", "tags", "readers", "kms_key"]);
  });

  test("refuses a repeated name, a default of the wrong kind, a required input with a default, and `of` on a scalar", () => {
    const doc = {
      contract: 1,
      description: "x",
      inputs: [
        { name: "a", kind: "number", default: "3" },
        { name: "a", kind: "string" },
        { name: "b", kind: "bool", default: false, required: true },
      ],
    };
    const problems = templateSpecProblems(doc);
    expect(problems).toEqual([
      '/inputs/0 (a) default is string, and the input is a number',
      '/inputs/1 (a) repeats the name "a"',
      "/inputs/2 (b) is required and has a default; an input with a default is optional",
    ]);
    expect(templateSpecProblems({ contract: 1, description: "x", inputs: [{ name: "c", kind: "string", of: "string" }] }).length).toBeGreaterThan(0);
    expect(templateSpecProblems({ contract: 1, description: "x", inputs: [{ name: "c", kind: "tuple" }] }).length).toBeGreaterThan(0);
    expect(() => parseTemplateSpec("contract: 1\n")).toThrow(TemplateSpecError);
    expect(() => parseTemplateSpec("a: [\n")).toThrow(/not YAML/);
  });

  test("kind checks", () => {
    expect(inputKindProblem({ kind: "number" }, Number.NaN)).toBeDefined();
    expect(inputKindProblem({ kind: "list", of: "number" }, [1, "2"])).toBe("is a list whose element 1 is string, and the input is a list of number");
    expect(inputKindProblem({ kind: "list" }, [1, "2"])).toBeUndefined();
    expect(inputKindProblem({ kind: "map", of: "bool" }, { a: true, b: 1 })).toBe('is a map whose "b" is number, and the input is a map of bool');
    expect(inputKindProblem({ kind: "object" }, [])).toBe("is list, and the input is a object");
    expect(inputKindProblem({ kind: "string" }, null)).toBe("is null, and the input is a string");
  });
});

describe("checkTemplateRequest", () => {
  test("accepts a request the catalog and template allow", () => {
    expect(checkTemplateRequest(base(), catalog, spec)).toEqual({ ok: true, request: base() });
  });

  const cases: Array<[TemplateRequestRefusalCode, unknown, string, RegExp]> = [
    ["unknown-version", base({ version: "9.9.9" }), "version", /version "9\.9\.9" of acme\/bucket\/aws is not in the catalog/],
    ["not-active", base({ version: "1.1.0" }), "version", /version 1\.1\.0 of acme\/bucket\/aws is yanked; use 1\.2\.0/],
    ["unsigned", base({ version: "1.2.0" }), "version", /version 1\.2\.0 of acme\/bucket\/aws is unsigned, and requests need signed/],
    ["unknown-input", base({ inputs: { bucket_name: "b", colour: "red" } }), "inputs.colour", /inputs\.colour: .* has no input "colour"/],
    ["missing-input", base({ inputs: {} }), "inputs.bucket_name", /inputs\.bucket_name is required/],
    ["sensitive-input", base({ inputs: { bucket_name: "b", kms_key: "k" } }), "inputs.kms_key", /inputs\.kms_key is sensitive/],
    ["input-type", base({ inputs: { bucket_name: "b", retention_days: "30" } }), "inputs.retention_days", /inputs\.retention_days is string, and the input is a number/],
    ["bad-name", base({ app: "Orders" }), "app", /app "Orders" is not a name/],
  ];
  test.each(cases)("%s", (code, request, field, reason) => {
    const out = checkTemplateRequest(request, catalog, spec);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toHaveLength(1);
    expect(out.refusals[0]).toMatchObject({ code, field });
    expect(out.refusals[0]!.reason).toMatch(reason);
    expect(out.refusals[0]!.reason).toContain(field);
  });

  test("bad-name covers the add-on, and a deprecated version is not active either", () => {
    const addon = checkTemplateRequest(base({ kind: "addon", addon: "9cache" }), catalog, spec);
    expect(addon.ok ? [] : addon.refusals.map((r) => [r.code, r.field])).toEqual([["bad-name", "addon"]]);
    const deprecated = buildReleaseCatalog(
      { releases: [rec({ releaseVersion: "1.0.0" })], statuses: [{ component: "acme/bucket/aws", digest: "sha256:aaa", status: "deprecated", actor: "ops", timestamp: "2026-10-02T00:00:00.000Z" }], attestations: [{ component: "acme/bucket/aws", digest: "sha256:aaa", state: "signed" }] },
      { generatedAt: "2026-10-27T00:00:00.000Z", chant: "0.0.0-test" },
    );
    const out = checkTemplateRequest(base(), deprecated, spec);
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual(["not-active"]);
  });

  test("a template the catalog does not list is unknown-version; `component` names it", () => {
    const out = checkTemplateRequest(base({ template: "acme/queue/aws" }), catalog, spec);
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual(["unknown-version"]);
    expect(checkTemplateRequest(base({ template: "registry.example/acme/bucket/aws" }), catalog, spec, { component: "acme/bucket/aws" }).ok).toBe(true);
  });

  test("require: unsigned accepts any attestation, verified refuses signed", () => {
    expect(checkTemplateRequest(base({ version: "1.2.0" }), catalog, spec, { require: "unsigned" }).ok).toBe(true);
    const out = checkTemplateRequest(base(), catalog, spec, { require: "verified" });
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual(["unsigned"]);
    expect(checkTemplateRequest(base({ version: "2.0.0" }), catalog, spec, { require: "verified" }).ok).toBe(true);
  });

  test("an add-on's app.<output> is accepted for any kind; an app request checks it as a string", () => {
    const refs = { bucket_name: "app.bucket_id", retention_days: "app.retention", readers: "app.reader_arns", tags: "app.tags" };
    const addon = base({ kind: "addon", addon: "cache", inputs: refs });
    expect(checkTemplateRequest(addon, catalog, spec)).toEqual({ ok: true, request: addon });
    const app = checkTemplateRequest(base({ inputs: refs }), catalog, spec);
    expect(app.ok ? [] : app.refusals.map((r) => [r.code, r.field])).toEqual([
      ["input-type", "inputs.retention_days"],
      ["input-type", "inputs.readers"],
      ["input-type", "inputs.tags"],
    ]);
    for (const r of app.ok ? [] : app.refusals) expect(r.reason).toMatch(/reads as an app output, and only an add-on request can name one/);
    const notRef = checkTemplateRequest(base({ kind: "addon", addon: "cache", inputs: { bucket_name: "b", retention_days: "app.9x" } }), catalog, spec);
    expect(notRef.ok ? [] : notRef.refusals.map((r) => [r.code, r.reason.includes("app output")])).toEqual([["input-type", false]]);
  });

  test("isAppOutputRef", () => {
    expect(["app.private_subnets", "app.x", "app._a-b"].every(isAppOutputRef)).toBe(true);
    expect(["app.", "app.9x", "app.a.b", "module.app.x", " app.x", 3, null, ["app.x"]].some(isAppOutputRef)).toBe(false);
  });

  test("a document the schema refuses is invalid", () => {
    const { via: _via, ...noVia } = base();
    const out = checkTemplateRequest(noVia, catalog, spec);
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual(["invalid"]);
    const appWithAddon = checkTemplateRequest(base({ addon: "cache" }), catalog, spec);
    expect(appWithAddon.ok).toBe(false);
    const addonWithout = checkTemplateRequest(base({ kind: "addon" }), catalog, spec);
    expect(addonWithout.ok).toBe(false);
  });
});

describe("requestBranch", () => {
  test("request/<template-name>/<app>[/<addon>]", () => {
    expect(requestBranch({ kind: "app", template: "acme/bucket/aws", app: "orders" })).toBe("request/bucket/orders");
    expect(requestBranch({ kind: "app", template: "acme/bucket/aws", app: "orders", addon: "cache" })).toBe("request/bucket/orders/cache");
    expect(requestBranch({ kind: "addon", template: "acme/bucket/aws", app: "orders", addon: "cache" })).toBe("request/bucket/orders/cache");
  });

  test("the template name of an address", () => {
    expect(templateName("registry.example/acme/bucket/aws")).toBe("bucket");
    expect(templateName("acme/bucket")).toBe("bucket");
    expect(templateName("bucket")).toBe("bucket");
  });
});

describe("requestBody", () => {
  const words = resolveProductWords({ product: "terragucci" });
  const request = makeTemplateRequest({
    kind: "app",
    template: "acme/bucket/aws",
    version: "1.0.0",
    app: "orders",
    inputs: { bucket_name: "orders-data", tags: { team: "pay|ments" }, readers: ["svc-a", "svc-b"] },
    requestedBy: "alice",
    claimedBy: "bob",
    via: "mcp",
  });

  test("matches the golden", async () => {
    await expect(requestBody(request, words)).toMatchFileSnapshot("./__fixtures__/request-body.md");
  });

  test("names the template, version, every input, the requester, via, and that nothing was applied", () => {
    const body = requestBody(request, words);
    for (const s of ["`acme/bucket/aws`", "`1.0.0`", "`alice`", "an agent over MCP", "| `bucket_name` |", "| `readers` |", "| `tags` |", "Nothing was applied or approved."]) expect(body).toContain(s);
    expect(requestBody(request, resolveProductWords({ product: "plywood", verbs: { plan: ["preview", "previewed"], apply: ["update", "updated"] } }))).toContain("Nothing was updated or approved.");
  });

  test("the fenced block parses back to the request", () => {
    expect(parseRequestBody(requestBody(request, words))).toEqual(request);
    const addon = base({ kind: "addon", addon: "cache", inputs: { note: "a ```fence``` inside" } });
    const body = requestBody(addon, words);
    expect(body).toContain("add-on `cache` for app `orders`");
    expect(parseRequestBody(body)).toEqual(addon);
    expect(parseRequestBody(body.replace(/\n/g, "\r\n"))).toEqual(addon);
  });

  test("a claimed requester gets its own row, labelled as claimed, only when set", () => {
    const body = requestBody(request, words);
    expect(body).toContain("| Claimed by (as given by the client; the forge does not vouch for it) | `bob` |");
    expect(parseRequestBody(body)?.claimedBy).toBe("bob");
    const without = base();
    expect(without).not.toHaveProperty("claimedBy");
    const plain = requestBody(without, words);
    expect(plain).not.toContain("Claimed by");
    expect(parseRequestBody(plain)).toEqual(without);
    expect(parseRequestBody(plain)).not.toHaveProperty("claimedBy");
    expect(validateTemplateRequest({ ...without, claimedBy: "" }).length).toBeGreaterThan(0);
    expect(validateTemplateRequest({ ...without, claimedBy: 7 }).length).toBeGreaterThan(0);
  });

  test("a body without the block, or with a broken one, carries no request", () => {
    expect(parseRequestBody("no request here")).toBeUndefined();
    expect(parseRequestBody(`\`\`\`json ${TEMPLATE_REQUEST_SCHEMA_ID}\n{"x":1}\n\`\`\`\n`)).toBeUndefined();
    expect(parseRequestBody(`\`\`\`json ${TEMPLATE_REQUEST_SCHEMA_ID}\n{not json\n\`\`\`\n`)).toBeUndefined();
  });
});
