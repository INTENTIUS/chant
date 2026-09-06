# Provider wiring for the live-root fixture. Derived from choudoufu's own
# live/e2e/estate-block/versions.tf; the estate name is declared in the
# estate.chdf.hcl sidecar beside this file rather than in a `live` block
# here, for the reason README.md gives.
#
# Same environment-variable wiring as choudoufu's own fixture
# (AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION);
# the provider block carries only the flags with no env-var form.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.58.0"
    }
  }
}

provider "aws" {
  skip_credentials_validation = true
  skip_metadata_api_check     = true

  # skip_requesting_account_id deliberately absent — same rationale as the
  # main estate's versions.tf (live/e2e/estate/versions.tf): letting the
  # provider resolve the account keeps tag-filtered discovery honest about
  # what real AWS would do.

  s3_use_path_style = true
}
