# What the gated acceptance suites have actually run against

Five `describe` blocks across three files run this lexicon against a real
binary rather than a fixture, and every one of them skips rather than fails
when its dependency is absent. A skip is silent by design, so without this
file nothing in the tree says which of them has ever passed, against what, or
when. The evidence had been living in PR prose (`#2157` for the live apply
pair), which no reader of the suite can see.

One row per gated block below: what it proves, what gates it, the command,
and the last binary and emulator it is known to have passed against.

`live-estate/README.md` next door is the sibling record for the two recorded
documents (`../live-plan.json`, `../live-ls.json`) rather than for a suite,
and stays where it is.

## The binary and the emulator these rows name

`choudoufu v0.15.0` below means the published release binary, not a source
build: `gh release download v0.15.0 -R INTENTIUS/choudoufu -p
'choudoufu_v0.15.0_darwin_arm64.tar.gz' -p SHA256SUMS`, verified against
`SHA256SUMS` (`db29573cb7d8dfa7205eeaecc0e4bcf154e941b8bb8179fb93ad53ac5c959409`),
extracted and put first on PATH. `choudoufu version` prints `choudoufu v0.15.0
(based on OpenTofu v1.13.0-dev)`. A row that still names `v0.14.0` means the
same recipe one tag back
(`41c705d9b5fec47100c4f2fb9ab0694f0160b31a4e0661e877b4d9821bc464e3`).

