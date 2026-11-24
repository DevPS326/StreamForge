variable "name" {
  type    = string
  default = "streamforge"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}$", var.name))
    error_message = "Use 3–20 lowercase letters, digits, or hyphens."
  }
}
variable "region" {
  type    = string
  default = "us-east-1"
}
variable "vpc_id" {
  type = string
}
variable "public_subnet_ids" {
  type = set(string)
}
variable "private_subnet_ids" {
  type = set(string)
}
variable "database_security_group_id" {
  type        = string
  description = "Security group of an existing PostgreSQL server in the deployment VPC."
}
variable "frontend_origin" {
  type        = string
  description = "HTTPS frontend origin without a trailing slash."
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9.-]+$", var.frontend_origin))
    error_message = "Enter the exact production HTTPS frontend origin."
  }
}
variable "api_hostname" {
  type = string
}
variable "route53_zone_id" {
  type = string
}
variable "api_certificate_arn" {
  type        = string
  description = "Issued regional ACM certificate for api_hostname."
}
variable "api_image" {
  type        = string
  description = "Immutable ECR image reference, preferably by digest."
}
variable "worker_image" {
  type = string
}
variable "migration_image" {
  type = string
}
variable "database_url_secret_arn" {
  type        = string
  description = "Secrets Manager SecretString containing the full runtime PostgreSQL URL."
}
variable "migration_database_url_secret_arn" {
  type        = string
  description = "Secrets Manager SecretString containing a PostgreSQL URL with migration privileges."
}
variable "media_token_secret_arn" {
  type        = string
  description = "Secrets Manager SecretString containing a randomly generated signing secret."
}
variable "cloudfront_public_key_pem" {
  type = string
}
variable "cloudfront_private_key_secret_arn" {
  type        = string
  description = "Secrets Manager SecretString containing the matching private signing key PEM."
}
variable "api_desired_count" {
  type    = number
  default = 0
  validation {
    condition     = contains([0, 1, 2], var.api_desired_count)
    error_message = "Choose 0–2 API tasks."
  }
}
variable "worker_desired_count" {
  type    = number
  default = 0
  validation {
    condition     = contains([0, 1, 2], var.worker_desired_count)
    error_message = "Choose 0–2 worker tasks."
  }
}
variable "monthly_budget_usd" {
  type    = number
  default = 100
}
variable "budget_email" {
  type        = string
  description = "Address for AWS budget threshold notifications."
}
