# Vendored for TF037 (chant #2288) from https://github.com/lexicalunit/spellbot
# Path: infrastructure/app/ecr.tf
# Commit: 31ea539eff3df6da03195324f8bdd377210c54ec
# Licence: MIT, https://github.com/lexicalunit/spellbot/blob/31ea539eff3df6da03195324f8bdd377210c54ec/LICENSE.md
# Excerpt: lines 1-34, unmodified.
#
# TF037: silent. IMMUTABLE_WITH_EXCLUSION (provider v6) keeps SHA tags immutable and names the four moving
# tags that stay mutable.
#
# Copyright (c) 2026 spellbot@lexicalunit.com
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

# ECR repository for SpellBot application
resource "aws_ecr_repository" "spellbot" {
  name = "spellbot-app"

  # SHA-tagged images (the artifacts ECS actually pulls) are immutable. The
  # moving aliases below are rewritten by the deploy workflow on every push
  # and so must remain mutable.
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"

  image_tag_mutability_exclusion_filter {
    filter      = "stage"
    filter_type = "WILDCARD"
  }
  image_tag_mutability_exclusion_filter {
    filter      = "prod"
    filter_type = "WILDCARD"
  }
  image_tag_mutability_exclusion_filter {
    filter      = "latest"
    filter_type = "WILDCARD"
  }
  image_tag_mutability_exclusion_filter {
    filter      = "pr-*"
    filter_type = "WILDCARD"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "spellbot-ecr"
  }
}
