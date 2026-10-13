# Vendored for TF032 (chant #2287). Source: https://github.com/aquasecurity/trivy-checks
# Path: checks/cloud/aws/ecs/no_plaintext_secrets.yaml (terraform.bad[0])
# Commit: 71c05d02845cc2c3a5dfa4fe914a68a052cc88bf
# Licence: MIT
# Copyright (c) 2024 Aqua Security. MIT licence: https://github.com/aquasecurity/trivy-checks/blob/71c05d02845cc2c3a5dfa4fe914a68a052cc88bf/LICENSE
# The upstream check's own failing example, lifted out of its YAML block scalar unchanged.
# A heredoc with no interpolation arrives from hcl2json as a plain string, so it is read
# as JSON. Fires once, on DATABASE_PASSWORD.

resource "aws_ecs_task_definition" "bad_example" {
  container_definitions = <<EOF
 [
   {
     "name": "my_service",
     "environment": [
       { "name": "ENVIRONMENT", "value": "development" },
       { "name": "DATABASE_PASSWORD", "value": "oh no D:"}
     ]
   }
 ]
 EOF
}
