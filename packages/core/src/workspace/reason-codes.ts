/**
 * The workspace read contract's closed list of reason codes (#2536, #2524
 * D15, ws-017, ws-020).
 *
 * Every code a `chant workspace` read prints is here: the error that stops a
 * read, the reason an unreadable member, group, ledger or record is listed
 * with, and the lineage lock findings of `check`. Each command's own list
 * (`WORKSPACE_ERROR_CODES`, `MEMBER_REASON_CODES`, `STATUS_REASON_CODES`,
 * `RECORD_REASON_CODES` and the rest) is a subset of this one, which the
 * compiler checks through `satisfies`. `reason-codes.test.ts` checks that the
 * output schemas and the source emit nothing outside it.
 *
 * The list is closed: a reader may switch on a code, and a new code is a
 * contract change. Within contract version 1, before the floor release, codes
 * may still be added; after it, a new code means a new contract version.
 *
 * `chant workspace check` also reports `WSP` ids. Those are the declaration
 * check catalog (`checks.ts`), a separate closed list, and a finding whose
 * cause is one of the codes here carries that code too.
 */

/** The version of the read contract this chant writes: the declaration format, the output schemas and these codes. */
export const READ_CONTRACT_VERSION = 1;

/** The first chant release that writes contract version 1. A reader that needs the contract refuses an older chant. */
export const READ_CONTRACT_FLOOR = "0.81.0";

