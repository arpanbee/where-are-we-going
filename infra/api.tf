# Backend: DynamoDB single table, two Lambdas (HTTP API + daily clue generator),
# HTTP API behind CloudFront at /api/*, and an EventBridge schedule.

# --- Data ---------------------------------------------------------------------

resource "aws_dynamodb_table" "main" {
  name                        = local.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = true

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "ttl" # rate-limit counters expire on their own
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

# Existing secret, created outside Terraform. This data source reads metadata
# (ARN) only, so the key never enters Terraform state.
data "aws_secretsmanager_secret" "muse" {
  name = var.muse_secret_name
}

# --- Lambda code --------------------------------------------------------------
# One bundle for both functions. The AWS SDK v3 ships with the Node 22 runtime,
# so node_modules (dev-only, for local scripts) is excluded.

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../api"
  output_path = "${path.module}/.build/api.zip"
  excludes    = ["node_modules", "node_modules/**", "test", "test/**", "package-lock.json"]
}

locals {
  lambda_env = {
    TABLE_NAME            = aws_dynamodb_table.main.name
    MUSE_SECRET_ID        = data.aws_secretsmanager_secret.muse.arn
    MUSE_MODEL            = var.muse_model
    MUSE_DAILY_CALL_LIMIT = tostring(var.muse_daily_call_limit)
    ROUND_DRAFTS_PER_DAY  = tostring(var.round_drafts_per_day)
  }
  fn_api       = "${local.name}-api"
  fn_generator = "${local.name}-generate-daily"
}

# --- IAM ----------------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  name = "${local.name}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "app"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Table"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
        ]
        Resource = aws_dynamodb_table.main.arn
      },
      {
        Sid      = "MuseKey"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = data.aws_secretsmanager_secret.muse.arn
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = [for g in aws_cloudwatch_log_group.fn : "${g.arn}:*"]
      },
    ]
  })
}

# --- Functions ----------------------------------------------------------------

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = toset([local.fn_api, local.fn_generator])
  name              = "/aws/lambda/${each.key}"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name    = local.fn_api
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "handlers/api.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 256
  timeout          = 29 # API Gateway's integration limit is 30 s
  environment {
    variables = local.lambda_env
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.lambda]
}

resource "aws_lambda_function" "generator" {
  function_name    = local.fn_generator
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "handlers/generate-daily.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 256
  timeout          = 600 # up to 7 puzzles x 2 attempts x 20 s, plus headroom
  environment {
    variables = local.lambda_env
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.lambda]
}

# Scheduler invokes asynchronously; one Lambda retry is enough (the next daily
# run fills any remaining gaps, and every attempt costs Muse calls).
resource "aws_lambda_function_event_invoke_config" "generator" {
  function_name          = aws_lambda_function.generator.function_name
  maximum_retry_attempts = 1
}

# --- HTTP API -----------------------------------------------------------------

resource "aws_apigatewayv2_api" "api" {
  name          = local.name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# --- Daily schedule -----------------------------------------------------------

resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke-generator"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = [aws_lambda_function.generator.arn, "${aws_lambda_function.generator.arn}:*"]
    }]
  })
}

resource "aws_scheduler_schedule" "generator" {
  name                         = "${local.name}-generate-daily"
  schedule_expression          = var.generator_schedule
  schedule_expression_timezone = "UTC"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.generator.arn
    role_arn = aws_iam_role.scheduler.arn
    retry_policy {
      maximum_retry_attempts = 2 # retries failed invokes (throttling), not function errors
    }
  }
}
