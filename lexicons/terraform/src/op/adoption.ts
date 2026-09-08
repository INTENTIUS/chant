/**
 * The adoption ledger: which live resources this estate's markers can claim,
 * read off `live-plan -json`'s document and rendered as text (#2105, #2241).
 *
 * Pure. No filesystem, no child process, no HCL parse — everything here is a
 * projection of two sections of choudoufu's document, which between them state
 * both halves of the answer: the live resource an adoption would claim, and
 * the `tofu-estate`/`tofu-address` pair that claims it. Two tags is the whole
 * ownership contract (choudoufu's `live/MARKERS.md`), so those two values are
 * the whole of what an adoption needs to know.
 *
 * ## The two sections, and why there are two
 *
 * `unowned[]` (choudoufu issue #788) is a live resource read at an identity
 * the configuration itself declares: a log group's name is in the block, so an
 * unmarked live one with that name is found by reading it.
 *
 * `adoptable[]` (choudoufu issue #962, shipped in v0.15.0) is a live resource
 * the estate-wide sweep matched to a declared instance by content, for a
 * declaration that carries no identity at all: EC2 assigns a VPC's id, so a
 * declared `aws_vpc` lands in `omissions[]` as `NEEDS_DISCOVERY` and the live
 * VPC standing at its `cidr_block` is found by comparing arguments. Each row
 * carries `matched[]`, the arguments that agreed, and `adopt_command`, the
 * paste-ready tagging command, so nothing on this path parses the human
 * render any more. Before v0.15.0 the document had no row for that match at
 * all and chant read the two regexes {@link parseAdoptionCommands} still
 * holds, which is what chant #2168 measured and filed.
 *
 * The two sections are disjoint by construction, so this reads both and keys
 * the union by declared address.
 *
 * ## What the empty ledger means
 *
 * `adoptable[]` and `swept[]` are populated only on a run that asked the
 * estate-wide sweep the account-bounded question (`-adoption-only`, or
 * `TOFU_LIVE_COLLECT_UNCLAIMED=1` on a `-json` run). {@link AdoptionLedger}
 * carries `swept` for exactly that reason: an empty `adoptions` under an empty
 * `swept` is "this run did not look", not "there is nothing to adopt", and
 * {@link renderAdoptionLedger} says which.
 *
 * ## Why chant renders a ledger at all
 *
 * choudoufu prints its own, under `live-plan -adoption-only`, and it is the
 * better report for a human at a terminal: it counts the marker-carrying and
 * the identity-by-declaration halves of the declared population separately and
 * says why each unadoptable instance is unadoptable. But `-adoption-only` and
 * `-json` are refused together (`internal/command/live_plan.go`: "this run
 * cannot produce both reports at once"), and an Op that reports adoptables
 * needs the machine-readable document anyway, for the counts it publishes as
 * outcome attributes and for the addresses an adoption step acts on. So the
 * ledger below is rendered from the document that run already has, in the row
 * form `-adoption-only` prints, rather than paying for a third live read.
 *
 * ## Ambiguity
 *
 * Both sections are one entry per live resource, keyed by the declared
 * instance the resource was matched to, so two live resources at one
 * declaration are two entries carrying the same `addr`. That is the ambiguous
 * case: no single tag write claims the address, and picking one of the two is
 * a decision about the estate rather than something a tool infers.
 * {@link readAdoptionLedger} separates those into `contested` and never lets
 * them into `adoptions`, and `TerraformAdoptOp` passes the contested list to
 * its Adopt step so the Op's result names what it refused as well as what it
 * wrote.
 */

/** One argument a content match rested on, as choudoufu's `adoptable[].matched[]`. */
export interface AdoptionMatch {
  /** The argument's name in the declared block, `cidr_block` and the like. */
  attribute: string;
  /** The value both the declaration and the live resource carried. */
  value: string;
}

