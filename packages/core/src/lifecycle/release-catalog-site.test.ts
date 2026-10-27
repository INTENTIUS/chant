/**
 * The release catalog site (#4595): two components, one a Terraform module
 * and one an npm package filled with `npm` fields (so plywood can use the
 * renderer as it is), a deprecated and a yanked version, engine sections,
 * escaping, relative links and stable bytes.
 */
import { describe, expect, test } from "vitest";
import type { ReleaseRecord } from "./release-ledger";
import { buildReleaseCatalog, parseReleaseCatalog } from "./release-catalog";
import { catalogPathSegments, renderCatalogSite, type CatalogSiteSections } from "./release-catalog-site";

const rec = (over: Partial<ReleaseRecord>): ReleaseRecord => ({
  version: 1,
  component: "vpc/aws",
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
      rec({ releaseVersion: "1.0.0", digest: "sha256:v1" }),
      rec({ releaseVersion: "1.1.0", digest: "sha256:v11", timestamp: "2026-10-02T00:00:00.000Z" }),
      rec({ releaseVersion: "2.0.0", digest: "sha256:v2", timestamp: "2026-10-03T00:00:00.000Z" }),
      rec({ component: "@acme/widgets", env: "npm", releaseVersion: "0.4.0", digest: "sha512:w4", timestamp: "2026-10-04T00:00:00.000Z" }),
    ],
    statuses: [
      { component: "vpc/aws", digest: "sha256:v1", status: "deprecated", reason: "use <1.1.0> & newer", replacement: "1.1.0", actor: "ana", timestamp: "2026-10-05T00:00:00.000Z" },
      { component: "vpc/aws", digest: "sha256:v2", status: "yanked", reason: "breaks routes", replacement: "1.1.0", actor: "ana", timestamp: "2026-10-05T00:00:00.000Z" },
    ],
    changelogs: [{ component: "vpc/aws", version: "1.1.0", bump: "minor", entries: [{ kind: "feat", sha: "abcdef0123456789", subject: "add flow logs", scope: "vpc" }, { kind: "fix", sha: "0123456789abcdef", subject: "tag subnets" }] }],
    attestations: [{ component: "vpc/aws", digest: "sha256:v11", state: "verified", verify: "cosign verify-blob --bundle vpc.bundle vpc.tgz" }],
    consumers: [{ component: "vpc/aws", version: "1.1.0", consumers: [{ repo: "acme/live", root: "prod", file: "prod/main.tf", address: "module.vpc" }] }],
    fields: [
      { component: "vpc/aws", engine: "terraform", fields: { source: "registry.acme.dev/acme/vpc/aws" } },
      { component: "@acme/widgets", engine: "npm", fields: { package: "@acme/widgets", registry: "https://registry.npmjs.org" } },
      { component: "@acme/widgets", version: "0.4.0", engine: "npm", fields: { exports: ["."], engines: { node: ">=20" } } },
    ],
  },
  { generatedAt: "2026-10-27T00:00:00.000Z", chant: "0.0.0-test" },
);

/** An engine's sections, read only from its own `fields` key: the npm fixture stands in for plywood. */
const sections: CatalogSiteSections = {
  component: (c) => {
    const npm = c.fields.npm as { package?: string } | undefined;
    if (npm?.package) return [{ title: "Install", body: { kind: "code", text: `npm install ${npm.package}` } }];
    const tf = c.fields.terraform as { source?: string } | undefined;
    if (tf?.source) return [{ title: "Usage", body: { kind: "code", text: `module "x" {\n  source = "${tf.source}"\n}` } }];
    return [];
  },
  version: (_c, v) => {
    const npm = v.fields.npm as { engines?: { node?: string } } | undefined;
    return npm?.engines?.node ? [{ title: "Engines", body: { kind: "table", columns: ["Engine", "Range"], rows: [["node", npm.engines.node]] } }] : [];
  },
};

const files = renderCatalogSite(catalog, sections, { title: "Acme modules" });
const text = (path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} in ${files.map((x) => x.path).join(", ")}`);
  return new TextDecoder().decode(f.bytes);
};

describe("renderCatalogSite", () => {
  test("writes the index, the search files, and a page per component and per version", () => {
    expect(files.map((f) => f.path)).toEqual([
      "_acme/widgets/0.4.0/index.html",
      "_acme/widgets/index.html",
      "index.html",
      "index.json",
      "search.js",
      "style.css",
      "vpc/aws/1.0.0/index.html",
      "vpc/aws/1.1.0/index.html",
      "vpc/aws/2.0.0/index.html",
      "vpc/aws/index.html",
    ]);
    expect(files.find((f) => f.path === "index.html")?.contentType).toBe("text/html; charset=utf-8");
    expect(files.find((f) => f.path === "index.json")?.contentType).toBe("application/json");
  });

  test("index.json is the catalog, so a reader parses it back", () => {
    expect(parseReleaseCatalog(text("index.json"))).toEqual(catalog);
  });

  test("the index lists both components with relative links", () => {
    const index = text("index.html");
    expect(index).toContain('<a href="vpc/aws/index.html">vpc/aws</a>');
    expect(index).toContain('<a href="_acme/widgets/index.html">@acme/widgets</a>');
    expect(index).toContain('<script src="search.js" defer></script>');
    expect(index).toContain('href="style.css"');
  });

  test("a deprecated version says so, escapes the reason and links its replacement", () => {
    const page = text("vpc/aws/1.0.0/index.html");
    expect(page).toContain('<span class="status status-deprecated">deprecated</span>');
    expect(page).toContain("use &lt;1.1.0&gt; &amp; newer");
    expect(page).toContain('<a href="../1.1.0/index.html">1.1.0</a>');
    expect(page).toContain('href="../../../style.css"');
  });

  test("a yanked version says so", () => {
    const page = text("vpc/aws/2.0.0/index.html");
    expect(page).toContain("status-yanked");
    expect(page).toContain("This version is yanked: breaks routes");
  });

  test("an active version shows its changelog, attestation line and consumers", () => {
    const page = text("vpc/aws/1.1.0/index.html");
    expect(page).not.toContain('class="notice"');
    expect(page).toContain("<h3>Features</h3>");
    expect(page).toContain("<b>vpc</b> add flow logs");
    expect(page).toContain("<h3>Fixes</h3>");
    expect(page).toContain("cosign verify-blob --bundle vpc.bundle vpc.tgz");
    expect(page).toContain("<td>acme/live</td><td>prod</td><td>prod/main.tf</td><td>module.vpc</td>");
  });

  test("the npm component renders from its own fields with no Terraform word", () => {
    const comp = text("_acme/widgets/index.html");
    expect(comp).toContain("npm install @acme/widgets");
    expect(comp).not.toMatch(/terraform|module "/i);
    const ver = text("_acme/widgets/0.4.0/index.html");
    expect(ver).toContain("<td>node</td><td>&gt;=20</td>");
    expect(text("vpc/aws/index.html")).toContain("source = &quot;registry.acme.dev/acme/vpc/aws&quot;");
  });

  test("the same catalog renders the same bytes", () => {
    const again = renderCatalogSite(catalog, sections, { title: "Acme modules" });
    expect(again.map((f) => [f.path, Buffer.from(f.bytes).toString("base64")])).toEqual(files.map((f) => [f.path, Buffer.from(f.bytes).toString("base64")]));
  });

  test("path segments stay inside the site", () => {
    expect(catalogPathSegments("../etc")).toEqual(["_..", "etc"]);
    expect(catalogPathSegments("sha256:abc")).toEqual(["sha256_abc"]);
  });
});