`the pinned floci emulator` means choudoufu's own smoke stack image,
`ghcr.io/lex00/floci@sha256:a39185cc3971d0188663d61043cb038dff1260d8a975b1aa72c4e2bb1feac3cb`
(that checkout's `live/floci-image`), brought up from
`live/smoke/docker-compose.yml` and exported as
`CHOUDOUFU_EMULATOR_ENDPOINT=http://localhost:<mapped port>`.

## The four blocks

### 1. `TerraformApplyOp applies a real root`

`composites/terraform-apply-op.acceptance.test.ts`. One test: `runOpLocally`
drives `TerraformApplyOp` with `gate: "never"` through Init, Plan and Apply
over the `with-backend/` fixture in a temp directory, and two
`null_resource`s in the resulting state is the pass. The backend is `local`,
so no credentials and no remote state are involved.

Gated on a `terraform` or `tofu` on PATH, and on the provider download
reaching `registry.terraform.io` (`CHANT_OFFLINE` unset and the host
resolvable).

```
npx vitest run lexicons/terraform/src/composites/terraform-apply-op.acceptance.test.ts
```

Last passed: 2026-09-08, `Terraform v1.15.8` on `darwin_arm64`, with
`hashicorp/null` resolved from the public registry for the fixture's `~> 3.2`
constraint. No emulator is involved. Re-run by chant #2241 alongside every
other block in this file, so all four rows come from one run; #2168 had run it
on 2026-09-07 the same way.

### 2. `TerraformApplyOp applies a live root against choudoufu's emulator`

Same file, second block. Two tests. The first is the live-root happy path end
to end through `runOpLocally`: Init, `plan -out=<file>`, `show` over that
file, `apply <file>`, two `null_resource`s applied against the `live/`
fixture. The second moves the world between plan and apply and asserts both
named refusals (`approval-mismatch`, `wrong-estate`) come back as results
carrying choudoufu's own message rather than as thrown errors, then applies
the same file once the world is restored.

Gated on a `choudoufu` on PATH, on it reporting a release version at or above
`MIN_CHOUDOUFU_VERSION` (0.15.0 since chant #2241), and on
`CHOUDOUFU_EMULATOR_ENDPOINT`. Not gated on choudoufu #894 and never was: the
plan half here is the stock `plan -out` path and reads no JSON document.

```
npx vitest run lexicons/terraform/src/composites/terraform-apply-op.acceptance.test.ts
```

Last passed: 2026-09-08, choudoufu v0.15.0 with the pinned floci emulator up,
recorded by chant #2241; before that 2026-09-07 on v0.14.0, recorded by chant
#2168. Both runs are reproducible from this file: the binary is a release
asset and the emulator is a pinned digest. Before them, the only record was PR
#2157's prose ("the acceptance suite 3 passed against v0.13.0 with the
emulator up", merged at `81200b5d97c15920619de4b109c4393ec3223720`), which
#2220 could not reproduce because no binary existed on the machine that wrote
this file.

### 3. `choudoufu live-check and live-plan against the fixture`

`op/activities/choudoufu.acceptance.test.ts`. Two tests. `live-check -json`
admits the `live/` fixture root (no cloud calls, so this half needs only the
binary), and `live-plan` reads the emulator and proposes creating both
`null_resource`s on a fresh estate.

Gated on a `choudoufu` on PATH and on `CHOUDOUFU_EMULATOR_ENDPOINT`. The
`CHOUDOUFU_894_OPEN` constant that used to skip the block whatever was on
PATH is gone.

```
npx vitest run lexicons/terraform/src/op/activities/choudoufu.acceptance.test.ts
```

Last passed: 2026-09-08, choudoufu v0.15.0 with the pinned floci emulator up,
recorded by chant #2241; before that 2026-09-07 on v0.14.0, recorded by chant
#2168, which was the first pass this block ever had as a suite and the first
the `live-plan` test ever had at all. It had been gated shut on choudoufu #894
since commit `65821d76` (2026-09-06 12:45Z); before that gate, PR #2135's body
records a hand verification of the `live-check` half only.

Two chant-side changes in #2168 were what the pass needed, both consequences
of what choudoufu PR 915 shipped. `-estate` is still refused beside a declared
estate; what changed is that the flag is no longer needed, so
`choudoufuLivePlanCommand` omits it exactly when the configuration names its
own estate. And the human-render call carries `-detailed-exitcode` too, so
exit 2 there is a plan with changes rather than a failure, which is what the
first real run of this block found.

### 4. `TerraformAdoptOp adopts an unmarked live resource`

`composites/terraform-adopt-op.acceptance.test.ts`. One test: create an
unmarked VPC directly against the emulator at the cidr the `live-adopt/` root
declares, so it is a live resource this estate does not own and the sweep can
match to a declaration by content, run the Ledger step and expect exactly one
adoptable match carrying the two marker values, run the Adopt step and let it
write them, then re-plan and expect the estate to own the same VPC with
nothing left adoptable.

Gated on a `choudoufu` on PATH, on an `aws` CLI on PATH (the unmarked
resource is created and adopted through it), and on
`CHOUDOUFU_EMULATOR_ENDPOINT`. Those three and nothing else since chant
#2241: the `CHOUDOUFU_ADOPTABLE_NOT_IN_DOCUMENT` constant that named choudoufu
#962, and the #894 gate before it, are both gone.

```
npx vitest run lexicons/terraform/src/composites/terraform-adopt-op.acceptance.test.ts
```

Last passed: 2026-09-08, choudoufu v0.15.0 with the pinned floci emulator up,
recorded by chant #2241. **That is the first time this block has ever passed,
on any binary.**

```
 ✓ TerraformAdoptOp adopts an unmarked live resource > ledgers one adoptable
   VPC, writes its two markers, and re-plans with it owned 18614ms
```

What it needed was choudoufu PR 963, released in v0.15.0. `live-plan -json`'s
document now carries the estate-wide sweep's content matches as an
`adoptable[]` section, with `swept[]` beside it, and each row carries the two
marker values, the arguments the match rested on, and the tagging command that
writes them. Before that the match existed only in the human `-adoption-only`
render, which choudoufu refuses alongside `-json`, so an `aws_vpc` (EC2
assigns the id, so no argument in the block determines it) reached
`omissions[].reason = "NEEDS_DISCOVERY"` and never `unowned[]`, and
`ledger.adoptions` came back empty:

```
AssertionError: expected [] to have a length of 1 but got +0
 ❯ terraform-adopt-op.acceptance.test.ts:116:34
```

That was chant #2168's measurement on 2026-09-07 against v0.14.0, filed
upstream as choudoufu #962
(https://github.com/INTENTIUS/choudoufu/issues/962), which carries the whole
of it. Two chant-side changes in #2241 were what the pass needed on top of the
release: `choudoufuLivePlan` puts `TOFU_LIVE_COLLECT_UNCLAIMED=1` on the
`-json` run under `adoptionOnly`, because a `-json` run asks no estate-wide
sweep of its own and the section is empty without one; and
`readAdoptionLedger` reads both `unowned[]` and `adoptable[]` into one ledger.

The fixture was deliberately left as an `aws_vpc`. A log group would make the
block pass off `unowned[]` alone and would stop it proving the content-matcher
path, which is the only thing it exists to prove.

### 5. `TerraformAdoptOp reaches its gate on a checkout that has never run init`

Same file, third block (#2302). One test: build `TerraformAdoptOp` and drive
it through `runOpLocally`, exactly as the apply Op's own acceptance suite
does, over a project this test creates fresh and never initializes by hand —
no `terraformInit` call anywhere in the block. The Op's own Init phase is what
has to download the provider, or the Ledger step fails the way it failed in
INTENTIUS/choudoufu#1026. `TerraformAdoptOp` gates unconditionally, so a
passing run ends `status: "gated"` right after the Ledger phase — reaching the
gate is the pass, not a completed adoption.

Gated on a `choudoufu` on PATH and `CHOUDOUFU_EMULATOR_ENDPOINT`. No `aws` CLI:
this block creates no live resource of its own.

```
npx vitest run lexicons/terraform/src/composites/terraform-adopt-op.acceptance.test.ts
```

Last passed: 2026-09-09, choudoufu v0.15.0 with the pinned floci emulator up.
Removing the Init phase this block exists to guard reproduces
INTENTIUS/choudoufu#1026 verbatim:

```
choudoufu live-plan failed in <dir> (exit 1)
Error: Provider unavailable for marker discovery

Finding the live resources of this estate needs provider
provider["registry.opentofu.org/hashicorp/aws"], which could not be used:
cannot read the schema of provider registry.opentofu.org/hashicorp/aws:
failed to instantiate provider "registry.opentofu.org/hashicorp/aws" to
obtain schema: unavailable provider "registry.opentofu.org/hashicorp/aws".
```

With the Init phase back, the same run reaches its gate:

```
 ✓ TerraformAdoptOp reaches its gate on a checkout that has never run init >
   Init downloads the provider the Ledger step needs, and the run reaches
   its gate
```

## Running everything that can run on a machine with no choudoufu

```
npx vitest run \
  lexicons/terraform/src/composites/terraform-apply-op.acceptance.test.ts \
  lexicons/terraform/src/composites/terraform-adopt-op.acceptance.test.ts \
  lexicons/terraform/src/op/activities/choudoufu.acceptance.test.ts
```

With `terraform` on PATH and the registry reachable, that is 1 passed and 6
skipped, and each skip names its own reason in the block title. With
choudoufu v0.15.0 and the emulator present (the `aws` CLI besides, for block
4), it is 7 passed and 0 skipped: no block in this file skips any more. On
2026-09-09 that is exactly what it printed.

```
 Test Files  3 passed (3)
      Tests  7 passed (7)
```

Bring the emulator up on a fixed port from choudoufu's own compose file rather
than through `just smoke`, which runs one scenario and tears the stack down
again:

```
cd <choudoufu checkout>
FLOCI_IMAGE="$(cat live/floci-image)" FLOCI_PORT=4660 \
OPENTOFU_IMAGE=unused SMOKE_WORK=/tmp \
  docker compose -p chant-acceptance -f live/smoke/docker-compose.yml up -d floci
export CHOUDOUFU_EMULATOR_ENDPOINT=http://localhost:4660
```

Each run wants a fresh emulator: the adopt block creates an unmarked VPC at a
fixed cidr, and a second one left over from an earlier run is a contested
address rather than an adoptable match, which is a real refusal and not a
flake. `docker compose -p chant-acceptance ... down -v` between runs.

## Keeping this file honest

Add a row when a suite is added, and update a "last passed" line in the same
change that makes a run happen. A line here that names no binary version and
no date is worth less than no line at all, so if a run cannot be reproduced,
say whose prose the claim comes from and that it was not reproduced.
