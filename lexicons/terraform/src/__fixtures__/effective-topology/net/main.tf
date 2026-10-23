# One VPC, three instances. Only `web` is internet-facing with SSH open to the
# world, and it gets its SSH rule through a launch template's security group.
# Every way of writing a route to an internet gateway and every way of writing
# an ingress rule appears exactly once, each on a path a test pins (chant #4362).

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

# --- Subnets and routing --------------------------------------------------

# public_a routes to the IGW through an INLINE `route` block.
resource "aws_subnet" "public_a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_route_table" "public_inline" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public_inline.id
}

# public_b routes to the IGW through a separate `aws_route` resource.
resource "aws_subnet" "public_b" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.2.0/24"
}

resource "aws_route_table" "public_separate" {
  vpc_id = aws_vpc.main.id
}

resource "aws_route" "public_separate_default" {
  route_table_id         = aws_route_table.public_separate.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public_separate.id
}

# private's default route goes to a NAT gateway, which is not internet-facing.
resource "aws_subnet" "private" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.3.0/24"
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_a.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# --- Security groups ------------------------------------------------------

# web: SSH open to the world through an INLINE `ingress` block.
resource "aws_security_group" "web" {
  vpc_id = aws_vpc.main.id

  ingress {
    protocol    = "tcp"
    from_port   = 22
    to_port     = 22
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# batch: HTTPS through an `aws_vpc_security_group_ingress_rule` resource.
resource "aws_security_group" "batch" {
  vpc_id = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "batch_https" {
  security_group_id = aws_security_group.batch.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# db: SSH open to the world through an `aws_security_group_rule` resource. The
# egress rule beside it is not ingress and must not be counted.
resource "aws_security_group" "db" {
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group_rule" "db_ssh" {
  type              = "ingress"
  security_group_id = aws_security_group.db.id
  protocol          = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "db_egress" {
  type              = "egress"
  security_group_id = aws_security_group.db.id
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
  cidr_blocks       = ["0.0.0.0/0"]
}

# --- Instances ------------------------------------------------------------

resource "aws_launch_template" "web" {
  image_id               = "ami-12345678"
  instance_type          = "t3.micro"
  vpc_security_group_ids = [aws_security_group.web.id]
}

# Public, SSH open to the world via the launch template's group. The one match.
resource "aws_instance" "web" {
  subnet_id = aws_subnet.public_a.id

  launch_template {
    id      = aws_launch_template.web.id
    version = "$Latest"
  }
}

# Public (through the aws_route spelling), HTTPS only, group via `security_groups`.
resource "aws_instance" "batch" {
  ami             = "ami-12345678"
  instance_type   = "t3.micro"
  subnet_id       = aws_subnet.public_b.id
  security_groups = [aws_security_group.batch.id]
}

# Private, SSH open to the world via `vpc_security_group_ids`. Not reachable.
resource "aws_instance" "db" {
  ami                    = "ami-12345678"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.private.id
  vpc_security_group_ids = [aws_security_group.db.id]
}
