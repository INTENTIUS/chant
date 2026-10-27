# Provider wiring, copied from ../../live-estate/versions.tf (itself derived
# from choudoufu's live/e2e/estate-block/versions.tf). The estate name is in
# the estate.chdf.hcl sidecar beside this file, as in live-estate/.
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
