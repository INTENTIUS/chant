import { describe, test, expect } from "bun:test";
import { S3Actions } from "./s3";
import { LambdaActions } from "./lambda";
import { DynamoDBActions } from "./dynamodb";
import { SQSActions } from "./sqs";
import { SNSActions } from "./sns";
import { IAMActions } from "./iam";
import { ECRActions } from "./ecr";
import { LogsActions } from "./logs";
import { ECSActions } from "./ecs";

const allConstants = {
  S3Actions,
  LambdaActions,
  DynamoDBActions,
  SQSActions,
  SNSActions,
  IAMActions,
  ECRActions,
  LogsActions,
  ECSActions,
};

describe("Action Constants", () => {
  for (const [name, constant] of Object.entries(allConstants)) {
    describe(name, () => {
      test("every action string matches serviceName:actionName pattern", () => {
        for (const [group, actions] of Object.entries(constant)) {
          for (const action of actions) {
            expect(action).toMatch(
              /^[a-z][a-z0-9]*:[A-Z*][A-Za-z0-9*]*$/,
            );
          }
        }
      });

      test("no duplicate actions within a group", () => {
        for (const [group, actions] of Object.entries(constant)) {
          const unique = new Set(actions);
          expect(unique.size).toBe(
            actions.length,
          );
        }
      });
    });
  }

  describe("S3Actions broad groups are supersets", () => {
    test("ReadWrite contains all ReadOnly actions", () => {
      for (const action of S3Actions.ReadOnly) {
        expect(S3Actions.ReadWrite).toContain(action);
      }
    });

    test("ReadWrite contains all WriteOnly actions", () => {
      for (const action of S3Actions.WriteOnly) {
        expect(S3Actions.ReadWrite).toContain(action);
      }
    });
  });

  describe("DynamoDBActions broad groups are supersets", () => {
    test("ReadWrite contains all ReadOnly actions", () => {
      for (const action of DynamoDBActions.ReadOnly) {
        expect(DynamoDBActions.ReadWrite).toContain(action);
      }
    });

    test("ReadWrite contains all WriteOnly actions", () => {
      for (const action of DynamoDBActions.WriteOnly) {
        expect(DynamoDBActions.ReadWrite).toContain(action);
      }
    });
  });
});
