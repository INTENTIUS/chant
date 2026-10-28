output "vpc_id" {
  value       = aws_vpc.this.id
  description = "The VPC's id."
}

output "arn" {
  value     = aws_vpc.this.arn
  sensitive = true
}
