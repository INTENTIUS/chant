<!-- chant-pr:prod -->
### chant plan for `prod`

Planned 2 members. Head `222222222222`, measured from `111111111111`.

| Member | Component | Status | Create | Update | Replace | Delete |
|---|---|---|---:|---:|---:|---:|
| `a` | a | planned | 0 | 1 | 0 | 0 |
| `app` | app | planned | 0 | 0 | 0 | 0 |

Plan digest: `jcs1-sha256:7623a8677afb0bf98d77c602521a3abfa96f76cff25675d350a28c2e26a7bad0`

Not approved yet.

A reviewer who approved this pull request approves the plan with:

```
chant approve pr-12 pr-apply --plan jcs1-sha256:7623a8677afb0bf98d77c602521a3abfa96f76cff25675d350a28c2e26a7bad0 --approver github:<your-login> --sign
```

It applies on merge if the plan is still this one. If it moved, the apply refuses and names both digests.

### Plan summary

2 members: 2 groups, 0 destroys or replacements.

#### Group e84467713bf6: 1 member (outlier), change

```
~ terraform_data.subnet: input
```

Members: `a`

#### Group 49648f9475c7: 1 member (outlier), no changes

Members: `app`
