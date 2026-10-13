# Vendored for TF031 (chant #2286), unmodified below this header.
# Source: https://github.com/alphagov/tech-ops/blob/122e78d1c6477825b22dd52f32e185a4a7838683/reliability-engineering/terraform/modules/concourse-monitoring/prometheus-ecs-iam.tf
# Repository: alphagov/tech-ops, path reliability-engineering/terraform/modules/concourse-monitoring/prometheus-ecs-iam.tf, commit 122e78d1c6477825b22dd52f32e185a4a7838683
# Licence: MIT
#
# Scoped policies only: every action is named and every resource is an
# attribute of a managed resource, which can never be "*". TF031 reports
# nothing, and not "not determined" either.
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

data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "prometheus_execution" {
  name               = "${var.deployment}-prometheus-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

data "aws_iam_policy_document" "prometheus_data_volume_access" {
  statement {
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.concourse_prometheus.arn]
    }

    actions = [
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
    ]

    condition {
      test     = "StringEquals"
      variable = "elasticfilesystem:AccessPointArn"
      values   = [aws_efs_access_point.prometheus.arn]
    }

    resources = [aws_efs_file_system.prometheus.arn]
  }
}

data "aws_iam_policy_document" "prometheus_cloudwatch_access" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = [
      aws_cloudwatch_log_group.prometheus.arn,
      "${aws_cloudwatch_log_group.prometheus.arn}:log-stream:*",
    ]
  }
}

resource "aws_iam_policy" "prometheus_cloudwatch_access" {
  name   = "${var.deployment}-prometheus-cloudwatch-access"
  policy = data.aws_iam_policy_document.prometheus_cloudwatch_access.json
}

resource "aws_iam_role_policy_attachment" "prometheus_cloudwatch_access" {
  role       = aws_iam_role.prometheus_execution.name
  policy_arn = aws_iam_policy.prometheus_cloudwatch_access.arn
}
