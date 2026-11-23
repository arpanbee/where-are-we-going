terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
  # Partial config: `terraform init -backend-config=backend.hcl`
  # (bucket comes from the bootstrap stack's `backend_hcl` output).
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "where-are-we-going", ManagedBy = "terraform", Env = var.env }
  }
}

# CloudFront only accepts ACM certificates from us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { Project = "where-are-we-going", ManagedBy = "terraform", Env = var.env }
  }
}
