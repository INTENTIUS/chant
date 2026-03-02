# VPC

A production-ready VPC with 2 public and 2 private subnets across 2 availability zones, an internet gateway, and a NAT gateway — built using the `VpcDefault` composite.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 17 CloudFormation resources:

- **VPC** — `10.0.0.0/16` CIDR with DNS support and hostnames enabled
- **Internet Gateway** + **IGW Attachment** — attached to the VPC for public internet access
- **2 Public Subnets** — `/20` blocks in separate AZs with `MapPublicIpOnLaunch`
- **2 Private Subnets** — `/20` blocks in separate AZs
- **Public Route Table** + **Public Route** — default route `0.0.0.0/0` → Internet Gateway
- **Private Route Table** + **Private Route** — default route `0.0.0.0/0` → NAT Gateway
- **Elastic IP** + **NAT Gateway** — single NAT (cost-conscious) in the first public subnet
- **4 Route Table Associations** — wiring subnets to their route tables

## Project Structure

```
src/
└── main.ts       # VpcDefault composite instantiation
```

## Patterns Demonstrated

1. **Infrastructure composites** — `VpcDefault` encapsulates 17 resources into a single declaration
2. **Deploy-time AZ resolution** — uses `Select(N, GetAZs(""))` to pick AZs at deploy time
3. **Composability** — the VPC outputs (`vpc.VpcId`, subnet IDs) are designed to feed into service composites like `FargateAlb`

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
