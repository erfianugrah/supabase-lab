# T27 - reach the second VPC's endpoint path over a TRANSIT GATEWAY instead
# of the peering connection built for T24 (vpc2.tf). The two transports are
# mutually exclusive by construction: the peering connection and its two
# routes there are additionally gated on `!var.enable_transit_gateway`, so
# turning this on tears peering down rather than adding a second path
# alongside it. Without that, a client in the second VPC could reach the
# endpoint over EITHER transport and T27 would have no way to attribute a
# reachable result to the transit gateway specifically - see
# tests/t27-transit-gateway.ts for the independent transport check that
# backs this up again at test time (it does not just trust the tofu toggle).
#
# The PHZ association (aws_route53_zone_association.db_second) and the
# endpoint security-group rule for the second VPC's CIDR
# (aws_security_group_rule.endpoint_from_second), both in vpc2.tf, are
# per-VPC and per-CIDR respectively - neither cares which transport carries
# the packets, so both are reused here unmodified rather than duplicated.
#
# Off by default (enable_transit_gateway) - a second, billed network surface;
# opt in alongside enable_second_vpc for a live spin that will run T27.
resource "aws_ec2_transit_gateway" "lab" {
  count = var.enable_transit_gateway ? 1 : 0

  description                     = "supabase-lab T27 transit gateway"
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"

  tags = { Name = "supabase-lab-tgw" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "lab" {
  count = var.enable_transit_gateway ? 1 : 0

  transit_gateway_id = aws_ec2_transit_gateway.lab[0].id
  vpc_id             = aws_vpc.lab.id
  subnet_ids         = aws_subnet.private[*].id

  tags = { Name = "supabase-lab-tgw-lab" }
}

# A transit gateway with only one VPC attached routes nowhere, so this (and
# the routes below) additionally gate on enable_second_vpc rather than
# assuming it is already on.
resource "aws_ec2_transit_gateway_vpc_attachment" "second" {
  count = var.enable_transit_gateway && var.enable_second_vpc ? 1 : 0

  transit_gateway_id = aws_ec2_transit_gateway.lab[0].id
  vpc_id             = aws_vpc.second[0].id
  subnet_ids         = [aws_subnet.second_private[0].id]

  tags = { Name = "supabase-lab-tgw-second" }
}

resource "aws_route" "lab_to_second_via_tgw" {
  count = var.enable_transit_gateway && var.enable_second_vpc ? 1 : 0

  route_table_id         = aws_route_table.private.id
  destination_cidr_block = aws_vpc.second[0].cidr_block
  transit_gateway_id     = aws_ec2_transit_gateway.lab[0].id

  depends_on = [aws_ec2_transit_gateway_vpc_attachment.lab]
}

resource "aws_route" "second_to_lab_via_tgw" {
  count = var.enable_transit_gateway && var.enable_second_vpc ? 1 : 0

  route_table_id         = aws_route_table.second_private[0].id
  destination_cidr_block = aws_vpc.lab.cidr_block
  transit_gateway_id     = aws_ec2_transit_gateway.lab[0].id

  depends_on = [aws_ec2_transit_gateway_vpc_attachment.second]
}
