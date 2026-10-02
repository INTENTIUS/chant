# Vendored for TF032 (chant #2287). Source: https://github.com/aquasecurity/trivy-checks
# Path: checks/cloud/aws/ecs/no_plaintext_secrets.yaml (terraform.good[0])
# Commit: 71c05d02845cc2c3a5dfa4fe914a68a052cc88bf
# Licence: MIT
# Copyright (c) 2024 Aqua Security. MIT licence: https://github.com/aquasecurity/trivy-checks/blob/71c05d02845cc2c3a5dfa4fe914a68a052cc88bf/LICENSE
# The upstream check's own passing example, lifted out of its YAML block scalar unchanged.
# Silent: the one environment entry is not a credential.

resource "aws_ecs_task_definition" "good_example" {
  container_definitions = <<EOF
 [
   {
     "name": "my_service",
     "environment": [
       { "name": "ENVIRONMENT", "value": "development" }
     ]
   }
 ]
 EOF
}
