terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Application = var.name }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  worker_health = "node -e \"fetch('http://127.0.0.1:3011/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""
}
