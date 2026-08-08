import { describe, test, expect } from "vitest";
import { exciseResourceBlocks, type ExciseTarget } from "./excise";

const bucket: ExciseTarget = { address: "aws_s3_bucket.assets", type: "aws_s3_bucket", name: "assets" };
const versioning: ExciseTarget = {
  address: "aws_s3_bucket_versioning.assets",
  type: "aws_s3_bucket_versioning",
  name: "assets",
};

describe("exciseResourceBlocks", () => {
  test("removes the target block, leaves the rest byte-for-byte", () => {
    const tf = `# the bucket
resource "aws_s3_bucket" "assets" {
  bucket = "myapp-assets-prod"
  tags   = { Team = "web" }
}

resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
}
`;
    const r = exciseResourceBlocks(tf, [bucket]);
    expect(r.excised).toEqual(["aws_s3_bucket.assets"]);
    expect(r.content).toBe(`# the bucket
resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
}
`);
  });

  test("removes several targets (a folded sub-resource travels with its parent)", () => {
    const tf = `resource "aws_s3_bucket" "assets" {
  bucket = "b"
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_sns_topic" "alerts" {
  name = "a"
}
`;
    const r = exciseResourceBlocks(tf, [bucket, versioning]);
    expect(r.excised).toEqual(["aws_s3_bucket.assets", "aws_s3_bucket_versioning.assets"]);
    expect(r.content).toBe(`resource "aws_sns_topic" "alerts" {\n  name = "a"\n}\n`);
  });

  test("a same-name block of a different type stays", () => {
    const tf = `resource "aws_s3_bucket" "assets" { bucket = "b" }
resource "aws_s3_bucket_versioning" "assets" { bucket = "b" }
`;
    const r = exciseResourceBlocks(tf, [bucket]);
    expect(r.excised).toEqual(["aws_s3_bucket.assets"]);
    expect(r.content).toContain('resource "aws_s3_bucket_versioning" "assets"');
  });

  test("braces inside strings, interpolations, comments, and heredocs do not fool the scanner", () => {
    const tf = `resource "aws_s3_bucket" "assets" {
  bucket = "b"
  # a } in a comment
  policy = jsonencode({ Statement = [{ Effect = "Allow" }] })
  note   = "literal } and \${var.m["k}"]} too"
  user_data = <<EOF
    if true; then echo "}"; fi
EOF
}
resource "aws_sns_topic" "alerts" { name = "a" }
`;
    const r = exciseResourceBlocks(tf, [bucket]);
    expect(r.excised).toEqual(["aws_s3_bucket.assets"]);
    expect(r.content).toBe(`resource "aws_sns_topic" "alerts" { name = "a" }\n`);
  });

  test("no target present → the file comes back unchanged", () => {
    const tf = `resource "aws_sns_topic" "alerts" { name = "a" }\n`;
    const r = exciseResourceBlocks(tf, [bucket]);
    expect(r.excised).toEqual([]);
    expect(r.content).toBe(tf);
  });

  test("an unbalanced block is left alone rather than corrupted", () => {
    const tf = `resource "aws_s3_bucket" "assets" {\n  bucket = "b"\n`;
    const r = exciseResourceBlocks(tf, [bucket]);
    expect(r.excised).toEqual([]);
    expect(r.content).toBe(tf);
  });
});