/** One live resource a marker write would bind to a declared instance. */
export interface AdoptionCandidate {
  /** The declared instance address the live resource was matched to. */
  addr: string;
  /** The live resource's type, as choudoufu's `type`. */
  type: string;
  /** The identity the live resource was read with: the handle a human, or a tagging call, needs. */
  identity: string;
  /** The `tofu-estate` value that adopts it. */
  markerEstate: string;
  /** The `tofu-address` value that adopts it, escaped as choudoufu stores it. */
  markerAddress: string;
  /**
   * The paste-ready tagging command choudoufu printed for this address, when
   * it printed one. Absent for a type whose service has its own tagging call
   * this fork does not spell out (IAM, Route53, S3 and friends): the two
   * marker values above are still the whole contract, but the caller has to
   * write them itself.
   *
   * An `adoptable[]` row carries its own (`adopt_command`, choudoufu #962). An
   * `unowned[]` row does not, so a command for one of those comes from the
   * `commands` map {@link parseAdoptionCommands} builds off the human render.
   */
  command?: string;
  /**
   * The arguments the declaration and the live resource agreed on exactly, in
   * the order choudoufu's matcher compared them. Present on a content match
   * (`adoptable[]`) and absent on a row found by reading a declared identity
   * (`unowned[]`), which matched on the identity itself and has nothing else
   * to name.
   */
  matched?: AdoptionMatch[];
}

/** What {@link readAdoptionLedger} found in one `live-plan -json` document. */
export interface AdoptionLedger {
  /** Candidates at an address exactly one live resource sits at. The adoptable set. */
  adoptions: AdoptionCandidate[];
  /**
   * Every candidate at an address more than one live resource sits at. Never
   * adopted: reported so a human can delete one or write the marker by hand.
   * Both (or all) candidates for a contested address appear, so the report
   * shows what the choice is between.
   */
  contested: AdoptionCandidate[];
  /** How many distinct declared addresses are contested. */
  ambiguous: number;
  /**
   * `swept[]`: every resource type the estate-wide sweep listed in full on the
   * run that produced the document. Empty means the run never asked the
   * account-bounded question, so an empty `adoptions` beside it is silence
   * rather than a finding.
   */
  swept: string[];
}

/** `unowned[]`'s entry shape, per choudoufu's `views.StatelessUnowned` json tags. */
interface UnownedEntry {
  addr?: unknown;
  type?: unknown;
  identity?: unknown;
  tofu_estate?: unknown;
  adopt_tofu_estate?: unknown;
  adopt_tofu_address?: unknown;
}

