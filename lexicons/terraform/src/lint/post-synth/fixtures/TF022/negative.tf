data "aws_secretsmanager_secret_version" "db" {
  secret_id = "prod/app/db"
}

resource "aws_db_instance" "app" {
  identifier = "app-prod"
  engine     = "postgres"
  username   = "app"
  password   = data.aws_secretsmanager_secret_version.db.secret_string
}
