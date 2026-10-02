import { describe, expect, test } from "vitest";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf030 } from "./tf030";

async function run(name: string): Promise<PostSynthDiagnostic[]> {
  return tf030.check(await loadFixture("TF030", name));
}

/** For the shapes no vendored fixture carries: parse one inline source. */
async function runInline(source: string): Promise<PostSynthDiagnostic[]> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "inline");
  return tf030.check({ outputs: new Map(), entities } as unknown as PostSynthContext);
}

const errors = (d: PostSynthDiagnostic[]) => d.filter((x) => x.severity === "error");
const infos = (d: PostSynthDiagnostic[]) => d.filter((x) => x.severity === "info");

describe("TF030: unrestricted ingress on a sensitive port", () => {
  describe("fires (vendored fixtures)", () => {
    test("a nested ingress block opening SSH to 0.0.0.0/0, and not the 8080 rule beside it", async () => {
      const d = await run("positive-mixed");
      expect(d).toHaveLength(1);
      expect(d[0].checkId).toBe("TF030");
      expect(d[0].severity).toBe("error");
      expect(d[0].entity).toBe("TF030/aws_security_group.jenkins_port");
      expect(d[0].message).toContain('"aws_security_group.jenkins_port" ingress rule 2');
      expect(d[0].message).toContain("0.0.0.0/0 on port 22 (SSH)");
    });

    test("a port range spanning sensitive ports, and not the 443 rule", async () => {
      const d = await run("positive");
      expect(d).toHaveLength(1);
      expect(d[0].severity).toBe("error");
      expect(d[0].message).toContain("ingress rule 2");
      expect(d[0].message).toContain("ports 1025-65535, which include MySQL (3306), RDP (3389) and PostgreSQL (5432)");
    });

    test("standalone aws_security_group_rule and aws_vpc_security_group_ingress_rule", async () => {
      const d = await run("positive-standalone");
      expect(errors(d).map((x) => x.entity).sort()).toEqual([
        "TF030/aws_security_group_rule.fail",
        "TF030/aws_vpc_security_group_ingress_rule.fail",
      ]);
      expect(d).toHaveLength(2);
    });

    test("::/0 on IPv6, and protocol -1 in attribute syntax reaching every port", async () => {
      const d = await run("positive-ipv6");
      expect(d).toHaveLength(2);
      const byEntity = new Map(d.map((x) => [x.entity, x]));
      expect(byEntity.get("TF030/aws_security_group.fail-ipv6")?.message).toContain("from ::/0 on port 22");
      expect(byEntity.get("TF030/aws_security_group.fail4")?.message).toContain("every port (protocol -1)");
    });
  });

  describe("silent (vendored fixtures)", () => {
    test("SSH open only to private ranges", async () => {
      expect(await run("negative")).toEqual([]);
    });

    test("no ingress at all, ICMP from anywhere, SSH from a security group, open egress", async () => {
      expect(await run("negative-rules")).toEqual([]);
    });
  });

  describe("not determined (vendored fixtures)", () => {
    test("cidr_blocks = var.allowed_ssh_cidrs on port 22 is an info, not an error", async () => {
      const d = await run("not-determined");
      expect(errors(d)).toEqual([]);
      expect(infos(d)).toHaveLength(1);
      expect(d[0].message).toMatch(/^Not determined: /);
      expect(d[0].message).toContain("`cidr_blocks` is `var.allowed_ssh_cidrs`");
    });

    test("an open CIDR on from_port/to_port = var.ssh_port is an info naming both", async () => {
      const d = await run("not-determined-port");
      expect(d).toHaveLength(1);
      expect(d[0].severity).toBe("info");
      expect(d[0].message).toContain("`from_port` is `var.ssh_port`; `to_port` is `var.ssh_port`");
    });

    test("a standalone rule with a variable CIDR is an info; the open egress rule is silent", async () => {
      const d = await run("not-determined-standalone");
      expect(d).toHaveLength(1);
      expect(d[0].severity).toBe("info");
      expect(d[0].entity).toBe("TF030/aws_security_group_rule.allow_ssh_internal");
      expect(d[0].message).toContain("an element of `cidr_blocks` is `var.cidr_vpc`");
    });

    test("a for_each over each.value is an info, even though its locals open SSH to the world", async () => {
      const d = await run("not-determined-vpc-rule");
      expect(d).toHaveLength(1);
      expect(d[0].severity).toBe("info");
      expect(d[0].message).toContain("`cidr_ipv4` is `each.value.cidr_ipv4`");
      expect(d[0].message).toContain("`ip_protocol` is `each.value.ip_protocol`");
    });
  });

  describe("edge cases (inline)", () => {
    test("a known-safe fact settles the rule even beside an unreadable one", async () => {
      const d = await runInline(`
resource "aws_security_group_rule" "https" {
  type        = "ingress"
  from_port   = 443
  to_port     = 443
  protocol    = "tcp"
  cidr_blocks = var.allowed
}
resource "aws_security_group_rule" "private" {
  type        = "ingress"
  from_port   = var.port
  to_port     = var.port
  protocol    = "tcp"
  cidr_blocks = ["10.0.0.0/8"]
}`);
      expect(d).toEqual([]);
    });

    test("egress and an unknown type", async () => {
      const d = await runInline(`
resource "aws_security_group_rule" "out" {
  type        = "egress"
  from_port   = 22
  to_port     = 22
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}
resource "aws_security_group_rule" "either" {
  type        = var.direction
  from_port   = 22
  to_port     = 22
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}`);
      expect(d).toHaveLength(1);
      expect(d[0].severity).toBe("info");
      expect(d[0].message).toContain("`type` is `var.direction`");
    });

    test("protocol written as the number -1, a quoted port, and upper-case TCP", async () => {
      const d = await runInline(`
resource "aws_security_group" "a" {
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = -1
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port        = "5432"
    to_port          = "5432"
    protocol         = "TCP"
    ipv6_cidr_blocks = ["::/0"]
  }
}`);
      expect(errors(d)).toHaveLength(2);
      expect(d[1].message).toContain("port 5432 (PostgreSQL)");
    });

    test("tcp 0-0 is port 0, not every port", async () => {
      const d = await runInline(`
resource "aws_security_group" "a" {
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}`);
      expect(d).toEqual([]);
    });

    test("ingress = var.rules and a dynamic ingress block are not determined", async () => {
      const d = await runInline(`
resource "aws_security_group" "whole" {
  ingress = var.rules
}
resource "aws_security_group" "dyn" {
  dynamic "ingress" {
    for_each = var.ports
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}
resource "aws_security_group" "dyn_private" {
  dynamic "ingress" {
    for_each = var.ports
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["10.0.0.0/8"]
    }
  }
}`);
      const byEntity = new Map(d.map((x) => [x.entity, x]));
      expect([...byEntity.keys()].sort()).toEqual(["inline/aws_security_group.dyn", "inline/aws_security_group.whole"]);
      expect(d.every((x) => x.severity === "info")).toBe(true);
      expect(byEntity.get("inline/aws_security_group.whole")?.message).toContain("`ingress` is `var.rules`");
      expect(byEntity.get("inline/aws_security_group.dyn")?.message).toContain("`for_each = var.ports`");
    });

    test("a vpc ingress rule with ip_protocol -1 and no ports", async () => {
      const d = await runInline(`
resource "aws_vpc_security_group_ingress_rule" "all" {
  security_group_id = aws_security_group.x.id
  ip_protocol       = "-1"
  cidr_ipv6         = "::/0"
}`);
      expect(errors(d)).toHaveLength(1);
    });
  });
});
