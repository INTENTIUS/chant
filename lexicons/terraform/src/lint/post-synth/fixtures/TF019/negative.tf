variable "log_level" {
  type        = string
  description = "Log level the application starts with"
  default     = "info"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"

  lifecycle {
    prevent_destroy = var.protect_instances
  }
}
