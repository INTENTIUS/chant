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
  // status.
  "environment-invalid": "An environment name that can't name a ledger directory.",
  // A member or group that can't be read (ls, graph).
  "dir-missing": "The member's directory does not exist.",
  "unknown-kind": "No built-in kind or pinned package supplies the member's kind.",
  "kind-probe-failed": "The member's directory is not what its kind reads.",
  "no-matches": "An example group matches no directory holding a chant project.",
  // A member graph leaves out (graph, and the other per-member commands).
  "kind-not-run": "The member's kind is one the per-member commands don't run, such as other.",
  "command-failed": "The member's own command exited with a failure.",
  "output-unreadable": "The member's command printed something that isn't the document asked for.",
  "ir-version-unsupported": "The member's IR has a version this chant can't read.",
  // A ledger status can't fully read.
  "ledger-unreadable": "Reading the ledger failed, so nothing from it is listed.",
  "ledger-malformed": "Some lines of the ledger aren't release records; the rest are listed.",
  // A member's gates status can't list (status, #2674).
  "gates-no-ledger": "The checkout has no chant/lifecycle branch, so there is no gate ledger to read.",
  "gates-no-gate-ledger": "The branch has no gate ledger for the member: no run of it has reached a gate.",
  "gates-ledger-unreadable": "Reading the member's gate ledger failed, so no gate is listed.",
  // A record that isn't valid (records).
  "record-unparseable": "No front matter, a YAML error or a value outside the JSON subset of YAML, or for a JSON kind a file that is not one object or repeats a member name.",
  "record-schema-invalid": "The record's front matter, or its JSON object, does not match the kind's schema.",
  "record-id-duplicate": "Another record earlier in path order has the same id.",
  "record-supersedes-unknown": "A supersedes link names an id no record has.",
  "record-supersedes-conflict": "A second closed record supersedes a record another one already superseded.",
  // A review session that isn't valid (records, #2673).
  "session-seal-mismatch": "A closed session's seal is not the digest of its text: the session changed after it closed.",
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
  "seal-unverifiable": "Nothing here can say whose seal it is: there is no signers file at base, or ssh-keygen is not installed.",
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
  "source-harvest-not-proposed": "A harvested record (source.via harvest) was written in a state other than the kind's first: a harvest proposes, and a person decides.",
  "record-sign-failed": "--sign was given and no author seal could be made: the record names no author, the key can't be read or used, git names no ssh signing key, or ssh-keygen is not installed.",
  // A review given in a session (records review --session, #2693).
  "session-unknown": "--session names no session of a session kind whose subjects are the record's kind.",
  "session-not-open": "--session names a session in a closed state, which takes no more verdicts.",
  // records --since that fails (#2673).
  "since-rev-unknown": "--since names no commit, or a session with no opening revision and no commit that added it.",
  "since-session-unknown": "--since has the shape of a session id and names no commit, and no session the kind or the declaration reads has that id.",
  "since-session-open": "--since names a session that is still open, so the comparison runs to the working tree.",
  // The intent graph (graph --intent, #2651): a read that fails.
  "intent-region-invalid": "The region's path, or its line range, does not exist in the tree read.",
  // The intent graph: part of the walk that can't be read. The document is still printed.
  "intent-history-shallow": "The repository is a shallow clone, so the region's history stops at the clone's boundary.",
  "intent-plugin-failed": "A kind file's commitJoins, which joins commits to units, contracts and evidence, failed for a commit.",
  // The intent graph: findings, each a node in the graph.
  "intent-commit-undecided": "A commit changed the region when no decision constrained it at path granularity.",
  "intent-commit-bare": "A commit names no unit, no pull request and no decision covering the region at its time.",
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
