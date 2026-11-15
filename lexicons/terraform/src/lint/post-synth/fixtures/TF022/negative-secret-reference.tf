data "google_secret_manager_secret_version_access" "fastly_api_key" {
  secret = "fastly_api_key"
}

data "google_secret_manager_secret_version" "datadog" {
  secret  = "projects/example/secrets/datadog_api_key"
  version = "3"
}

data "aws_secretsmanager_secret_version" "db" {
  secret_id = "prod/app/db"
}

resource "google_cloud_run_v2_service" "app" {
  name     = "app"
  location = "us-central1"

  template {
    containers {
      image = "us-docker.pkg.dev/example/app:1"
      env {
        name = "API_KEY"
        value_source {
          secret_key_ref {
            secret  = "app_api_key"
            version = "latest"
          }
        }
      }
    }
  }
}
