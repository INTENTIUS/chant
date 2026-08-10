import { describe, expect, it } from "vitest";
import { hasOwnershipMarker, readOwnership } from "@intentius/chant/ownership";
import {
  AVP_DESCRIPTION_MAX,
  AVP_OWNERSHIP_KEYS,
  AVP_POLICY_ID_KEY,
  decodeOwnershipDescription,
  descriptionIsOwned,
  encodeOwnershipDescription,
  ownershipFromDescription,
  ownershipFromStoreTags,
  storeOwnershipTags,
} from "./ownership";

describe("the AVP description marker", () => {
  it("keeps the author's text ahead of the marker", () => {
    const encoded = encodeOwnershipDescription("Owners read their own documents.", {
      stack: "authz",
      env: "prod",
    });
    expect(encoded.startsWith("Owners read their own documents. [chant:")).toBe(true);

    const decoded = decodeOwnershipDescription(encoded);
    expect(decoded.text).toBe("Owners read their own documents.");
    expect(decoded.marked).toBe(true);
  });

  it("round-trips the stack and env through core's own ownership helpers", () => {
    const encoded = encodeOwnershipDescription(undefined, { stack: "authz", env: "prod" });
    const { tags } = decodeOwnershipDescription(encoded);

    expect(hasOwnershipMarker(tags, AVP_OWNERSHIP_KEYS)).toBe(true);
    expect(readOwnership(tags, AVP_OWNERSHIP_KEYS)).toEqual({ stack: "authz", env: "prod" });
  });

  it("carries the cedar policy id, and does not let it count as an ownership claim", () => {
    const encoded = encodeOwnershipDescription("", { stack: "authz" }, "owner-read");
    expect(decodeOwnershipDescription(encoded).policyId).toBe("owner-read");

    // A marker segment carrying only the id is not ownership.
    const idOnly = decodeOwnershipDescription(`[${AVP_POLICY_ID_KEY}=owner-read]`);
    expect(hasOwnershipMarker(idOnly.tags, AVP_OWNERSHIP_KEYS)).toBe(false);
    expect(idOnly.policyId).toBe("owner-read");
  });

  it("survives values holding spaces and brackets", () => {
    const encoded = encodeOwnershipDescription("desc", { stack: "my stack", env: "pr[7]" }, "a b");
    const decoded = decodeOwnershipDescription(encoded);

    expect(decoded.text).toBe("desc");
    expect(readOwnership(decoded.tags, AVP_OWNERSHIP_KEYS)).toEqual({
      stack: "my stack",
      env: "pr[7]",
    });
    expect(decoded.policyId).toBe("a b");
  });

  it("truncates the prose rather than the marker at AVP's 150-character cap", () => {
    const encoded = encodeOwnershipDescription("x".repeat(400), { stack: "authz", env: "prod" }, "p");

    expect(encoded.length).toBeLessThanOrEqual(AVP_DESCRIPTION_MAX);
    expect(descriptionIsOwned(encoded)).toBe(true);
    expect(decodeOwnershipDescription(encoded).policyId).toBe("p");
  });

  it("keeps the marker whole when there is no room for prose at all", () => {
    const encoded = encodeOwnershipDescription("x".repeat(400), {
      stack: "s".repeat(60),
      env: "e".repeat(60),
    });
    expect(descriptionIsOwned(encoded)).toBe(true);
  });

  it("reads an unmarked description as foreign, not as an error", () => {
    expect(ownershipFromDescription("added by hand in the console")).toBe("foreign");
    expect(ownershipFromDescription(undefined)).toBe("foreign");
    expect(decodeOwnershipDescription("added by hand").text).toBe("added by hand");
  });

  it("degrades a corrupt marker entry to foreign rather than throwing", () => {
    // A truncated percent-escape: the entry is dropped, and a foreign policy is
    // never deleted, so the failure lands on the safe side.
    const decoded = decodeOwnershipDescription("[chant:managed-by=%E0%A4 chant:stack=authz]");
    expect(decoded.marked).toBe(true);
    expect(hasOwnershipMarker(decoded.tags, AVP_OWNERSHIP_KEYS)).toBe(false);
  });

  it("classifies a marked description as owned", () => {
    const encoded = encodeOwnershipDescription("d", { stack: "authz", env: "prod" }, "id");
    expect(ownershipFromDescription(encoded)).toBe("owned");
  });
});

describe("the store-level channel", () => {
  it("stamps and reads the same keys as the per-policy channel", () => {
    const tags = storeOwnershipTags({ stack: "authz", env: "prod" });
    expect(tags[AVP_OWNERSHIP_KEYS.managedBy]).toBe("chant");
    expect(ownershipFromStoreTags(tags)).toBe("owned");
    expect(ownershipFromStoreTags({ Team: "platform" })).toBe("foreign");
  });
});
