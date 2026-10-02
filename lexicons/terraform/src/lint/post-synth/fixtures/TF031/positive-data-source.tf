# Vendored for TF031 (chant #2286), unmodified below this header.
# Source: https://github.com/alphagov/tech-ops/blob/122e78d1c6477825b22dd52f32e185a4a7838683/cyber-security/modules/gds_security_audit_role/inline_policies.tf
# Repository: alphagov/tech-ops, path cyber-security/modules/gds_security_audit_role/inline_policies.tf, commit 122e78d1c6477825b22dd52f32e185a4a7838683
# Licence: MIT
#
# TF031 fires on both aws_iam_policy_document data sources (resources = ["*"]).
# The two aws_iam_role_policy resources name those documents' .json and are
# not reported again.
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

data "aws_iam_policy_document" "support_inline_policy_document" {
  statement {
    effect    = "Allow"
    actions   = ["support:*"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "support_inline_policy" {
  name   = "${var.prefix}GDSSecurityAuditInlineSupportPolicy"
  role   = aws_iam_role.gds_security_audit_role.id
  policy = data.aws_iam_policy_document.support_inline_policy_document.json
}

data "aws_iam_policy_document" "sts_inline_policy_document" {
  statement {
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sts_inline_policy" {
  name   = "${var.prefix}GDSSecurityAuditInlineSTSPolicy"
  role   = aws_iam_role.gds_security_audit_role.id
  policy = data.aws_iam_policy_document.sts_inline_policy_document.json
}

