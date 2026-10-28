import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadHcl2json, parseTerraformDir } from "@intentius/chant/terraform/parse";
import { makeTemplateRequest, type TemplateInput, type TemplateRequest } from "@intentius/chant/template-request";
import { editPins } from "../pin/edit";
import { scanBlocks } from "../pin/scan";
import { readModulePin } from "../pin/source";
import { renderAddonCall, renderAppRoot, terraformInputType, TemplateRenderError } from "./index";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const GOLDEN = join(FIXTURES, "app-root.golden.tf");
const SOURCE = "registry.example.com/acme/orders/aws";
const CACHE = "registry.example.com/acme/cache/aws";

const parser = await loadHcl2json();

const APP_INPUTS: TemplateInput[] = [
  { name: "bucket_name", kind: "string" },
  { name: "replicas", kind: "number" },
  { name: "public", kind: "bool", default: false },
  { name: "readers", kind: "list", of: "string" },
  { name: "tags", kind: "map", of: "string" },
  { name: "retention_days", kind: "number", default: 30 },
  { name: "note", kind: "string", required: false },
];

const appRequest = (inputs: Record<string, unknown> = {}): TemplateRequest =>
  makeTemplateRequest({
    kind: "app",
    template: "acme/orders/aws",
    version: "1.2.0",
    app: "orders",
    inputs: {
      // Out of the template's order on purpose: the file follows the template.
      tags: { team: "payments", "cost-center": "42" },
      readers: ["svc-a", "svc-b"],
      public: true,
      replicas: 3,
      bucket_name: "orders-data",
      ...inputs,
    },
    requestedBy: "alice",
    via: "form",
  });

const OUTPUTS = [{ name: "endpoint" }, { name: "bucket_arn", description: "The bucket's ARN." }];

const renderApp = (request = appRequest()) => renderAppRoot({ request, source: SOURCE, inputs: APP_INPUTS, outputs: OUTPUTS });

const addonRequest = (inputs: Record<string, unknown>): TemplateRequest =>
  makeTemplateRequest({ kind: "addon", template: "acme/cache/aws", version: "2.0.1", app: "orders", addon: "cache", inputs, requestedBy: "bob", via: "cli" });

const ADDON_INPUTS: TemplateInput[] = [
  { name: "endpoint", kind: "string" },
  { name: "size", kind: "number", default: 1 },
];

const renderAddon = (inputs: Record<string, unknown>, appOutputs: string[] = ["endpoint", "bucket_arn"]) =>
  renderAddonCall({ request: addonRequest(inputs), source: CACHE, inputs: ADDON_INPUTS, appOutputs });

const refusal = (fn: () => unknown): TemplateRenderError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof TemplateRenderError) return e;
    throw e;
  }
  throw new Error("expected a TemplateRenderError");
};

