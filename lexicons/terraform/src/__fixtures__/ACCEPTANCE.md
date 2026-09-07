# What the gated acceptance suites have actually run against

Four `describe` blocks across three files run this lexicon against a real
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

Last passed: 2026-09-07, `Terraform v1.15.8` on `darwin_arm64`, with
`hashicorp/null v3.3.1` resolved from the public registry for the fixture's
`~> 3.2` constraint. No emulator is involved. Recorded by chant #2220, which
ran it while writing this file. Before that, PR #2157 (2026-09-06) counted it
among its three passing acceptance tests.

### 2. `TerraformApplyOp applies a live root against choudoufu's emulator`

Same file, second block. Two tests. The first is the live-root happy path end
to end through `runOpLocally`: Init, `plan -out=<file>`, `show` over that
file, `apply <file>`, two `null_resource`s applied against the `live/`
fixture. The second moves the world between plan and apply and asserts both
named refusals (`approval-mismatch`, `wrong-estate`) come back as results
carrying choudoufu's own message rather than as thrown errors, then applies
the same file once the world is restored.

Gated on a `choudoufu` on PATH, on it reporting a release version at or above
`MIN_CHOUDOUFU_VERSION` (0.13.0, the release that shipped the approval
artifact, choudoufu #878), and on `CHOUDOUFU_EMULATOR_ENDPOINT`. Not gated on
choudoufu #894: the plan half here is the stock `plan -out` path and reads no
JSON document.

```
# in a github.com/INTENTIUS/choudoufu checkout at the v0.13.0 tag
go build ./cmd/choudoufu && export PATH="$PWD:$PATH"
just smoke                                    # brings up the pinned floci stack
export CHOUDOUFU_EMULATOR_ENDPOINT=http://localhost:<mapped port>

# back in this repository
npx vitest run lexicons/terraform/src/composites/terraform-apply-op.acceptance.test.ts
```

Last passed: 2026-09-06, against a choudoufu built from the v0.13.0 tag with
choudoufu's own pinned floci emulator up (`live/smoke/README.md`'s `just
smoke` stack). Recorded in the body of chant PR #2157 ("the acceptance suite
3 passed against v0.13.0 with the emulator up"), merged at
`81200b5d97c15920619de4b109c4393ec3223720`. That is the whole of the record:
the run is not reproduced in this tree, and #2220 could not reproduce it,
because no `choudoufu` binary exists on the machine that wrote this file. The
command above is what someone holding the binary runs to check the claim.

### 3. `choudoufu live-check and live-plan against the fixture`

`op/activities/choudoufu.acceptance.test.ts`. Two tests. `live-check -json`
admits the `live/` fixture root (no cloud calls, so this half needs only the
binary), and `live-plan` reads the emulator and proposes creating both
`null_resource`s on a fresh estate.

Gated on a `choudoufu` on PATH, on `CHOUDOUFU_EMULATOR_ENDPOINT`, and then on
`CHOUDOUFU_894_OPEN`, which is hard-coded `true` and skips the whole block
whatever is on PATH. choudoufu #894: `live-plan -json` is reachable only
through the `-estate` form, and that form is refused on a configuration that
names its own estate, which the fixture is by construction.

```
# same choudoufu build and emulator as block 2, then
npx vitest run lexicons/terraform/src/op/activities/choudoufu.acceptance.test.ts
```

Last passed: never, as a suite. The `live-check` test ran unskipped between
this file landing (PR #2135, 2026-09-06 05:41Z) and commit `65821d76`
(2026-09-06 12:45Z), which added the #894 gate over both tests because the
`live-plan` one reproduces #894 whenever a binary and the emulator are both
present. PR #2135's body records a hand verification over that window: "both
fixture forms admit cleanly under `live-check -json`" against a locally built
choudoufu. The `live-plan` test has never passed against anything. When #894
ships, drop `CHOUDOUFU_894_OPEN` and this block runs as written; chant #2168
tracks that reversal.

### 4. `TerraformAdoptOp adopts an unmarked live resource`

`composites/terraform-adopt-op.acceptance.test.ts`. One test: create an
unmarked VPC directly against the emulator so it is a live resource this
estate does not own at an identity the `live-adopt/` root declares, run the
Ledger step and expect exactly one adoptable match carrying the two marker
values, run the Adopt step and let it write them, then re-plan and expect the
estate to own the same VPC with nothing left adoptable.

Gated on a `choudoufu` on PATH, on an `aws` CLI on PATH (the unmarked
resource is created and adopted through it), on
`CHOUDOUFU_EMULATOR_ENDPOINT`, and then on `CHOUDOUFU_894_OPEN`, the same
hard gate as block 3 and for the same reason: there is no adoption ledger to
act on until `live-plan -json` runs.

```
# same choudoufu build and emulator as block 2, then
npx vitest run lexicons/terraform/src/composites/terraform-adopt-op.acceptance.test.ts
```

Last passed: never. It has been gated on #894 since it was written (PR #2142,
2026-09-06), whose body says so directly: it "cannot pass today ... so it
skips with that as a named reason, one constant to flip when the fix ships".

## Running everything that can run on a machine with no choudoufu

```
npx vitest run \
  lexicons/terraform/src/composites/terraform-apply-op.acceptance.test.ts \
  lexicons/terraform/src/composites/terraform-adopt-op.acceptance.test.ts \
  lexicons/terraform/src/op/activities/choudoufu.acceptance.test.ts
```

With `terraform` on PATH and the registry reachable, that is 1 passed and 5
skipped, and each skip names its own reason in the block title. On
2026-09-07 that is exactly what it printed.

## Keeping this file honest

Add a row when a suite is added, and update a "last passed" line in the same
change that makes a run happen. A line here that names no binary version and
no date is worth less than no line at all, so if a run cannot be reproduced,
say whose prose the claim comes from and that it was not reproduced, the way
blocks 2 and 3 do.
