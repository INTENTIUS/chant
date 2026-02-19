import { PseudoParameter, createPseudoParameters } from "@intentius/chant/pseudo-parameter";

export { PseudoParameter };

export const { StackName, Region, AccountId, StackId, URLSuffix, NoValue, NotificationARNs, Partition } =
  createPseudoParameters({
    StackName: "AWS::StackName",
    Region: "AWS::Region",
    AccountId: "AWS::AccountId",
    StackId: "AWS::StackId",
    URLSuffix: "AWS::URLSuffix",
    NoValue: "AWS::NoValue",
    NotificationARNs: "AWS::NotificationARNs",
    Partition: "AWS::Partition",
  });

/**
 * AWS namespace containing all pseudo-parameters
 */
export const AWS = {
  StackName,
  Region,
  AccountId,
  StackId,
  URLSuffix,
  NoValue,
  NotificationARNs,
  Partition,
} as const;
