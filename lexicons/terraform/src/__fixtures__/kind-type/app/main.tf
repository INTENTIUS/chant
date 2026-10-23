# Two instances, one IAM role and one inline policy on it. The policy's type
# begins with the role's, so `kind:aws_iam_role` has to stop at the type
# boundary to leave it out (chant #4366).

resource "aws_iam_role" "app" {
  name               = "app"
  assume_role_policy = "{}"
}

resource "aws_iam_role_policy" "app" {
  name   = "app"
  role   = aws_iam_role.app.id
  policy = "{}"
}

resource "aws_instance" "web" {
  ami           = "ami-12345678"
  instance_type = "t3.micro"
}

resource "aws_instance" "worker" {
  ami           = "ami-12345678"
  instance_type = "t3.micro"
}
