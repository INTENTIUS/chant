/**
 * #5481: a VEX statement clears a finding only in the products it names. The
 * statement below has the shape of the one a downstream project records for
 * GO-2026-6612 in the OpenTofu binary two of its CI images carry: two image
 * repositories, each with OpenTofu and golang.org/x/net as subcomponents.
 */
import { describe, expect, test } from "vitest";
import { applyScopedVex, parsePurl, parseVexDocument, purlCovers, statementCovers, validateScopedStatements, type VexSubject } from "./vex";
import type { VulnFinding } from "./vuln-scan";

const TOFU_X_NET = JSON.stringify({
  "@context": "https://openvex.dev/ns/v0.2.0",
  "@id": "https://example.test/vex/tofu-1.13.9-x-net.openvex.json",
  author: "maintainers",
  timestamp: "2026-11-22T00:00:00Z",
  version: 1,
  statements: [
    {
      vulnerability: { "@id": "https://pkg.go.dev/vuln/GO-2026-6612", name: "GO-2026-6612", aliases: ["CVE-2026-78663"] },
      products: [
        {
          "@id": "pkg:oci/terragucci-tofu?repository_url=ghcr.io/intentius/terragucci-tofu",
          subcomponents: [{ "@id": "pkg:golang/github.com/opentofu/opentofu@v1.13.9" }, { "@id": "pkg:golang/golang.org/x/net@v0.57.0" }],
        },
        {
          "@id": "pkg:oci/terragucci-terragrunt?repository_url=ghcr.io/intentius/terragucci-terragrunt",
          subcomponents: [{ "@id": "pkg:golang/github.com/opentofu/opentofu@v1.13.9" }, { "@id": "pkg:golang/golang.org/x/net@v0.57.0" }],
        },
      ],
      status: "not_affected",
      justification: "vulnerable_code_not_present",
    },
  ],
});

const xNet = (over: Partial<VulnFinding> = {}): VulnFinding => ({
  cveId: "GO-2026-6612",
  severity: "high",
  package: "golang.org/x/net",
  installedVersion: "v0.57.0",
  purl: "pkg:golang/golang.org/x/net@v0.57.0",
  fixedVersion: "v0.60.0",
  fixable: true,
  ...over,
});

const image = (name: string, tags: string[] = ["1.4.0"]): VexSubject => ({ repository: `ghcr.io/intentius/${name}`, digest: "sha256:" + "a".repeat(64), tags });

describe("a statement applies where it names", () => {
  const statements = parseVexDocument(TOFU_X_NET, "security/vex/tofu-1.13.9-x-net.openvex.json");

  test("the terragucci statement parses to two products with their subcomponents, named by file and index", () => {
    expect(statements).toHaveLength(1);
    const s = statements[0]!;
    expect(s.ref).toBe("security/vex/tofu-1.13.9-x-net.openvex.json#statements[0]");
    expect(s.ids).toEqual(["GO-2026-6612", "https://pkg.go.dev/vuln/GO-2026-6612", "CVE-2026-78663"]);
    expect(s.products?.map((p) => p.subcomponents.length)).toEqual([2, 2]);
    expect(validateScopedStatements(statements).invalid).toEqual([]);
  });

  test("it clears the advisory in both repositories it names, under the plain and the -chainguard tags", () => {
    for (const repo of ["terragucci-tofu", "terragucci-terragrunt"]) {
      for (const tags of [["1.4.0"], ["1.4.0-chainguard"], []]) {
        const out = applyScopedVex([xNet()], statements, image(repo, tags));
        expect(out.gating).toEqual([]);
        expect(out.suppressed[0]).toMatchObject({ status: "not_affected", statement: "security/vex/tofu-1.13.9-x-net.openvex.json#statements[0]" });
      }
    }
  });

  test("it does not clear the advisory in another image of the same release", () => {
    for (const repo of ["terragucci-terraform", "terragucci-choudoufu"]) {
      const out = applyScopedVex([xNet()], statements, image(repo));
      expect(out.suppressed).toEqual([]);
      expect(out.gating).toHaveLength(1);
      expect(out.used.size).toBe(0);
    }
  });

  test("it does not clear the advisory in another package, or another version of x/net", () => {
    const other = xNet({ package: "golang.org/x/crypto", purl: "pkg:golang/golang.org/x/crypto@v0.57.0" });
    const newer = xNet({ installedVersion: "v0.58.0", purl: "pkg:golang/golang.org/x/net@v0.58.0" });
    const out = applyScopedVex([other, newer], statements, image("terragucci-tofu"));
    expect(out.suppressed).toEqual([]);
    expect(out.gating).toHaveLength(2);
  });

  test("it matches the finding by an alias the statement or the scanner gives", () => {
    expect(applyScopedVex([xNet({ cveId: "CVE-2026-78663" })], statements, image("terragucci-tofu")).suppressed).toHaveLength(1);
    expect(applyScopedVex([xNet({ cveId: "GHSA-xxxx-yyyy-zzzz", aliases: ["CVE-2026-78663"] })], statements, image("terragucci-tofu")).suppressed).toHaveLength(1);
    expect(applyScopedVex([xNet({ cveId: "GHSA-xxxx-yyyy-zzzz" })], statements, image("terragucci-tofu")).suppressed).toEqual([]);
  });

  test("a finding without a purl is matched by package name and version", () => {
    const bare = xNet({ purl: undefined });
    expect(applyScopedVex([bare], statements, image("terragucci-tofu")).suppressed).toHaveLength(1);
    expect(applyScopedVex([{ ...bare, installedVersion: "v0.58.0" }], statements, image("terragucci-tofu")).suppressed).toEqual([]);
  });

  test("an affected statement for the same product keeps the finding; one for another product does not", () => {
    const affected = (repo: string) =>
      parseVexDocument(JSON.stringify({ statements: [{ vulnerability: { name: "GO-2026-6612" }, products: [{ "@id": `ghcr.io/intentius/${repo}` }], status: "affected" }] }));
    expect(applyScopedVex([xNet()], [...statements, ...affected("terragucci-tofu")], image("terragucci-tofu")).suppressed).toEqual([]);
    expect(applyScopedVex([xNet()], [...statements, ...affected("terragucci-terraform")], image("terragucci-tofu")).suppressed).toHaveLength(1);
  });
});

