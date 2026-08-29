<!--
Link the issue with a closing keyword, not a bare reference.

  Fixes #123        closes the issue on merge
  Closes #123       closes the issue on merge
  Part of #123      does NOT close it — use this only for an epic

A bare "#123" or "(#123)" in the title or body does not close anything. Eleven
issues in this repo stayed open after their own fix landed for exactly that
reason: seven carve issues written up as "Part of #998", plus #1275, #1276 and
#1701. Several sat open for a month while the work was on main.

If a PR implements an epic child, close the child and reference the epic:

  Fixes #1006
  Part of #998
-->

Fixes #

## What changed

## Verification

<!--
Which gates you ran, and what you did NOT run. Note anything you could not
verify locally so a reviewer knows what CI is carrying alone.
-->
