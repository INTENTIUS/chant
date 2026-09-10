# Dependency and blast-radius detection for `chant carve advise`

Research spike. Two questions the carve advisor cannot answer today: does it see every
dependency an estate actually has, and can it say how much of the estate a carve disturbs
beyond the edges it cuts. Both were measured rather than reasoned about — every number below
came out of a prototype run against the shipped fixtures and against estates written for the
run. chant 0.61.0 at `08575889`, Node v24.13.1, `@cdktf/hcl2json` 0.21.0.

The short version: the graph layer is sound and its edge extraction is better than expected
in one place (`depends_on`) and blind in two others (`locals`, `data` blocks). Transitive
reach is absent, cheap to add, and worth adding for its magnitude rather than its ranking.

## 1. What the graph detects today, and what it misses

`buildGraph` (`packages/core/src/terraform/graph.ts:205`) classifies traversal accessors the
hcl2json expression AST resolved, so a quoted address inside an expression is not mistaken for
a reference. Its coverage was probed with an estate whose every resource depends on one bucket
by a different route.

```
resource "aws_s3_bucket" "assets" { bucket = "app-assets" }

locals { assets_id = aws_s3_bucket.assets.id }
resource "aws_lambda_function" "via_local" { ... B = local.assets_id }

data "aws_s3_bucket" "lookup" { bucket = aws_s3_bucket.assets.bucket }
resource "aws_lambda_function" "via_data" { ... B = data.aws_s3_bucket.lookup.arn }

resource "aws_lambda_function" "direct" { ... B = aws_s3_bucket.assets.arn }
```

Three real dependents. The advisor reports one:

```
addr                                   score in out
aws_s3_bucket.assets                      88  1   0
aws_lambda_function.via_local             85  0   0
aws_lambda_function.direct                81  0   1
aws_lambda_function.via_data              75  0   0
```

The bucket lands in the top band, "clean leaf — carve now", on a count that is a third of the
truth.

*Corrected while fixing this in #2342: the bridge half of this claim was overstated as first
written, and the correction is worth keeping because it changes what a reproduction looks like.
On the estate above, `carve bridge` already rewires all three routes. `generateBridge`'s rewrite
is whole-file, so the single direct reference is enough to put one inbound edge on the bucket,
and once the rewrite fires it catches the `locals` and `data` routes with it. The genuine break
needs the direct reference absent: with only indirect routes the bucket has zero inbound edges,
so no data source is generated, nothing is rewritten, and the bucket's own block is still
excised — which is the broken plan. The scoring error stands unqualified either way, and it is
what puts the bucket in the top band.*

The cause is one line of traversal. `collectExpressions` (`:89`) visits `tree.resource`,
`tree.module` and `tree.output` and nothing else (`:100`), so expressions inside `locals` and
`data` blocks are never handed to the AST at all, and `local` is in `NON_RESOURCE_HEADS`
(`:27`) so a resolved `local.x` accessor would be discarded anyway. Both are non-node
referrers that sit on a path between two nodes, which is the same shape as the `output` block
the graph already models: not carvable, but load-bearing for the plan.

`depends_on` was expected to be a third gap and is not. hcl2json renders
`depends_on = [aws_s3_bucket.assets]` as the interpolation `"${aws_s3_bucket.assets}"`, so
`refsInBlock` (`:131`) picks it up with `via: ["depends_on"]` and no attribute, and a
`depends_on` chain of three resources produces the correct two edges and a transitive depth of
2. That behaviour is real and untested; nothing in the fixture corpus contains a `depends_on`.

Two smaller residues, both correct to leave alone. A `provider` block referencing a resource
yields no edge, which is right, since a provider is not part of the plan graph the way a
resource is. A reference through a `var` default is unresolvable without evaluating the
variable and should stay unresolved.

## 2. The fixture corpus cannot see a transitive dependency at all

Before measuring what transitive reach buys, the question is what the existing tests would
notice. Reachability was computed over every shipped estate:

