# The capabilities the ledger doesn't exercise, each with a case that holds
# and one that doesn't (#4375).

# in-default-vpc: an instance in a subnet of the default VPC, and one outside it.
resource "aws_default_vpc" "default" {}
resource "aws_subnet" "legacy" {
  vpc_id     = aws_default_vpc.default.id
  cidr_block = "172.31.200.0/24"
}
resource "aws_vpc" "main" { cidr_block = "10.9.0.0/16" }
resource "aws_subnet" "main" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.9.0.0/24"
}
resource "aws_instance" "legacy" {
  ami                    = "ami-12345678"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.legacy.id
  vpc_security_group_ids = [aws_security_group.used.id]
}
resource "aws_instance" "current" {
  ami                    = "ami-12345678"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.main.id
  vpc_security_group_ids = [aws_security_group.used.id]
}

# attached-to-nothing: a group no instance uses, a policy no role holds, and
# a subnet nothing sits in.
resource "aws_security_group" "used" { vpc_id = aws_vpc.main.id }
resource "aws_security_group" "unused" { vpc_id = aws_vpc.main.id }
resource "aws_subnet" "empty" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.9.1.0/24"
}
resource "aws_iam_policy" "orphan" {
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "s3:ListBucket", Resource = aws_s3_bucket.open.arn }]
  })
}

# publicly-readable: a bucket policy for principal "*", once with nothing in
# its way and once behind a public-access block.
resource "aws_s3_bucket" "open" { bucket = "catalog-open" }
resource "aws_s3_bucket_policy" "open" {
  bucket = aws_s3_bucket.open.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "${aws_s3_bucket.open.arn}/*" }]
  })
}
resource "aws_s3_bucket" "blocked" { bucket = "catalog-blocked" }
resource "aws_s3_bucket_policy" "blocked" {
  bucket = aws_s3_bucket.blocked.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "${aws_s3_bucket.blocked.arn}/*" }]
  })
}
resource "aws_s3_bucket_public_access_block" "blocked" {
  bucket              = aws_s3_bucket.blocked.id
  block_public_policy = true
}

# holds-secret and encrypted-at-rest: a SecureString and a plain parameter,
# an encrypted file system and an unencrypted database.
resource "aws_ssm_parameter" "token" {
  name  = "/catalog/token"
  type  = "SecureString"
  value = "not-a-real-token"
}
resource "aws_ssm_parameter" "plain" {
  name  = "/catalog/plain"
  type  = "String"
  value = "hello"
}
resource "aws_efs_file_system" "shared" { encrypted = true }
resource "aws_db_instance" "plain" {
  engine            = "postgres"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  username          = "catalog"
  password          = "not-a-real-password"
  storage_encrypted = false
}

# grants: an explicit Deny on the same pair cancels the Allow.
resource "aws_iam_role" "denied" {
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_role_policy" "denied" {
  role = aws_iam_role.denied.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:*", Resource = aws_s3_bucket.open.arn },
      { Effect = "Deny", Action = "s3:*", Resource = aws_s3_bucket.open.arn },
      { Effect = "Allow", Action = "s3:GetObject", Resource = aws_s3_bucket.blocked.arn },
    ]
  })
}
