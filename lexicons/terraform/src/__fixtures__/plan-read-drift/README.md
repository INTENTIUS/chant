# Recording `../show-plan.json`

`../show-plan.json` is `terraform show -json` over a saved plan of this root,
recorded on 2026-10-23 with Terraform v1.15.8 on darwin_arm64 and
`scottwinkler/shell` v1.7.10 from the public registry. The plan depth's unit
tests (`../../describe-resources.plan.test.ts`) read it, so they run no binary.

The recording, from a temp copy of this directory:

```
terraform init -input=false
terraform apply -auto-approve -input=false        # generation 1
printf '{"port":"9090"}' > conf.json               # the change outside Terraform
terraform plan -input=false -lock=false -var-file=next.tfvars -out=$TMP/plan.tfplan
terraform show -json $TMP/plan.tfplan | jq . > ../show-plan.json
```

What the document holds, and what each block is for:

| block | plan | why it is here |
| --- | --- | --- |
| `shell_script.conf` | drift `update` (`dirty`, `read_error`), then replace forced by `dirty` | `resource_drift`, `replace_paths`, `action_reason` |
| `terraform_data.reader` | update, `input` unknown until apply | `relevant_attributes` names `shell_script.conf` `output.port` |
| `terraform_data.replaced` | replace forced by `triggers_replace` | `replace_paths`, `action_reason` |
| `terraform_data.updated` | update of a map holding a sensitive `token` | `before_sensitive`/`after_sensitive` nested in a map |
| `terraform_data.downstream` | update, `input` unknown until apply | `after_unknown` |

The token's value is `hunter2`. Terraform flags it under `input.token` and
leaves the copy in `output.token` unflagged, which is why the reader also
redacts any value equal to a flagged one.

The shell provider runs its commands in `path.module`, so no absolute path of
the recording machine is in the document.
