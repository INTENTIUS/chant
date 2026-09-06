provider "vault" {
  address = "https://vault.internal:8200"
  token   = var.vault_token
}

provider "postgresql" {
  host     = "db.internal"
  username = "terraform"
  password = data.aws_secretsmanager_secret_version.db.secret_string
}
