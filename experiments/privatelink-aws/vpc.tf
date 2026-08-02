data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "lab" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  # Opt-in only. The default lab shape stays IPv4 so every other measurement
  # is taken against the same network; set enable_ipv6 to answer the
  # "IPv6-first VPC" question, which needs dualstack subnets to even attempt
  # a dualstack endpoint.
  assign_generated_ipv6_cidr_block = var.enable_ipv6

  tags = { Name = "supabase-lab" }
}

# Public subnet exists only to host the NAT gateway.
resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.lab.id
  cidr_block        = "10.42.0.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = { Name = "supabase-lab-public" }
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.lab.id
  cidr_block        = "10.42.${count.index + 1}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  ipv6_cidr_block = var.enable_ipv6 ? cidrsubnet(aws_vpc.lab.ipv6_cidr_block, 8, count.index + 1) : null
  # Required before an endpoint in this subnet can take a dualstack address.
  assign_ipv6_address_on_creation = var.enable_ipv6

  tags = { Name = "supabase-lab-private-${count.index + 1}" }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "supabase-lab" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "supabase-lab-nat" }
}

# NAT gateway: the biggest hourly cost in this lab (~$0.062/hr + data).
# It exists so the runner can reach the Management API (api.supabase.com) -
# which is exactly the egress a migration runner needs for
# `supabase link`. Destroy the same day you apply.
resource "aws_nat_gateway" "lab" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "supabase-lab" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.lab.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.lab.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.lab.id
  }
}

resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
