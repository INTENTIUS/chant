resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"

  connection {
    type     = "ssh"
    user     = "ubuntu"
    password = "B00tstrapP4ssword"
  }
}
