# Where the VM runs, and its security group.
#
# Three placements: an existing subnet (subnet_id), a default subnet of the default VPC (use_default_vpc), or, by
# default, a minimal VPC of its own: one public subnet, an internet gateway and a default route. The zone is the first
# (by name) that offers instance_type, unless availability_zone names one.
#
# Ingress: the runner port, and RDP when enable_rdp, each from allowed_cidrs only (variables.tf refuses the internet).
# Egress: HTTPS and HTTP, which is what SSM, Secrets Manager, the runner download and Windows Update need. Amazon DNS,
# NTP and Windows activation use link-local addresses that security groups don't filter.

locals {
  use_given_subnet = var.subnet_id != null
  use_default_vpc  = !local.use_given_subnet && var.use_default_vpc
  create_vpc       = !local.use_given_subnet && !var.use_default_vpc

  offered_zones = sort(data.aws_ec2_instance_type_offerings.this.locations)
  zone          = coalesce(var.availability_zone, try(local.offered_zones[0], null))

  vpc_id = (
    local.use_given_subnet ? data.aws_subnet.given[0].vpc_id :
    local.use_default_vpc ? data.aws_vpc.default[0].id :
    aws_vpc.this[0].id
  )
  subnet_id = (
    local.use_given_subnet ? var.subnet_id :
    local.use_default_vpc ? try(sort(data.aws_subnets.default[0].ids)[0], null) :
    aws_subnet.public[0].id
  )

  ingress_ports = merge(
    { runner = var.runner_port },
    var.enable_rdp ? { rdp = 3389 } : {},
  )
  # One rule per port and CIDR, keyed "<port name> <cidr>" (both known at plan).
  ingress = merge([
    for name, port in local.ingress_ports : {
      for cidr in var.allowed_cidrs : "${name} ${cidr}" => { port = port, cidr = cidr }
    }
  ]...)
}

data "aws_ec2_instance_type_offerings" "this" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

data "aws_subnet" "given" {
  count = local.use_given_subnet ? 1 : 0

  id = var.subnet_id
}

data "aws_vpc" "default" {
  count = local.use_default_vpc ? 1 : 0

  default = true
}

data "aws_subnets" "default" {
  count = local.use_default_vpc ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
  filter {
    name   = "availability-zone"
    values = var.availability_zone != null ? [var.availability_zone] : local.offered_zones
  }
}

resource "aws_vpc" "this" {
  count = local.create_vpc ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = var.name })
}

# A new VPC's default security group lets its members talk to each other; nothing here uses it, so empty it.
resource "aws_default_security_group" "this" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id
  tags   = merge(local.tags, { Name = "${var.name}-default-unused" })
}

resource "aws_internet_gateway" "this" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id
  tags   = merge(local.tags, { Name = var.name })
}

resource "aws_subnet" "public" {
  count = local.create_vpc ? 1 : 0

  vpc_id            = aws_vpc.this[0].id
  cidr_block        = cidrsubnet(var.vpc_cidr, 1, 0)
  availability_zone = local.zone
  tags              = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table" "public" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id
  tags   = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "internet" {
  count = local.create_vpc ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this[0].id
}

resource "aws_route_table_association" "public" {
  count = local.create_vpc ? 1 : 0

  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-"
  description = "RPA desktop runner test bed: runner port and RDP from allowed CIDRs only"
  vpc_id      = local.vpc_id
  tags        = merge(local.tags, { Name = var.name })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "allowed" {
  for_each = local.ingress

  security_group_id = aws_security_group.this.id
  description       = each.value.port == 3389 ? "RDP" : "RPA desktop runner"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = strcontains(each.value.cidr, ":") ? null : each.value.cidr
  cidr_ipv6         = strcontains(each.value.cidr, ":") ? each.value.cidr : null
  tags              = local.tags
}

resource "aws_vpc_security_group_egress_rule" "web" {
  for_each = toset(["80", "443"])

  security_group_id = aws_security_group.this.id
  description       = "SSM, Secrets Manager, runner download, Windows Update"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = "0.0.0.0/0"
  tags              = local.tags
}
