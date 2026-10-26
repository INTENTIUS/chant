# pr-loop: five roots through the pull-request loop

The workspace `../../components/pr-loop.tofu.test.ts` runs through
`chant components pr-plan` and `chant components pr-apply` over real `tofu`
(or `terraform`). Every root uses `terraform_data` with local state, so
nothing downloads a provider or reaches a cloud.

The estate is net -> a, b and a -> app, with dns on its own. a and b read
net's `cidr`, and app reads a's `id`, through `stackOutput()` in
`estate.component.ts`. a's `id` is `terraform_data.subnet.output`, which is
known only after a applies, so on a pull request that changes a, app sits
outside any group with an unknown upstream read and is previewed with a
placeholder for `var.subnet` (chant#4463).

What happens on merge depends on the value a applies with:

- A pull request that changes a's subnet suffix from `a-v1` to `a-v2`: app's
  real plan, made once a applied, is the update the preview showed with
  `a.id` filled in. The first approval covers it and both roots apply in one
  run. This is the single-approval path.
- A pull request that changes it to `a-wide`: app's `wide` resource has
  `count = local.wide`, and `local.wide` reads `var.subnet` through a local,
  which the preview does not follow. The stand-in does not end in `-wide`, so
  the preview plans no `terraform_data.wide`. The real id does, so the real
  plan also creates `terraform_data.wide[0]`. That exceeds the preview, so
  app's round 2 is not covered and waits on its own `pr-apply-round-2` gate
  (chant#4487).

`chant.config.json` names `tofu`; the test writes its own with whichever
binary is on PATH.

## The recorded pull-request run for chant#4463

chant#4463's maintainer run uses this fixture, on the `a-v2` path. In a scratch
directory:

1. Copy this directory, `git init -b main`, add a `.gitignore` with
   `node_modules`, `.terraform`, `.terraform.lock.hcl`, `*.tfstate*`,
   `chant.tfplan` and `.chant`, and commit.
2. Apply the base once: write `all.json` as `{"changed":["net","dns"]}` and run
   `chant components fan-out --from-affected all.json`.
3. On a branch, change `a-v1` to `a-v2` in `roots/a/main.tf`, commit, and run
   `chant components pr-plan --base main --pr <n> --forge github` on the pull
   request. The note's app row says `previewed with placeholders for var.subnet`.
4. Approve the digest the note names, merge, and run
   `chant components pr-apply --base <main before the merge> --forge github --require-review`.
   Both roots apply in one run, and the note says app's round was covered by
   the first approval with `a.id` filled in.

Record the note and the apply's output on chant#4463.