describe("renderAppRoot", () => {
  test("a request with a string, a number, a bool, a list of strings and a map matches the golden file", () => {
    const files = renderApp();
    expect(files.map((f) => f.path)).toEqual(["main.tf"]);
    expect(files[0]!.text).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("the golden file parses with zero errors, into one module call and the re-exported outputs", async () => {
    const tree = (await parser.parse("main.tf", readFileSync(GOLDEN, "utf-8"))) as { module?: Record<string, unknown>; output?: Record<string, unknown> };
    expect(Object.keys(tree.module ?? {})).toEqual(["app"]);
    expect(Object.keys(tree.output ?? {}).sort()).toEqual(["app_bucket_arn", "app_endpoint"]);
    const graph = await parseTerraformDir(FIXTURES);
    expect(graph).toBeDefined();
  });

  test("the version is read back as 1.2.0, and the pin editor moves it", async () => {
    const [file] = renderApp();
    const call = scanBlocks(file!.text, "main.tf").find((b) => b.type === "module" && b.labels[0] === "app")!;
    const attr = (name: string) => call.attributes.find((a) => a.name === name)!.literal!.raw;
    expect(readModulePin(attr("source"), attr("version"))).toEqual({ module: SOURCE, at: "version", pin: "1.2.0" });

    const moved = await editPins(file!.text, "main.tf", { module: SOURCE, from: "1.2.0", to: "1.3.0" }, parser);
    expect(moved.calls.map((c) => c.outcome)).toEqual(["moved"]);
    expect(moved.content).toBe(file!.text.replace('version = "1.2.0"', 'version = "1.3.0"'));
  });

  test("the same request renders to the same bytes, whatever order its inputs and map keys came in", () => {
    const a = renderApp();
    const b = renderApp();
    expect(b).toEqual(a);
    const reordered = appRequest({ tags: { "cost-center": "42", team: "payments" } });
    expect(renderApp(reordered)).toEqual(a);
  });

  test("an input the request leaves out takes the template's default, or is left to the module", () => {
    const text = renderApp()[0]!.text;
    expect(text).toContain("retention_days = 30\n");
    expect(text).not.toContain("note");
    expect(renderApp(appRequest({ note: "hi ${x}" }))[0]!.text).toContain('note           = "hi $${x}"\n');
  });

  test("a string with quotes, a backslash, a template and control characters reads back as itself", async () => {
    const note = 'say "hi" \\ ${var.x} %{if} \n\r\t\u0001';
    const text = renderApp(appRequest({ note }))[0]!.text;
    expect(text).toContain('"say \\"hi\\" \\\\ $${var.x} %%{if} \\n\\r\\t\\u0001"');
    const tree = (await parser.parse("main.tf", text)) as { module: { app: Array<{ note: string }> } };
    // hcl2json hands a literal `${` back escaped, as Terraform's JSON syntax would write it.
    expect(tree.module.app[0]!.note.replace(/\$\$\{/g, "${").replace(/%%\{/g, "%{")).toBe(note);
  });

  test("a sensitive input becomes a sensitive root variable of its Terraform type", async () => {
    const inputs: TemplateInput[] = [{ name: "readers", kind: "list", of: "string" }, { name: "db_password", kind: "string", sensitive: true }];
    const request = makeTemplateRequest({ kind: "app", template: "acme/orders/aws", version: "1.2.0", app: "orders", inputs: { readers: [] }, requestedBy: "a", via: "cli" });
    const text = renderAppRoot({ request, source: SOURCE, inputs })[0]!.text;
    expect(text).toContain('variable "app_db_password" {\n  type      = string\n  sensitive = true\n}\n');
    expect(text).toContain("  readers     = []\n  db_password = var.app_db_password\n");
    await parser.parse("main.tf", text);
    expect(refusal(() => renderAppRoot({ request: { ...request, inputs: { readers: [], db_password: "x" } }, source: SOURCE, inputs })).code).toBe("sensitive-input");
  });

  test("objects and lists of maps open one line per entry, and still parse", async () => {
    const inputs: TemplateInput[] = [{ name: "settings", kind: "object" }];
    const request = makeTemplateRequest({
      kind: "app",
      template: "acme/orders/aws",
      version: "1.2.0",
      app: "orders",
      inputs: { settings: { rules: [{ port: 80 }], empty: {}, "a b": null } },
      requestedBy: "a",
      via: "cli",
    });
    const text = renderAppRoot({ request, source: SOURCE, inputs })[0]!.text;
    expect(text).toContain('  settings = {\n    "a b" = null\n    empty = {}\n    rules = [\n      {\n        port = 80\n      },\n    ]\n  }\n');
    const tree = (await parser.parse("main.tf", text)) as { module: { app: Array<{ settings: unknown }> } };
    expect(tree.module.app[0]!.settings).toEqual({ "a b": null, empty: {}, rules: [{ port: 80 }] });
  });

  test("refusals: wrong kind, a version that is not exact, unknown, missing and mistyped inputs", () => {
    expect(refusal(() => renderAppRoot({ request: addonRequest({}), source: SOURCE, inputs: APP_INPUTS })).code).toBe("wrong-kind");
    expect(refusal(() => renderApp({ ...appRequest(), version: "~> 1.2" })).code).toBe("not-a-version");
    expect(refusal(() => renderApp({ ...appRequest(), version: `sha256:${"a".repeat(64)}` })).code).toBe("not-a-version");
    const unknown = refusal(() => renderApp(appRequest({ colour: "red" })));
    expect([unknown.code, unknown.subject]).toEqual(["unknown-input", "colour"]);
    const { bucket_name: _b, ...rest } = appRequest().inputs;
    const missing = refusal(() => renderApp({ ...appRequest(), inputs: rest }));
    expect([missing.code, missing.subject]).toEqual(["missing-input", "bucket_name"]);
    const typed = refusal(() => renderApp(appRequest({ replicas: "3" })));
    expect([typed.code, typed.subject]).toEqual(["input-type", "replicas"]);
    // An app root has no app module to reference yet.
    expect(refusal(() => renderApp(appRequest({ replicas: "app.endpoint" }))).code).toBe("input-type");
  });
});

describe("renderAddonCall", () => {
  test("an input app.endpoint becomes module.app.endpoint in addon-<name>.tf", async () => {
    const file = renderAddon({ endpoint: "app.endpoint" });
    expect(file.path).toBe("addon-cache.tf");
    expect(file.text).toBe(
      [
        "# The add-on cache of the app orders, from the template acme/cache/aws. Written by chant from a template request; a rollout moves the version.",
        "",
        'module "cache" {',
        `  source  = "${CACHE}"`,
        '  version = "2.0.1"',
        "",
        "  endpoint = module.app.endpoint",
        "  size     = 1",
        "}",
        "",
      ].join("\n"),
    );
    const tree = (await parser.parse("addon-cache.tf", file.text)) as { module: { cache: Array<{ endpoint: string }> } };
    expect(tree.module.cache[0]!.endpoint).toBe("${module.app.endpoint}");
  });

  test("app.missing is refused with unknown-output naming missing", () => {
    const e = refusal(() => renderAddon({ endpoint: "app.missing" }));
    expect(e.code).toBe("unknown-output");
    expect(e.subject).toBe("missing");
    expect(e.message).toMatch(/^unknown-output: .*\bmissing\b/);
  });

  test("the app's outputs may be given as the catalog lists them", () => {
    const file = renderAddonCall({ request: addonRequest({ endpoint: "app.endpoint", size: 2 }), source: CACHE, inputs: ADDON_INPUTS, appOutputs: [{ name: "endpoint", description: null, sensitive: false }] });
    expect(file.text).toContain("  endpoint = module.app.endpoint\n  size     = 2\n");
  });

  test("a string that only looks like a reference stays a string", () => {
    expect(renderAddon({ endpoint: "app.endpoint.extra" }).text).toContain('  endpoint = "app.endpoint.extra"\n');
  });

  test("the same add-on request renders to the same bytes", () => {
    expect(renderAddon({ endpoint: "app.endpoint", size: 3 })).toEqual(renderAddon({ size: 3, endpoint: "app.endpoint" }));
  });

  test("refusals: an add-on named app, no add-on name, and a request for an app", () => {
    expect(refusal(() => renderAddonCall({ request: { ...addonRequest({ endpoint: "x" }), addon: "app" }, source: CACHE, inputs: ADDON_INPUTS, appOutputs: [] })).code).toBe("bad-name");
    const { addon: _a, ...noName } = addonRequest({ endpoint: "x" });
    expect(refusal(() => renderAddonCall({ request: noName as TemplateRequest, source: CACHE, inputs: ADDON_INPUTS, appOutputs: [] })).code).toBe("bad-name");
    expect(refusal(() => renderAddonCall({ request: appRequest(), source: CACHE, inputs: APP_INPUTS, appOutputs: [] })).code).toBe("wrong-kind");
  });
});

describe("terraformInputType", () => {
  test("each engine-neutral kind maps to a Terraform type", () => {
    const rows: Array<[Pick<TemplateInput, "kind" | "of">, string]> = [
      [{ kind: "string" }, "string"],
      [{ kind: "number" }, "number"],
      [{ kind: "bool" }, "bool"],
      [{ kind: "list", of: "string" }, "list(string)"],
      [{ kind: "list" }, "list(any)"],
      [{ kind: "map", of: "number" }, "map(number)"],
      [{ kind: "map" }, "map(any)"],
      [{ kind: "object" }, "any"],
    ];
    for (const [input, type] of rows) expect(terraformInputType(input)).toBe(type);
  });
});
