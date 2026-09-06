import { describe, expect, test } from "vitest";
import { loadFixture } from "./fixtures/load";
import { tf006 } from "./tf006";
import { tf007 } from "./tf007";
import { tf008 } from "./tf008";
import { tf009 } from "./tf009";
import { tf010 } from "./tf010";
import { tf011 } from "./tf011";
import { tf012 } from "./tf012";
import { tf013 } from "./tf013";
import { tf016 } from "./tf016";
import { tf017 } from "./tf017";
import { tf018 } from "./tf018";
import { tf019 } from "./tf019";
import { tf022 } from "./tf022";

/**
 * The single-block rules (#2110): TF006 to TF013, TF016 to TF019 and TF022,
 * every one of them reading one entity of one type. Each rule's headline pair
 * runs through `fixtures/<id>/positive.tf` and `negative.tf` and the shared
 * loader, so the HCL a test asserts on is the HCL the page shows; the extra
 * cases below each pair are the ones that are about a shape rather than a
 * file, and are written as small fixtures of their own through the same
 * loader rather than as hand-built entity maps.
 *
 * TF001 keeps its own file (./post-synth.test.ts) and TF023 is not a
 * post-synth check at all: it reads the audit's file list, so it is tested in
 * ../audit.test.ts against a real directory.
 */

describe("TF006: sensitive variable with a default", () => {
  test("flags a sensitive variable that carries a default", async () => {
    const diags = tf006.check(await loadFixture("TF006", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF006");
    expect(diags[0].entity).toBe("TF006/var.deploy_token");
    expect(diags[0].severity).toBe("error");
  });

  test("passes a sensitive variable with no default", async () => {
    expect(tf006.check(await loadFixture("TF006", "negative"))).toHaveLength(0);
  });

  test("an empty or null default still counts", async () => {
    const diags = tf006.check(await loadFixture("TF006", "positive-empty-default"));
    expect(diags.map((d) => d.entity).sort()).toEqual(["TF006/var.blank_token", "TF006/var.null_token"]);
  });
});

describe("TF007: secret-shaped literal in a variable default or a locals value", () => {
  test("flags a credential-named default and a credential-shaped local", async () => {
    const diags = tf007.check(await loadFixture("TF007", "positive"));
    expect(diags.map((d) => d.entity).sort()).toEqual(["TF007/locals.ci_token", "TF007/var.db_password"]);
    expect(diags.every((d) => d.checkId === "TF007")).toBe(true);
  });

  test("never repeats the value in the message", async () => {
    const diags = tf007.check(await loadFixture("TF007", "positive"));
    for (const d of diags) {
      expect(d.message).not.toContain("hunter2-prod-db");
      expect(d.message).not.toContain("ghp_");
    }
  });

  test("passes a sensitive variable with no default and a local that references one", async () => {
    expect(tf007.check(await loadFixture("TF007", "negative"))).toHaveLength(0);
  });
});

describe("TF008: hardcoded credentials in a provider block", () => {
  test("flags both literal credentials, whatever the provider is", async () => {
    const diags = tf008.check(await loadFixture("TF008", "positive"));
    expect(diags.map((d) => d.entity).sort()).toEqual([
      "TF008/provider.aws.access_key",
      "TF008/provider.aws.secret_key",
    ]);
  });

  test("passes a provider with no credential and one pointed at a key file", async () => {
    expect(tf008.check(await loadFixture("TF008", "negative"))).toHaveLength(0);
  });

  test("reads attribute names, not provider types, so a non-AWS provider is covered", async () => {
    const diags = tf008.check(await loadFixture("TF008", "positive-other-provider"));
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.entity).sort()).toEqual([
      "TF008/provider.postgresql.password",
      "TF008/provider.vault.token",
    ]);
  });

  test("a credential passed as a variable is the fix, not a finding", async () => {
    expect(tf008.check(await loadFixture("TF008", "negative-variable"))).toHaveLength(0);
  });
});