| Fixture | nodes | edges | max transitive depth | any node where radius > direct |
|---|---|---|---|---|
| `__fixtures__/sample-estate` | 9 | 5 | 1 | no |
| `__fixtures__/gcp-estate` | 10 | 6 | 1 | no |
| `examples/terraform-carve-out/terraform` | 9 | 5 | 1 | no |
| `examples/terraform-carve-out/kubernetes` | 4 | 1 | 1 | no |
| `cdk/__fixtures__/cdk.out` | 6 | 4 | 1 | no |

Not one estate in the repository contains a two-hop dependency chain. The gcp estate looks
like it should: `google_container_cluster.primary` reads `google_compute_subnetwork.a`, which
reads `google_compute_network.main`. But the cluster also reads the network directly, so it is
already counted as a direct inbound edge and the transitive walk adds nothing. On every
fixture, transitive radius equals `breakdown.inbound + breakdown.outputs` exactly.

So a transitive implementation would pass the entire existing suite whether it was correct,
inverted, or a stub returning the direct count. A fixture with genuine depth is a precondition
for the work, not a nicety.

## 3. What transitive reach changes on an estate that has depth

The estate below is deliberately unremarkable: a VPC, two subnets, two security groups, a
subnet group, an Aurora cluster and its instance, a load balancer with a target group and
listener, a KMS key, a bucket with its versioning sub-resource, a Lambda, and two outputs.
Fifteen nodes, twenty-two edges, one fold. The chains are the ones any VPC-rooted estate grows
on its own.

`direct` is what the report prints today (`breakdown.inbound + breakdown.outputs`). `radius`
counts everything reachable inbound with folds contracted, split into resources and `output`
blocks; `depth` is the longest inbound path.

| address | score | band | direct | radius (res + out) | depth |
|---|---|---|---|---|---|
| `aws_s3_bucket.assets` | 88 | clean leaf | 1 | 1 + 0 | 1 |
| `aws_db_subnet_group.main` | 80 | clean leaf | 1 | 3 + 1 | 2 |
| `aws_lb_listener.https` | 77 | carvable | 0 | 0 + 0 | 0 |
| `aws_subnet.a` | 72 | carvable | 2 | 6 + 2 | 3 |
| `aws_subnet.b` | 72 | carvable | 2 | 6 + 2 | 3 |
| `aws_lambda_function.api` | 69 | carvable | 0 | 0 + 0 | 0 |
| `aws_lb_target_group.app` | 69 | carvable | 1 | 1 + 0 | 1 |
| `aws_security_group.app` | 69 | carvable | 1 | 1 + 0 | 1 |
| `aws_security_group.db` | 69 | carvable | 1 | 3 + 1 | 2 |
| `aws_kms_key.data` | 61 | carvable | 2 | 3 + 1 | 2 |
| `aws_lb.public` | 61 | carvable | 2 | 1 + 1 | 1 |
| `aws_rds_cluster.main` | 45 | leave in TF | 3 | 2 + 1 | 1 |
| `aws_vpc.main` | 40 | leave in TF | 5 | 11 + 2 | 3 |
| `aws_rds_cluster_instance.one` | 0 | leave in TF | 0 | 0 + 0 | 0 |

Six of the fourteen have a radius larger than the direct count the report prints. The row that
matters is `aws_db_subnet_group.main`: score 80, top band, one direct inbound edge, and three
resources plus an output downstream. The report tells a reader that carving it costs one
data-source patch, which is true, and says nothing about the Aurora cluster, its instance and
the Lambda sitting behind that one edge. `aws_subnet.a` is the same story one band down, at six
resources and two outputs against a direct count of 2. `aws_vpc.main` reaches eleven of the
thirteen other resources in the estate.

The inversion is the interesting part. `aws_rds_cluster.main` scores 45 and sits in the
"leave in Terraform" band with a radius of 3; `aws_db_subnet_group.main` scores 80 in the
"carve now" band with a radius of 4. Ranked by peelability the subnet group is the safer
carve. Ranked by what a mistake disturbs it is the riskier one.

## 4. Is radius just a proxy for the direct count?

