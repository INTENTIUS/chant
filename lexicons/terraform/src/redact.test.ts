/**
 * A sensitive variable's literal default is left out of the IR (chant #4377).
 *
 * Unit tests on the scanner and on `blocksToEntities`. The commands' output
 * is grepped in redact-ir.e2e.test.ts.
 */
import { describe, expect, it } from "vitest";
import { redactSensitiveSource, SENSITIVE_PLACEHOLDER } from "./hcl/redact";
import { blocksToEntities, type TerraformEntity } from "./hcl/parse";

const FILE = `variable "token" {
  type      = string
  default   = "hunter2"
  sensitive = true
}

variable "port" {
  default   = 5432
  sensitive = true
}

variable "creds" {
  sensitive = true
  default = {
    user = "admin"
    pass = "s3cret"
    note = <<-EOT
      heredoc } with "quotes"
    EOT
  }
  validation {
    condition     = length(var.creds) > 0
    error_message = "default = \\"nope\\""
  }
}

variable "region" {
  default = "us-east-1"
}

variable "plain" {
  default   = "visible"
  sensitive = false
}

resource "aws_db_instance" "main" {
  password = var.token # default = "hunter2"
}
`;

describe("redactSensitiveSource", () => {
  const out = redactSensitiveSource(FILE);

  it("replaces a string, a number and a multi-line map default", () => {
    expect(out).toContain("default   = (sensitive)\n  sensitive = true\n}\n\nvariable \"port\"");
    expect(out).toContain("default   = (sensitive)\n  sensitive = true\n}\n\nvariable \"creds\"");
    expect(out).toContain("sensitive = true\n  default = (sensitive)\n  validation {");
    for (const secret of ["hunter2\"\n  sensitive", "5432", "s3cret", "admin", "heredoc"]) expect(out).not.toContain(secret);
  });

  it("leaves everything else byte for byte", () => {
    expect(out).toContain('default = "us-east-1"');
    expect(out).toContain('default   = "visible"');
    expect(out).toContain('error_message = "default = \\"nope\\""');
    expect(out).toContain('password = var.token # default = "hunter2"');
  });

  it("handles a one-line block", () => {
    expect(redactSensitiveSource('variable "t" { default = "hunter2", sensitive = true }')).toBe('variable "t" { default = (sensitive), sensitive = true }');
    expect(redactSensitiveSource('variable "t" { sensitive = true, default = "hunter2" }')).toBe('variable "t" { sensitive = true, default = (sensitive) }');
  });
});

describe("blocksToEntities", () => {
  const source = `variable "s" {
  default   = "str-secret"
  sensitive = true
}
variable "n" {
  default   = 424242
  sensitive = true
}
variable "m" {
  sensitive = true
  default = {
    a = "map-secret"
    b = 7
  }
}
variable "open" {
  default = "visible-default"
}
`;

  it("redacts default in source and body but keeps the key, for a string, a number and a map", async () => {
    const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
    for (const name of ["s", "n", "m"]) {
      const e = entities.get(`app/var.${name}`) as TerraformEntity;
      expect("default" in e.props.body).toBe(true);
      expect(e.props.body.default).toBe(SENSITIVE_PLACEHOLDER);
      for (const secret of ["str-secret", "424242", "map-secret"]) expect(JSON.stringify(e.props)).not.toContain(secret);
    }
  });

  it("leaves a non-sensitive default alone, in body and source", async () => {
    const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
    const e = entities.get("app/var.open") as TerraformEntity;
    expect(e.props.body.default).toBe("visible-default");
    expect(e.props.source).toContain('default = "visible-default"');
  });
});
