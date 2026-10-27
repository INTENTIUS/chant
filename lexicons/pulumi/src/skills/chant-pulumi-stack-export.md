---
skill: chant-pulumi-stack-export
description: Keep a Pulumi member's checked-in stack-export.json current and clean, and fix what PUL001 to PUL015 report about it
user-invocable: true
---

# The Pulumi Member's Stack Export

chant reads a Pulumi member's graph from `stack-export.json`, checked in beside `Pulumi.yaml`. The graph read never runs the program or `pulumi`, so the file is the whole of what the graph knows. Every build that reads the member (`pulumi.member` in `chant.config.ts`, or the reader project `chant workspace graph` writes) runs PUL001 to PUL015 against it.

## Taking the export

In the member's directory, with the stack selected:

```bash
pulumi stack export --file stack-export.json
git add stack-export.json
```

Take it again after every `pulumi up`, and never with `--show-secrets`. Do not edit the file by hand or merge two exports into one; replace it with a fresh export instead.

Never run `pulumi up`, `pulumi destroy`, `pulumi import`, `pulumi stack import` or `pulumi refresh` without `--preview-only` for the user. The fixes below that need one of them are the stack owner's to run; say which command and stop.

## What each check means

| Id | Severity | What it found | What to do |
|---|---|---|---|
| PUL001 | warning | no readable export, so the member has no nodes | take the export |
| PUL002 | warning | pending operations from an interrupted update | the owner runs `pulumi refresh`, then export again |
| PUL003 | error | secret values in plaintext (`--show-secrets`) | export again without it; the owner rotates the exposed secrets |
| PUL004 | warning | `delete: true`, a replaced object whose delete failed | the owner runs `pulumi up` to retry the delete, then export again |
| PUL005 | warning | `pendingReplacement: true`, deleted for a replace that never finished | the owner runs `pulumi up`, then export again |
| PUL006 | info | `taint: true`, replaced on the next update | expect the replace in the preview, or `pulumi state untaint` |
| PUL007 | warning | `pulumi.member.stack` names another stack than the export | export that stack, or fix the config |
| PUL008 | warning | URNs from more than one stack or project | replace the file with one export |
| PUL009 | warning | the export's project is not `Pulumi.yaml`'s `name` | export this member's own stack |
| PUL010 | warning | a parent or dependency the export does not hold | replace the file with a fresh export |
| PUL011 | warning | two live entries for one URN | replace the file with a fresh export |
| PUL012 | info | `external: true` resources the program only reads | nothing; drift on them is another owner's |
| PUL013 | warning | a deployment version other than 3 | export with the Pulumi CLI |
| PUL014 | info | no resources besides the stack and providers | export again after the stack is deployed |
| PUL015 | warning | `engine: "pulumi"` on a `plunge` backend | drop `engine` or set it to `"plunge"` |

PUL003 is the one error, so it fails `chant build`. A plaintext export already in the history stays there after the fix, so the rotation is not optional.

## Checking the result

```bash
npx chant build
npx chant lint
npx chant workspace graph
```

The member's nodes are the export's resources, `<member>/<type>::<name>`. With no export, `meta.pulumiMember` in the graph says why.
