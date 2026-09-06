/**
 * The adoption ledger (#2105): reading `live-plan -json`'s `unowned` section,
 * pairing it with the commands `-adoption-only` printed, and rendering it.
 *
 * The document fragments below are the shape choudoufu actually emits, taken
 * from `views.StatelessUnowned`'s json tags (`internal/command/live_plan.go`)
 * and checked against the recorded document #2104 captured off the emulator:
 * an adoptable row carries `adopt_tofu_estate`/`adopt_tofu_address`, and a row
 * held by somebody else carries `tofu_estate` and neither of the other two.
 */

import { describe, test, expect } from "vitest";
import { parseAdoptionCommands, readAdoptionLedger, renderAdoptionLedger } from "./adoption";

const adoptable = (addr: string, identity: string, type = "aws_vpc") => ({
  addr,
  type,
  identity,
  adopt_tofu_estate: "prod-networking",
  adopt_tofu_address: addr,
});

describe("readAdoptionLedger (#2105)", () => {
  test("a row carrying both marker values is adoptable", () => {
    const ledger = readAdoptionLedger({ unowned: [adoptable("aws_vpc.main", "vpc-0abc")] });
    expect(ledger.adoptions).toEqual([
      {
        addr: "aws_vpc.main",
        type: "aws_vpc",
        identity: "vpc-0abc",
        markerEstate: "prod-networking",
        markerAddress: "aws_vpc.main",
      },
    ]);
    expect(ledger.contested).toEqual([]);
    expect(ledger.ambiguous).toBe(0);
  });

  test("a row held by another estate is neither adoptable nor contested", () => {
    // Adoption was not this run's to offer, so there is no tag write to refuse.
    const ledger = readAdoptionLedger({
      unowned: [
        {
          addr: "aws_cloudwatch_log_group.held_elsewhere",
          type: "aws_cloudwatch_log_group",
          identity: "/estate/held-elsewhere",
          tofu_estate: "other-estate",
        },
      ],
    });
    expect(ledger.adoptions).toEqual([]);
    expect(ledger.contested).toEqual([]);
  });

  test("two live resources at one declared address are contested, never adoptable", () => {
    const ledger = readAdoptionLedger({
      unowned: [
        adoptable("aws_vpc.main", "vpc-0abc"),
        adoptable("aws_vpc.main", "vpc-0def"),
        adoptable("aws_subnet.app", "subnet-01", "aws_subnet"),
      ],
    });
    expect(ledger.adoptions.map((c) => c.addr)).toEqual(["aws_subnet.app"]);
    expect(ledger.contested.map((c) => c.identity)).toEqual(["vpc-0abc", "vpc-0def"]);
    // One address is contested, and both of its candidates are listed, so the
    // report shows what the choice is between.
    expect(ledger.ambiguous).toBe(1);
  });

  test("a command from the -adoption-only render rides on the matching candidate", () => {
    const commands = new Map([["aws_vpc.main", "aws ec2 create-tags --resources 'vpc-0abc'"]]);
    const ledger = readAdoptionLedger(
      { unowned: [adoptable("aws_vpc.main", "vpc-0abc"), adoptable("aws_subnet.app", "subnet-01", "aws_subnet")] },
      commands,
    );
    expect(ledger.adoptions.find((c) => c.addr === "aws_vpc.main")?.command).toBe(
      "aws ec2 create-tags --resources 'vpc-0abc'",
    );
    expect(ledger.adoptions.find((c) => c.addr === "aws_subnet.app")?.command).toBeUndefined();
  });

  test("a document with no unowned section, or none at all, is an empty ledger", () => {
    expect(readAdoptionLedger({ bound: [] })).toEqual({ adoptions: [], contested: [], ambiguous: 0 });
    expect(readAdoptionLedger(undefined)).toEqual({ adoptions: [], contested: [], ambiguous: 0 });
    expect(readAdoptionLedger({ unowned: "not a list" })).toEqual({ adoptions: [], contested: [], ambiguous: 0 });
  });
});

