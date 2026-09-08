/**
 * The adoption ledger (#2105, #2241): reading `live-plan -json`'s `unowned`
 * and `adoptable` sections, pairing the first with the commands
 * `-adoption-only` printed, and rendering both.
 *
 * The document fragments below are the shape choudoufu actually emits, taken
 * from `views.StatelessUnowned` and `views.LivePlanAdoptable`'s json tags
 * (`internal/command/live_plan.go`) and checked against the recorded document
 * next door: an adoptable row carries
 * `adopt_tofu_estate`/`adopt_tofu_address`, and a row held by somebody else
 * carries `tofu_estate` and neither of the other two.
 *
 * The last block reads `../__fixtures__/live-plan.json` itself, so the
 * `adoptable` half is proved against a real v0.15.0 document rather than
 * against a literal a test author typed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("a document with neither section, or none at all, is an empty ledger", () => {
    const empty = { adoptions: [], contested: [], ambiguous: 0, swept: [] };
    expect(readAdoptionLedger({ bound: [] })).toEqual(empty);
    expect(readAdoptionLedger(undefined)).toEqual(empty);
    expect(readAdoptionLedger({ unowned: "not a list", adoptable: 7, swept: "aws_vpc" })).toEqual(empty);
  });
});

describe("readAdoptionLedger over the adoptable section (choudoufu #962, #2241)", () => {
  const matched = (addr: string, identity: string) => ({
    addr,
    type: "aws_vpc",
    identity,
    matched: [{ attribute: "cidr_block", value: "10.77.0.0/16" }],
    adopt_tofu_estate: "prod-networking",
    adopt_tofu_address: addr,
    adopt_command: `aws ec2 create-tags --resources '${identity}'`,
  });

  test("a content match is a candidate carrying its own command and what it matched on", () => {
    const ledger = readAdoptionLedger({ unowned: [], adoptable: [matched("aws_vpc.main", "vpc-0abc")] });
    expect(ledger.adoptions).toEqual([
      {
        addr: "aws_vpc.main",
        type: "aws_vpc",
        identity: "vpc-0abc",
        markerEstate: "prod-networking",
        markerAddress: "aws_vpc.main",
        command: "aws ec2 create-tags --resources 'vpc-0abc'",
        matched: [{ attribute: "cidr_block", value: "10.77.0.0/16" }],
      },
    ]);
  });

  test("the document's own command wins: no render is parsed for this half", () => {
    const ledger = readAdoptionLedger(
      { adoptable: [matched("aws_vpc.main", "vpc-0abc")] },
      new Map([["aws_vpc.main", "a command scraped off the render"]]),
    );
    expect(ledger.adoptions[0].command).toBe("aws ec2 create-tags --resources 'vpc-0abc'");
  });

  test("both sections feed one ledger, and one address in both is contested", () => {
    const ledger = readAdoptionLedger({
      unowned: [adoptable("aws_cloudwatch_log_group.app", "/estate/app", "aws_cloudwatch_log_group")],
      adoptable: [matched("aws_vpc.main", "vpc-0abc"), matched("aws_cloudwatch_log_group.app", "/estate/app")],
    });
    expect(ledger.adoptions.map((c) => c.addr)).toEqual(["aws_vpc.main"]);
    expect(ledger.contested.map((c) => c.addr)).toEqual([
      "aws_cloudwatch_log_group.app",
      "aws_cloudwatch_log_group.app",
    ]);
    expect(ledger.ambiguous).toBe(1);
  });

  test("swept comes back so an empty ledger can say which empty it is", () => {
    expect(readAdoptionLedger({ swept: ["aws_vpc", 7, "aws_subnet"] }).swept).toEqual(["aws_vpc", "aws_subnet"]);
    expect(readAdoptionLedger({ unowned: [] }).swept).toEqual([]);
  });
});

describe("readAdoptionLedger over the recorded v0.15.0 document (#2241)", () => {
  const document: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "__fixtures__", "live-plan.json"), "utf-8"),
  );
  const ledger = readAdoptionLedger(document);

  test("both halves of the real document reach the ledger", () => {
    // The log group's identity is the name in its own block, so choudoufu read
    // it and put it in `unowned[]`. The VPC's is assigned by EC2, so the sweep
    // content-matched it and put it in `adoptable[]`. One ledger, both rows.
    expect(ledger.adoptions.map((c) => c.addr).sort()).toEqual([
      "aws_cloudwatch_log_group.adoptable",
      "aws_vpc.adoptable",
    ]);
    expect(ledger.contested).toEqual([]);
  });

  test("the content match carries the cidr it rested on and choudoufu's own tagging command", () => {
    const vpc = ledger.adoptions.find((c) => c.addr === "aws_vpc.adoptable")!;
    expect(vpc.type).toBe("aws_vpc");
    expect(vpc.identity).toMatch(/^vpc-/);
    expect(vpc.markerEstate).toBe("stateless-e2e-block");
    expect(vpc.markerAddress).toBe("aws_vpc.adoptable");
    expect(vpc.matched).toEqual([{ attribute: "cidr_block", value: "10.88.0.0/16" }]);
    expect(vpc.command).toContain("aws ec2 create-tags");
  });

  test("the declared-identity row carries no match and no command of its own", () => {
    // `views.StatelessUnowned` has no command field, which is why
    // `parseAdoptionCommands` still exists for this half alone.
    const log = ledger.adoptions.find((c) => c.addr === "aws_cloudwatch_log_group.adoptable")!;
    expect(log.matched).toBeUndefined();
    expect(log.command).toBeUndefined();
  });

  test("the sweep's type list rides along, so nothing here is silence", () => {
    expect(ledger.swept).toContain("aws_vpc");
  });

  test("the rendering names the match under its row", () => {
    const text = renderAdoptionLedger(ledger, "stateless-e2e-block");
    expect(text).toContain("Adoptable now: 2 live resources");
    expect(text).toContain("      matched on: cidr_block=10.88.0.0/16");
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

  test("an empty ledger off a run that swept nothing says it did not look", () => {
    // The difference choudoufu's own view draws, and the reason `swept` is
    // carried at all: no sweep means no answer, which is not the same answer
    // as "nothing to adopt".
    expect(renderAdoptionLedger(readAdoptionLedger({ unowned: [] }))).toContain("No estate-wide sweep ran");
    expect(renderAdoptionLedger(readAdoptionLedger({ unowned: [], swept: ["aws_vpc"] }))).toContain(
      "across 1 swept resource type (aws_vpc)",
    );
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

  test("nothing outside the two adoption sections reaches the rendering", () => {
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
