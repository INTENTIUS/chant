# The -findings layer of choudoufu terralith-gen -scale 4 -findings (INTENTIUS/choudoufu#2199),
# copied from its bastion.tf, data.tf and network.tf, for behold#912 steps 4 and 6 (#4375).
resource "aws_vpc" "main" {
  cidr_block = "10.42.0.0/16"
}

resource "aws_subnet" "main" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.1.0/24"
  availability_zone = "us-east-1a"

  tags = {
    Name = "tl-subnet"
  }
}

resource "aws_security_group" "ecs" {
  name        = "tl-ecs-sg"
  description = "terralith-gen: shared security group for the container-service layer"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}


resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "tl-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.42.2.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true

  tags = {
    Name = "tl-public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "tl-public"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "bastion" {
  name        = "tl-bastion-sg"
  description = "terralith-gen: the bastion's security group"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "bastion_ssh" {
  security_group_id = aws_security_group.bastion.id
  description       = "ssh from anywhere"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_launch_template" "bastion" {
  name                   = "tl-bastion"
  image_id               = "ami-12345678"
  instance_type          = "t3.micro"
  vpc_security_group_ids = [aws_security_group.bastion.id]

  # By arn, not name: floci returns the profile by ARN only (issue #2199).
  iam_instance_profile {
    arn = aws_iam_instance_profile.app_data.arn
  }
}

resource "aws_instance" "bastion" {
  subnet_id = aws_subnet.public.id

  launch_template {
    id      = aws_launch_template.bastion.id
    version = "$Latest"
  }

  tags = {
    Name = "tl-bastion"
  }

  # floci does not return the aws:ec2launchtemplate:id tag the provider
  # reads this block back from, so without this every plan replaces the
  # instance (issue #2199).
  lifecycle {
    ignore_changes = [launch_template]
  }
}

resource "aws_subnet" "db_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.10.0/24"
  availability_zone = "us-east-1a"

  tags = {
    Name = "tl-db-a"
  }
}

resource "aws_subnet" "db_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.11.0/24"
  availability_zone = "us-east-1b"

  tags = {
    Name = "tl-db-b"
  }
}

resource "aws_db_subnet_group" "orders" {
  name       = "tl-orders"
  subnet_ids = [aws_subnet.db_a.id, aws_subnet.db_b.id]
}

# storage_encrypted = true forces replacement; identifier and
# engine_version update in place on provider 6.59.0 (issue #2199).
resource "aws_db_instance" "orders" {
  identifier           = "tl-orders"
  engine               = "postgres"
  engine_version       = "16.3"
  instance_class       = "db.t3.micro"
  allocated_storage    = 20
  db_name              = "orders"
  username             = "orders_admin"
  password             = "emulator-only-not-a-secret"
  db_subnet_group_name = aws_db_subnet_group.orders.name
  storage_encrypted    = false
  skip_final_snapshot  = true
}

resource "aws_dynamodb_table" "sessions" {
  name         = "tl-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_iam_role" "app_data" {
  name = "tl-app-data-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_policy" "app_data" {
  name = "tl-app-data"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem"]
      Resource = aws_dynamodb_table.sessions.arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "app_data" {
  role       = aws_iam_role.app_data.name
  policy_arn = aws_iam_policy.app_data.arn
}

resource "aws_iam_instance_profile" "app_data" {
  name = "tl-app-data"
  role = aws_iam_role.app_data.name
}

# One of the eight team roles with dynamodb actions on Resource = "*" (iam.tf).
resource "aws_iam_role" "team_0002_role" {
  name = "tl-team-0002-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "team_0002_inline" {
  name = "tl-team-0002-inline"
  role = aws_iam_role.team_0002_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      Resource = "*"
    }]
  })
}