This was the question most likely to kill the feature, and the answer is topology-dependent
enough that the honest answer is "sometimes, and you cannot tell which case you are in".

Spearman rank correlation between `score` and transitive radius, over ensembles of synthetic
estates (200 trials each, 40 nodes, plus 2000 trials for the small-sample check):

| Model | spearman(score, radius) | worst radius-minus-direct gap |
|---|---|---|
| Random DAG, density 1.5 / 3 / 6 | -0.89 / -0.91 / -0.86 | — |
| Layered pyramid 2-4-8-16-32 | -0.88 | 56 |
| Layered with a narrow waist 4-12-3-20-25 | -0.88 | 45 |
| Flat 30-32 | -0.90 | 0 |
| Layered, types drawn by graph position | -0.46 | 55 |
| The hand-built estate in section 3 (n=14) | -0.09 | 8 |

Under a uniform-random type draw the score and the radius rank almost identically, and the
feature looks redundant. The mechanism is the tier map's shape: 49 tier-1 types against 256
tier-2 and 35 tier-3, so a random draw is tier 2 roughly three times in four and the tier
penalty is very nearly a constant. With tier held constant the score is a function of edge
counts alone, and edge counts track reachability.

Real estates do not draw types at random. Foundations are tier-1 (`aws_vpc`, `aws_subnet`,
`aws_db_subnet_group`, `aws_s3_bucket`), workloads are tier-2 (`aws_rds_cluster`,
`aws_lambda_function`, `aws_lb`), and leaves are often unsupported and score 0
(`aws_rds_cluster_instance`). Tying tier to layer in the generator moves the correlation from
-0.89 to -0.46, confirming the mechanism, and the hand-built estate goes further to -0.09. That
last figure is not small-sample noise: across 2000 layered trials at n=14 the correlation never
once reached -0.10, and its 95th percentile was -0.55.

The case for the feature should not rest on any of this, because the correlation swings with
topology and a rank correlation is the wrong statistic anyway. The invariant across every model
measured is the magnitude column. Even at spearman -0.88, where the ranking is nearly
preserved, an individual node's radius runs up to 56 higher than its direct count. Ordering
candidates correctly is not the same as telling a reader how much is behind the edge they are
about to cut, and a 0-100 score that clamps cannot carry a number that large.

## 5. Cost: the existing accessor cannot be the primitive

`inboundEdges` (`graph.ts:293`) is `graph.edges.filter(e => e.to === address)`, a linear scan.
Calling it at every step of a breadth-first walk, for every node in the estate, is O(V²E). One
reverse-adjacency index built once and reused across the estate is O(V + E) to build and O(V+E)
per walk. Both were run to exhaustion on layered synthetic graphs, verified to produce
identical radii:

| nodes | edges | naive (filter per step) | indexed | speedup |
|---|---|---|---|---|
| 100 | 160 | 1 ms | 0.2 ms | 5x |
| 500 | 900 | 52 ms | 0.9 ms | 56x |
| 2 000 | 3 800 | 1 061 ms | 7.9 ms | 134x |
| 6 000 | 11 600 | 20 804 ms | 52.2 ms | 398x |

Twenty-one seconds at six thousand resources, which is an ordinary size for the estate someone
runs this against, against fifty milliseconds. The index is a precondition, not an
optimisation. Nothing forces `inboundEdges` to change: it stays the readable accessor for the
depth-1 callers in `score.ts` and `carve.ts`, and the reachability pass builds its own index.

Cycle safety costs nothing. Terraform rejects a resource cycle, but chant never runs Terraform,
and a `depends_on` cycle in a malformed estate would reach the advisor unvalidated. A visited
set handles it; a three-node cycle terminates immediately and reports all three.

## 6. Four ways a naive radius is wrong

