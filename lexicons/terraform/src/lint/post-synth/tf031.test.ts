import { describe, expect, test } from "vitest";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf031 } from "./tf031";

async function inline(source: string): Promise<PostSynthContext> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

const warnings = (d: PostSynthDiagnostic[]) => d.filter((x) => x.severity === "warning");
const infos = (d: PostSynthDiagnostic[]) => d.filter((x) => x.severity === "info");
const entities = (d: PostSynthDiagnostic[]) => d.map((x) => x.entity).sort();

describe("TF031 over vendored real-world fixtures", () => {
  test("a literal jsonencode policy with Action and Resource \"*\" (BishopFox/iam-vulnerable)", async () => {
    const diags = tf031.check(await loadFixture("TF031", "positive-jsonencode"));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      checkId: "TF031",
      severity: "warning",
      lexicon: "terraform",
      entity: "TF031/aws_iam_policy.privesc-AssumeRole-high-priv-policy",
    });
    expect(diags[0].message).toContain('statement 1 allows Action "*" and Resource "*"');
  });

  test("aws_iam_policy_document statements with resources = [\"*\"] (alphagov/tech-ops)", async () => {
    const diags = tf031.check(await loadFixture("TF031", "positive-data-source"));
    expect(warnings(diags).map((d) => d.entity).sort()).toEqual([
      "TF031/data.aws_iam_policy_document.sts_inline_policy_document",
      "TF031/data.aws_iam_policy_document.support_inline_policy_document",
    ]);
    // The role policies name those documents' .json: checked at the document, not again.
    expect(infos(diags)).toEqual([]);
  });

  test("a heredoc reads as JSON; a variable policy is not determined (tf_aws_ecs)", async () => {
    const diags = tf031.check(await loadFixture("TF031", "positive-heredoc"));
    expect(entities(warnings(diags))).toEqual([
      "TF031/aws_iam_policy.ecs_policy",
      "TF031/data.aws_iam_policy_document.consul_task_policy",
    ]);
    const [nd] = infos(diags);
    expect(infos(diags)).toHaveLength(1);
    expect(nd.entity).toBe("TF031/aws_iam_policy.custom_ecs_policy");
    expect(nd.message).toMatch(/^Not determined: /);
    expect(nd.message).toContain("var.custom_iam_policy");
  });

  test("policies built with concat() are not determined, never a warning (alphagov/tech-ops)", async () => {
    const diags = tf031.check(await loadFixture("TF031", "not-determined"));
    expect(warnings(diags)).toEqual([]);
    expect(entities(infos(diags))).toEqual([
      "TF031/aws_iam_role.concourse_secrets_admin",
      "TF031/aws_iam_role_policy.concourse_secrets_admin",
    ]);
    for (const d of diags) expect(d.message).toMatch(/^Not determined: .*Statement is a function call \(concat/);
  });

  test("scoped policies report nothing at all (alphagov/tech-ops)", async () => {
    expect(tf031.check(await loadFixture("TF031", "negative"))).toEqual([]);
  });
});

describe("TF031 cases the fixtures do not isolate", () => {
  test("Resource \"*\" alone fires, naming only the field that is a wildcard", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_role_policy" "p" {
  role = aws_iam_role.r.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Sid = "Logs", Effect = "Allow", Action = ["logs:PutLogEvents"], Resource = "*" }]
  })
}`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('statement 1 (Sid "Logs") allows Resource "*"');
    expect(diags[0].message).toContain('allows Resource "*". ');
  });

  test("a literal Action \"*\" fires even when Resource is a reference", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_user_policy" "p" {
  user = "u"
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = var.arn }] })
}`),
    );
    expect(warnings(diags)).toHaveLength(1);
    expect(diags[0].message).toContain('allows Action "*"');
  });

  test("a variable Resource with a scoped Action is not determined", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_group_policy" "p" {
  group = "g"
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = var.arn }] })
}`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("statement 1 Resource is a reference (var...)");
  });

  test("a template whose literal text is not * is scoped, not not-determined", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_policy" "p" {
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::\${var.bucket}/*" }] })
}
data "aws_iam_policy_document" "d" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::\${var.bucket}/*", aws_s3_bucket.b.arn]
  }
}`),
    );
    expect(diags).toEqual([]);
  });

  test("Deny statements never fire", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_policy" "p" {
  policy = jsonencode({ Statement = [{ Effect = "Deny", Action = "*", Resource = "*" }] })
}
data "aws_iam_policy_document" "d" {
  statement {
    effect    = "Deny"
    actions   = ["*"]
    resources = ["*"]
  }
}`),
    );
    expect(diags).toEqual([]);
  });

  test("an Effect from an expression beside a wildcard is not determined", async () => {
    const diags = tf031.check(
      await inline(`
data "aws_iam_policy_document" "d" {
  statement {
    effect  = var.effect
    actions = ["*"]
  }
}`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("Effect is an expression (var.effect)");
  });

  test("inline_policy on aws_iam_role is read, and assume_role_policy is in scope", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_role" "r" {
  assume_role_policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Principal = { Service = "ec2.amazonaws.com" } }] })
  inline_policy {
    name   = "admin"
    policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = "*" }] })
  }
}`),
    );
    expect(diags.map((d) => d.message.match(/`([^`]+)`/)?.[1])).toEqual(["assume_role_policy", "inline_policy[0].policy"]);
  });

  test("file(), a templated heredoc and a for-expression argument are not determined", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_policy" "f" {
  policy = file("policy.json")
}
resource "aws_iam_policy" "t" {
  policy = <<EOT
{"Statement":[{"Effect":"Allow","Action":"*","Resource":"\${var.arn}"}]}
EOT
}
resource "aws_iam_policy" "j" {
  policy = jsonencode(local.policy)
}
data "aws_iam_policy_document" "dyn" {
  dynamic "statement" {
    for_each = var.statements
    content {
      actions = statement.value.actions
    }
  }
}`),
    );
    expect(warnings(diags)).toEqual([]);
    const byEntity = Object.fromEntries(infos(diags).map((d) => [d.entity, d.message]));
    expect(byEntity["app/aws_iam_policy.f"]).toContain("file() call");
    expect(byEntity["app/aws_iam_policy.t"]).toContain("template string");
    expect(byEntity["app/aws_iam_policy.j"]).toContain("jsonencode() call whose argument holds a reference");
    expect(byEntity["app/data.aws_iam_policy_document.dyn"]).toContain('dynamic "statement"');
  });

  test("a policy naming a document declared in another module is not determined", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_policy" "p" {
  policy = data.aws_iam_policy_document.elsewhere.json
}`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("data.aws_iam_policy_document.elsewhere.json");
  });

  test("absence is not a finding: no policy argument, no inline_policy, empty data source", async () => {
    const diags = tf031.check(
      await inline(`
resource "aws_iam_policy" "p" {
  name = "unset"
}
resource "aws_iam_role" "r" {
  name = "no-policies"
}
data "aws_iam_policy_document" "empty" {}
resource "aws_vpc_endpoint" "out_of_scope" {
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = "*", Principal = "*" }] })
}`),
    );
    expect(diags).toEqual([]);
  });
});
