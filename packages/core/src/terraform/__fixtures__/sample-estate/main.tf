# A small, deliberately mixed Terraform estate for the carve-out advisor demo.
# Some resources are clean leaves, some carry boundary edges, some should stay.

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

# Stays in Terraform: the Lambda reads the bucket (tier-2 map + outbound edge).
resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
  environment {
    variables = {
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
      ASSETS_ARN    = aws_s3_bucket.assets.arn
    }
  }
}

# Carvable w/ edits: three subnets depend on the VPC, so carving it means three
# data-source patches to the surviving Terraform — real but bounded boundary work.
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

# Leave in Terraform: an unsupported provider with no native mapping, scored 0.
resource "random_pet" "suffix" {
  length = 2
}
