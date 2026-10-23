/**
 * The capability catalog over Terraform's AWS provider (#4375).
 *
 * `__fixtures__/capabilities/` holds three roots:
 *
 *   ledger    the estate chant#4361 measured the rule language on, whose
 *             answers were worked out by hand: identity reach 13 pairs,
 *             exfiltration 3, blast radius 15 from three starts.
 *   catalog   a case that holds and one that doesn't for each capability the
 *             ledger leaves out (default VPC, unused things, public buckets,
 *             SecureString, encryption, an explicit Deny).
 *   findings  the -findings layer of choudoufu's terralith-gen, the estate
 *             behold#912's step 6 asks about.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildGraphIr, type GraphIR } from "@intentius/chant/graph-ir";
import { CapabilityEngine } from "@intentius/chant/capabilities/matcher";
import { buildView, displayName } from "@intentius/chant/capabilities/view";
import { resolvePacks, shippedRules } from "@intentius/chant/capabilities/catalog";
import { runSearch } from "@intentius/chant/cli/handlers/search";
import { renderTerraformRoots } from "./hcl/roots";
import { terraformPlugin } from "./plugin";
import { terraformCapabilityPack } from "./capabilities/adapter";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "capabilities");

let engine: CapabilityEngine;
let ir: GraphIR;

beforeAll(async () => {
  const rendered = await renderTerraformRoots({
    projectRoot: FIXTURE,
    roots: { ledger: { dir: "./ledger" }, catalog: { dir: "./catalog" }, findings: { dir: "./findings" } },
  });
  expect(rendered.warnings).toEqual([]);
  ir = buildGraphIr(rendered.entities);
  engine = new CapabilityEngine(buildView(ir, resolvePacks([terraformCapabilityPack])), shippedRules().rules);
});

const set = (name: string, args: unknown[] = [], root?: string) =>
  [...engine.set(name, engine.bind(name, args as never)).keys()].filter((id) => !root || id.startsWith(`${root}/`)).map(displayName).sort();
const pairs = (name: string, args: unknown[] = [], root = "ledger") =>
  [...engine.relation(name, engine.bind(name, args as never)).out]
    .filter(([a]) => a.startsWith(`${root}/`))
    .flatMap(([a, m]) => [...m.keys()].map((b) => `${displayName(a)} ${displayName(b)}`))
    .sort();

describe("the ledger's three hand-checked answers (chant#4361)", () => {
  it("identity reach: 13 (role, resource) pairs", () => {
    expect(pairs("reaches")).toEqual([
      "aws_iam_role.audit aws_dynamodb_table.orders",
      "aws_iam_role.batch aws_dynamodb_table.orders",
      "aws_iam_role.batch aws_iam_role.audit",
      "aws_iam_role.deploy aws_s3_bucket.customer_data",
      "aws_iam_role.deploy aws_secretsmanager_secret.db",
      "aws_iam_role.reporter aws_s3_bucket.customer_data",
      "aws_iam_role.web aws_iam_role.deploy",
      "aws_iam_role.web aws_s3_bucket.assets",
      "aws_iam_role.web aws_s3_bucket.customer_data",
      "aws_iam_role.web aws_secretsmanager_secret.db",
      "aws_iam_role.worker aws_dynamodb_table.orders",
      "aws_iam_role.worker aws_s3_bucket.assets",
      "aws_iam_role.worker aws_secretsmanager_secret.db",
    ]);
  });

  it("exfiltration: 3 (compute, store) pairs", () => {
    expect(pairs("exfiltrates")).toEqual([
      "aws_instance.web aws_s3_bucket.customer_data",
      "aws_instance.web aws_secretsmanager_secret.db",
      "aws_lambda_function.reporter aws_s3_bucket.customer_data",
    ]);
  });

  it("blast radius: 15 members from webServer, reporter and batch", () => {
    const from = (start: string) => pairs("blast").filter((p) => p.startsWith(`${start} `)).map((p) => p.split(" ")[1]);
    expect(from("aws_instance.web")).toEqual([
      "aws_db_instance.customers",
      "aws_dynamodb_table.orders",
      "aws_iam_role.deploy",
      "aws_iam_role.web",
      "aws_iam_role.worker",
      "aws_instance.admin_box",
      "aws_instance.worker",
      "aws_s3_bucket.assets",
      "aws_s3_bucket.customer_data",
      "aws_secretsmanager_secret.db",
    ]);
    expect(from("aws_lambda_function.reporter")).toEqual(["aws_iam_role.reporter", "aws_s3_bucket.customer_data"]);
    expect(from("aws_lambda_function.batch")).toEqual(["aws_dynamodb_table.orders", "aws_iam_role.audit", "aws_iam_role.batch"]);
  });

  it("the exfiltration path includes the trust statement that makes the assume-role hop real", () => {
    const ev = engine.relation("exfiltrates").out.get("ledger/aws_instance.web")!.get("ledger/aws_s3_bucket.customer_data")!;
    const visited = ev.hops.flatMap((h) => [h.from, h.to]).map(displayName);
    expect(visited).toContain("aws_iam_role.deploy#assume_role_policy[0].Statement[0]");
    expect(visited.at(-1)).toBe("aws_s3_bucket.customer_data");
    expect(ev.because.map((b) => b.capability)).toEqual(["internet-reachable", "holds-secret"]);
    expect(ev.because[0].evidence.because.map((b) => b.capability)).toEqual(["internet-facing", "open-ingress"]);
  });
});

describe("each capability on a fixture", () => {
  it("internet-facing: a subnet routed to an internet gateway, by aws_route or by an inline route", () => {
    expect(set("internet-facing", [], "ledger")).toEqual(["aws_instance.admin_box", "aws_instance.web"]);
    expect(set("internet-facing", [], "findings")).toEqual(["aws_instance.bastion"]);
  });

  it("open-ingress: a world-open rule reached through a launch template, filtered by port and protocol", () => {
    expect(set("open-ingress", [], "ledger")).toEqual(["aws_instance.web"]);
    expect(set("open-ingress", [22], "ledger")).toEqual(["aws_instance.web"]);
    expect(set("open-ingress", [8080], "ledger")).toEqual([]);
    expect(set("open-ingress", [22, "udp"], "ledger")).toEqual([]);
  });

  it("internet-reachable: facing and open, or a function URL with no auth", () => {
    expect(set("internet-reachable", [], "ledger")).toEqual(["aws_instance.web", "aws_lambda_function.reporter"]);
    expect(set("internet-reachable", [22], "findings")).toEqual(["aws_instance.bastion"]);
  });

  it("attached-to-nothing: an unused group, an empty subnet, a policy no role holds", () => {
    expect(set("attached-to-nothing", [], "catalog")).toEqual(["aws_iam_policy.orphan", "aws_security_group.unused", "aws_subnet.empty"]);
  });

  it("in-default-vpc: an instance in a subnet of aws_default_vpc, and the subnet", () => {
    expect(set("in-default-vpc", [], "catalog")).toEqual(["aws_instance.legacy", "aws_subnet.legacy"]);
  });

  it("network: host to host through group-to-group ingress", () => {
    expect(pairs("network")).toEqual([
      "aws_instance.admin_box aws_db_instance.customers",
      "aws_instance.web aws_instance.admin_box",
      "aws_instance.web aws_instance.worker",
      "aws_instance.worker aws_db_instance.customers",
    ]);
  });

  it("stores-data and holds-secret: restricted by tag (through a local), a secret, a SecureString", () => {
    expect(set("stores-data", [], "ledger")).toEqual([
      "aws_db_instance.customers",
      "aws_dynamodb_table.orders",
      "aws_s3_bucket.assets",
      "aws_s3_bucket.customer_data",
      "aws_secretsmanager_secret.db",
    ]);
    expect(set("holds-secret", [], "ledger")).toEqual(["aws_db_instance.customers", "aws_s3_bucket.customer_data", "aws_secretsmanager_secret.db"]);
    expect(set("holds-secret", [], "catalog")).toEqual(["aws_ssm_parameter.token"]);
  });

  it("encrypted-at-rest: by attribute for a database or file system, always for a bucket", () => {
    const enc = set("encrypted-at-rest", [], "catalog");
    expect(enc).toEqual(["aws_efs_file_system.shared", "aws_s3_bucket.blocked", "aws_s3_bucket.open"]);
    expect(enc).not.toContain("aws_db_instance.plain");
  });

  it("publicly-readable: principal * with no public-access block in the way", () => {
    expect(set("publicly-readable", [], "catalog")).toEqual(["aws_s3_bucket.open"]);
  });

  it("runs-as: through an instance profile, a launch template's profile, a Lambda role", () => {
    expect(pairs("runs-as")).toEqual([
      "aws_instance.admin_box aws_iam_role.worker",
      "aws_instance.web aws_iam_role.web",
      "aws_instance.worker aws_iam_role.worker",
      "aws_lambda_function.batch aws_iam_role.batch",
      "aws_lambda_function.reporter aws_iam_role.reporter",
    ]);
    expect(pairs("runs-as", [], "findings")).toEqual(["aws_instance.bastion aws_iam_role.app_data"]);
  });

  it("can-assume: by reference with a matching trust, and by ARN string naming a declared role", () => {
    expect(pairs("can-assume")).toEqual(["aws_iam_role.batch aws_iam_role.audit", "aws_iam_role.web aws_iam_role.deploy"]);
  });

  it("grants: an action argument narrows it, and an explicit Deny on the same pair cancels it", () => {
    expect(pairs("grants", ["sts:AssumeRole"])).toEqual(["aws_iam_role.batch aws_iam_role.audit", "aws_iam_role.web aws_iam_role.deploy"]);
    expect(pairs("grants", ["s3:GetObject"], "catalog")).toEqual(["aws_iam_role.denied aws_s3_bucket.blocked"]);
    expect(pairs("grants", [], "catalog")).toEqual(["aws_iam_role.denied aws_s3_bucket.blocked"]);
  });
});

describe("behold#912 step 6: what the findings layer's role can reach", () => {
  it("reaches the DynamoDB table and no other store, and leaves the wildcard roles to the not-evaluated note", () => {
    const reached = [...engine.relation("reaches").out.get("findings/aws_iam_role.app_data")!.keys()].map(displayName);
    expect(reached).toEqual(["aws_dynamodb_table.sessions"]);
    expect(engine.relation("reaches").out.get("findings/aws_iam_role.team_0002_role")).toBeUndefined();
  });
});

describe("chant search with capabilities", () => {
  afterEach(() => vi.restoreAllMocks());

  async function search(args: Record<string, unknown>): Promise<{ exit: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
    const cwd = process.cwd();
    process.chdir(FIXTURE);
    try {
      const exit = await runSearch({ args: args as never, plugins: [terraformPlugin], serializers: [] });
      return { exit, out, err };
    } finally {
      process.chdir(cwd);
    }
  }

  it("step 6: the store the role reaches, with what the rule did not evaluate", async () => {
    const { exit, out } = await search({ path: "cap:stores-data <-[cap=reaches]aws_iam_role.app_data" });
    expect(exit).toBe(0);
    expect(out[0]).toBe("findings/aws_dynamodb_table.sessions  aws_dynamodb_table");
    expect(out[1]).toBe("— declared only · no observation · physical ids unavailable · stores-data, reaches derived from declared references");
    expect(out[2]).toMatch(/^— reaches does not evaluate: IAM Condition keys; Resource "\*" \(2 statements here\);/);
  });

  it("--explain prints each match's path in #4359's hop format, and the sets it relied on", async () => {
    const { out } = await search({ path: "kind:aws_instance cap:internet-reachable(22)", explain: true });
    const lines = out.filter((l) => l.includes("bastion"));
    expect(lines).toContain(
      "  path findings/aws_instance.bastion cap:internet-reachable(22): (the node itself)",
    );
    expect(lines).toContain(
      "    internet-facing findings/aws_instance.bastion: findings/aws_instance.bastion.subnet_id -> findings/aws_subnet.public.id; findings/aws_subnet.public.id <- findings/aws_route_table_association.public.subnet_id; findings/aws_route_table_association.public.route_table_id -> findings/aws_route_table.public.id; findings/aws_route_table.public.route -> findings/aws_route_table.public#route[0]; findings/aws_route_table.public#route[0].gateway_id -> findings/aws_internet_gateway.main.id",
    );
    expect(lines).toContain(
      "    open-ingress findings/aws_instance.bastion: findings/aws_instance.bastion.launch_template -> findings/aws_launch_template.bastion.id; findings/aws_launch_template.bastion.vpc_security_group_ids -> findings/aws_security_group.bastion.id; findings/aws_security_group.bastion.id <- findings/aws_vpc_security_group_ingress_rule.bastion_ssh.security_group_id",
    );
  });

  it("--explain prints an edge capability's path through the policy statement", async () => {
    const { out } = await search({ path: "aws_iam_role.app_data ->[cap=reaches]cap:stores-data", explain: true });
    expect(out).toContain(
      "  path findings/aws_iam_role.app_data ->[cap=reaches]cap:stores-data: findings/aws_iam_role.app_data.name <- findings/aws_iam_role_policy_attachment.app_data.role; findings/aws_iam_role_policy_attachment.app_data.policy_arn -> findings/aws_iam_policy.app_data.arn; findings/aws_iam_policy.app_data.policy -> findings/aws_iam_policy.app_data#policy[0].Statement[0]; findings/aws_iam_policy.app_data#policy[0].Statement[0].Resource[0] -> findings/aws_dynamodb_table.sessions.arn",
    );
  });

  it("--json carries the path, each hop's capability edge, and the not-evaluated list", async () => {
    const { out } = await search({ path: "cap:exfiltrates", json: true });
    const doc = JSON.parse(out[0]);
    expect(doc.matches.map((m: { id: string }) => m.id)).toEqual(["ledger/aws_instance.web", "ledger/aws_lambda_function.reporter"]);
    const path = doc.matches[0].paths[0];
    expect(path.term).toBe("cap:exfiltrates");
    expect(path.hops[0]).toEqual({ from: "ledger/aws_instance.web", fromAttr: "iam_instance_profile", to: "ledger/aws_iam_instance_profile.web", toAttr: "name", edge: "profile" });
    expect(path.because.map((b: { capability: string }) => b.capability)).toContain("internet-facing");
    expect(doc.capabilities).toEqual([
      expect.objectContaining({ name: "exfiltrates", source: "declared", notEvaluated: expect.arrayContaining(["IAM Condition keys"]) }),
    ]);
  });

  it("refuses an unknown capability, a set used as an edge, and the wrong arguments", async () => {
    let r = await search({ path: "cap:reachable" });
    expect(r.exit).toBe(1);
    expect(r.err.join("\n")).toMatch(/no capability "reachable"/);
    r = await search({ path: "->[cap=stores-data]kind:aws_s3_bucket" });
    expect(r.exit).toBe(1);
    expect(r.err.join("\n")).toMatch(/"stores-data" is a set, not an edge/);
    r = await search({ path: "cap:open-ingress(22,tcp,3)" });
    expect(r.exit).toBe(1);
    expect(r.err.join("\n")).toMatch(/open-ingress takes at most 2 \(port, proto\)/);
  });
});
