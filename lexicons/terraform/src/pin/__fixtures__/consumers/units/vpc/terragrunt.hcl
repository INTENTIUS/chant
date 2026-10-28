terraform {
  source = "tfr://registry.acme.dev/acme/vpc/aws?version=1.1.0"
}

inputs = {
  cidr = "10.0.0.0/16"
}
