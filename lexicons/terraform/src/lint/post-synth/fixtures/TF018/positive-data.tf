output "base_ami" {
  description = "The whole AMI data source"
  value       = data.aws_ami.base
}

output "base_ami_id" {
  description = "Id of the base AMI"
  value       = data.aws_ami.base.id
}
