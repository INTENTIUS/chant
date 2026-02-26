import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw030, checkMissingDependsOn } from "./waw030";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW030: Missing DependsOn for Known Patterns", () => {
  test("check metadata", () => {
    expect(waw030.id).toBe("WAW030");
    expect(waw030.description).toContain("DependsOn");
  });

  // --- ECS Service + Listener pattern ---

  test("ECS Service with LoadBalancers, no Listener DependsOn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        MyService: {
          Type: "AWS::ECS::Service",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "MyTG" } }],
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW030");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("MyService");
    expect(diags[0].message).toContain("Listener");
    expect(diags[0].entity).toBe("MyService");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("ECS Service with LoadBalancers and Listener DependsOn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        MyService: {
          Type: "AWS::ECS::Service",
          DependsOn: "MyListener",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "MyTG" } }],
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("ECS Service with LoadBalancers and Listener DependsOn (array) → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        MyService: {
          Type: "AWS::ECS::Service",
          DependsOn: ["MyListener"],
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "MyTG" } }],
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("ECS Service without LoadBalancers → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        MyService: {
          Type: "AWS::ECS::Service",
          Properties: { Cluster: "my-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no ECS Service → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- EC2 Route + VPCGatewayAttachment pattern ---

  test("Route with GatewayId, no VPCGatewayAttachment dependency → warning", () => {
    const ctx = makeCtx({
      Resources: {
        MyAttachment: {
          Type: "AWS::EC2::VPCGatewayAttachment",
          Properties: {},
        },
        MyRoute: {
          Type: "AWS::EC2::Route",
          Properties: {
            GatewayId: { Ref: "MyIGW" },
            RouteTableId: { Ref: "MyRT" },
            DestinationCidrBlock: "0.0.0.0/0",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW030");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("MyRoute");
    expect(diags[0].message).toContain("VPCGatewayAttachment");
    expect(diags[0].entity).toBe("MyRoute");
  });

  test("Route with GatewayId and VPCGatewayAttachment DependsOn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyAttachment: {
          Type: "AWS::EC2::VPCGatewayAttachment",
          Properties: {},
        },
        MyRoute: {
          Type: "AWS::EC2::Route",
          DependsOn: "MyAttachment",
          Properties: {
            GatewayId: { Ref: "MyIGW" },
            RouteTableId: { Ref: "MyRT" },
            DestinationCidrBlock: "0.0.0.0/0",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("Route with GatewayId and property Ref to VPCGatewayAttachment → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyAttachment: {
          Type: "AWS::EC2::VPCGatewayAttachment",
          Properties: {},
        },
        MyRoute: {
          Type: "AWS::EC2::Route",
          Properties: {
            GatewayId: { Ref: "MyAttachment" },
            RouteTableId: { Ref: "MyRT" },
            DestinationCidrBlock: "0.0.0.0/0",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("Route without GatewayId → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyAttachment: {
          Type: "AWS::EC2::VPCGatewayAttachment",
          Properties: {},
        },
        MyRoute: {
          Type: "AWS::EC2::Route",
          Properties: {
            NatGatewayId: { Ref: "MyNAT" },
            RouteTableId: { Ref: "MyRT" },
            DestinationCidrBlock: "0.0.0.0/0",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- Edge cases ---

  test("ECS Service with empty LoadBalancers array → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        MyService: {
          Type: "AWS::ECS::Service",
          Properties: { LoadBalancers: [] },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("ECS Service with LoadBalancers but no Listener in template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyService: {
          Type: "AWS::ECS::Service",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "MyTG" } }],
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("Route with GatewayId but no VPCGatewayAttachment in template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyRoute: {
          Type: "AWS::EC2::Route",
          Properties: {
            GatewayId: { Ref: "MyIGW" },
            RouteTableId: { Ref: "MyRT" },
            DestinationCidrBlock: "0.0.0.0/0",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("Route with Fn::GetAtt (dot-delimited) referencing VPCGatewayAttachment → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyAttachment: {
          Type: "AWS::EC2::VPCGatewayAttachment",
          Properties: {},
        },
        MyRoute: {
          Type: "AWS::EC2::Route",
          Properties: {
            GatewayId: { "Fn::GetAtt": "MyAttachment.InternetGatewayId" },
            RouteTableId: { Ref: "MyRT" },
            DestinationCidrBlock: "0.0.0.0/0",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("multiple ECS Services — only flags those missing DependsOn", () => {
    const ctx = makeCtx({
      Resources: {
        Listener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        GoodService: {
          Type: "AWS::ECS::Service",
          DependsOn: "Listener",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "TG" } }],
          },
        },
        BadService: {
          Type: "AWS::ECS::Service",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "TG2" } }],
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("BadService");
  });

  test("ECS Service DependsOn includes one of multiple listeners → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        HttpListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        HttpsListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        MyService: {
          Type: "AWS::ECS::Service",
          DependsOn: "HttpsListener",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "TG" } }],
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("empty Resources → no diagnostic", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("both patterns fire in same template", () => {
    const ctx = makeCtx({
      Resources: {
        Listener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        Service: {
          Type: "AWS::ECS::Service",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "TG" } }],
          },
        },
        Attachment: {
          Type: "AWS::EC2::VPCGatewayAttachment",
          Properties: {},
        },
        Route: {
          Type: "AWS::EC2::Route",
          Properties: {
            GatewayId: { Ref: "MyIGW" },
            DestinationCidrBlock: "0.0.0.0/0",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(2);
    const entities = diags.map((d) => d.entity).sort();
    expect(entities).toEqual(["Route", "Service"]);
  });

  // --- API Gateway Deployment + Method pattern ---

  test("API Gateway Deployment + Method, no DependsOn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        MyMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: { RestApiId: { Ref: "MyApi" } },
        },
        MyDeployment: {
          Type: "AWS::ApiGateway::Deployment",
          Properties: { RestApiId: { Ref: "MyApi" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW030");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("MyDeployment");
    expect(diags[0].message).toContain("Method");
    expect(diags[0].entity).toBe("MyDeployment");
  });

  test("API Gateway Deployment + Method, with DependsOn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: { RestApiId: { Ref: "MyApi" } },
        },
        MyDeployment: {
          Type: "AWS::ApiGateway::Deployment",
          DependsOn: "MyMethod",
          Properties: { RestApiId: { Ref: "MyApi" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("API Gateway Deployment + Method, with property ref to Method → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: { RestApiId: { Ref: "MyApi" } },
        },
        MyDeployment: {
          Type: "AWS::ApiGateway::Deployment",
          Properties: { RestApiId: { Ref: "MyApi" }, StageName: { Ref: "MyMethod" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("API Gateway Deployment without any Methods in template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyDeployment: {
          Type: "AWS::ApiGateway::Deployment",
          Properties: { RestApiId: { Ref: "MyApi" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no API Gateway Deployment → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: { RestApiId: { Ref: "MyApi" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- API Gateway V2 Deployment + Route pattern ---

  test("API Gateway V2 Deployment + Route, no DependsOn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        MyRoute: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: { ApiId: { Ref: "MyApi" } },
        },
        MyDeployment: {
          Type: "AWS::ApiGatewayV2::Deployment",
          Properties: { ApiId: { Ref: "MyApi" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW030");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("MyDeployment");
    expect(diags[0].message).toContain("Route");
    expect(diags[0].entity).toBe("MyDeployment");
  });

  test("API Gateway V2 Deployment + Route, with DependsOn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyRoute: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: { ApiId: { Ref: "MyApi" } },
        },
        MyDeployment: {
          Type: "AWS::ApiGatewayV2::Deployment",
          DependsOn: "MyRoute",
          Properties: { ApiId: { Ref: "MyApi" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("API Gateway V2 Deployment without Routes in template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyDeployment: {
          Type: "AWS::ApiGatewayV2::Deployment",
          Properties: { ApiId: { Ref: "MyApi" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- DynamoDB Table + ScalableTarget pattern ---

  test("ScalableTarget (dynamodb) + Table, no DependsOn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: { TableName: "my-table" },
        },
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "dynamodb",
            ScalableDimension: "dynamodb:table:ReadCapacityUnits",
            ResourceId: "table/my-table",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW030");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("MyTarget");
    expect(diags[0].message).toContain("DynamoDB");
    expect(diags[0].entity).toBe("MyTarget");
  });

  test("ScalableTarget (dynamodb) + Table, with DependsOn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: { TableName: "my-table" },
        },
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          DependsOn: "MyTable",
          Properties: {
            ServiceNamespace: "dynamodb",
            ScalableDimension: "dynamodb:table:ReadCapacityUnits",
            ResourceId: "table/my-table",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("ScalableTarget (dynamodb) + Table, with property ref to Table → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: { TableName: "my-table" },
        },
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "dynamodb",
            ScalableDimension: "dynamodb:table:ReadCapacityUnits",
            ResourceId: { "Fn::Sub": ["table/${TableName}", { TableName: { Ref: "MyTable" } }] },
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("ScalableTarget with non-dynamodb namespace → no diagnostic for dynamodb pattern", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: { TableName: "my-table" },
        },
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "ecs",
            ScalableDimension: "ecs:service:DesiredCount",
            ResourceId: "service/my-cluster/my-service",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    // Should not fire for dynamodb pattern (no ECS Service in template either)
    expect(diags).toHaveLength(0);
  });

  test("ScalableTarget (dynamodb) but no Table in template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "dynamodb",
            ScalableDimension: "dynamodb:table:ReadCapacityUnits",
            ResourceId: "table/my-table",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- ECS Service + ScalableTarget pattern ---

  test("ScalableTarget (ecs) + ECS Service, no DependsOn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        MyService: {
          Type: "AWS::ECS::Service",
          Properties: { Cluster: "my-cluster" },
        },
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "ecs",
            ScalableDimension: "ecs:service:DesiredCount",
            ResourceId: "service/my-cluster/my-service",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW030");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("MyTarget");
    expect(diags[0].message).toContain("ECS");
    expect(diags[0].entity).toBe("MyTarget");
  });

  test("ScalableTarget (ecs) + ECS Service, with DependsOn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyService: {
          Type: "AWS::ECS::Service",
          Properties: { Cluster: "my-cluster" },
        },
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          DependsOn: "MyService",
          Properties: {
            ServiceNamespace: "ecs",
            ScalableDimension: "ecs:service:DesiredCount",
            ResourceId: "service/my-cluster/my-service",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("ScalableTarget (ecs) but no ECS Service in template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "ecs",
            ScalableDimension: "ecs:service:DesiredCount",
            ResourceId: "service/my-cluster/my-service",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("ScalableTarget with non-ecs namespace → no diagnostic for ecs pattern", () => {
    const ctx = makeCtx({
      Resources: {
        MyService: {
          Type: "AWS::ECS::Service",
          Properties: { Cluster: "my-cluster" },
        },
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "dynamodb",
            ScalableDimension: "dynamodb:table:ReadCapacityUnits",
            ResourceId: "table/my-table",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    // Should not fire for ECS pattern (no DynamoDB Table in template either)
    expect(diags).toHaveLength(0);
  });

  // --- Cross-pattern edge cases ---

  test("all patterns missing DependsOn → all fire", () => {
    const ctx = makeCtx({
      Resources: {
        Listener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
        EcsService: {
          Type: "AWS::ECS::Service",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "TG" } }],
          },
        },
        Attachment: {
          Type: "AWS::EC2::VPCGatewayAttachment",
          Properties: {},
        },
        Route: {
          Type: "AWS::EC2::Route",
          Properties: {
            GatewayId: { Ref: "MyIGW" },
            DestinationCidrBlock: "0.0.0.0/0",
          },
        },
        Method: {
          Type: "AWS::ApiGateway::Method",
          Properties: { RestApiId: { Ref: "Api" } },
        },
        ApiDeployment: {
          Type: "AWS::ApiGateway::Deployment",
          Properties: { RestApiId: { Ref: "Api" } },
        },
        V2Route: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: { ApiId: { Ref: "HttpApi" } },
        },
        V2Deployment: {
          Type: "AWS::ApiGatewayV2::Deployment",
          Properties: { ApiId: { Ref: "HttpApi" } },
        },
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: { TableName: "t" },
        },
        DynamoTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "dynamodb",
            ResourceId: "table/t",
          },
        },
        EcsTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ServiceNamespace: "ecs",
            ResourceId: "service/c/s",
          },
        },
        EksCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        EksNodegroup: {
          Type: "AWS::EKS::Nodegroup",
          Properties: { ClusterName: "my-cluster" },
        },
        EksAddon: {
          Type: "AWS::EKS::Addon",
          Properties: { AddonName: "vpc-cni", ClusterName: "my-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(8);
    const entities = diags.map((d) => d.entity).sort();
    expect(entities).toEqual([
      "ApiDeployment",
      "DynamoTarget",
      "EcsService",
      "EcsTarget",
      "EksAddon",
      "EksNodegroup",
      "Route",
      "V2Deployment",
    ]);
  });

  test("ScalableTarget with ScalableDimension fallback (no ServiceNamespace) → detects namespace", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: { TableName: "my-table" },
        },
        MyTarget: {
          Type: "AWS::ApplicationAutoScaling::ScalableTarget",
          Properties: {
            ScalableDimension: "dynamodb:table:ReadCapacityUnits",
            ResourceId: "table/my-table",
          },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("MyTarget");
    expect(diags[0].message).toContain("DynamoDB");
  });

  // --- EKS Addon + Cluster/Nodegroup pattern ---

  test("EKS Addon with hardcoded ClusterName, no DependsOn on Cluster → warning", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        MyNodegroup: {
          Type: "AWS::EKS::Nodegroup",
          DependsOn: "MyCluster",
          Properties: { ClusterName: "my-cluster" },
        },
        VpcCni: {
          Type: "AWS::EKS::Addon",
          Properties: { AddonName: "vpc-cni", ClusterName: "my-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW030");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("VpcCni");
    expect(diags[0].message).toContain("Addon");
    expect(diags[0].entity).toBe("VpcCni");
  });

  test("EKS Addon with DependsOn on Cluster → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        VpcCni: {
          Type: "AWS::EKS::Addon",
          DependsOn: "MyCluster",
          Properties: { AddonName: "vpc-cni", ClusterName: "my-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("EKS Addon with DependsOn on Nodegroup → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        MyNodegroup: {
          Type: "AWS::EKS::Nodegroup",
          DependsOn: "MyCluster",
          Properties: { ClusterName: "my-cluster" },
        },
        VpcCni: {
          Type: "AWS::EKS::Addon",
          DependsOn: ["MyCluster", "MyNodegroup"],
          Properties: { AddonName: "vpc-cni", ClusterName: "my-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("EKS Addon with Ref to Cluster in ClusterName → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        VpcCni: {
          Type: "AWS::EKS::Addon",
          Properties: { AddonName: "vpc-cni", ClusterName: { Ref: "MyCluster" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("EKS Addon without Cluster in template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        VpcCni: {
          Type: "AWS::EKS::Addon",
          Properties: { AddonName: "vpc-cni", ClusterName: "external-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- EKS Nodegroup + Cluster pattern ---

  test("EKS Nodegroup with hardcoded ClusterName, no DependsOn on Cluster → warning", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        MyNodegroup: {
          Type: "AWS::EKS::Nodegroup",
          Properties: { ClusterName: "my-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW030");
    expect(diags[0].message).toContain("MyNodegroup");
    expect(diags[0].message).toContain("Nodegroup");
    expect(diags[0].entity).toBe("MyNodegroup");
  });

  test("EKS Nodegroup with DependsOn on Cluster → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        MyNodegroup: {
          Type: "AWS::EKS::Nodegroup",
          DependsOn: "MyCluster",
          Properties: { ClusterName: "my-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("EKS Nodegroup with Ref to Cluster → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        MyNodegroup: {
          Type: "AWS::EKS::Nodegroup",
          Properties: { ClusterName: { Ref: "MyCluster" } },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("EKS Nodegroup without Cluster in template → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyNodegroup: {
          Type: "AWS::EKS::Nodegroup",
          Properties: { ClusterName: "external-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("multiple EKS Addons — only flags those missing DependsOn", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
        GoodAddon: {
          Type: "AWS::EKS::Addon",
          DependsOn: "MyCluster",
          Properties: { AddonName: "vpc-cni", ClusterName: "my-cluster" },
        },
        BadAddon: {
          Type: "AWS::EKS::Addon",
          Properties: { AddonName: "coredns", ClusterName: "my-cluster" },
        },
      },
    });
    const diags = checkMissingDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("BadAddon");
  });
});
