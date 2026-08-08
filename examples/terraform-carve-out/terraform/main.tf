# A small Terraform estate to practice carving out of, into native chant.
# Some resources are clean leaves; some are load-bearing; one has no native map.
# Run the walkthrough in this example's README with `chant carve`.

# Clean leaf: a bucket a Lambda reads from. Its versioning sub-resource folds in.
resource "aws_s3_bucket" "assets" {
  bucket = "myapp-assets-prod"
  tags   = { Team = "web", Env = "prod" }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Clean leaf: a log group nothing depends on.
resource "aws_cloudwatch_log_group" "api" {
  name              = "/myapp/api"
  retention_in_days = 30
}

# Reads the bucket (inbound edge → the survivor gets a data-source patch on carve).
resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
  environment {
    variables = {
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
      ASSETS_ARN    = aws_s3_bucket.assets.arn
      # A quoted address is a map key, not a reference — the expression AST
      # knows the difference, so this is NOT an edge to the log group.
      LOG_GROUP = var.settings["aws_cloudwatch_log_group.api.name"]
    }
  }
}

# Carvable with edits: three subnets depend on the VPC.
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_subnet" "b" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.2.0/24"
}

resource "aws_subnet" "c" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.3.0/24"
}

# Leave in Terraform: an unsupported provider, no native mapping. Scored 0.
resource "random_pet" "suffix" {
  length = 2
}
