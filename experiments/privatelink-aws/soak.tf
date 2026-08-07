# T29 - the PgBouncer soak, built as INFRASTRUCTURE. The read side lives in
# tests/t29-soak-read.ts, which does NOT run this - it only reads what
# accumulates here. An EventBridge Scheduler schedule invokes the EXISTING
# probe Lambda (lambda.tf) every 5 minutes with {"mode":"soak"}; the Lambda
# (lambda/index.mjs) writes one JSON record per invocation into the suite
# bucket suite.sh already creates (supabase-lab-suite-<account>) under
# soak/ - reusing that bucket rather than standing up a second one.
#
# Off by default (enable_soak) - the schedule racks up Lambda invocations and
# small S3 PUT costs for as long as it runs; opt in for a live spin, then run
# T29 against the accumulated records.
resource "aws_scheduler_schedule" "soak" {
  count = var.enable_soak && var.enable_lambda ? 1 : 0

  name                = "supabase-lab-soak"
  schedule_expression = "rate(5 minutes)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.probe[0].arn
    role_arn = aws_iam_role.soak_scheduler[0].arn
    input    = jsonencode({ mode = "soak" })
  }
}

data "aws_iam_policy_document" "soak_scheduler_assume" {
  count = var.enable_soak ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "soak_scheduler" {
  count = var.enable_soak ? 1 : 0

  name               = "supabase-lab-soak-scheduler"
  assume_role_policy = data.aws_iam_policy_document.soak_scheduler_assume[0].json
}

resource "aws_iam_role_policy" "soak_scheduler_invoke" {
  count = var.enable_soak && var.enable_lambda ? 1 : 0

  role = aws_iam_role.soak_scheduler[0].name
  name = "invoke-probe"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.probe[0].arn
    }]
  })
}

# The Lambda's own execution role needs S3 write for its soak records - same
# bucket as the runner's suite-artifacts policy in runner.tf, just a
# dedicated prefix so the two write paths cannot collide.
resource "aws_iam_role_policy" "lambda_soak_write" {
  count = var.enable_soak && var.enable_lambda ? 1 : 0

  role = aws_iam_role.lambda[0].name
  name = "soak-write"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = "arn:aws:s3:::supabase-lab-suite-${var.aws_account_id}/soak/*"
    }]
  })
}
