# Two expanded module calls, one per expansion form, so every address the
# live-plan and state documents beside this directory carry is module-keyed
# (chant #4513): `module.app[0].aws_eip.pool[1]`, `module.edge["east"]...`.
#
# The instance key reaches the child only through a variable, which is the
# form choudoufu's identity resolver reads for a module call's count and
# for_each (internal/live/identity/moduleforeachvar_test.go,
# TestModuleCallCountVar and TestModuleCallForEachVar, testdata
# module-count-var/ and module-foreach-var/).

module "app" {
  source = "./modules/app"
  count  = 2
  index  = count.index
}

module "edge" {
  source   = "./modules/edge"
  for_each = toset(["east", "west"])
  zone     = each.key
}
