variable "region" {
  description = "Home region for regional resources (S3 today; API/Lambda/DynamoDB in step 3)."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Environment name, used in resource names and tags."
  type        = string
  default     = "prod"
}

variable "domain_name" {
  description = "Custom domain (e.g. play.example.com). Leave empty to use the *.cloudfront.net domain."
  type        = string
  default     = ""
}

variable "hosted_zone_name" {
  description = "Existing Route 53 public hosted zone that contains domain_name (e.g. example.com). Required when domain_name is set."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || var.hosted_zone_name != ""
    error_message = "hosted_zone_name is required when domain_name is set."
  }
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 = NA + Europe edges (cheapest)."
  type        = string
  default     = "PriceClass_100"
}

variable "muse_secret_name" {
  description = "Existing Secrets Manager secret holding the Muse API key. Terraform reads only its ARN, never the value."
  type        = string
  default     = "where-are-we-going/muse-api-key"
}

variable "muse_model" {
  description = "Muse model id passed to Lambda as MUSE_MODEL."
  type        = string
  default     = "muse-spark-1.1"
}

variable "muse_daily_call_limit" {
  description = "Global cap on Muse HTTP calls per UTC day (includes retries). Over the cap, the API returns 429."
  type        = number
  default     = 500
}

variable "round_drafts_per_day" {
  description = "Partner-round drafts each couple may generate per UTC day."
  type        = number
  default     = 10
}

variable "generator_schedule" {
  description = "EventBridge Scheduler expression (UTC) for the daily clue generator."
  type        = string
  default     = "cron(0 3 * * ? *)"
}
