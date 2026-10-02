import { describe, expect, test } from "vitest";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { tf032 } from "./tf032";
import { loadFixture } from "./fixtures/load";
import { blocksToEntities } from "../../hcl/parse";

async function ctxOf(source: string): Promise<PostSynthContext> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "TF032");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

const errors = (d: PostSynthDiagnostic[]) => d.filter((x) => x.severity === "error");
const infos = (d: PostSynthDiagnostic[]) => d.filter((x) => x.severity === "info");

/** One task definition around a container_definitions expression. */
const task = (defs: string) => `resource "aws_ecs_task_definition" "t" {\n  family = "t"\n  container_definitions = ${defs}\n}\n`;

describe("TF032: plaintext credential in an ECS container definition", () => {
  test("fires on each literal credential in a jsonencode'd environment (edstem paylink-platform)", async () => {
    const diags = tf032.check(await loadFixture("TF032", "positive"));
    expect(errors(diags).map((d) => d.message.match(/passes "([^"]+)"/)?.[1])).toEqual(["DB_PASSWORD", "PAYMENT_API_KEY"]);
    // `image = "${var.ecr_repo}:latest"` is an unknown leaf, not a reason to give up on the container.
    expect(infos(diags)).toHaveLength(0);
    for (const d of errors(diags)) {
      expect(d.checkId).toBe("TF032");
      expect(d.entity).toBe("TF032/aws_ecs_task_definition.api");
      expect(d.message).toContain("redacted");
      expect(d.message).not.toContain("Pl-Pr0d-Db-2025!");
      expect(d.message).not.toContain("pk_live_");
    }
  });

  test("reads a heredoc with no interpolation as JSON (trivy-checks' failing example)", async () => {
    const diags = tf032.check(await loadFixture("TF032", "positive-heredoc"));
    expect(errors(diags)).toHaveLength(1);
    expect(errors(diags)[0].message).toContain('"DATABASE_PASSWORD"');
    expect(errors(diags)[0].message).toContain('container "my_service"');
  });

  test("fires on a literal sidecar password and reports the local-fed environments as not determined (govuk forms-admin)", async () => {
    const diags = tf032.check(await loadFixture("TF032", "positive-sidecar"));
    expect(errors(diags)).toHaveLength(1);
    expect(errors(diags)[0].message).toContain('container "postgres" passes "POSTGRES_PASSWORD"');
    const nd = infos(diags);
    expect(nd).toHaveLength(2);
    for (const d of nd) {
      expect(d.message.startsWith("Not determined:")).toBe(true);
      expect(d.message).toContain("`environment`");
    }
    expect(nd.map((d) => d.message.match(/container "([^"]+)"/)?.[1])).toEqual(["forms-admin", "forms-admin-seeding"]);
  });

  test("is silent when credentials come through secrets (vapor penny-bot)", async () => {
    expect(tf032.check(await loadFixture("TF032", "negative"))).toEqual([]);
  });

  test("is silent on trivy-checks' passing example", async () => {
    expect(tf032.check(await loadFixture("TF032", "negative-heredoc"))).toEqual([]);
  });

  test("a reference value is not a literal, a container with no environment is not insecure (testdrivenio)", async () => {
    const diags = tf032.check(await loadFixture("TF032", "negative-references"));
    expect(errors(diags)).toEqual([]);
    // The one task whose definitions are `data.template_file.app.rendered`.
    expect(infos(diags)).toHaveLength(1);
    expect(infos(diags)[0].entity).toBe("TF032/aws_ecs_task_definition.app");
    expect(infos(diags)[0].message).toMatch(/^Not determined: .*data\.template_file\.app\.rendered/);
  });

  describe("not determined, never a warning", () => {
    test.each([
      ["file()", 'file("service.json")', /call to file\(\)/],
      ["templatefile()", 'templatefile("defs.tpl", { image = var.image })', /call to templatefile\(\)/],
      ["a local", "local.container_definitions", /reference `local\.container_definitions`/],
      ["jsonencode(concat(...))", "jsonencode(concat([{ name = \"a\" }], var.extra))", /jsonencode argument holds/],
      ["a heredoc with interpolation", '<<EOT\n[{"name":"a","image":"${var.image}"}]\nEOT', /interpolation/],
    ])("%s", async (_label, defs, reason) => {
      const diags = tf032.check(await ctxOf(task(defs)));
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe("info");
      expect(diags[0].message.startsWith("Not determined:")).toBe(true);
      expect(diags[0].message).toMatch(reason);
    });

    test("an environment entry that is itself an expression", async () => {
      const diags = tf032.check(
        await ctxOf(task('jsonencode([{ name = "a", environment = [{ name = "MODE", value = "api" }, local.extra_env] }])')),
      );
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe("info");
      expect(diags[0].message).toContain('container "a"');
    });
  });

  test("the same name through secrets does not fire; a secret-named literal in environment does", async () => {
    const viaSecrets = task(
      'jsonencode([{ name = "a", secrets = [{ name = "DB_PASSWORD", valueFrom = "arn:aws:ssm:eu-west-1:123456789012:parameter/db" }] }])',
    );
    expect(tf032.check(await ctxOf(viaSecrets))).toEqual([]);
    const viaEnv = task('jsonencode([{ name = "a", environment = [{ name = "DB_PASSWORD", value = "s3cr3t-Pa55word" }] }])');
    expect(errors(tf032.check(await ctxOf(viaEnv)))).toHaveLength(1);
  });

  test("short values, placeholders and lookalike names are not credentials", async () => {
    const defs = task(
      'jsonencode([{ name = "a", environment = [' +
        '{ name = "PASSWORD_MIN_LENGTH", value = "8" },' +
        '{ name = "DB_PASSWORD", value = "changeme-please" },' +
        '{ name = "TOKENIZER", value = "wordpiece-uncased" },' +
        '{ name = "DB_SECRET_ARN", value = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:db" }' +
        "] }])",
    );
    expect(tf032.check(await ctxOf(defs))).toEqual([]);
  });

  test("a credential-shaped value fires whatever it is called", async () => {
    const defs = task('jsonencode([{ name = "a", environment = [{ name = "UPSTREAM", value = "AKIAIOSFODNN7EXAMPLF" }] }])');
    const diags = errors(tf032.check(await ctxOf(defs)));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("shape of a credential");
  });

  test("only aws_ecs_task_definition is read", async () => {
    const src = 'resource "aws_ecs_service" "s" {\n  name = "s"\n  container_definitions = local.x\n}\n';
    expect(tf032.check(await ctxOf(src))).toEqual([]);
  });
});
