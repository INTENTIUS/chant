// The program behind lexicons/pulumi/src/testdata/pulumi-member/stack-export.json
// (INTENTIUS/chant#4507). It is plain JavaScript so chant's tsc, which
// includes everything under src/, never compiles it. It runs against the
// floci emulator only; the README one directory up has the commands.
"use strict";
const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");

const prefix = new pulumi.Config("app").get("prefix") ?? "rec-r2-4507";

const assets = new aws.s3.Bucket("assets", { bucket: `${prefix}-assets` });

const web = new aws.iam.Role("web", {
    name: `${prefix}-web`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "lambda.amazonaws.com" } }],
    }),
});

// The policy is a secret, so the export carries it as ciphertext and the
// graph tests can check that inputs never reach a node.
new aws.iam.RolePolicy("webReadsAssets", {
    role: web.id,
    policy: pulumi.secret(pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: [pulumi.interpolate`${assets.arn}/*`] }],
    })),
});

class Web extends pulumi.ComponentResource {
    constructor(name, args, opts) {
        super("my:mod:Web", name, {}, opts);
        new aws.lambda.Function("handler", {
            name: `${prefix}-handler`,
            role: args.role.arn,
            runtime: "nodejs20.x",
            handler: "index.handler",
            code: new pulumi.asset.AssetArchive({
                "index.js": new pulumi.asset.StringAsset("exports.handler = async () => ({ statusCode: 200 });\n"),
            }),
        }, { parent: this });
        this.registerOutputs({});
    }
}

new Web("web-app", { role: web });
