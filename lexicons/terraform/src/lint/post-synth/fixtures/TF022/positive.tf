resource "aws_db_instance" "app" {
  identifier = "app-prod"
  engine     = "postgres"
  username   = "app"
  password   = "Pr0dDbP4ssw0rd"
}
