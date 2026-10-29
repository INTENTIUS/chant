# The app orders, from the template acme/orders/aws. Written by chant from a template request; a rollout moves the version.

module "app" {
  source  = "registry.example.com/acme/orders/aws"
  version = "1.2.0"

  bucket_name = "orders-data"
  replicas    = 3
  public      = true
  readers     = ["svc-a", "svc-b"]
  tags = {
    cost-center = "42"
    team        = "payments"
  }
  retention_days = 30
}

output "app_endpoint" {
  value = module.app.endpoint
}

output "app_bucket_arn" {
  value       = module.app.bucket_arn
  description = "The bucket's ARN."
}
