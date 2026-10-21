/**
 * A value read from a resource this template doesn't hold, such as another
 * lexicon's, is a parameter, not a dangling Fn::GetAtt (#4180).
 */

import { describe, expect, it } from "vitest";
import { AttrRef } from "@intentius/chant";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { awsSerializer } from "./serializer";

function entity(lexicon: string, entityType: string, props: Record<string, unknown> = {}): any {
  return { [DECLARABLE_MARKER]: true, lexicon, entityType, kind: "resource", props };
}

describe("aws foreign attributes", () => {
  it("turns another lexicon's attribute into a parameter and warns", () => {
    const app = entity("azure", "Microsoft.App/containerApps", { name: "web" });
    const fqdn = new AttrRef(app, "configuration.ingress.fqdn");
    fqdn._setLogicalName("app");
    const record = entity("aws", "AWS::Route53::RecordSet", { Type: "CNAME", ResourceRecords: [fqdn] });

    const result = awsSerializer.serialize(new Map([["record", record]]));
    expect(typeof result).toBe("object");
    const { primary, warnings } = result as { primary: string; warnings?: string[] };
    const template = JSON.parse(primary);

    expect(template.Resources.record.Properties.ResourceRecords).toEqual([{ Ref: "appConfigurationIngressFqdn" }]);
    expect(template.Parameters.appConfigurationIngressFqdn.Type).toBe("String");
    expect(warnings).toHaveLength(1);
    expect(warnings![0]).toContain('"app" is not in this template');
  });

  it("keeps Fn::GetAtt for a resource in the template", () => {
    const bucket = entity("aws", "AWS::S3::Bucket");
    const arn = new AttrRef(bucket, "Arn");
    arn._setLogicalName("bucket");
    const topic = entity("aws", "AWS::SNS::Topic", { TopicName: arn });

    const result = awsSerializer.serialize(new Map([["bucket", bucket], ["topic", topic]]));
    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string).Resources.topic.Properties.TopicName).toEqual({ "Fn::GetAtt": ["bucket", "Arn"] });
  });
});
