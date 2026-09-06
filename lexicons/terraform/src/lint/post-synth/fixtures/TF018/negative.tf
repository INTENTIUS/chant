output "web_instance_id" {
  description = "Id of the web instance"
  value       = aws_instance.web.id
}

output "cdn" {
  description = "Everything the cdn module returns"
  value       = module.cdn
}
