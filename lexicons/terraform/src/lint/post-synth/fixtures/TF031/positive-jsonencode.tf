# Vendored for TF031 (chant #2286), unmodified below this header.
# Source: https://github.com/BishopFox/iam-vulnerable/blob/0f298666f9b7cfa01488b86912afdb211773188a/modules/free-resources/privesc-paths/privesc-AssumeRole.tf
# Repository: BishopFox/iam-vulnerable, path modules/free-resources/privesc-paths/privesc-AssumeRole.tf, commit 0f298666f9b7cfa01488b86912afdb211773188a
# Licence: MIT
#
# TF031 fires on aws_iam_policy.privesc-AssumeRole-high-priv-policy: a literal
# jsonencode() policy whose one Allow statement has Action "*" and Resource "*".
# The three roles' assume_role_policy documents carry a reference Principal
# beside a literal Action, and are read as scoped, not as not determined.
#
# Copyright (c) 2021 Bishop Fox
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

resource "aws_iam_policy" "privesc-AssumeRole-high-priv-policy" {
  name        = "privesc-AssumeRole-high-priv-policy"
  path        = "/"
  description = "Allows privesc via targeted sts:AssumeRole"

  # Terraform's "jsonencode" function converts a
  # Terraform expression result to valid JSON syntax.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action = "*"
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role" "privesc-AssumeRole-starting-role" {
  name                = "privesc-AssumeRole-starting-role"
  assume_role_policy  = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Sid    = ""
        Principal = {
          AWS = var.aws_assume_role_arn
        }
      },
    ]
  })
}

resource "aws_iam_role" "privesc-AssumeRole-intermediate-role" {
  name                = "privesc-AssumeRole-intermediate-role"
  assume_role_policy  = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Sid    = ""
        Principal = {
          AWS = aws_iam_role.privesc-AssumeRole-starting-role.arn
        }
      },
    ]
  })
}


resource "aws_iam_role" "privesc-AssumeRole-ending-role" {
  name                = "privesc-AssumeRole-ending-role"
  assume_role_policy  = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Sid    = ""
        Principal = {
          AWS = aws_iam_role.privesc-AssumeRole-intermediate-role.arn
        }
      },
    ]
  })
}



resource "aws_iam_user" "privesc-AssumeRole-start-user" {
  name = "privesc-AssumeRole-start-user"
  path = "/"
}
resource "aws_iam_access_key" "privesc-AssumeRole-start-user" {
  user = aws_iam_user.privesc-AssumeRole-start-user.name
}
resource "aws_iam_role_policy_attachment" "privesc-AssumeRole-high-priv-policy-role-attach-policy" {
  role       = aws_iam_role.privesc-AssumeRole-ending-role.name
  policy_arn = aws_iam_policy.privesc-AssumeRole-high-priv-policy.arn

}  