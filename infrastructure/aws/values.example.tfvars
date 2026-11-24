name                              = "streamforge"
region                            = "us-east-1"
vpc_id                            = "vpc-00000000000000000"
public_subnet_ids                 = ["subnet-00000000000000001", "subnet-00000000000000002"]
private_subnet_ids                = ["subnet-00000000000000003", "subnet-00000000000000004"]
database_security_group_id        = "sg-00000000000000000"
frontend_origin                   = "https://app.example.com"
api_hostname                      = "api.example.com"
route53_zone_id                   = "Z00000000000000000"
api_certificate_arn               = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
api_image                         = "123456789012.dkr.ecr.us-east-1.amazonaws.com/streamforge-api:replace"
worker_image                      = "123456789012.dkr.ecr.us-east-1.amazonaws.com/streamforge-worker:replace"
migration_image                   = "123456789012.dkr.ecr.us-east-1.amazonaws.com/streamforge-migrate:replace"
database_url_secret_arn           = "arn:aws:secretsmanager:us-east-1:123456789012:secret:streamforge/db-replace"
migration_database_url_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:streamforge/migration-replace"
media_token_secret_arn            = "arn:aws:secretsmanager:us-east-1:123456789012:secret:streamforge/token-replace"
cloudfront_private_key_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:streamforge/cloudfront-replace"
cloudfront_public_key_pem         = <<-PEM
-----BEGIN PUBLIC KEY-----
REPLACE WITH TRUSTED CLOUDFRONT PUBLIC KEY
-----END PUBLIC KEY-----
PEM
api_desired_count                 = 0
worker_desired_count              = 0
monthly_budget_usd                = 100
budget_email                      = "billing@example.com"
