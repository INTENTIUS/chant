module "vpc" {
  source  = "registry.acme.dev/acme/vpc/aws"
  version = "1.0.0"
}

module "eks" {
  source  = "acme/eks/aws"
  version = "~> 2.0"
}

module "net" {
  source = "git::https://git.acme.dev/acme/net.git?ref=v1.2.0"
}

module "cache" {
  source = "oci://registry.acme.dev/modules/cache?tag=3.1.0"
}

module "local" {
  source = "./modules/local"
}
