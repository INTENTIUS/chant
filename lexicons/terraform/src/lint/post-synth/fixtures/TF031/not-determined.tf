# Vendored for TF031 (chant #2286), unmodified below this header.
# Source: https://github.com/alphagov/tech-ops/blob/122e78d1c6477825b22dd52f32e185a4a7838683/reliability-engineering/terraform/modules/concourse-secrets-admin/iam.tf
# Repository: alphagov/tech-ops, path reliability-engineering/terraform/modules/concourse-secrets-admin/iam.tf, commit 122e78d1c6477825b22dd52f32e185a4a7838683
# Licence: MIT
#
# Both documents build Statement with concat(...) and a for-expression, so
# TF031 cannot read them and reports not determined, never a warning. The
# Deny statement with Action "*" and Resource "*" inside the concat is a guard
# rail and would not fire even if it were readable.
#
# Copyright (c) 2018 Government Digital Service
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

resource "aws_iam_role" "concourse_secrets_admin" {
  name = "${var.deployment}-${var.concourse_team_name}-concourse-secrets-admin"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        for team_id in concat(
          var.trusted_github_team_id == "" ? [] : [var.trusted_github_team_id],
          var.trusted_github_team_ids
        ) : {
          Effect = "Allow"
          Principal = {
            Federated = var.iam_oidc_provider_arn
          }
          Action = "sts:AssumeRoleWithWebIdentity"
          Condition = {
            StringEquals = {
              "${var.oidc_host_path}:aud" = var.github_oauth_client_id
              "aws:RequestTag/t${team_id}" = "t"
            }
          }
        }
      ],
      [
        {
          Sid = "AllowPassSessionTagsAndTransitive"
          Effect = "Allow"
          Action = "sts:TagSession"
          Principal = {
            Federated = var.iam_oidc_provider_arn
          }
        }
      ],
      (length(var.allowed_cidrs) == 0 ? [] : [{
          Sid = "DisallowAssumeFromUntrustedCIDR"
          Effect = "Deny"
          Principal = {
            Federated = var.iam_oidc_provider_arn
          }
          Action = "sts:AssumeRoleWithWebIdentity"
          Condition = {
            NotIpAddress = {
              "aws:SourceIp" = var.allowed_cidrs
            }
          }
        }
      ])
    )
  })
}

resource "aws_iam_role_policy" "concourse_secrets_admin" {
  name = "${var.deployment}-${var.concourse_team_name}-concourse-secrets-admin-policy"
  role = aws_iam_role.concourse_secrets_admin.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Action = [
            "ssm:GetParameter",
            "ssm:GetParameterHistory",
            "ssm:GetParameters",
            "ssm:GetParametersByPath",
            "ssm:DeleteParameter",
            "ssm:PutParameter",
          ]
          Effect = "Allow"
          Resource = [
            "arn:aws:ssm:eu-west-2:${data.aws_caller_identity.account.account_id}:parameter/${var.deployment}/concourse/pipelines/${var.concourse_team_name}/*"
          ]
        }, {
          Action = [
            "ssm:DeleteParameter",
            "ssm:PutParameter",
          ]
          Effect = "Deny"
          Resource = [
            "arn:aws:ssm:eu-west-2:${data.aws_caller_identity.account.account_id}:parameter/${var.deployment}/concourse/pipelines/${var.concourse_team_name}/readonly_*"
          ]
        }, {
          Action = [
            "kms:ListKeys",
            "kms:ListAliases",
            "kms:Describe*",
            "kms:Decrypt",
            "kms:Encrypt",
          ]
          Effect = "Allow"
          Resource = var.kms_key_arn
        }
      ],
      (length(var.allowed_cidrs) == 0 ? [] : [{
          Sid = "DisallowAllFromUntrustedCIDR"
          Effect = "Deny"
          Action = "*"
          Resource = "*"
          Condition = {
            NotIpAddress = {
              "aws:SourceIp" = var.allowed_cidrs
            }
          }
        }
      ])
    )
  })
}
