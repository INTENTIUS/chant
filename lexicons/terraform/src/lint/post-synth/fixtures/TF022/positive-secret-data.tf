resource "google_secret_manager_secret_version" "app" {
  secret      = "app_api_key"
  secret_data = "Pr0dS3cretValue-9xQ2"
}

resource "example_widget" "w" {
  secret = "plainly-committed-value"
}
