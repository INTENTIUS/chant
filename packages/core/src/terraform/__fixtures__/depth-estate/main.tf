# A Terraform estate built to close the gaps the carve dependency/blast-radius
# spike found in every other fixture (docs/design/carve-dependency-blast-
# radius-spike.md, #2323): none of them has a two-hop dependency chain, and
# none has a `depends_on` edge. Every resource below carries a comment saying
# which of those gaps it demonstrates; several are lifted verbatim from the
# spike's appendix, which lacked the `depends_on`, `count` and module cases
# folded in here.

# --- The depth chain: vpc -> subnet -> db_subnet_group -> rds_cluster -> instance ---
# aws_vpc.main sits three inbound hops upstream of aws_rds_cluster_instance.one
# (vpc -> subnet.a -> db_subnet_group.main -> rds_cluster.main -> instance/
# lambda), the transitive chain no shipped fixture has. Every other fixture's
# max transitive inbound depth is 1.
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

# count: without `--state`, `applyStateCounts` never runs, so a `.tf`-only
# parse reports 1 instance here and flags `hasDynamic`. The shipped
# terraform.tfstate resolves it to 3, so the fixture also exercises
# `readStateInstanceCounts`/`applyStateCounts` when advised with `--state`.
resource "aws_subnet" "private" {
  count      = 3
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.1.${count.index}.0/24"
}

resource "aws_security_group" "db" {
  vpc_id = aws_vpc.main.id
  name   = "db"
}

resource "aws_security_group" "app" {
  vpc_id = aws_vpc.main.id
  name   = "app"
}

resource "aws_db_subnet_group" "main" {
  name       = "main"
  subnet_ids = [aws_subnet.a.id, aws_subnet.b.id]
}

resource "aws_kms_key" "data" {
  description = "rds + s3"
}

resource "aws_rds_cluster" "main" {
  cluster_identifier     = "app-db"
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  kms_key_id             = aws_kms_key.data.arn
}

# Leave in Terraform: no native mapping (score 0), and the far end of the
# depth chain above — the node the whole fixture exists to put three hops
# behind aws_vpc.main.
resource "aws_rds_cluster_instance" "one" {
  identifier         = "app-db-1"
  cluster_identifier = aws_rds_cluster.main.id
}

# --- A second, shorter chain off the same VPC: lb -> target group -> listener ---
resource "aws_lb" "public" {
  name    = "app-lb"
  subnets = [aws_subnet.a.id, aws_subnet.b.id]
}

resource "aws_lb_target_group" "app" {
  name   = "app-tg"
  port   = 8080
  vpc_id = aws_vpc.main.id
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  default_action {
    target_group_arn = aws_lb_target_group.app.arn
    type             = "forward"
  }
}

# Clean leaf: a bucket a Lambda reads from. Its versioning sub-resource folds
# into it (same shape as `sample-estate`) and is never ranked on its own.
resource "aws_s3_bucket" "assets" {
  bucket = "app-assets"
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

# depends_on: nothing below reads an attribute off this log group, but the
# Lambda names it in `depends_on` — a real pattern (ordering a function's log
# group ahead of the function). hcl2json renders `depends_on =
# [aws_cloudwatch_log_group.api]` as the interpolation
# "${aws_cloudwatch_log_group.api}", which `refsInBlock` already picks up with
# `via: ["depends_on"]` and no attribute; nothing in the fixture corpus
# exercised it before this estate.
resource "aws_cloudwatch_log_group" "api" {
  name              = "/myapp/api"
  retention_in_days = 30
}

resource "aws_lambda_function" "api" {
  function_name = "app-api"
  kms_key_arn   = aws_kms_key.data.arn
  depends_on    = [aws_cloudwatch_log_group.api]
  environment {
    variables = {
      ASSETS = aws_s3_bucket.assets.bucket
      DB     = aws_rds_cluster.main.endpoint
      SG     = aws_security_group.app.id
    }
  }
}

# module: a module block is one graph node whatever it contains — state is
# read for root-module resources only, so radius through a module undercounts
# by however much the module holds. No other fixture has one.
module "platform" {
  source     = "./modules/platform"
  vpc_id     = aws_vpc.main.id
  subnet_ids = [aws_subnet.a.id, aws_subnet.b.id]
}

output "lb_dns"      { value = aws_lb.public.dns_name }
output "db_endpoint" { value = aws_rds_cluster.main.endpoint }
