provider "vault" {
  address = "https://vault.internal:8200"
  token   = "9Rk2QpZ7mXt4LbW1nY6cV3dF"
}

provider "postgresql" {
  host     = "db.internal"
  username = "terraform"
  password = "9Rk2QpZ7mXt4LbW1"
}
