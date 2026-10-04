<!-- chant-pr:prod -->
### chant apply for `prod`

Applied 2 members. Head `222222222222`, measured from `111111111111`.

| Member | Component | Status | Create | Update | Replace | Delete |
|---|---|---|---:|---:|---:|---:|
| `a` | a | applied | 0 | 1 | 0 | 0 |
| `app` | app | applied, inputs from a moved | 0 | 0 | 0 | 0 |

A member whose inputs moved applied the plan it was approved with. The next run plans it against the new values.

Plan digest: `jcs1-sha256:46bff52773a158dffa5c895b98f8760d601a2f9dc6af7dc235dbf65496f7bf65`

Approved by `github:alice` for this digest.

### Plan summary

2 members: 2 groups, 0 destroys or replacements.

#### Group e84467713bf6: 1 member (outlier), change

```
~ terraform_data.subnet: input
```

Members: `a`

#### Group 49648f9475c7: 1 member (outlier), no changes

Members: `app`
