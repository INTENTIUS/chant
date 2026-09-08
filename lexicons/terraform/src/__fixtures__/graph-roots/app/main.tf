variable "region" {
  type = string
}

variable "subnets" {
  type = list(string)
}

provider "aws" {
  alias  = "replica"
  region = var.region
}

data "aws_iam_policy" "boundary" {
  name = "waterpark-boundary"
}

resource "aws_s3_bucket" "assets" {
  provider = aws.replica
  bucket   = "app-assets"
}

module "cdn" {
  source = "./modules/cdn"

  bucket = aws_s3_bucket.assets.id
}

resource "aws_instance" "web" {
  count      = length(var.subnets)
  subnet_id  = var.subnets[count.index]
  depends_on = [aws_s3_bucket.assets, module.cdn]

  tags = {
    boundary = data.aws_iam_policy.boundary.arn
  }
}

output "cdn_url" {
  value = module.cdn.url
}
