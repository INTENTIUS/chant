output "endpoint" {
  description = "Endpoint the application is served from"
  value       = aws_lb.web.dns_name
  ephemeral   = false
}
