# T24 - a second, peered VPC, built to answer one question: does a Resource
# endpoint stay reachable across a peering connection, or is it scoped to the
# VPC it was created in? Everything here is deliberately fully wired (routes
# both ways, an opened security-group rule, the PHZ associated with the peer
# too) so an unreachable result at test time rules out "something else was
# blocking it" and leaves only the endpoint's own per-VPC scoping as the
# explanation. Off by default (enable_second_vpc) - see vpc.tf for the lab
# VPC this peers with.

resource "aws_vpc" "second" {
  count = var.enable_second_vpc ? 1 : 0

  cidr_block           = "10.43.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "supabase-lab-second" }
}

resource "aws_subnet" "second_private" {
  count = var.enable_second_vpc ? 1 : 0

  vpc_id            = aws_vpc.second[0].id
  cidr_block        = "10.43.1.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = { Name = "supabase-lab-second-private" }
}

resource "aws_route_table" "second_private" {
  count = var.enable_second_vpc ? 1 : 0

  vpc_id = aws_vpc.second[0].id

  tags = { Name = "supabase-lab-second-private" }
}

resource "aws_route_table_association" "second_private" {
  count = var.enable_second_vpc ? 1 : 0

  subnet_id      = aws_subnet.second_private[0].id
  route_table_id = aws_route_table.second_private[0].id
}

# Same account, same region - auto_accept works with no manual step.
resource "aws_vpc_peering_connection" "second" {
  count = var.enable_second_vpc ? 1 : 0

  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.second[0].id
  auto_accept = true

  tags = { Name = "supabase-lab-peering" }
}

resource "aws_route" "lab_to_second" {
  count = var.enable_second_vpc ? 1 : 0

  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = aws_vpc.second[0].cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.second[0].id
}

resource "aws_route" "second_to_lab" {
  count = var.enable_second_vpc ? 1 : 0

  route_table_id            = aws_route_table.second_private[0].id
  destination_cidr_block    = aws_vpc.lab.cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.second[0].id
}

# Route53 private zones are per-VPC-association, same as the endpoint's own
# claimed scoping - associating this here is what lets T24 tell "resolves but
# unreachable" apart from "does not resolve at all" instead of conflating the
# two AWS mechanisms.
resource "aws_route53_zone_association" "db_second" {
  count = var.enable_second_vpc ? 1 : 0

  zone_id = aws_route53_zone.db.zone_id
  vpc_id  = aws_vpc.second[0].id
}

# Egress-only, mirrors aws_security_group.runner - this VPC has no NAT and
# needs none: the probe Lambda only makes an outbound TCP connection over the
# peering link, never to the public internet.
resource "aws_security_group" "second" {
  count = var.enable_second_vpc ? 1 : 0

  name        = "supabase-lab-second"
  description = "Egress-only: probe Lambda in the second VPC"
  vpc_id      = aws_vpc.second[0].id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "supabase-lab-second" }
}

# The endpoint SG must allow the peer VPC's CIDR too, or a firewall denial
# would be indistinguishable from the per-VPC scoping T24 actually tests.
# One rule per port, matching aws_security_group.endpoint's own two blocks.
resource "aws_security_group_rule" "endpoint_from_second" {
  for_each = var.enable_second_vpc ? toset(["5432", "6543"]) : toset([])

  type              = "ingress"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  protocol          = "tcp"
  cidr_blocks       = [aws_vpc.second[0].cidr_block]
  security_group_id = aws_security_group.endpoint.id
  description       = "Second VPC (T24) - full connectivity, so an unreachable result means the endpoints per-VPC scoping"
}
