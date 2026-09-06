# The live-root fixture, and the two documents recorded from it

This directory is one choudoufu live root: `.tf` files derived from
choudoufu's own `live/e2e/estate-block/`, plus an `estate.chdf.hcl` sidecar
naming the estate `stateless-e2e-block`. Under `terraform.binary:
"choudoufu"` chant reads it as `mode: "live"` (#2103), which is what makes
`describeResources()` branch onto `live-plan` instead of `terraform show`.

`../live-plan.json` and `../live-ls.json` were recorded from this exact
configuration, running choudoufu built from source at
https://github.com/INTENTIUS/choudoufu (`go build ./cmd/choudoufu`,
OpenTofu 1.13.0-dev) against that repository's own pinned floci emulator
(`live/smoke/README.md`'s `just smoke` stack image, `live/floci-image`):

```
choudoufu init
choudoufu apply -auto-approve                 # with storage.tf still present
aws logs create-log-group --log-group-name /stateless-e2e-block/adoptable
aws logs create-log-group --log-group-name /stateless-e2e-block/held-elsewhere
aws logs tag-log-group    --log-group-name /stateless-e2e-block/held-elsewhere \
  --tags tofu-estate=other-estate,tofu-address=aws_cloudwatch_log_group.elsewhere
rm storage.tf                                 # the applied bucket becomes an owned orphan
choudoufu live-plan -detailed-exitcode -json -estate=stateless-e2e-block
choudoufu live-ls -estate=stateless-e2e-block -json -consistent .
```

Every row `describe-resources.ts` maps is in those two documents because the
run produced it, not because a fixture author typed it:

| Case | Where it came from |
|---|---|
| bound by marker | `aws_vpc.main`, `aws_subnet.app`, `aws_security_group.main`, and the two `aws_eip.pool` count instances with their slots |
| bound by derivation | `aws_cloudwatch_log_group.app`, whose identity is the name in the block |
| omission, `ABSENT` | `aws_cloudwatch_log_group.never_applied` and `aws_security_group_rule.https`, declared and never applied |
| omission, `UNOWNED` | the two log groups the `unowned[]` section also carries |
| unowned, adoptable | `aws_cloudwatch_log_group.adoptable`, with the two tag values that would claim it |
| unowned, held elsewhere | `aws_cloudwatch_log_group.held_elsewhere`, carrying `other-estate` |
| owned orphan | `aws_s3_bucket.data` in the listing, `declared: false` after `storage.tf` was removed |
| listing gap | `aws_security_group_rule.https`, on the declaration-carried rung |

## Two things the recording could not do as a chant live root would

**The sidecar was not present during the recording.** `live-plan -json` is
choudoufu's `-estate` form only, and that form refuses to run against a
configuration that names its own estate: `choudoufu live-plan -estate=X` on a
root with a `live` block or an `estate.chdf.hcl` sidecar answers "Estate named
by both the live block and -estate", while plain `choudoufu plan -json` under
one answers "Machine-readable output is not available under live resource
markers yet" (`internal/command/live_plan.go` and `live_mode.go`). So the
documents were recorded with the sidecar absent and `-estate` passed, and the
sidecar was added afterwards to make this directory the live root chant sees.
The documents themselves are byte-identical either way: the same estate, the
same resources, the same sections.

**The plan document's leading progress lines are not part of it.**
`live-plan -json` prints its refresh progress to stdout ahead of the document.
`../live-plan.json` is the document alone, from the first line that is a bare
`{`.