/** Each code and what it means. The key order is the order the docs list them in. */
export const REASONS = {
  // Reading the declaration (ls, graph, check, status).
  "declaration-missing": "No chant.workspace.json or .jsonc between the directory and the git root.",
  "declaration-ambiguous": "Both chant.workspace.json and chant.workspace.jsonc exist.",
  "declaration-unparseable": "The declaration is not valid JSON, or not valid JSONC for .jsonc.",
  "declaration-invalid": "The declaration does not match its schema, repeats a name, or --member names no entry.",
  "placement-invalid": "A member or group match breaks a placement rule.",
  "reader-too-old": "The declaration's minReader is newer than the chant reading it.",
  "root-chant-required": "The declaration pins a chant version other than the reader's, and that chant is not installed at the workspace root.",
  // --at and git.
  "not-a-git-repository": "--at, or a ledger read, needs a git repository and there is none.",
  "revision-unknown": "--at names no commit.",
  "live-at-revision": "graph was given --live and --at: a live read is of the account now, not of a revision.",
  // status.
  "environment-invalid": "An environment name that can't name a ledger directory.",
  // A member or group that can't be read (ls, graph).
  "dir-missing": "The member's directory does not exist.",
  "unknown-kind": "No built-in kind or pinned package supplies the member's kind.",
  "kind-probe-failed": "The member's directory is not what its kind reads.",
  "no-matches": "An example group matches no directory holding a chant project.",
  // A member graph leaves out (graph, and the other per-member commands).
  "kind-not-run": "The member's kind is one the per-member commands don't run, such as other.",
  "command-failed": "The member's own command exited with a failure, or the lexicon that reads the member through its kind's graph block isn't installed where the workspace resolves its pin.",
  "output-unreadable": "The member's command printed something that isn't the document asked for.",
  "ir-version-unsupported": "The member's IR has a version this chant can't read.",
  // A ledger status can't fully read.
  "ledger-unreadable": "Reading the ledger failed, so nothing from it is listed.",
  "ledger-malformed": "Some lines of the ledger aren't release records; the rest are listed.",
  // A member's gates status can't list (status, #2674).
  "gates-no-ledger": "The checkout has no chant/lifecycle branch, so there is no gate ledger to read.",
  "gates-no-gate-ledger": "The branch has no gate ledger for the member: no run of it has reached a gate.",
  "gates-ledger-unreadable": "Reading the member's gate ledger failed, so no gate is listed.",
  // A member's stewards status can't fully list (status, #2731).
  "stewards-unreadable": "An *.op.ts file could not be imported, so a steward it declares may be missing.",
  "stewards-conflict": "A steward was dropped: its name, or an Op it lists, belongs to another steward.",
  "steward-runs-unreadable": "Reading an Op's run ledger, or a ConvergeOp's converge ledger, failed, so its last run or last tick is null.",
  // A record that isn't valid (records).
  "record-unparseable": "No front matter, a YAML error or a value outside the JSON subset of YAML, or for a JSON kind a file that is not one object or repeats a member name.",
  "record-schema-invalid": "The record's front matter, or its JSON object, does not match the kind's schema.",
  "record-id-duplicate": "Another record earlier in path order has the same id.",
  "record-supersedes-unknown": "A supersedes link names an id no record has.",
  "record-supersedes-conflict": "A second closed record supersedes a record another one already superseded.",
  "record-remediates-unknown": "A remediates link names an id no record has.",
  "record-remediates-not-closed": "A remediates link names a record that isn't closed; a record still open is amended instead.",
  "record-seal-mismatch": "A closed record's seal is not the whole-file seal of its text now: the record changed after it closed.",
  // A review session that isn't valid (records, #2673).
  "session-seal-mismatch": "A closed session's seal is not the whole-file seal of its text now: the session changed after it closed, or was sealed by the rule before #2546.",
  "session-verdict-unknown-record": "A session's verdict names a record that none of the session kind's subject records has.",
  // A record that is valid but warned about (records, #2549).
  "asset-drift": "A file the record pins by hash has changed: its bytes no longer hash to the pinned sha256.",
  "asset-missing": "A file the record pins by hash does not exist in the tree read.",
  "asset-stale": "A file the record pins is unchanged at the hash a record it supersedes pinned: the decision changed and the artifact did not follow.",
  "record-supersedes-pending": "A supersedes link from a record whose state is weaker than the record it names, so the link has no effect yet.",
  "record-no-evidence": "The record's evidence list is empty: it cites nothing and pins no file. Information for a reviewer, never an error.",
  "review-undigested": "A verdict names no digest of the text it judged. It still counts, and an amendment does not stop it counting.",
  "source-transcript-drift": "The record's source block pins a transcript by hash, the file it names can be read here, and its bytes hash to something else: it is not the transcript the record means.",
  // A work record that is valid but warned about (records and graph --intent, #2683).
  "work-needs-unknown": "A work record's needs list names a work id no record has, so the item stays blocked.",
  "work-implements-unknown": "A work record's implements list names a decision id no decision has.",
  "work-needs-cycle": "A work record needs itself through its needs links, so it can never be ready.",
  "work-implements-undecided": "A work record implements a decision whose state is not approved, such as proposed.",
  "work-done-unpinned": "A work record is done and its evidence list is empty: nothing shows the work was done.",
  "work-closed-without-date": "A work record is done or dropped and has no closing date.",
  "work-done-gap-open": "A work record is done, and the finding it came from still fires on its region. graph --intent raises it, and records does by walking that region.",
  "work-acceptance-unmet": "A work record is done, and one of its acceptance criteria has no passing evidence of the verification it expects. check fails on it (WSP117).",
  "work-acceptance-self-verified": "A passing manual verdict on a work record's criterion names the record's implementer, so it does not count: a manual verdict comes from someone else.",
  "work-contract-unknown": "A work record names a contract that no record of its kind's contract kind has.",
  "work-contract-undecided": "A work record names a contract whose state is not approved, such as a draft.",
  "work-tier-unknown": "A work record names a builder tier that its kind's work.tier.tiers does not list.",
  // An answer to a decision point that is valid but warned about (records, points, ws-058, #2739).
  "answer-points-unreadable": "The points file the answer kind names can't be read, or is not valid.",
  "answer-point-unknown": "The answer's point is not declared in the points file the answer kind names.",
  "answer-point-changed": "The point's declaration changed since the question was asked, so the answer is to an older version of the question.",
  // A verdict the quorum does not count (records, #2671, #2672).
  "review-decider": "The verdict is the decider's own, and the quorum counts verdicts besides the decider's.",
  "review-agent": "The reviewer holds the agent role in the trust policy at base.",
  "review-duplicate": "A later verdict by the same principal replaces this one. Names are compared after NFKC, trimming and lower-casing.",
  "review-older-digest": "The verdict names a digest other than the record's text now: the record changed after the verdict.",
  "review-unattested": "An attestation policy is active at base, and the verdict carries no seal that verifies for its reviewer.",
  // A seal that is not attested (records): a verdict's (#2687) or a record's author seal (#2688). Each reports one of these in its attestation, unless its seal verified.
  "seal-missing": "The verdict, or the record, carries no seal.",
  "seal-signer-unlisted": "The reviewer, or the record's author, has no key in the signers file at base, so the seal can't count.",
  "seal-signature-invalid": "The seal is malformed, names a signer other than the reviewer or author, or its signature does not verify over the verdict or record.",
  "seal-unverifiable": "Nothing here can say whose seal it is: there is no signers file at base, ssh-keygen is not installed, or the record came back in a return sealed by a signer no admission lists yet.",
  // A record whose author seal is not attested under a signers file at base (records, #2688). A warning: the record is still read.
  "record-unattested": "A signers file is active at base, and the record names an author whose seal does not verify: it has none, the author has no key in the file, or the signature fails.",
  // A records read that fails (records).
  "kind-unreadable": "The record kind file is missing or could not be imported.",
  "kind-invalid": "The record kind file exports no recordKind, or its shape is wrong.",
  "schema-unreadable": "The schema file the record kind names is missing or is not JSON.",
  "schema-id-mismatch": "The schema's $id differs from the id the record kind names.",
  "schema-invalid": "The record schema itself does not compile.",
  "location-missing": "The records directory does not exist, in the tree or at the revision.",
  // A records write that is refused (records new, amend and review, #2670). Nothing is written.
  "write-usage-invalid": "The command line lacks a value the write needs, or gives one it does not take.",
  "write-input-invalid": "The fields given with --from or --set can't be read, are not JSON, or are not a JSON object.",
  "record-not-found": "No record of the kind has the id given.",
  "record-id-taken": "The id given for a new record is already used, by a record or a file name.",
  "record-id-unallocatable": "No id was given and none can be allocated: the records share no single prefix and --prefix names none.",
  "record-path-unmatched": "The file name made from the record's id and title does not match the kind's location.",
  "record-closed": "The record is in a closed state, so nothing in it changes; a new record supersedes it instead.",
  "amend-id-immutable": "An amendment changes the record's id, and ids are never renumbered.",
  "amend-supersede-instead": "The record is approved, and the amendment changes a field the approval rule does not let change in place; a new record supersedes it instead.",
  "review-unsupported": "The kind's schema has no reviews field, so its records take no review.",
  "review-note-required": "A dissent was given with no note: a dissent needs a reason.",
  "review-sign-failed": "--sign was given and no seal could be made: the key can't be read or used, git names no ssh signing key, or ssh-keygen is not installed.",
  "record-state-not-initial": "A record written through chant serve mcp gives a state other than the kind's first: a new record opens proposed, and a person moves it on.",
  "source-harvest-not-proposed": "A harvested record (source.via harvest) was written in a state other than the kind's first: a harvest proposes, and a person decides.",
  "ratify-quorum-not-met": "The write puts a record in its kind's ratified state (reviews.ratified), and the record's quorum is not met: too few agreeing verdicts count.",
  "record-sign-failed": "--sign was given and no author seal could be made: the record names no author, the key can't be read or used, git names no ssh signing key, or ssh-keygen is not installed.",
  // Write scope (#2548): a records write that is refused, and a commit check --changes reports, outside the writer's scope.
  "write-scope-member": "The write is to a file, or to a record kind, of a member outside the writer's scope: an agent session writes only its own member, and writeScope.<class>.members leaves the member out.",
  "write-scope-kind": "The write is to a record kind writeScope.<class>.records does not list, with a verb it does not list for the kind, or deletes a record.",
  "write-scope-protected": "The write is to a file writeScope.<class>.protected lists, or one under a directory it lists, outside the top-level keys or JSON Pointers the entry's except allows (#3146, #3308).",
  "write-scope-class-unknown": "The declaration's writeScope at base names a principal class no pinned package supplies, and the writer is judged human, so it may be in that class; the write is refused until the package is installed at the pinned version or the entry removed (#3080).",
  "agent-unknown": "CHANT_AGENT, or a commit's Chant-Agent trailer, names an agent session the declaration at base does not declare.",
  "principal-unidentified": "chant.workspace.json at base sets identity.attribution to identified, and the write names a person by a bare name: --by, an author field or a decision point's answerer must be a forge identity (github:<login>, gitlab:<login>, <forge>@<host>:<login>), a principal the signers file at base lists, or an agent, runner or service principal (#3163).",
  // A review given in a session (records review --session, #2693).
  "session-unknown": "--session names no session of a session kind whose subjects are the record's kind.",
  "session-not-open": "--session names a session in a closed state, which takes no more verdicts.",
  // Decision points (points, points ask, points answer, ws-058, #2739).
  "points-undeclared": "No record kind with an answers block is declared, or given with --kind, so there is no points file to ask.",
  "points-invalid": "The points file an answer kind names can't be read, or does not match decision-points.schema.json and the rules checked in code.",
  "point-unknown": "No points file declares the point asked, or the one an answer names.",
  "point-inputs-invalid": "The inputs given to an ask are not a JSON object of the point's declared inputs.",
  "point-decider-failed": "A model decider that fails closed (unreachable: fail) could not answer, so the ask wrote nothing.",
  "answer-not-candidate": "The people's answer is not one of the question's candidates.",
  "quorum-not-met": "Too few of the people who answered count toward the point's quorum: distinct, not holding the agent role, not the steward that asked, and holding one of its roles when it names any.",
  "answer-in-steward-turn": "The answer was given during a steward's turn, or by a process it started: a steward never answers a decision point, and a person answers it through hud or at a shell.",
  // records --since that fails (#2673).
  "since-rev-unknown": "--since names no commit, or a session with no opening revision and no commit that added it.",
  "since-session-unknown": "--since has the shape of a session id and names no commit, and no session the kind or the declaration reads has that id.",
  "since-session-open": "--since names a session that is still open, so the comparison runs to the working tree.",
  // The intent graph (graph --intent, #2651): a read that fails.
  "intent-region-invalid": "The region's path, or its line range, does not exist in the tree read.",
  "intent-record-unknown": "graph --intent --record names an id that no record of a decision kind read has.",
  "intent-symbol-unsupported": "The region names a symbol, path#symbol, in a file no symbol resolver reads; a line range still works.",
  "intent-symbol-unknown": "The region names a symbol the file does not declare in the tree read.",
  "intent-symbol-ambiguous": "The region names a symbol that matches more than one declaration in the file; its qualified name picks one.",
  // The intent graph: part of the walk that can't be read. The document is still printed.
  "intent-history-shallow": "The repository is a shallow clone, so the region's history stops at the clone's boundary.",
  "intent-plugin-failed": "A kind file's commitJoins, which joins commits to units, contracts and evidence, failed for a commit.",
  // The intent graph: findings, each a node in the graph.
  "intent-commit-undecided": "A commit changed the region when no decision constrained it at path granularity.",
  "intent-commit-bare": "A commit names no unit, carries no record through its Chant-Record or Chant-Lease trailer, and has no pull request and no decision covering the region at its time.",
  "intent-pin-drifted": "A decision's pinned artifact no longer hashes to the pin.",
  "intent-pin-missing": "A decision's pinned artifact does not exist in the tree read.",
  "intent-pin-stale": "A current decision pins an artifact at the hash a record it supersedes pinned, and the artifact has not changed since: the decision moved on and the artifact did not.",
  "intent-artifact-unpinned": "An artifact decisions in the graph pinned, which no current decision pins.",
  "intent-decision-superseded-live": "Every decision constraining the region is superseded.",
  "intent-decision-provisional": "The current decisions constraining the region are all in states their kind does not close, such as decided.",
  "intent-decision-contested": "A current decision constraining the region has an open concern: a dissent neither addressed nor withdrawn.",
  "intent-constraint-coarse": "The region is constrained only through its member, not by path.",
  "intent-constraint-lost": "A decision's path constraint names a path that does not exist in the tree read.",
  "intent-evidence-unpinned": "A decision's evidence has no hash: a URL, or a path with no sha256.",
  "intent-trailer-unverified": "A commit carries a trailer a plugin says claims authorship, and the commit is not attested.",
  "intent-region-unconstrained": "No decision constrains the region at any granularity.",
  "intent-decision-unimplemented": "A decided decision constrains the region, no work item that is not dropped implements it, and no commit falls in its window.",
  "intent-work-blocked": "A work item constraining the region has commits in its window while a work item it needs is not done.",
  "intent-work-open-decided-code": "Commits in the region are a decision's own work while the work item implementing that decision is still open.",
  // The intent graph's answer to why the region is like this (#3034): what it can't account for.
  "intent-why-no-decision": "No current decision governs the region at any granularity, and none is carried out by the commits or runs that made its current lines.",
  "intent-why-no-run": "None of the region's current lines was made by a commit an agent run is joined to.",
  "intent-why-uncommitted": "Some of the region's lines are not committed yet.",
  "intent-why-run-ambiguous": "Some lines come from a commit several agent runs made, and no run's recorded hunks say which wrote them.",
  // The forward coverage check (check --changes, #2773): findings, one per changed path.
  "change-uncovered": "A path the diff changes is covered by no current decided record and no open work item, by path or by its member.",
  "change-out-of-scope": "A record in hand for the change, such as the work item it is for or a decision that item implements, lists a path the diff changes in its out_of_scope.",
  // The patch read (workspace patch): a read that fails.
  "patch-path-invalid": "workspace patch --path names a path that is not relative and inside the workspace.",
  // Composite instances joined to components (graph --composites, #2662): why the list is empty or has no component.
  "composites-no-chant-member": "No member of kind chant was read, so nothing declares a composite instance or a component.",
  "composites-none-declared": "The members read declare no composite instance.",
  "composites-no-component": "The members read declare no component, so no composite instance has one.",
  // The runtimes a member's components can deploy on (graph --composites, #2674).
  "runtimes-config-unreadable": "The member's chant.config.ts could not be read, so only the built-in local runtime is listed, and no environment from the config.",
  "runtimes-lexicon-unreadable": "A lexicon the member's config lists could not be loaded, so it is not listed as a runtime.",
  // The environments a member's components may deploy to (graph --composites, #2695).
  "environments-none-declared": "The member's chant.config.ts declares no environments, so only local and the environments in its ledger are listed.",
  "environments-ledger-undeclared": "The member's ledger has releases in an environment its config's environments don't cover, so chant run --env would refuse it and it is not listed.",
  "environments-ledger-unreadable": "The chant/lifecycle branch exists and the member's ledger environments could not be listed.",
  // A declared diagram's source or render (check, #2764). Each is also a WSP finding.
  "diagram-source-missing": "A declared diagram's source file does not exist in the tree read.",
  "diagram-render-missing": "A declared diagram's render file does not exist in the tree read.",
  "diagram-render-drift": "A declared diagram records a sourceHash, and the source's bytes now hash to something else: the render is stale for its source.",
  // A box that holds a credential (check, #2726). Each is also a WSP finding.
  "box-credential-declared": "A file in a box member's directory carries a literal secret: a credential's shape, or a literal where a credential goes. A variable or secret-manager reference is not one.",
  "box-capability-unbrokered": "A capability in a member's box block names no broker, so the box would hold its credential.",
  // The credential fountain itself hands a persistent box (check, #2780). Also a WSP finding.
  "box-fountain-callback-undeclared": "A box member builds a fountain Box, whose persistent sandbox fountain gives a callback token scoped to its owner, and the member's box block does not declare the fountain-callback capability brokered by fountain with scope owner.",
  // A box's intent, the decision record its box block names (check, #2850). Each is also a WSP finding.
  "box-intent-unknown": "A box block names an intent, and no record of a declared kind named decision has that id.",
  "box-intent-unconstrained": "The decision record a box names as its intent constrains no member or path of this workspace: no member: entry for a declared member and no path: entry at, above or inside one's directory.",
  // Why a workspace isn't plantable (status and graph, #3146): not a finding, since a workspace need not be.
  "box-none": "No member's box block declares services, so the workspace has no box for a host to plant.",
  "box-several": "More than one member's box block declares services, and a planted workspace runs one box.",
  // The work lease (chant workspace work claim|renew|release, #2732): why the command could not run.
  "work-kind-missing": "No work kind to find the item in: --kind names a kind with no work block, or the declaration names no work kind.",
  "work-kind-ambiguous": "More than one declared work kind has a record with the id, so --kind must name one.",
  "work-item-unknown": "No work record has the id, so there is nothing to lease.",
  "work-item-closed": "A claim on a work item in a closed state, such as done or dropped: there is no work left to claim.",
  // Evidence attached to a criterion under the run's work lease (#2772): why it was refused. Nothing is written.
  "work-criterion-unknown": "The work record lists no acceptance criterion with the id the evidence names, or its kind has no acceptance criteria.",
  // The work lease: why a claim, renew or release was refused (exit 2).
  "lease-held": "Someone holds a live lease on the work item: another worker, or, for a claim, the same one.",
  "lease-not-held": "Nobody holds a live lease on the work item: it expired, was released or was never claimed.",
  "lease-token-mismatch": "The live lease on the work item carries another fencing token than the one given.",
  "lease-race": "Another writer changed the lease between this command's read and its write.",
  "lease-push-rejected": "The remote refused the lease push: another clone claimed the item first, or the remote could not be reached.",
  // The agent run record (chant workspace runs, #3033): why a write was refused, and what a read could not see. Nothing is written on a refusal.
  "run-exists": "runs start or runs record was given a run id the ledger already has.",
  "run-unknown": "runs end names a run the ledger has no start for.",
  "run-ended": "runs end names a run whose end is already recorded.",
  "runs-no-ledger": "The checkout has no chant/lifecycle branch, so there are no agent runs to read.",
  "runs-ledger-malformed": "Some lines of the agent run ledger aren't run events; the rest are read.",
  // The agent-run statement (runs sign, statement and verify, #3192): why a statement is refused or does not verify.
  "run-not-ended": "runs sign or runs statement names a run with no end recorded. A statement is signed over the run's whole record.",
  "run-statement-invalid": "The envelope's payload is not an in-toto Statement v1 with chant's agent-run predicate, or has a field the predicate does not define.",
  "run-statement-signer-mismatch": "The statement names a signer other than the runner whose key signed it.",
  "run-statement-mismatch": "A listed runner key signed the statement, and it does not match the run's record: another run, a record that hashes differently, or another unit, harness, model, provider or principal.",
  // A box's listing written through chant (box listing set, #3308): why the write was refused. Nothing is written.
  "listing-member-unknown": "box listing set names a member the declaration does not declare.",
  "listing-box-missing": "box listing set names a member whose entry declares no box block, so it has no listing.",
  "listing-cover-invalid": "The cover can't be read, is not a PNG, JPEG or WebP picture, is larger than 5 MiB, has a path outside the workspace, or has an extension other than its picture format's.",
  // Work in progress under refs/chant/wip/<branch> and its replication (wip save|restore|push|fetch, #3172): why the write was refused. Nothing is written.
  "wip-no-branch": "HEAD is detached, or names a branch with no commit yet, so there is no branch to keep work in progress for.",
  "wip-none": "wip restore was given no snapshot, and the branch has none under refs/chant/wip/<branch>.",
  "wip-snapshot-unknown": "wip restore names something that is not a work-in-progress snapshot chant took.",
  "wip-branch-other": "wip restore names a snapshot taken on another branch than the one checked out.",
  "wip-race": "Another writer moved refs/chant/wip/<branch> between this command's read and its write.",
  "wip-policy-none": "wip push or wip fetch was run, and no box block declares replicate, so there is no remote.",
  "wip-remote-unknown": "The replicate policy names a git remote the checkout does not have; the host adds it, with its credential, before chant pushes.",
  // A box whose isolation fails (check, #2727). Each is also a WSP finding.
  "box-isolation-collision": "Two boxes on one host resolve to the same port, state path or cookie name, or two ports in one box share an offset.",
  "box-isolation-literal": "A host's stateRoot or a box's state entry is a literal machine path instead of one derived from an environment reference and the box's name.",
  // The signer set's history (signers and verify, #2553): why a version is not a valid rotation of the one before. Nothing verifies past it.
  "signers-file-missing": "There is no signers file at the base revision, so there is no signer history to read.",
  "signers-removed": "The signers file was removed. Commits merged before the removal keep the set they were judged by; nothing after it verifies.",
  "rotation-unparseable": "The rotation file beside the signers file is not JSON.",
  "rotation-invalid": "The rotation file does not match its shape: schema 1, a version, the previous set's digest, a threshold and signatures.",
  "rotation-first-version": "The first signer set's rotation file names a version other than 1, or a previous digest.",
  "rotation-missing": "The signer set or its threshold changed and no rotation file signed by the set before it came with the change.",
  "rotation-version-skew": "The rotation names a version other than the one after the set it replaces, as a replayed or skipped rotation does.",
  "rotation-previous-mismatch": "The rotation names a previous digest other than the set it replaces, as a rollback to an older set does.",
  "rotation-threshold-unsatisfiable": "The new threshold is more than the number of distinct signers in the new set, so no later rotation could meet it.",
  "rotation-threshold-not-met": "Fewer distinct signers of the set before signed the rotation, in the chant-signers namespace, than that set's threshold.",
  // Runner evidence (evidence sign and verify, #2553): why evidence is refused.
  "trust-policy-unreadable": "The trust policy at base can't be read, or its signer history is broken, so no runner key is trusted.",
  "envelope-unreadable": "The --envelope file can't be read, or is not JSON.",
  "envelope-invalid": "The file is not a DSSE envelope: payloadType, payload in canonical base64, and signatures with keyid and sig.",
  "envelope-untrusted": "No signature in the envelope verifies against a runner key the policy at base lists.",
  "evidence-payload-type": "The envelope's payload type is not application/vnd.in-toto+json.",
  "evidence-statement-invalid": "The payload is not an in-toto Statement v1 with chant's runner-evidence predicate, or has a field the predicate does not define.",
  "evidence-runner-mismatch": "The statement names a runner other than the one whose key signed it.",
  "runner-key-invalid": "The key given to evidence sign or runs sign is not an Ed25519 private key in PEM.",
  "runner-key-is-signer": "The key given to evidence sign or runs sign is a person's key in the signers file. Evidence and run statements are signed by a service or CI identity.",
  "runner-key-unlisted": "The policy at base lists no runner with the key given to evidence sign or runs sign.",
  // The lineage lock (check).
  "lock-invalid": "The lineage lock can't be read.",
  "manual-step-open": "A scope in the lineage lock has an open manual step.",
} as const;

export type ReasonCode = keyof typeof REASONS;

/** Every code, in the order of {@link REASONS}. */
export const REASON_CODES = Object.keys(REASONS) as ReasonCode[];

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REASONS, value);
}

/**
 * A finding code a plugin contributes to the intent graph through its
 * `commitJoins` (#2656): `plugin:<name>:<code>`, where `<name>` is the kind's
 * name, or the kind file's `commitJoinsName` when it has one (#2663), and
 * `<code>` is lower case words joined by dashes. These are outside the
 * closed list: the plugin owns its namespace, and core only carries them.
 */
export type PluginCode = `plugin:${string}:${string}`;

export const PLUGIN_CODE = /^plugin:([^:\s]+):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Whether `value` is a plugin code, and, given `name` (a kind's name or its `commitJoinsName`), one in that namespace. */
export function isPluginCode(value: unknown, name?: string): value is PluginCode {
  if (typeof value !== "string") return false;
  const m = value.match(PLUGIN_CODE);
  return !!m && (name === undefined || m[1] === name);
}
