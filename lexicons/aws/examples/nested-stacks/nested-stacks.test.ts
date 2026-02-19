import { describe, test, expect } from "bun:test";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../src/serializer";
import type { SerializerResult } from "../../../../packages/core/src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("nested-stacks example", () => {
  test("build produces valid CloudFormation with nested stack", async () => {
    const result = await build(srcDir, [awsSerializer]);

    expect(result.errors).toHaveLength(0);

    const output = result.outputs.get("aws");
    expect(output).toBeDefined();

    // Should be a SerializerResult with files
    expect(typeof output).toBe("object");
    const sr = output as SerializerResult;

    // Parse parent template
    const parent = JSON.parse(sr.primary);
    expect(parent.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(parent.Resources).toBeDefined();

    // Parent should have TemplateBasePath parameter
    expect(parent.Parameters?.TemplateBasePath).toBeDefined();
    expect(parent.Parameters.TemplateBasePath.Default).toBe(".");

    // Parent should have network as AWS::CloudFormation::Stack
    expect(parent.Resources.network).toBeDefined();
    expect(parent.Resources.network.Type).toBe("AWS::CloudFormation::Stack");
    expect(parent.Resources.network.Properties.TemplateURL).toEqual({
      "Fn::Sub": "${TemplateBasePath}/network.template.json",
    });

    // Parent should have TemplateBasePath propagated to child
    expect(parent.Resources.network.Properties.Parameters.TemplateBasePath).toEqual({
      Ref: "TemplateBasePath",
    });

    // Parent should have explicit parameters passed
    expect(parent.Resources.network.Properties.Parameters.Environment).toBe("prod");

    // Parent should have the handler Lambda function
    expect(parent.Resources.handler).toBeDefined();
    expect(parent.Resources.handler.Type).toBe("AWS::Lambda::Function");

    // Cross-stack ref: handler VpcConfig should reference network stack outputs
    const vpcConfig = parent.Resources.handler.Properties.VpcConfig;
    expect(vpcConfig).toBeDefined();
    const subnetRef = vpcConfig.SubnetIds[0];
    expect(subnetRef).toEqual({
      "Fn::GetAtt": ["network", "Outputs.subnetId"],
    });
    const sgRef = vpcConfig.SecurityGroupIds[0];
    expect(sgRef).toEqual({
      "Fn::GetAtt": ["network", "Outputs.lambdaSgId"],
    });

    // Child template should exist
    expect(sr.files).toBeDefined();
    expect(sr.files!["network.template.json"]).toBeDefined();

    const child = JSON.parse(sr.files!["network.template.json"]);
    expect(child.AWSTemplateFormatVersion).toBe("2010-09-09");

    // Child should have VPC and Subnet resources
    expect(child.Resources.vpc).toBeDefined();
    expect(child.Resources.vpc.Type).toBe("AWS::EC2::VPC");
    expect(child.Resources.subnet).toBeDefined();
    expect(child.Resources.subnet.Type).toBe("AWS::EC2::Subnet");

    // Child should have internet gateway and routing resources
    expect(child.Resources.igw).toBeDefined();
    expect(child.Resources.igw.Type).toBe("AWS::EC2::InternetGateway");
    expect(child.Resources.igwAttachment).toBeDefined();
    expect(child.Resources.igwAttachment.Type).toBe("AWS::EC2::VPCGatewayAttachment");
    expect(child.Resources.routeTable).toBeDefined();
    expect(child.Resources.routeTable.Type).toBe("AWS::EC2::RouteTable");
    expect(child.Resources.defaultRoute).toBeDefined();
    expect(child.Resources.defaultRoute.Type).toBe("AWS::EC2::Route");
    expect(child.Resources.subnetRouteTableAssoc).toBeDefined();
    expect(child.Resources.subnetRouteTableAssoc.Type).toBe("AWS::EC2::SubnetRouteTableAssociation");

    // Child should have security group
    expect(child.Resources.lambdaSg).toBeDefined();
    expect(child.Resources.lambdaSg.Type).toBe("AWS::EC2::SecurityGroup");

    // Child should have Outputs for stackOutput() declarations
    expect(child.Outputs).toBeDefined();
    expect(child.Outputs.vpcId).toBeDefined();
    expect(child.Outputs.vpcId.Description).toBe("VPC ID");
    expect(child.Outputs.subnetId).toBeDefined();
    expect(child.Outputs.subnetId.Description).toBe("Public subnet ID");
    expect(child.Outputs.lambdaSgId).toBeDefined();
    expect(child.Outputs.lambdaSgId.Description).toBe("Lambda security group ID");
  });
});
