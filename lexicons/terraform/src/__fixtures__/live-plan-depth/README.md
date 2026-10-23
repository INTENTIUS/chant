# The plan depth on a live root: three documents recorded from `live-estate/`

`describe-resources.live-plan.test.ts` (#4371) reads these. All three were
recorded on 2026-10-23 by the published choudoufu **v0.30.0** release binary
(`gh release download v0.30.0 -R INTENTIUS/choudoufu -p
'choudoufu_v0.30.0_darwin_arm64.tar.gz' -p SHA256SUMS`, verified against
`SHA256SUMS`; `choudoufu version` prints `choudoufu v0.30.0 (based on OpenTofu
v1.13.0)`), against choudoufu's pinned floci emulator
(`ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec`,
that repository's `live/floci-image` at the time).

The configuration is `../live-estate/` as checked in, estate
`stateless-e2e-block`:

```
# unowned.tf, rule.tf and adoptable.tf held back over the apply, as live-estate/README.md does
choudoufu init -input=false
choudoufu apply -auto-approve -input=false
# restore the three, then:
aws logs create-log-group --log-group-name /stateless-e2e-block/adoptable
aws logs create-log-group --log-group-name /stateless-e2e-block/held-elsewhere
aws logs tag-log-group    --log-group-name /stateless-e2e-block/held-elsewhere \
  --tags tofu-estate=other-estate,tofu-address=aws_cloudwatch_log_group.elsewhere
# out-of-band drift on two bound resources
aws logs put-retention-policy --log-group-name /stateless-e2e-block/app --retention-in-days 3
aws ec2 create-tags --resources <aws_vpc.main's id> --tags Key=drifted,Value=yes

choudoufu plan -input=false -lock=false -out=<tmp>/plan.tfplan
choudoufu show -json <tmp>/plan.tfplan            > show-plan.json
choudoufu live-plan -detailed-exitcode -json      > live-plan.json
```

`-lock=false` is accepted, the plan exits 0, and the root was byte-for-byte
unchanged after the plan and the show (every entry's size and mtime compared,
`.terraform/choudoufu-cache.tfstate` and `.tofu-records/` included).

`show-plan-sensitive.json` is the same root one step further, recorded to see
what a live root does with a value from a `sensitive` variable. In a copy of
the root, `secret.tf` declared `variable "token" { sensitive = true, default =
"hunter2" }` and `aws_vpc.main` got `tags = { token = var.token }`; that was
applied, the default changed to `"hunter3"`, and the plan and show above were
run again.

## What the documents show

choudoufu rebuilds prior state from the account on every run, so:

- `resource_drift` is empty although two resources drifted. The drift is in
  `resource_changes` as a planned `update`, with the live value in `before`
  (`retention_in_days: 3`, `tags.drifted: "yes"`) and the declared value in
  `after`.
- `prior_state` holds exactly the six instances `live-plan`'s `bound[]` names.
- The unowned log groups and the never-applied ones are planned `create`s
  with no row in `prior_state`.
- In `show-plan-sensitive.json`, `after_sensitive` flags `tags.token` and
  `before_sensitive` flags nothing: the live value in `before` is the previous
  secret, `"hunter2"`, unflagged. A stock root's state records which paths were
  sensitive, so its `before` is flagged; a live root's is not. This is why
  `plan-observation.ts` redacts both sides of a path flagged on either.