describe("parseAdoptionCommands (#2105)", () => {
  // The row shape `StatelessAdoptionHuman.adoptionSection` prints: the address
  // line, then indented detail lines.
  const RENDER = [
    "",
    "Adoptable now: 2 resource instances",
    "",
    "Each of these is a live resource this run found at a declared resource's identity.",
    "",
    "  aws_vpc.main <- aws_vpc vpc-0abc",
    "      matched on: cidr_block=10.0.0.0/16",
    "      adopt with: aws ec2 create-tags --resources 'vpc-0abc' --tags 'Key=tofu-estate,Value=prod'",
    "      or write: tofu-estate=prod tofu-address=aws_vpc.main",
    "  aws_iam_role.app <- aws_iam_role app-role",
    "      or write: tofu-estate=prod tofu-address=aws_iam_role.app",
    "",
  ].join("\n");

  test("pairs each address with the command printed under it", () => {
    expect(parseAdoptionCommands(RENDER).get("aws_vpc.main")).toBe(
      "aws ec2 create-tags --resources 'vpc-0abc' --tags 'Key=tofu-estate,Value=prod'",
    );
  });

  test("an address with no printed command is absent, not empty", () => {
    // IAM has its own tagging call, which choudoufu does not spell out.
    const commands = parseAdoptionCommands(RENDER);
    expect(commands.has("aws_iam_role.app")).toBe(false);
    expect(commands.size).toBe(1);
  });

  test("a render with no adoptable section yields nothing", () => {
    expect(parseAdoptionCommands("Adoption: 3 declared resource instances\n\nNo changes.\n").size).toBe(0);
  });
});

describe("renderAdoptionLedger (#2105)", () => {
  test("one line per adoptable match, carrying the address, identity and both marker values", () => {
    const text = renderAdoptionLedger(
      readAdoptionLedger({ unowned: [adoptable("aws_vpc.main", "vpc-0abc")] }),
      "prod-networking",
    );
    expect(text).toContain(
      "  aws_vpc.main <- aws_vpc vpc-0abc  write: tofu-estate=prod-networking tofu-address=aws_vpc.main",
    );
    expect(text).toContain('Adoptable now: 1 live resource, estate "prod-networking"');
  });

  test("an empty ledger still says so, rather than rendering nothing", () => {
    const text = renderAdoptionLedger(readAdoptionLedger({ unowned: [] }), "prod-networking");
    expect(text).toContain("Adoptable now: nothing");
  });

  test("contested addresses are listed under their own heading with no marker values offered", () => {
    const text = renderAdoptionLedger(
      readAdoptionLedger({ unowned: [adoptable("aws_vpc.main", "vpc-0abc"), adoptable("aws_vpc.main", "vpc-0def")] }),
      "prod-networking",
    );
    expect(text).toContain("Ambiguous: 1 declared address with more than one candidate");
    expect(text).toContain("  aws_vpc.main <- aws_vpc vpc-0abc");
    expect(text).toContain("  aws_vpc.main <- aws_vpc vpc-0def");
    // Nothing in the contested block offers a write: there is no single one.
    const contestedBlock = text.slice(text.indexOf("Ambiguous:"));
    expect(contestedBlock).not.toContain("write: tofu-estate=");
  });

  test("nothing outside the unowned section reaches the rendering", () => {
    // The document carries every declared instance the plan bound and every
    // one it could not read, with identities and reasons. The ledger is a
    // projection of `unowned` alone, and this is what says so.
    const document = {
      unowned: [adoptable("aws_vpc.main", "vpc-0abc")],
      bound: [{ addr: "aws_db_instance.prod", identity: "prod-db-0f1e2d3c" }],
      omissions: [{ addr: "aws_kms_key.signing", detail: "provider error" }],
    };
    const text = renderAdoptionLedger(readAdoptionLedger(document), "prod-networking");
    expect(text).not.toContain("aws_db_instance.prod");
    expect(text).not.toContain("prod-db-0f1e2d3c");
    expect(text).not.toContain("aws_kms_key.signing");
    expect(text).not.toContain("adopt_tofu_estate");
  });
});
