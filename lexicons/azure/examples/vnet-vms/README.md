# VNet + VMs

A Chant Azure example that provisions a full network layer and a Linux VM, using `VnetDefault` and `VmLinux` composites together.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 7 ARM resources:

- **Virtual Network** — `10.0.0.0/16` address space with two subnets
- **Subnet 1** — `10.0.1.0/24`, associated with NSG and Route Table
- **Subnet 2** — `10.0.2.0/24`, associated with NSG and Route Table
- **VNet NSG** — Network Security Group for subnet-level traffic control
- **Route Table** — UDR table attached to both subnets
- **VM NSG** — Network Security Group with SSH (port 22) inbound rule
- **NIC** — Network Interface placed in subnet-1
- **Virtual Machine** — Ubuntu 22.04 LTS Linux VM with SSH key auth

## Project Structure

```
src/
├── main.ts       # VnetDefault + VmLinux composite instantiation
└── tags.ts       # Project-wide default tags
```

## Patterns Demonstrated

1. **Composite composition** — `VnetDefault` creates the network layer, `VmLinux` adds a VM that references a subnet
2. **Cross-resource references** — `ResourceId` intrinsic links the VM's NIC to the VNet subnet
3. **Pseudo-parameters** — `Azure.ResourceGroupLocation` ensures all resources deploy to the same region
