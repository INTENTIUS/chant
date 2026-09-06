/**
 * The adoption ledger: which live resources this estate's markers can claim,
 * read off `live-plan -json`'s document and rendered as text (#2105).
 *
 * Pure. No filesystem, no child process, no HCL parse — everything here is a
 * projection of GitHub issue #788's `unowned` section, which is the one place
 * choudoufu states both halves of the answer: the live resource sitting at a
 * declared instance's identity, and the `tofu-estate`/`tofu-address` pair that
 * would adopt it. Two tags is the whole ownership contract (choudoufu's
 * `live/MARKERS.md`), so those two values are the whole of what an adoption
 * needs to know.
 *
 * ## Why chant renders a ledger at all
 *
 * choudoufu prints its own, under `live-plan -adoption-only`, and it is the
 * better report for a human at a terminal: it counts the marker-carrying and
 * the identity-by-declaration halves of the declared population separately and
 * says why each unadoptable instance is unadoptable. But `-adoption-only` and
 * `-json` are refused together (`internal/command/live_plan.go`: "this run
 * cannot produce both reports at once"), and an Op that reports adoptables
 * needs the machine-readable document anyway — for the counts it publishes as
 * search attributes, and for the addresses an adoption step acts on. So the
 * ledger below is rendered from the document that run already has, in the row
 * form `-adoption-only` prints, rather than paying for a third live read.
 *
 * ## Ambiguity
 *
 * `unowned[]` is one entry per live resource, keyed by the declared instance
 * whose identity found it, so two live resources at one declared identity are
 * two entries carrying the same `addr`. That is the ambiguous case: no single
 * tag write claims the address, and picking one of the two is a decision about
 * the estate rather than something a tool infers. {@link readAdoptionLedger}
 * separates those into `contested` and never lets them into `adoptions`, and
 * `TerraformAdoptOp` passes the contested list to its Adopt step so the Op's
 * result names what it refused as well as what it wrote.
 */

/** One live resource a marker write would bind to a declared instance. */
export interface AdoptionCandidate {
  /** The declared instance address whose identity found the live resource. */
  addr: string;
  /** The live resource's type, as choudoufu's `unowned[].type`. */
  type: string;
  /** The identity the live resource was read with — the handle a human, or a tagging call, needs. */
  identity: string;
  /** The `tofu-estate` value that adopts it. */
  markerEstate: string;
  /** The `tofu-address` value that adopts it, escaped as choudoufu stores it. */
  markerAddress: string;
  /**
   * The paste-ready tagging command choudoufu printed for this address under
   * `live-plan -adoption-only`, when it printed one. Absent for a type whose
   * service has its own tagging call this fork does not spell out (IAM,
   * Route53, S3 and friends): the two marker values above are still the whole
   * contract, but the caller has to write them itself.
   */
  command?: string;
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

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Project a `live-plan -json` document's `unowned` section into the adoptable
 * and the contested sets.
 *
 * An entry counts as a candidate only when choudoufu offered both marker
 * values. Both empty means adoption was not this run's to offer — the resource
 * belongs to another estate (`tofu_estate` names it), or the run had no estate
 * name of its own — and such an entry is neither adoptable nor contested here,
 * because there is no tag write to refuse.
 *
 * `commands` maps a declared address to the paste-ready tagging command
 * choudoufu printed for it, from {@link parseAdoptionCommands}; omit it when
 * the run had no `-adoption-only` render to read one out of.
 */
export function readAdoptionLedger(document: unknown, commands?: ReadonlyMap<string, string>): AdoptionLedger {
  const unowned = (document as { unowned?: unknown } | null | undefined)?.unowned;
  if (!Array.isArray(unowned)) return { adoptions: [], contested: [], ambiguous: 0 };

  const byAddr = new Map<string, AdoptionCandidate[]>();
  for (const raw of unowned) {
    const e = (raw ?? {}) as UnownedEntry;
    const markerEstate = str(e.adopt_tofu_estate);
    const markerAddress = str(e.adopt_tofu_address);
    if (!markerEstate && !markerAddress) continue;
    const addr = str(e.addr);
    const command = commands?.get(addr);
    const candidate: AdoptionCandidate = {
      addr,
      type: str(e.type),
      identity: str(e.identity),
      markerEstate,
      markerAddress,
      ...(command ? { command } : {}),
    };
    const at = byAddr.get(addr);
    if (at) at.push(candidate);
    else byAddr.set(addr, [candidate]);
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
  return { adoptions, contested, ambiguous };
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
 * `tofu-estate=`, `tofu-address=`). Contested addresses follow, listed and not
 * offered. An empty ledger still renders a line: "nothing adoptable" is a
 * result a reader wants, and a section that vanishes reads as one that was
 * never computed.
 */
export function renderAdoptionLedger(ledger: AdoptionLedger, estate?: string): string {
  const where = estate ? `, estate ${JSON.stringify(estate)}` : "";
  const lines: string[] = [];

  if (ledger.adoptions.length === 0) {
    lines.push(`Adoptable now: nothing${where}`, "");
    lines.push(
      "No live resource sits at a declared identity carrying a marker this estate could write. " +
        "Anything the plan proposes creating, it proposes creating for real.",
    );
  } else {
    lines.push(
      `Adoptable now: ${ledger.adoptions.length} live ${plural(ledger.adoptions.length, "resource", "resources")}${where}`,
      "",
    );
    lines.push(
      "Each line is a live resource found at a declared resource's identity, carrying no marker for " +
        "this estate. Writing the two tags shown adopts it; nothing is bound until they are written, " +
        "because ownership is the tofu-estate and tofu-address pair and nothing else.",
      "",
    );
    for (const c of ledger.adoptions) {
      lines.push(
        `  ${c.addr} <- ${c.type} ${c.identity}  write: ` +
          `tofu-estate=${c.markerEstate} tofu-address=${c.markerAddress}`,
      );
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