**Folds must contract before the walk.** `aws_s3_bucket_versioning.assets` carves with its
bucket, and the boundary contract already promises a folded sub-resource is never an endpoint.
An uncontracted walk from `aws_s3_bucket.assets` on the shipped sample estate returns 2
(`aws_lambda_function.api` and `aws_s3_bucket_versioning.assets`) where the correct answer is
1. A 100% overstatement on the simplest case in the repository, and it is easy to miss: the
first pass of this spike made the mistake, and section 3's estate came back with seven
diverging nodes instead of six, the spurious seventh being the bucket counting its own
versioning block. The fold map is computed by `computeFolds` (`score.ts:152`), private to the
scorer, and would need to move somewhere the reachability pass can also see it.

**Outputs are terminal and should be counted separately.** An `output.<name>` pseudo-address
has no inbound edges by construction, so it never extends a path, but a naive walk still counts
it as a member of the radius. On the CDK fixture `AppStack/Api` has one construct dependent and
one stack output reading it; an unsplit radius of 2 cannot be lined up against
`breakdown.inbound` of 1 without the reader guessing which of the two it grew from. Splitting
resource radius from output radius mirrors the split `breakdown.inbound` and
`breakdown.outputs` already make, and keeps the numbers comparable term by term.

**Modules and `count` make the node count a lie.** A `module.platform` node is one node whatever
it contains, and state is read for root-module resources only, so radius through a module
undercounts by however much the module holds. A `resource "aws_subnet" "many" { count = 20 }`
is likewise one node: measured against a VPC upstream of it, the radius is 3 nodes covering 20
subnets plus a module plus a Lambda. `readStateInstanceCounts`/`applyStateCounts`
(`state.ts:64`, `:81`) already resolve the count when `--state` is passed, so an
instance-weighted radius is computable on that path and only on that path. A module's contents
stay unknowable and the report should say so rather than print a confidently small number.

**Cross-stack hops are not equivalent to intra-stack ones.** On the CDK path an
`Fn::ImportValue` resolved through the exporting stack is tagged `crossStack: true`, and a hop
into a different template with possibly a different deploy pipeline is a different kind of
consequence from one inside the same stack. Summing them loses the distinction the graph
already went to the trouble of recording.

## 7. Where it lands

Both halves fit the existing seams without a contract break.

The `locals` and `data` gap is a change to `collectExpressions` and `buildGraph` alone: visit
those two block types, build a non-node referrer table the way `output` blocks are already
handled, and resolve a `local.x` or `data.t.n` accessor through it to the resource it
ultimately names. `output` is the proof the shape works; `locals` needs one extra step because
locals can reference each other, so the substitution is itself a small fixpoint.

Reachability is a new pure function beside `inboundEdges`/`outboundEdges`, taking the graph and
returning an index-backed closure. Every consumer is already source-agnostic:
`packages/core/src/cdk/graph.ts` emits the same `TfGraph`, `adviseCloudAssembly` calls the same
`scoreEstate`, so one implementation covers Terraform and CDK.

The reported shape should be a new field, not a seventh penalty term. Every existing term is
denominated in units of work — an inbound edge is one data-source patch, an outbound edge is
one deferred input, tier 2 is a reshaping — which is what lets the CLI print "1 inbound (a
data-source patch each)" and have it be literally true. Transitive dependents are not work;
nobody patches them. Folding them into the score would break the one property that makes it
legible and would break `100 + sum(breakdown.penalties)`, which the version policy explicitly
invites readers to rely on. A sibling field to `boundary` on the per-resource entry stays
additive and stays inside `version: 1`, the same way the CDK `asset` term did.

## Recommendation

Land the dependency fix first and separately, then the radius.

The `locals` and `data` blindness is a correctness bug with a user-visible consequence: an
estate using either idiom gets a boundary report that is wrong in the unsafe direction, a
too-high peelability score, and a bridge patch that leaves the surviving plan broken. It needs
no new report field, no new contract, and no decision about how radius is presented. It should
not wait behind the larger feature.

Blast radius is worth building, and the argument is magnitude rather than ranking. Sections 3
and 4 together say that the score already orders candidates tolerably in most topologies, and
that no score in 0-100 can tell a reader that eleven resources sit behind the edge they are
about to cut. Build it as a separate reported axis, with the fold contraction and the
output/resource split from section 6, on a reverse index rather than the existing accessor.
Report `unknown` through a module rather than a number, and report instance-weighted radius
only when `--state` was passed.

