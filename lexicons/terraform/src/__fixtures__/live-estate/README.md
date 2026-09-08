# The live-root fixture, and the two documents recorded from it

This directory is one choudoufu live root: `.tf` files derived from
choudoufu's own `live/e2e/estate-block/`, plus an `estate.chdf.hcl` sidecar
naming the estate `stateless-e2e-block`. Under `terraform.binary:
"choudoufu"` chant reads it as `mode: "live"` (#2103), which is what makes
`describeResources()` branch onto `live-plan` instead of `terraform show`.

`../live-plan.json` and `../live-ls.json` were recorded from this exact
configuration by the published choudoufu **v0.15.0** release binary (`gh
release download v0.15.0 -R INTENTIUS/choudoufu -p
'choudoufu_v0.15.0_darwin_arm64.tar.gz' -p SHA256SUMS`, verified against
`SHA256SUMS`,
`db29573cb7d8dfa7205eeaecc0e4bcf154e941b8bb8179fb93ad53ac5c959409`), running
against choudoufu's own pinned floci emulator
(`ghcr.io/lex00/floci@sha256:a39185cc3971d0188663d61043cb038dff1260d8a975b1aa72c4e2bb1feac3cb`,
that repository's `live/floci-image`), on 2026-09-08 for chant #2241. The
first recording (#2104) was made by a choudoufu built from source; a release
binary and a pinned image is what makes this one reproducible.

```
# unowned.tf, rule.tf and adoptable.tf are held back over the apply: they
# declare resources this fixture needs to exist as something other than a
# marked, bound resource.
choudoufu init
choudoufu apply -auto-approve                 # with storage.tf, without those three
aws logs create-log-group --log-group-name /stateless-e2e-block/adoptable
aws logs create-log-group --log-group-name /stateless-e2e-block/held-elsewhere
aws logs tag-log-group    --log-group-name /stateless-e2e-block/held-elsewhere \
  --tags tofu-estate=other-estate,tofu-address=aws_cloudwatch_log_group.elsewhere
aws ec2 create-vpc --cidr-block 10.88.0.0/16  # unmarked, and nothing declares its id
rm storage.tf                                 # the applied bucket becomes an owned orphan
# restore unowned.tf, rule.tf and adoptable.tf, then:
TOFU_LIVE_COLLECT_UNCLAIMED=1 choudoufu live-plan -detailed-exitcode -json
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
| omission, `NEEDS_DISCOVERY` | `aws_vpc.adoptable`, whose id EC2 assigns, so no argument in the block determines it |
| unowned, adoptable | `aws_cloudwatch_log_group.adoptable`, with the two tag values that would claim it |
| unowned, held elsewhere | `aws_cloudwatch_log_group.held_elsewhere`, carrying `other-estate` |
| adoptable by content match | `aws_vpc.adoptable` again, this time in `adoptable[]`, carrying the live VPC's id, `matched: cidr_block=10.88.0.0/16`, both marker values and the tagging command |
| owned orphan | `aws_s3_bucket.data` in the listing, `declared: false` after `storage.tf` was removed |
| listing gap | `aws_security_group_rule.https`, on the declaration-carried rung |

## What the v0.15.0 re-recording changed (#2241)

**The document now has an `adoptable` section and a `swept` list.** choudoufu
PR 963 added both, answering
[choudoufu #962](https://github.com/INTENTIUS/choudoufu/issues/962), which
chant #2168 filed. `adoptable[]` is the estate-wide sweep's content matches:
a live resource the sweep bound to a declared instance by comparing
identity-bearing arguments, for a declaration that carries no identity of its
own. `swept[]` is the resource types that sweep listed in full, which is what
tells an empty `adoptable[]` apart from a run that never looked. `adoptable.tf`
and the out-of-band VPC beside it are new in this recording and exist to put a
real row in that section.

**The sidecar was present throughout, and `-estate` was not passed.** The
first recording could not do that: `live-plan -json` was the `-estate` form
only, and that form refused a configuration naming its own estate. choudoufu
v0.14.0 (PR 915,
[#894](https://github.com/INTENTIUS/choudoufu/issues/894)) settled the name
from the declaration instead, so this recording runs the live root exactly as
chant runs it. `live-ls` still takes `-estate`, and needs to: it reads the
account and has no configuration to derive a name from. chant passes it the
same way.

**The `-json` run carries `TOFU_LIVE_COLLECT_UNCLAIMED=1`.** Without it the
sweep answers only the removal question, and `adoptable[]` and `swept[]` come
back empty (`internal/command/live_collect_unclaimed.go`: the setting defaults
on under `-adoption-only` and off otherwise). `choudoufuLivePlan` sets the same
variable on its `-json` run under `adoptionOnly` and on no other run, so an
observation read's document has both sections empty. This one is an adoption
run's document, and the 36 "Incomplete sweep for undeclared resources"
warnings in `diagnostics[]` are the sweep's own, not noise a fixture author
left in.

## Two things about the recording a reader needs

**The plan document is not the first `live-plan` after the apply.** It is a
later one. The tagging index the marker read goes through is eventually
consistent, and on the run immediately after an apply every marker-bound row
in `bound[]` comes back with `source: "marker"` and no `identity` at all,
which would make `describeResources()` fall back to the address for a
`physicalId` it can normally give. Re-running settles it. `live-ls` has
`-consistent` for the same reason and the same window; `live-plan` has no such
flag, so the recording waits instead. Filed upstream as
[choudoufu #1014](https://github.com/INTENTIUS/choudoufu/issues/1014): a row
that says `source: "marker"` and carries no identity is telling a consumer two
things that disagree, whatever the read underneath was doing.

**The plan document's leading progress lines are not part of it.**
`live-plan -json` prints its refresh progress to stdout ahead of the document.
`../live-plan.json` is the document alone, from the first line that is a bare
`{`.
