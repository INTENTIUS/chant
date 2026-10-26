# The four configuration blocks that become entities (chant #4458): two
# `moved` blocks, an `import`, a `removed` and a `check` with a scoped `data`
# block. `aws_instance.old`, `module.legacy` and `aws_instance.gone` are not
# declared here, by design: that is what a `from` names.

variable "region" {
  type = string
}

resource "aws_instance" "web" {
  ami           = "ami-123"
  instance_type = "t3.micro"
}

resource "aws_lb" "front" {
  name = "front"
}

module "network" {
  source = "./modules/network"
}

# A root-level data source with the same address as the check's scoped one.
# The check's assertion reads its own, so no edge lands here from it.
data "http" "site" {
  url = "https://example.com"
}

moved {
  from = aws_instance.old
  to   = aws_instance.web
}

moved {
  from = module.legacy
  to   = module.network
}

import {
  to = aws_lb.front
  id = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/front/abc"
}

removed {
  from = aws_instance.gone

  lifecycle {
    destroy = false
  }
}

check "health" {
  data "http" "site" {
    url = "https://${aws_lb.front.dns_name}/healthz"
  }

  assert {
    condition     = data.http.site.status_code == 200
    error_message = "front is down in ${var.region}"
  }
}