describe("TF009: credential-named variable not marked sensitive", () => {
  test("flags a password variable with no sensitive flag", async () => {
    const diags = tf009.check(await loadFixture("TF009", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF009/var.db_password");
  });

  test("passes a sensitive one, and an ARN that only points at a secret", async () => {
    expect(tf009.check(await loadFixture("TF009", "negative"))).toHaveLength(0);
  });
});

describe("TF010: variable without a type", () => {
  test("flags an untyped variable", async () => {
    const diags = tf010.check(await loadFixture("TF010", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF010/var.instance_count");
    expect(diags[0].severity).toBe("info");
  });

  test("passes a typed one", async () => {
    expect(tf010.check(await loadFixture("TF010", "negative"))).toHaveLength(0);
  });
});

describe("TF011: variable without a description", () => {
  test("flags an undocumented variable", async () => {
    const diags = tf011.check(await loadFixture("TF011", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF011/var.region");
  });

  test("passes a documented one", async () => {
    expect(tf011.check(await loadFixture("TF011", "negative"))).toHaveLength(0);
  });

  test("a blank description is no description", async () => {
    expect(tf011.check(await loadFixture("TF011", "positive-blank"))).toHaveLength(1);
  });
});

describe("TF012: output without a description", () => {
  test("flags an undocumented output", async () => {
    const diags = tf012.check(await loadFixture("TF012", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF012/output.bucket_name");
  });

  test("passes a documented one", async () => {
    expect(tf012.check(await loadFixture("TF012", "negative"))).toHaveLength(0);
  });
});

describe("TF013: ignore_changes = all", () => {
  test("flags a lifecycle block that ignores everything", async () => {
    const diags = tf013.check(await loadFixture("TF013", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF013/aws_instance.web");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes a named list of attributes", async () => {
    expect(tf013.check(await loadFixture("TF013", "negative"))).toHaveLength(0);
  });

  test("a data source's lifecycle block counts too", async () => {
    const diags = tf013.check(await loadFixture("TF013", "positive-data"));
    expect(diags.map((d) => d.entity)).toEqual(["TF013/data.aws_ami.base"]);
  });
});

describe("TF016: interpolation-only attribute values", () => {
  test("flags each quoted interpolation, with its file and line", async () => {
    const diags = tf016.check(await loadFixture("TF016", "positive"));
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.entity)).toEqual(["TF016/positive.tf:7", "TF016/positive.tf:12"]);
    expect(diags[0].message).toContain("bucket");
  });

  test("passes bare references, which the parse cannot tell apart from quoted ones", async () => {
    // The point of reading the source: `bucket = var.assets_bucket` parses to
    // exactly the same `"${var.assets_bucket}"` string as the positive fixture.
    expect(tf016.check(await loadFixture("TF016", "negative"))).toHaveLength(0);
  });

  test("passes a template that carries literal text as well", async () => {
    expect(tf016.check(await loadFixture("TF016", "negative-template"))).toHaveLength(0);
  });

  test("scans a file once however many blocks it holds", async () => {
    const diags = tf016.check(await loadFixture("TF016", "positive-shared-file"));
    expect(diags).toHaveLength(1);
  });
});

describe("TF017: depends_on on a module block", () => {
  test("flags the module call", async () => {
    const diags = tf017.check(await loadFixture("TF017", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF017/module.cdn");
  });

  test("passes a module wired through its inputs", async () => {
    expect(tf017.check(await loadFixture("TF017", "negative"))).toHaveLength(0);
  });
});

describe("TF018: output of a whole resource", () => {
  test("flags an output that returns the resource itself", async () => {
    const diags = tf018.check(await loadFixture("TF018", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF018/output.web_instance");
    expect(diags[0].message).toContain("aws_instance.web.id");
  });

  test("passes an attribute, and a whole module (its outputs are already curated)", async () => {
    expect(tf018.check(await loadFixture("TF018", "negative"))).toHaveLength(0);
  });

  test("a whole data source counts, a data source attribute does not", async () => {
    const diags = tf018.check(await loadFixture("TF018", "positive-data"));
    expect(diags.map((d) => d.entity)).toEqual(["TF018/output.base_ami"]);
  });
});

describe("TF019: a meta-argument set to its default false", () => {
  test("flags the variable flag and both lifecycle flags", async () => {
    const diags = tf019.check(await loadFixture("TF019", "positive"));
    expect(diags.map((d) => d.entity).sort()).toEqual([
      "TF019/aws_instance.web.create_before_destroy",
      "TF019/aws_instance.web.prevent_destroy",
      "TF019/var.log_level.sensitive",
    ]);
  });

  test("passes a root with no redundant defaults, and an expression is not a literal false", async () => {
    expect(tf019.check(await loadFixture("TF019", "negative"))).toHaveLength(0);
  });

  test("an output's ephemeral flag counts too", async () => {
    const diags = tf019.check(await loadFixture("TF019", "positive-output"));
    expect(diags.map((d) => d.entity)).toEqual(["TF019/output.endpoint.ephemeral"]);
  });
});

describe("TF022: credential-named resource attribute holding a literal", () => {
  test("flags the plaintext password", async () => {
    const diags = tf022.check(await loadFixture("TF022", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("TF022/aws_db_instance.app.password");
    expect(diags[0].message).not.toContain("Pr0dDbP4ssw0rd");
    expect(diags[0].message).toContain("reference");
  });

  test("passes a password read from a data source", async () => {
    expect(tf022.check(await loadFixture("TF022", "negative"))).toHaveLength(0);
  });

  test("descends into a nested block", async () => {
    const diags = tf022.check(await loadFixture("TF022", "positive-nested"));
    expect(diags.map((d) => d.entity)).toEqual(["TF022/aws_instance.web.connection.password"]);
  });

  test("a locator attribute is the remediation, not the finding", async () => {
    expect(tf022.check(await loadFixture("TF022", "negative-locator"))).toHaveLength(0);
  });
});