describe("how a product is matched", () => {
  const stmt = (product: unknown, extra: Record<string, unknown> = {}) =>
    parseVexDocument(JSON.stringify({ statements: [{ vulnerability: "CVE-1", products: [product], status: "not_affected", ...extra }] }))[0]!;
  const finding: VulnFinding = { cveId: "CVE-1", severity: "critical", package: "openssl", installedVersion: "3.0.11-1", purl: "pkg:deb/debian/openssl@3.0.11-1?arch=amd64&distro=debian-12", fixable: true };
  const api: VexSubject = { repository: "ghcr.io/acme/api", digest: "sha256:abc", tags: ["v1.4.0", "latest"] };

  test("an image reference: the repository, with a tag or digest only when the scanned image has it", () => {
    expect(statementCovers(stmt("ghcr.io/acme/api"), finding, api)).toBe(true);
    expect(statementCovers(stmt("https://ghcr.io/acme/api/"), finding, api)).toBe(true);
    expect(statementCovers(stmt("ghcr.io/acme/api:v1.4.0"), finding, api)).toBe(true);
    expect(statementCovers(stmt("ghcr.io/acme/api:v1.3.0"), finding, api)).toBe(false);
    expect(statementCovers(stmt("ghcr.io/acme/api@sha256:abc"), finding, api)).toBe(true);
    expect(statementCovers(stmt("ghcr.io/acme/api@sha256:def"), finding, api)).toBe(false);
    expect(statementCovers(stmt("ghcr.io/acme/worker"), finding, api)).toBe(false);
    expect(statementCovers(stmt("ghcr.io/acme/api:v1.4.0"), finding, { repository: "ghcr.io/acme/api", digest: "sha256:abc" })).toBe(false);
  });

  test("an oci purl: a qualifier it leaves out matches any value, one it names must match", () => {
    expect(statementCovers(stmt("pkg:oci/api"), finding, api)).toBe(true);
    expect(statementCovers(stmt("pkg:oci/api?repository_url=ghcr.io/acme/api"), finding, api)).toBe(true);
    expect(statementCovers(stmt("pkg:oci/api?repository_url=ghcr.io/other/api"), finding, api)).toBe(false);
    expect(statementCovers(stmt("pkg:oci/api@sha256%3Aabc?repository_url=ghcr.io/acme/api"), finding, api)).toBe(true);
    expect(statementCovers(stmt("pkg:oci/api@sha256%3Adef"), finding, api)).toBe(false);
    expect(statementCovers(stmt("pkg:oci/api?tag=latest"), finding, api)).toBe(true);
    expect(statementCovers(stmt("pkg:oci/api?tag=edge"), finding, api)).toBe(false);
    expect(statementCovers(stmt("pkg:oci/api?arch=amd64"), finding, api)).toBe(false);
  });

  test("identifiers and hashes name a product too", () => {
    expect(statementCovers(stmt({ "@id": "urn:x", identifiers: { purl: "pkg:oci/api?repository_url=ghcr.io/acme/api" } }), finding, api)).toBe(true);
    expect(statementCovers(stmt({ "@id": "urn:x", hashes: { "sha-256": "abc" } }), finding, api)).toBe(true);
    expect(statementCovers(stmt({ "@id": "urn:x" }), finding, api)).toBe(false);
  });

  test("an npm package by purl, scoped or not, and its version", () => {
    const pkg: VexSubject = { purls: ["pkg:npm/%40acme/core@1.4.0"] };
    expect(statementCovers(stmt("pkg:npm/%40acme/core"), finding, pkg)).toBe(true);
    expect(statementCovers(stmt("pkg:npm/@acme/core@1.4.0"), finding, pkg)).toBe(true);
    expect(statementCovers(stmt("pkg:npm/%40acme/core@1.3.0"), finding, pkg)).toBe(false);
    expect(statementCovers(stmt("pkg:npm/%40acme/cli"), finding, pkg)).toBe(false);
  });

  test("a subcomponent purl without qualifiers covers the scanner's purl with them", () => {
    expect(statementCovers(stmt({ "@id": "ghcr.io/acme/api", subcomponents: [{ "@id": "pkg:deb/debian/openssl@3.0.11-1" }] }), finding, api)).toBe(true);
    expect(statementCovers(stmt({ "@id": "ghcr.io/acme/api", subcomponents: [{ "@id": "pkg:deb/debian/openssl@3.0.11-1?arch=arm64" }] }), finding, api)).toBe(false);
    expect(statementCovers(stmt({ "@id": "ghcr.io/acme/api", subcomponents: [{ "@id": "pkg:deb/debian/zlib" }] }), finding, api)).toBe(false);
  });

  test("statement-level subcomponents (OpenVEX before v0.2.0) apply to each product", () => {
    expect(statementCovers(stmt("ghcr.io/acme/api", { subcomponents: ["pkg:deb/debian/zlib"] }), finding, api)).toBe(false);
    expect(statementCovers(stmt("ghcr.io/acme/api", { subcomponents: ["pkg:deb/debian/openssl"] }), finding, api)).toBe(true);
  });

  test("a subject with nothing to match matches nothing", () => {
    expect(statementCovers(stmt("ghcr.io/acme/api"), finding, {})).toBe(false);
  });
});

