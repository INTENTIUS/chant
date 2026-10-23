# "ledger": the Terraform form of the estate chant#4361 measured the rule language on (#4375).
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" { region = "us-east-1" }

locals {
  ami        = "ami-0f3f13f145e66a0a3"
  restricted = { "data-classification" = "restricted" }
}

# network
resource "aws_vpc" "vpc" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "public" {
  vpc_id     = aws_vpc.vpc.id
  cidr_block = "10.0.0.0/24"
}
resource "aws_subnet" "private" {
  vpc_id     = aws_vpc.vpc.id
  cidr_block = "10.0.1.0/24"
}
resource "aws_internet_gateway" "igw" { vpc_id = aws_vpc.vpc.id }
resource "aws_route_table" "public" { vpc_id = aws_vpc.vpc.id }
resource "aws_route_table" "private" { vpc_id = aws_vpc.vpc.id }
resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.igw.id
}
resource "aws_route_table_association" "public" {
  route_table_id = aws_route_table.public.id
  subnet_id      = aws_subnet.public.id
}
resource "aws_route_table_association" "private" {
  route_table_id = aws_route_table.private.id
  subnet_id      = aws_subnet.private.id
}

resource "aws_security_group" "web" {
  description = "web"
  vpc_id      = aws_vpc.vpc.id
  ingress {
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    protocol    = "tcp"
    from_port   = 22
    to_port     = 22
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group" "app" {
  description = "app"
  vpc_id      = aws_vpc.vpc.id
}
resource "aws_vpc_security_group_ingress_rule" "app_from_web" {
  security_group_id            = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.web.id
}
resource "aws_security_group" "db" {
  description = "db"
  vpc_id      = aws_vpc.vpc.id
  ingress {
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.app.id]
  }
}

# data
resource "aws_s3_bucket" "assets" {}
resource "aws_s3_bucket" "customer_data" { tags = local.restricted }
resource "aws_dynamodb_table" "orders" {
  name         = "orders"
  hash_key     = "id"
  billing_mode = "PAY_PER_REQUEST"
  attribute {
    name = "id"
    type = "S"
  }
}
resource "aws_secretsmanager_secret" "db" { name = "ledger-db" }
resource "aws_secretsmanager_secret_version" "db" {
  secret_id     = aws_secretsmanager_secret.db.id
  secret_string = "generated-elsewhere"
}
resource "aws_db_instance" "customers" {
  engine                 = "postgres"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  username               = "ledger"
  password               = aws_secretsmanager_secret_version.db.secret_string
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  storage_encrypted      = true
  tags                   = { "data-classification" = "restricted" }
}

# identity
data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "web" { assume_role_policy = data.aws_iam_policy_document.ec2_trust.json }
resource "aws_iam_role" "deploy" {
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.web.arn }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_role_policy" "web" {
  name = "web"
  role = aws_iam_role.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.assets.arn}/*" },
      { Effect = "Allow", Action = "sts:AssumeRole", Resource = aws_iam_role.deploy.arn },
    ]
  })
}
resource "aws_iam_policy" "deploy" {
  name = "deploy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:*", Resource = [aws_s3_bucket.customer_data.arn, "${aws_s3_bucket.customer_data.arn}/*"] },
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = aws_secretsmanager_secret.db.arn },
    ]
  })
}
resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy.arn
}
resource "aws_iam_role" "worker" {
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
  inline_policy {
    name = "worker"
    policy = jsonencode({
      Version = "2012-10-17"
      Statement = [
        { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = aws_secretsmanager_secret.db.arn },
        { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = aws_dynamodb_table.orders.arn },
      ]
    })
  }
}
resource "aws_iam_role" "reporter" {
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_policy" "report_read" {
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.customer_data.arn}/*" },
      { Effect = "Allow", Action = "logs:*", Resource = "*" },
    ]
  })
}
resource "aws_iam_role_policy_attachment" "report_read" {
  role       = aws_iam_role.reporter.name
  policy_arn = aws_iam_policy.report_read.arn
}
resource "aws_iam_role" "batch" {
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_role_policy" "batch" {
  role = aws_iam_role.batch.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Resource = "arn:aws:iam::123456789012:role/audit" }]
  })
}
resource "aws_iam_role" "audit" {
  name = "audit"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.batch.arn }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_role_policy" "audit" {
  role = aws_iam_role.audit.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "dynamodb:Scan", Resource = aws_dynamodb_table.orders.arn }]
  })
}
resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.worker.arn }, Action = "s3:GetObject", Resource = "${aws_s3_bucket.assets.arn}/*" }]
  })
}

# compute
resource "aws_iam_instance_profile" "web" { role = aws_iam_role.web.name }
resource "aws_iam_instance_profile" "worker" { role = aws_iam_role.worker.name }
resource "aws_launch_template" "web" {
  image_id               = local.ami
  instance_type          = "t3.micro"
  vpc_security_group_ids = [aws_security_group.web.id]
}
resource "aws_instance" "web" {
  launch_template {
    id      = aws_launch_template.web.id
    version = "1"
  }
  subnet_id            = aws_subnet.public.id
  iam_instance_profile = aws_iam_instance_profile.web.name
}
resource "aws_instance" "worker" {
  ami                    = local.ami
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.private.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.worker.name
}
# in a public subnet, but nothing on the internet is allowed in
resource "aws_instance" "admin_box" {
  ami                    = local.ami
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.worker.name
}
resource "aws_lambda_function" "reporter" {
  function_name = "reporter"
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  role          = aws_iam_role.reporter.arn
  filename      = "fn.zip"
}
resource "aws_lambda_function_url" "reporter" {
  function_name      = aws_lambda_function.reporter.function_name
  authorization_type = "NONE"
}
resource "aws_lambda_function" "batch" {
  function_name = "batch"
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  role          = aws_iam_role.batch.arn
  filename      = "fn.zip"
}
