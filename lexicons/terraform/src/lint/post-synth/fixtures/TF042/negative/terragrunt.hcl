dependency "vpc" {
  config_path  = "../vpc"
  skip_outputs = true
}

dependency "db" {
  config_path  = "../db"
  skip_outputs = false

  mock_outputs = {
    endpoint = "db.example.com"
  }
}
