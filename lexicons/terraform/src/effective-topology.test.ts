/**
 * Core's effective-topology folds over a terraform root (chant #4362).
 *
 * `enrichEffectiveTopology` used to select nodes by CloudFormation kind, and
 * every terraform resource is `Terraform::Resource`, so on a terraform root
 * `attr:internetFacing=true` matched nothing. The fixture
 * (`src/__fixtures__/effective-topology/`) holds three instances and writes
 * each route spelling and each ingress spelling once, on a path of its own,
 * so every test below fails when the code for its spelling is removed.
 *
 *   web    public (inline `route`), SSH open via a launch template's group (inline `ingress`)
 *   batch  public (`aws_route`), HTTPS via `security_groups` (`aws_vpc_security_group_ingress_rule`)
 *   db     private (NAT route), SSH open via `vpc_security_group_ids` (`aws_security_group_rule`)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildGraphIr, type GraphIR } from "@intentius/chant/graph-ir";
import { enrichEffectiveTopology, terraformResourceType } from "@intentius/chant/graph-effective";
import { __searchInternals, runSearch } from "@intentius/chant/cli/handlers/search";
import { renderTerraformRoots } from "./hcl/roots";
import { terraformPlugin } from "./plugin";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "effective-topology");
const QUERY = "attr:internetFacing=true attr:effectiveIngress=tcp:22:0.0.0.0/0";

let ir: GraphIR;
const attrs = (address: string): Record<string, unknown> =>
  ir.nodes.find((n) => n.id === `net/${address}`)!.attrs as Record<string, unknown>;

beforeAll(async () => {
  const rendered = await renderTerraformRoots({ projectRoot: FIXTURE, roots: { net: { dir: "./net" } } });
  expect(rendered.warnings).toEqual([]);
  ir = enrichEffectiveTopology(buildGraphIr(rendered.entities));
});

describe("terraformResourceType", () => {
  it("reads the provider type off a terraform resource's address, and nothing else's", () => {
    const web = ir.nodes.find((n) => n.id === "net/aws_instance.web");
    expect(terraformResourceType(web)).toBe("aws_instance");
    expect(terraformResourceType({ id: "x", kind: "AWS::EC2::Instance", attrs: {} } as never)).toBeUndefined();
  });
});

describe("internetFacing on terraform's AWS kinds", () => {
  it("follows an inline `route` block to the internet gateway", () => {
    expect(attrs("aws_instance.web").internetFacing).toBe(true);
    expect(attrs("aws_instance.web").internetFacingVia).toBe(
      "subnet route aws_subnet.public_a -> aws_route_table.public_inline -> aws_internet_gateway.main (inline route)",
    );
  });

  it("follows a separate `aws_route` resource to the internet gateway", () => {
    expect(attrs("aws_instance.batch").internetFacing).toBe(true);
    expect(attrs("aws_instance.batch").internetFacingVia).toBe(
      "subnet route aws_subnet.public_b -> aws_route_table.public_separate -> aws_internet_gateway.main (aws_route.public_separate_default)",
    );
  });

  it("does not count a default route to a NAT gateway", () => {
    expect(attrs("aws_instance.db").internetFacing).toBe(false);
    expect(attrs("aws_instance.db").internetFacingVia).toBeUndefined();
  });
});

describe("effectiveIngress on terraform's AWS kinds", () => {
  it("reads an inline `ingress` block on a group reached through a launch template", () => {
    expect(attrs("aws_instance.web").effectiveIngress).toEqual(["tcp:22:0.0.0.0/0"]);
    expect(attrs("aws_instance.web").effectiveIngressVia).toBe(
      "security groups aws_launch_template.web -> aws_security_group.web",
    );
  });

  it("reads an `aws_security_group_rule` of type ingress, and skips its egress sibling", () => {
    expect(attrs("aws_instance.db").effectiveIngress).toEqual(["tcp:22:0.0.0.0/0"]);
  });

  it("reads an `aws_vpc_security_group_ingress_rule` on a group reached through `security_groups`", () => {
    expect(attrs("aws_instance.batch").effectiveIngress).toEqual(["tcp:443:0.0.0.0/0"]);
  });

  it("records the derived surface under the terraform type", () => {
    expect(ir.derivedAttrs?.["aws_instance"]).toEqual(["internetFacing", "effectiveIngress"]);
  });
});

describe(`search "${QUERY}"`, () => {
  const { parseQuery, matchTerm, explain } = __searchInternals;
  afterEach(() => vi.restoreAllMocks());

  it("matches exactly the public instance with SSH open through its launch template", () => {
    const terms = parseQuery(QUERY);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, byId)));
    expect(matches.map((n) => n.id)).toEqual(["net/aws_instance.web"]);
  });

  it("--explain prints the inclusion evidence for the match", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const terms = parseQuery(QUERY);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, byId)));
    explain(terms, matches, ir, byId, QUERY);
    expect(lines).toContain(
      "  ✓ net/aws_instance.web internetFacing via subnet route aws_subnet.public_a -> aws_route_table.public_inline -> aws_internet_gateway.main (inline route)",
    );
  });

  it("end to end: reads the root from config and says the facts are declared-only", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const cwd = process.cwd();
    process.chdir(FIXTURE);
    try {
      const exit = await runSearch({ args: { path: QUERY } as never, plugins: [terraformPlugin], serializers: [] });
      expect(exit).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(lines).toEqual([
      "net/aws_instance.web  Terraform::Resource",
      "— declared only · no observation · physical ids unavailable · effectiveIngress, internetFacing derived from declared references",
    ]);
  });
});
