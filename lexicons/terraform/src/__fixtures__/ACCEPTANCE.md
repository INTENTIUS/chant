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

## The binary and the emulator these rows name

`choudoufu v0.14.0` below means the published release binary, not a source
build: `gh release download v0.14.0 -R INTENTIUS/choudoufu -p
'choudoufu_v0.14.0_darwin_arm64.tar.gz' -p SHA256SUMS`, verified against
`SHA256SUMS` (`41c705d9b5fec47100c4f2fb9ab0694f0160b31a4e0661e877b4d9821bc464e3`),
extracted and put first on PATH. `choudoufu version` prints `choudoufu v0.14.0
(based on OpenTofu v1.13.0-dev)`.

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

Last passed: 2026-09-07, `Terraform v1.15.8` on `darwin_arm64`, with
`hashicorp/null` resolved from the public registry for the fixture's `~> 3.2`
constraint. No emulator is involved. Re-run by chant #2168 alongside the two
live blocks in the same file, so the file's three rows all come from one run.

### 2. `TerraformApplyOp applies a live root against choudoufu's emulator`

Same file, second block. Two tests. The first is the live-root happy path end
to end through `runOpLocally`: Init, `plan -out=<file>`, `show` over that
file, `apply <file>`, two `null_resource`s applied against the `live/`
fixture. The second moves the world between plan and apply and asserts both
named refusals (`approval-mismatch`, `wrong-estate`) come back as results
carrying choudoufu's own message rather than as thrown errors, then applies
the same file once the world is restored.

Gated on a `choudoufu` on PATH, on it reporting a release version at or above
`MIN_CHOUDOUFU_VERSION` (0.14.0), and on `CHOUDOUFU_EMULATOR_ENDPOINT`. Not
gated on choudoufu #894 and never was: the plan half here is the stock `plan
-out` path and reads no JSON document.

```
npx vitest run lexicons/terraform/src/composites/terraform-apply-op.acceptance.test.ts
```

Last passed: 2026-09-07, choudoufu v0.14.0 with the pinned floci emulator up,
recorded by chant #2168. That run is reproducible from this file: the binary
is a release asset and the emulator is a pinned digest. Before it, the only
record was PR #2157's prose ("the acceptance suite 3 passed against v0.13.0
with the emulator up", merged at `81200b5d97c15920619de4b109c4393ec3223720`),
which #2220 could not reproduce because no binary existed on the machine that
wrote this file.

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

Last passed: 2026-09-07, choudoufu v0.14.0 with the pinned floci emulator up,
recorded by chant #2168. That is the first pass this block has ever had as a
suite, and the first the `live-plan` test has ever had at all. It had been
gated shut on choudoufu #894 since commit `65821d76` (2026-09-06 12:45Z);
before that gate, PR #2135's body records a hand verification of the
`live-check` half only.

Two chant-side changes in #2168 were what the pass needed, both consequences
of what choudoufu PR 915 shipped. `-estate` is still refused beside a declared
estate; what changed is that the flag is no longer needed, so
`choudoufuLivePlanCommand` omits it exactly when the configuration names its
own estate. And the human-render call carries `-detailed-exitcode` too, so
exit 2 there is a plan with changes rather than a failure, which is what the
first real run of this block found.

### 4. `TerraformAdoptOp adopts an unmarked live resource`

`composites/terraform-adopt-op.acceptance.test.ts`. One test: create an
unmarked VPC directly against the emulator so it is a live resource this
estate does not own at an identity the `live-adopt/` root declares, run the
Ledger step and expect exactly one adoptable match carrying the two marker
values, run the Adopt step and let it write them, then re-plan and expect the
estate to own the same VPC with nothing left adoptable.

Gated on a `choudoufu` on PATH, on an `aws` CLI on PATH (the unmarked
resource is created and adopted through it), on
`CHOUDOUFU_EMULATOR_ENDPOINT`, and then on
`CHOUDOUFU_ADOPTABLE_NOT_IN_DOCUMENT`, which replaced the #894 gate and names
choudoufu #962.

```
npx vitest run lexicons/terraform/src/composites/terraform-adopt-op.acceptance.test.ts
```

Last passed: never, and the reason changed on 2026-09-07 rather than going
away. chant #2168 dropped the #894 gate and ran the block against choudoufu
v0.14.0 and the pinned floci emulator. It reached the document and stopped
there, with `ledger.adoptions` empty:

```
AssertionError: expected [] to have a length of 1 but got +0
 ❯ terraform-adopt-op.acceptance.test.ts:116:34
```

The document's `unowned[]` is the resources found at an identity the
configuration itself declares, and it works: an unmarked
`aws_cloudwatch_log_group` in the same fixture shape comes back on the same
binary with `adopt_tofu_estate` and `adopt_tofu_address` on it, which is the
shape `../live-plan.json` recorded. An `aws_vpc` has no such identity, so the
document reports `omissions[].reason = "NEEDS_DISCOVERY"` and leaves
`unowned[]` empty. The VPC is matched by choudoufu's content matcher during
the estate-wide unclaimed sweep instead, and that match is printed only in the
human render's "Adoptable" section, for which `views.LivePlanDocument` has no
field. `-adoption-only` is refused alongside `-json`, and
`TOFU_LIVE_COLLECT_UNCLAIMED=1` on the `-json` run leaves `"unowned": []`
while the text run beside it prints `Adoptable: 1 live resource matches a
declared resource`. Filed upstream as choudoufu #962
(https://github.com/INTENTIUS/choudoufu/issues/962), which carries the full
measurement; chant #2168 has the same.

The fixture was deliberately left as an `aws_vpc`. A log group would make the
block pass and would stop it proving the content-matcher path, which is the
only thing it exists to prove.

## Running everything that can run on a machine with no choudoufu

```
npx vitest run \
  lexicons/terraform/src/composites/terraform-apply-op.acceptance.test.ts \
  lexicons/terraform/src/composites/terraform-adopt-op.acceptance.test.ts \
  lexicons/terraform/src/op/activities/choudoufu.acceptance.test.ts
```

With `terraform` on PATH and the registry reachable, that is 1 passed and 5
skipped, and each skip names its own reason in the block title. With
choudoufu v0.14.0, the `aws` CLI and the emulator all present, it is 5 passed
and 1 skipped: block 4 is the skip. On 2026-09-07 that is exactly what it
printed.

## Keeping this file honest

Add a row when a suite is added, and update a "last passed" line in the same
change that makes a run happen. A line here that names no binary version and
no date is worth less than no line at all, so if a run cannot be reproduced,
say whose prose the claim comes from and that it was not reproduced.
