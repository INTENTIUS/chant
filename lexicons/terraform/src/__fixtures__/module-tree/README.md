# module-tree

Four roots for the module-descent tests (`src/hcl/descend.test.ts`, chant
#2112). Nothing here is applied, and no provider is real; the shapes are what
the descent has to get right.

- `root/` calls `./modules/cdn` (which itself calls `./modules/bucket`, two
  levels) and a registry module. The registry call is where "not followed"
  is asserted; the local ones are where the `<root>/module.<name>/<address>`
  keys and the `callers` chains are.
- `cycle/` is `a` calling `b` calling `a`, the case the visited set on
  resolved paths has to stop.
- `outside/root` sources `../../shared`, which resolves outside `outside/`,
  the project root the test hands the render. `shared/` is the directory it
  points at, deliberately reachable on disk so the refusal is about the
  boundary and not about a missing directory.
