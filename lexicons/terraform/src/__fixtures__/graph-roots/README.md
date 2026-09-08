# graph-roots

Two root modules with real references between their blocks, for the graph-IR
edge and grouping tests (chant #2265, #2266).

Everything the two issues asked to have pinned by a test rather than by prose
is here exactly once:

- every reference form that becomes an edge: `resource`, `data`, `module`,
  `var` and `local`
- a `depends_on`, which is an edge with no attribute
- a `count` block, which stays ONE node and one edge per target
- a local child module, so a reference resolves inside the child's own scope
  and never against the root's
- a `provider = aws.replica` meta-argument, which is deliberately NOT an edge
- two roots that share nothing, which is what a cross-root edge would have to
  invent

`app` reads a policy by NAME through a data source rather than by reference,
which is how the estate these issues were filed against composes its roots.
No edge should appear between the two roots because of it.
