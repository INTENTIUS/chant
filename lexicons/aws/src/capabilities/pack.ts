/**
 * The aws lexicon's capability pack (#4375): its mapping of CloudFormation
 * kinds onto the lexicon-neutral view the capability rules read. All data;
 * CloudFormation policy documents are JSON already, so no adapter code.
 */
import type { CapabilityMapping, CapabilityPack } from "@intentius/chant/capabilities/view";
import mapping from "./mapping.json" with { type: "json" };

export const awsCapabilityPack: CapabilityPack = { mapping: mapping as CapabilityMapping };