One thing is a precondition for both: the fixture corpus has no depth and no `depends_on`, so
it can neither demonstrate the feature nor catch a regression in it.

Proposed sub-issues, in order:

1. `test(carve): a fixture estate with real dependency depth`. Acceptance: an estate under
   `packages/core/src/terraform/__fixtures__/` with a transitive inbound depth of at least 3, a
   `depends_on` edge, a `count` block and a module, and a pinned advise snapshot. Blocks
   everything below.
2. `fix(carve): references through locals and data blocks are dependencies`. Acceptance:
   `collectExpressions` visits `locals` and `data`; a resource reading a carved resource through
   either is reported as an inbound edge and rewired by `carve bridge`; the section 1 estate is
   a test with all three dependents found. No report version bump.
3. `feat(carve): reverse-adjacency index and transitive reachability`. Acceptance: a pure
   reachability function beside `inboundEdges`, fold-contracted, outputs counted separately,
   cycle-safe, under 100 ms at 6 000 nodes, shared by the Terraform and CDK paths. The fold map
   moves out of `score.ts`'s private scope. Nothing in the report changes yet.
4. `feat(carve): report blast radius on advise` (blocked on 3). Acceptance: a per-resource
   field carrying resource radius, output radius, depth, and a cross-stack split on the CDK
   path; `unknown` rather than a number where a module or an unresolved count makes it
   unknowable; instance-weighted only under `--state`; a column in the human output; additive
   within `version: 1`, with the version policy section of the CLI reference updated to say so.

## Appendix: the estate measured in sections 3 and 4

Written for this spike, and the candidate for sub-issue 1. Fifteen nodes, twenty-two edges, one
fold, a longest inbound path of 3.

```hcl
resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }

resource "aws_subnet" "a" { vpc_id = aws_vpc.main.id
                            cidr_block = "10.0.1.0/24" }
resource "aws_subnet" "b" { vpc_id = aws_vpc.main.id
                            cidr_block = "10.0.2.0/24" }

resource "aws_security_group" "db"  { vpc_id = aws_vpc.main.id
                                      name = "db" }
resource "aws_security_group" "app" { vpc_id = aws_vpc.main.id
                                      name = "app" }

resource "aws_db_subnet_group" "main" {
  name       = "main"
  subnet_ids = [aws_subnet.a.id, aws_subnet.b.id]
}

resource "aws_kms_key" "data" { description = "rds + s3" }

resource "aws_rds_cluster" "main" {
  cluster_identifier     = "app-db"
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  kms_key_id             = aws_kms_key.data.arn
}

resource "aws_rds_cluster_instance" "one" {
  identifier         = "app-db-1"
  cluster_identifier = aws_rds_cluster.main.id
}

resource "aws_lb" "public" { name = "app-lb"
                             subnets = [aws_subnet.a.id, aws_subnet.b.id] }
resource "aws_lb_target_group" "app" { name = "app-tg"
                                       port = 8080
                                       vpc_id = aws_vpc.main.id }
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  default_action {
    target_group_arn = aws_lb_target_group.app.arn
    type             = "forward"
  }
}

resource "aws_s3_bucket" "assets" { bucket = "app-assets" }
resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_lambda_function" "api" {
  function_name = "app-api"
  kms_key_arn   = aws_kms_key.data.arn
  environment {
    variables = {
      ASSETS = aws_s3_bucket.assets.bucket
      DB     = aws_rds_cluster.main.endpoint
      SG     = aws_security_group.app.id
    }
  }
}

output "lb_dns"      { value = aws_lb.public.dns_name }
output "db_endpoint" { value = aws_rds_cluster.main.endpoint }
```

It is missing the `depends_on` edge, the `count` block and the module that sub-issue 1 also
calls for; those were measured on separate throwaway estates (sections 1 and 6) and should be
folded into this one rather than kept apart.
