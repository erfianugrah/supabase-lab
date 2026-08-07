# Optional test Lambda (var.enable_lambda = true). Build first: make lambda-zip.
# Stands in for a Lambda -> endpoint -> pooler path.

data "archive_file" "lambda" {
  count = var.enable_lambda ? 1 : 0

  type        = "zip"
  source_dir  = "${path.module}/lambda/dist"
  output_path = "${path.module}/lambda/function.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  count = var.enable_lambda ? 1 : 0

  name               = "supabase-lab-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  count = var.enable_lambda ? 1 : 0

  role       = aws_iam_role.lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Lambda auto-creates this log group on first invoke and tofu would never own
# it, so `make destroy` left it behind (run 6). Declaring it keeps teardown
# complete and bounds retention on a disposable lab.
resource "aws_cloudwatch_log_group" "lambda" {
  count = var.enable_lambda ? 1 : 0

  name              = "/aws/lambda/supabase-lab-probe"
  retention_in_days = 1
}

resource "aws_lambda_function" "probe" {
  count = var.enable_lambda ? 1 : 0

  function_name    = "supabase-lab-probe"
  role             = aws_iam_role.lambda[0].arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda[0].output_path
  depends_on       = [aws_cloudwatch_log_group.lambda]
  source_code_hash = data.archive_file.lambda[0].output_base64sha256
  timeout          = 30

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.runner.id]
  }

  environment {
    variables = {
      PGHOST     = local.phz
      PGUSER     = "postgres"
      PGDATABASE = "postgres"
      PGSSLMODE  = "require"
      # In-config on purpose: db_password is already in state via
      # supabase_project, so out-of-band `make lambda-secret` bought no
      # secrecy - and any later apply silently reverted the env to this
      # block, leaving the probe authenticating with no password (run 6).
      PGPASSWORD = var.db_password
    }
  }

  tags = { Name = "supabase-lab" }
}

# T24's probe Lambda, same code (same zip artifact) as the primary one above,
# placed inside the SECOND VPC instead of the lab VPC. No NAT in that VPC and
# none needed - this only opens an outbound TCP connection over the peering
# link, never to the public internet.
resource "aws_cloudwatch_log_group" "lambda_second_vpc" {
  count = var.enable_second_vpc && var.enable_lambda ? 1 : 0

  name              = "/aws/lambda/supabase-lab-probe-second-vpc"
  retention_in_days = 1
}

resource "aws_lambda_function" "probe_second_vpc" {
  count = var.enable_second_vpc && var.enable_lambda ? 1 : 0

  function_name    = "supabase-lab-probe-second-vpc"
  role             = aws_iam_role.lambda[0].arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda[0].output_path
  depends_on       = [aws_cloudwatch_log_group.lambda_second_vpc]
  source_code_hash = data.archive_file.lambda[0].output_base64sha256
  timeout          = 30

  vpc_config {
    subnet_ids         = [aws_subnet.second_private[0].id]
    security_group_ids = [aws_security_group.second[0].id]
  }

  environment {
    variables = {
      PGHOST     = local.phz
      PGUSER     = "postgres"
      PGDATABASE = "postgres"
      PGSSLMODE  = "require"
      PGPASSWORD = var.db_password
    }
  }

  tags = { Name = "supabase-lab-second-vpc" }
}
