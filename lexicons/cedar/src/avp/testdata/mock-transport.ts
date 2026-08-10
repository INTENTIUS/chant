/**
 * A fake AVP wire, for the tests of every reader in ../ .
 *
 * Mocks the *client layer*, never the network: it implements {@link AvpHttp},
 * the same injection point `lexicons/aws/src/api/read-client.ts` exposes, so a
 * test drives real `avpCall` / `listPolicies` / `getPolicy` code — the
 * pagination loop, the `__type` error mapping, the description decoding — with
 * only the socket replaced.
 */

import type { AvpHttp } from "../client";
import { encodeOwnershipDescription } from "../ownership";

/** One policy the fake store holds. */
export interface MockPolicy {
  policyId: string;
  statement: string;
  description?: string;
  policyType?: string;
  createdDate?: string;
  lastUpdatedDate?: string;
  /** Make `GetPolicy` fail for this one, to exercise a per-policy hole. */
  getFails?: boolean;
}

export interface MockStore {
  policyStoreId: string;
  policies: MockPolicy[];
  /** Page size, so the pagination loop is actually exercised. */
  pageSize?: number;
  /** Fail `ListPolicies` with this AWS error code. */
  listFails?: { code: string; message: string; status?: number };
  tags?: Record<string, string>;
  arn?: string;
}

/** A chant-stamped description for a policy the fake store should read as owned. */
export function markedDescription(
  policyId: string,
  text = "",
  marker: { stack: string; env?: string } = { stack: "authz", env: "prod" },
): string {
  return encodeOwnershipDescription(text, marker, policyId);
}

/** A statement carrying the `@id` a chant entity resolves to. */
export function statementFor(policyId: string, body = "permit (\n  principal,\n  action,\n  resource\n)"): string {
  return `@id("${policyId}")\n${body};`;
}

export interface MockTransport {
  http: AvpHttp;
  /** Every operation issued, in order — for asserting round-trip counts. */
  calls: Array<{ operation: string; payload: Record<string, unknown> }>;
}

/** Build an {@link AvpHttp} over one fake store. */
export function mockAvpTransport(store: MockStore): MockTransport {
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const pageSize = store.pageSize ?? 50;

  const error = (type: string, message: string, status = 400) => ({
    status,
    text: JSON.stringify({ __type: `com.amazonaws.verifiedpermissions#${type}`, message }),
  });

  const definitionOf = (policy: MockPolicy, withStatement: boolean) => ({
    static: {
      ...(policy.description !== undefined ? { description: policy.description } : {}),
      ...(withStatement ? { statement: policy.statement } : {}),
    },
  });

  const http: AvpHttp = async (_url, init) => {
    const operation = (init.headers["x-amz-target"] ?? "").split(".").pop() ?? "";
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ operation, payload });

    if (payload.policyStoreId !== undefined && payload.policyStoreId !== store.policyStoreId) {
      return error("ResourceNotFoundException", `No policy store: ${String(payload.policyStoreId)}`, 404);
    }

    switch (operation) {
      case "ListPolicies": {
        if (store.listFails) {
          return error(store.listFails.code, store.listFails.message, store.listFails.status ?? 400);
        }
        const from = typeof payload.nextToken === "string" ? Number(payload.nextToken) : 0;
        const page = store.policies.slice(from, from + pageSize);
        const next = from + pageSize < store.policies.length ? String(from + pageSize) : undefined;
        return {
          status: 200,
          text: JSON.stringify({
            policies: page.map((policy) => ({
              policyStoreId: store.policyStoreId,
              policyId: policy.policyId,
              policyType: policy.policyType ?? "STATIC",
              definition: definitionOf(policy, false),
              ...(policy.createdDate ? { createdDate: policy.createdDate } : {}),
              ...(policy.lastUpdatedDate ? { lastUpdatedDate: policy.lastUpdatedDate } : {}),
            })),
            ...(next ? { nextToken: next } : {}),
          }),
        };
      }

      case "GetPolicy": {
        const policy = store.policies.find((p) => p.policyId === payload.policyId);
        if (!policy) return error("ResourceNotFoundException", "No such policy", 404);
        if (policy.getFails) return error("ThrottlingException", "Rate exceeded", 429);
        return {
          status: 200,
          text: JSON.stringify({
            policyStoreId: store.policyStoreId,
            policyId: policy.policyId,
            policyType: policy.policyType ?? "STATIC",
            definition: definitionOf(policy, true),
            ...(policy.createdDate ? { createdDate: policy.createdDate } : {}),
            ...(policy.lastUpdatedDate ? { lastUpdatedDate: policy.lastUpdatedDate } : {}),
          }),
        };
      }

      case "GetPolicyStore":
        return {
          status: 200,
          text: JSON.stringify({
            policyStoreId: store.policyStoreId,
            arn: store.arn ?? `arn:aws:verifiedpermissions::111122223333:policy-store/${store.policyStoreId}`,
          }),
        };

      case "ListTagsForResource":
        return { status: 200, text: JSON.stringify({ tags: store.tags ?? {} }) };

      default:
        return error("UnknownOperationException", `no mock for ${operation}`, 400);
    }
  };

  return { http, calls };
}

/** The env a reader needs to consider itself credentialed against a fake endpoint. */
export const MOCK_ENV: Record<string, string | undefined> = {
  AWS_ENDPOINT_URL: "http://localhost:4566",
};