describe("a statement without products", () => {
  test("is refused with a reason and clears nothing", () => {
    const statements = parseVexDocument(JSON.stringify({ statements: [{ vulnerability: "CVE-1", status: "not_affected" }] }), "vex.json");
    const { usable, invalid } = validateScopedStatements(statements);
    expect(usable).toEqual([]);
    expect(invalid).toEqual([{ statement: statements[0], reason: expect.stringContaining("names no products") }]);
    const out = applyScopedVex([{ cveId: "CVE-1", severity: "critical", package: "a", installedVersion: "1", fixable: true }], statements, { repository: "ghcr.io/acme/api" });
    expect(out.suppressed).toEqual([]);
  });

  test("a CycloneDX statement's product is the document's metadata.component, and affects names the component", () => {
    const doc = {
      bomFormat: "CycloneDX",
      metadata: { component: { "bom-ref": "api", name: "ghcr.io/acme/api", purl: "pkg:oci/api?repository_url=ghcr.io/acme/api" } },
      components: [{ "bom-ref": "openssl-ref", name: "openssl", purl: "pkg:deb/debian/openssl@3.0.11-1" }],
      vulnerabilities: [{ id: "CVE-1", analysis: { state: "not_affected" }, affects: [{ ref: "openssl-ref" }] }],
    };
    const [s] = parseVexDocument(JSON.stringify(doc), "cdx.json");
    expect(s!.ref).toBe("cdx.json#vulnerabilities[0]");
    const finding: VulnFinding = { cveId: "CVE-1", severity: "critical", package: "openssl", installedVersion: "3.0.11-1", purl: "pkg:deb/debian/openssl@3.0.11-1", fixable: true };
    expect(statementCovers(s!, finding, { repository: "ghcr.io/acme/api" })).toBe(true);
    expect(statementCovers(s!, finding, { repository: "ghcr.io/acme/worker" })).toBe(false);
    const { metadata: _m, ...bare } = doc;
    expect(validateScopedStatements(parseVexDocument(JSON.stringify(bare))).invalid).toHaveLength(1);
  });
});

describe("purls", () => {
  test("parse and cover per the spec's rules for a less specific purl", () => {
    expect(parsePurl("pkg:golang/golang.org/x/net@v0.57.0")).toEqual({ type: "golang", namespace: "golang.org/x", name: "net", version: "v0.57.0", qualifiers: {} });
    expect(parsePurl("ghcr.io/acme/api")).toBeNull();
    const have = parsePurl("pkg:deb/debian/openssl@3.0.11-1?arch=amd64")!;
    expect(purlCovers(parsePurl("pkg:deb/debian/openssl")!, have)).toBe(true);
    expect(purlCovers(parsePurl("pkg:deb/debian/openssl?arch=amd64")!, have)).toBe(true);
    expect(purlCovers(parsePurl("pkg:deb/debian/openssl?arch=arm64")!, have)).toBe(false);
    expect(purlCovers(parsePurl("pkg:deb/ubuntu/openssl")!, have)).toBe(false);
  });
});
