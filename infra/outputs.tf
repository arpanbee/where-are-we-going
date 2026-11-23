output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_url" {
  value = "https://${local.use_domain ? var.domain_name : aws_cloudfront_distribution.site.domain_name}"
}

output "table_name" {
  value = aws_dynamodb_table.main.name
}

output "generator_function" {
  description = "Invoke manually: aws lambda invoke --function-name <this> /dev/stdout"
  value       = aws_lambda_function.generator.function_name
}

output "api_endpoint_direct" {
  description = "Raw API Gateway URL (for debugging). Players use <site_url>/api/*."
  value       = aws_apigatewayv2_api.api.api_endpoint
}