/** `adoptable[]`'s entry shape, per choudoufu's `views.LivePlanAdoptable` json tags. */
interface AdoptableEntry extends UnownedEntry {
  matched?: unknown;
  adopt_command?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `matched[]` as choudoufu writes it, dropping anything that is not a pair of strings. */
function readMatched(raw: unknown): AdoptionMatch[] {
  if (!Array.isArray(raw)) return [];
  const out: AdoptionMatch[] = [];
  for (const item of raw) {
    const m = (item ?? {}) as { attribute?: unknown; value?: unknown };
    const attribute = str(m.attribute);
    if (attribute) out.push({ attribute, value: str(m.value) });
  }
  return out;
}

/** `swept[]` as choudoufu writes it: resource type names, and nothing else. */
function readSwept(document: unknown): string[] {
  const swept = (document as { swept?: unknown } | null | undefined)?.swept;
  return Array.isArray(swept) ? swept.filter((t): t is string => typeof t === "string") : [];
}

/**
 * Project a `live-plan -json` document's `unowned` and `adoptable` sections
 * into the adoptable and the contested sets.
 *
 * An entry counts as a candidate only when choudoufu offered both marker
 * values. Both empty means adoption was not this run's to offer: the resource
 * belongs to another estate (`tofu_estate` names it), or the run had no estate
 * name of its own, and such an entry is neither adoptable nor contested here,
 * because there is no tag write to refuse.
 *
 * `commands` maps a declared address to the paste-ready tagging command
 * choudoufu printed for it, from {@link parseAdoptionCommands}. An
 * `adoptable[]` row carries its own command in the document and never needs
 * the map; omit the map entirely when the run had no `-adoption-only` render
 * to read one out of.
 */
export function readAdoptionLedger(document: unknown, commands?: ReadonlyMap<string, string>): AdoptionLedger {
  const doc = (document ?? {}) as { unowned?: unknown; adoptable?: unknown };
  const swept = readSwept(document);
  const byAddr = new Map<string, AdoptionCandidate[]>();

  const add = (candidate: AdoptionCandidate): void => {
    const at = byAddr.get(candidate.addr);
    if (at) at.push(candidate);
    else byAddr.set(candidate.addr, [candidate]);
  };

  for (const raw of Array.isArray(doc.unowned) ? doc.unowned : []) {
    const e = (raw ?? {}) as UnownedEntry;
    const markerEstate = str(e.adopt_tofu_estate);
    const markerAddress = str(e.adopt_tofu_address);
    if (!markerEstate && !markerAddress) continue;
    const addr = str(e.addr);
    const command = commands?.get(addr);
    add({
      addr,
      type: str(e.type),
      identity: str(e.identity),
      markerEstate,
      markerAddress,
      ...(command ? { command } : {}),
    });
  }

  for (const raw of Array.isArray(doc.adoptable) ? doc.adoptable : []) {
    const e = (raw ?? {}) as AdoptableEntry;
    const markerEstate = str(e.adopt_tofu_estate);
    const markerAddress = str(e.adopt_tofu_address);
    if (!markerEstate && !markerAddress) continue;
    const addr = str(e.addr);
    const command = str(e.adopt_command) || commands?.get(addr);
    const matched = readMatched(e.matched);
    add({
      addr,
      type: str(e.type),
      identity: str(e.identity),
      markerEstate,
      markerAddress,
      ...(command ? { command } : {}),
      ...(matched.length > 0 ? { matched } : {}),
    });
  }

  const adoptions: AdoptionCandidate[] = [];
  const contested: AdoptionCandidate[] = [];
  let ambiguous = 0;
  for (const candidates of byAddr.values()) {
    if (candidates.length === 1) {
      adoptions.push(candidates[0]);
    } else {
      ambiguous++;
      contested.push(...candidates);
    }
  }
  return { adoptions, contested, ambiguous, swept };
}

/**
 * Pair each declared address in a `live-plan -adoption-only` render with the
 * tagging command choudoufu printed under it.
 *
 * The render's "Adoptable now" rows are `  <addr> <- <type> <identity>`
 * followed by indented detail lines, one of which is `      adopt with: <cmd>`
 * (`internal/command/views/live_adoption.go`). choudoufu builds that command
 * to be pasted verbatim: every interpolated value is shell-quoted, the tagging
 * verb comes from its own botocore-derived table rather than a guess, and the
 * provider configuration's region and endpoint ride along as `--region` and
 * `--endpoint-url`, so the write lands where the resource is rather than
 * wherever an operator's AWS CLI profile points. Re-deriving any of that from
 * the two marker values alone would be a worse command, so this reads the one
 * choudoufu already wrote.
 *
 * An address the render offered no command for is simply absent from the map.
 *
 * ## Which caller still needs this (#2241)
 *
 * One: the `unowned[]` half of {@link readAdoptionLedger}. choudoufu's
 * `views.StatelessUnowned` has no command field, so a live resource found at
 * an identity the configuration declares still gets its paste-ready command
 * from the human render and from nowhere else. The `adoptable[]` half no
 * longer reads a line of text: those rows carry `adopt_command` in the
 * document itself since v0.15.0 (choudoufu #962), which is what made the
 * adopt path stop resting on two regexes over a render nobody promised to
 * keep stable.
 */
export function parseAdoptionCommands(ledgerText: string): Map<string, string> {
  const commands = new Map<string, string>();
  let current: string | undefined;
  for (const line of ledgerText.split("\n")) {
    const row = /^ {2}(\S+) <- \S+ /.exec(line);
    if (row) {
      current = row[1];
      continue;
    }
    const cmd = /^ {6}(?:or )?adopt with: (.+)$/.exec(line);
    if (cmd && current) {
      commands.set(current, cmd[1].trim());
      continue;
    }
    // A blank line ends a row's detail block; a non-indented line ends the
    // section. Either way the next "adopt with:" belongs to nobody until the
    // next row line names an address.
    if (line.trim() === "" || !line.startsWith("    ")) current = undefined;
  }
  return commands;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * Render {@link readAdoptionLedger}'s answer as the text an issue or PR body
 * carries under the plan.
 *
 * One line per adoptable match, naming the declared address, the live resource
 * it binds, and the two tag values that adopt it, in the token forms
 * `-adoption-only` prints them in (`<addr> <- <type> <identity>`,
 * `tofu-estate=`, `tofu-address=`). A content match adds the arguments it
 * rested on under its row, in the same `matched on:` form the human render
 * uses, because "these two agreed on this cidr" is the whole evidence for a
 * match nobody read an identity for. Contested addresses follow, listed and
 * not offered.
 *
 * An empty ledger still renders a line: "nothing adoptable" is a result a
 * reader wants, and a section that vanishes reads as one that was never
 * computed. Which of the two empties it is comes from `swept`: a run that
 * asked no estate-wide sweep found nothing because it did not look, and
 * saying so is the difference between a report and a silence.
 */
export function renderAdoptionLedger(ledger: AdoptionLedger, estate?: string): string {
  const where = estate ? `, estate ${JSON.stringify(estate)}` : "";
  const lines: string[] = [];

  if (ledger.adoptions.length === 0) {
    lines.push(`Adoptable now: nothing${where}`, "");
    lines.push(
      ledger.swept.length === 0
        ? "No estate-wide sweep ran on this plan, so nothing here says whether an unmarked live " +
            "resource exists for any declared instance. This is silence, not a finding: ask the " +
            "account-bounded question with an adoption run."
        : "No live resource this run could claim was found, across " +
            `${ledger.swept.length} swept resource ${plural(ledger.swept.length, "type", "types")} ` +
            `(${ledger.swept.join(", ")}). Anything the plan proposes creating, it proposes ` +
            "creating for real.",
    );
  } else {
    lines.push(
      `Adoptable now: ${ledger.adoptions.length} live ${plural(ledger.adoptions.length, "resource", "resources")}${where}`,
      "",
    );
    lines.push(
      "Each line is a live resource this estate could claim, found either at a declared resource's " +
        "own identity or by matching a declaration's arguments, and carrying no marker for this " +
        "estate. Writing the two tags shown adopts it; nothing is bound until they are written, " +
        "because ownership is the tofu-estate and tofu-address pair and nothing else.",
      "",
    );
    for (const c of ledger.adoptions) {
      lines.push(
        `  ${c.addr} <- ${c.type} ${c.identity}  write: ` +
          `tofu-estate=${c.markerEstate} tofu-address=${c.markerAddress}`,
      );
      if (c.matched?.length) {
        lines.push(`      matched on: ${c.matched.map((m) => `${m.attribute}=${m.value}`).join(", ")}`);
      }
    }
  }

  if (ledger.contested.length > 0) {
    lines.push("");
    lines.push(
      `Ambiguous: ${ledger.ambiguous} declared ${plural(ledger.ambiguous, "address", "addresses")} ` +
        "with more than one candidate",
      "",
    );
    lines.push(
      "More than one live resource sits at each of these declared identities, so no single tag write " +
        "claims the address. None of them is adopted. Resolve it by deleting the duplicate or by " +
        "writing the marker onto the one you mean.",
      "",
    );
    for (const c of ledger.contested) {
      lines.push(`  ${c.addr} <- ${c.type} ${c.identity}`);
    }
  }

  return lines.join("\n");
}
