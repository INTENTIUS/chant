# Vendored for TF031 (chant #2286), unmodified below this header.
# Source: https://github.com/terraform-community-modules/tf_aws_ecs/blob/4a41e9c5acf4b71893bcb1ab3856c7c630f283d6/iam.tf
# Repository: terraform-community-modules/tf_aws_ecs, path iam.tf, commit 4a41e9c5acf4b71893bcb1ab3856c7c630f283d6
# Licence: MIT
#
# A heredoc with no interpolation is a literal string in the parse, so TF031
# reads it as JSON: aws_iam_policy.ecs_policy (Resource "*") fires, and so does
# data.aws_iam_policy_document.consul_task_policy. aws_iam_policy.custom_ecs_policy
# is "${var.custom_iam_policy}" and is reported as not determined.
#
# Copyright (c) 2016 Tim Hartmann
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

resource "aws_iam_instance_profile" "ecs_profile" {
  name_prefix = "${replace(format("%.102s", replace("tf-ECSProfile-${var.name}-", "_", "-")), "/\\s/", "-")}"
  role        = "${aws_iam_role.ecs_role.name}"
  path        = "${var.iam_path}"
}

resource "aws_iam_role" "ecs_role" {
  name_prefix = "${replace(format("%.32s", replace("tf-ECSInRole-${var.name}-", "_", "-")), "/\\s/", "-")}"
  path        = "${var.iam_path}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
      "Service": ["ecs.amazonaws.com", "ec2.amazonaws.com"]

    },
    "Effect": "Allow",
    "Sid": ""
    }
  ]
}
EOF
}

# It may be useful to add the following for troubleshooting the InstanceStatus
# Health check if using the fitnesskeeper/consul docker image
# "ec2:Describe*",
# "autoscaling:Describe*",

resource "aws_iam_policy" "ecs_policy" {
  name_prefix = "${replace(format("%.102s", replace("tf-ECSInPol-${var.name}-", "_", "-")), "/\\s/", "-")}"
  description = "A terraform created policy for ECS"
  path        = "${var.iam_path}"
  count       = "${length(var.custom_iam_policy) > 0 ? 0 : 1}"

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:CreateCluster",
        "ecs:DeregisterContainerInstance",
        "ecs:DiscoverPollEndpoint",
        "ecs:Poll",
        "ecs:RegisterContainerInstance",
        "ecs:StartTelemetrySession",
        "ecs:Submit*",
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
EOF
}

resource "aws_iam_policy" "custom_ecs_policy" {
  name_prefix = "${replace(format("%.102s", replace("tf-ECSInPol-${var.name}-", "_", "-")), "/\\s/", "-")}"
  description = "A terraform created policy for ECS"
  path        = "${var.iam_path}"
  count       = "${length(var.custom_iam_policy) > 0 ? 1 : 0}"

  policy = "${var.custom_iam_policy}"
}

resource "aws_iam_policy_attachment" "attach_ecs" {
  name       = "ecs-attachment"
  roles      = ["${aws_iam_role.ecs_role.name}"]
  policy_arn = "${element(concat(aws_iam_policy.ecs_policy.*.arn, aws_iam_policy.custom_ecs_policy.*.arn), 0)}"
}

# IAM Resources for Consul and Registrator Agents

data "aws_iam_policy_document" "consul_task_policy" {
  statement {
    actions = [
      "ec2:Describe*",
      "autoscaling:Describe*",
    ]

    resources = ["*"]
  }
}

data "aws_iam_policy_document" "assume_role_consul_task" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "consul_task" {
  count              = "${var.enable_agents ? 1 : 0}"
  name_prefix        = "${replace(format("%.32s", replace("tf-agentTaskRole-${var.name}-", "_", "-")), "/\\s/", "-")}"
  path               = "${var.iam_path}"
  assume_role_policy = "${data.aws_iam_policy_document.assume_role_consul_task.json}"
}

resource "aws_iam_role_policy" "consul_ecs_task" {
  count       = "${var.enable_agents ? 1 : 0}"
  name_prefix = "${replace(format("%.102s", replace("tf-agentTaskPol-${var.name}-", "_", "-")), "/\\s/", "-")}"
  role        = "${aws_iam_role.consul_task.id}"
  policy      = "${data.aws_iam_policy_document.consul_task_policy.json}"
}
