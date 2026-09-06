resource "aws_ecs_task_definition" "app" {
  family = "app"

  secret_arn      = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/app/db-AbCdEf"
  api_key_id      = "ak-0f3c1d9e"
  private_key_path = "/etc/ssl/private/app.pem"
}
