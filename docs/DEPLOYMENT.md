# Deployment and rollback

## Prerequisites

- An AWS account with permission to deploy the Terraform resources and a separate GitHub OIDC role that can publish to three ECR repositories.
- A VPC with two public subnets in distinct Availability Zones and private Fargate subnets with HTTPS egress through NAT or the required AWS VPC endpoints. The database must be reachable on 5432 from the private subnets.
- PostgreSQL 16 with encryption, backups, a migration login that owns the application schema, and a runtime login with read/write access to that schema and its tables. Grant default privileges from the migration role to the runtime role for newly created tables and sequences.
- A Route 53 zone, an issued regional ACM certificate for `api.example.com`, and a Vercel custom domain on the same site such as `app.example.com`.
- Four Secrets Manager secrets with plain SecretString values. Supply the runtime and migration PostgreSQL URLs, a random signing secret of at least 32 characters, and the CloudFront private PEM. Keep their ARNs in Terraform variables and pass the matching public PEM separately.

Create the CloudFront RSA signing key with OpenSSL and store the private file in Secrets Manager.

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out cloudfront-private.pem
openssl pkey -in cloudfront-private.pem -pubout -out cloudfront-public.pem
openssl rand -hex 32
```

Use Secrets Manager’s default encryption key or grant the task execution role KMS decrypt permission for your customer-managed key. Keep persistent Terraform state in a restricted encrypted backend with locking before applying shared infrastructure.

## Build and provision

Build the local artifacts with `docker compose --profile app build migrate api worker`. The images run as an unprivileged user. The worker image builds the signed FFmpeg release in a dedicated build stage. Run the service integration suite and scan the exact image digests for critical and high vulnerabilities before publishing.

Create immutable-tag ECR repositories `streamforge-api`, `streamforge-worker`, and `streamforge-migrate`. Configure the GitHub Actions production environment with `AWS_REGION`, `AWS_IMAGE_PUBLISH_ROLE_ARN`, and `ECR_REPOSITORY_PREFIX=streamforge`. Run **Publish container images** on a reviewed commit and copy the three digest references from its job summaries.

```sh
cd infrastructure/aws
cp values.example.tfvars terraform.tfvars
terraform init
terraform validate
terraform plan -out=.terraform.tfplan
terraform apply .terraform.tfplan
```

Populate `terraform.tfvars` before planning. Keep both desired counts at zero for the first apply. The public ALB and related resources can accrue charges even while task counts are zero.

Run and check the one-off migration task.

```sh
cluster=$(terraform output -raw ecs_cluster)
task=$(aws ecs run-task --cluster "$cluster" --launch-type FARGATE \
  --task-definition "$(terraform output -raw migration_definition)" \
  --network-configuration "$(terraform output -raw migration_network_configuration)" \
  --query 'tasks[0].taskArn' --output text)
test "$task" != "None" && test -n "$task"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
test "$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)" = "0"
```

Set the API and worker desired counts to one and apply the new reviewed plan. Wait for healthy ECS tasks, then check `https://api.example.com/health/ready`.

Connect the repository to Vercel with project Root Directory `apps/web` and access to files outside the root enabled. Set the Node.js runtime to 22.x, `NEXT_PUBLIC_API_ORIGIN=https://api.example.com`, and attach `app.example.com`. If you customize `MAX_UPLOAD_BYTES` at the API, set the matching byte limit in `NEXT_PUBLIC_MAX_UPLOAD_BYTES` at build time. Test against the real custom frontend domain so the API cookie remains same-site. Smoke-test upload, seeking, quality selection, share revocation, deletion, and anonymous S3 or CDN denial before publishing the URL.

## Rollback and operations

- Restore the previous API and worker digests in Terraform and apply. Roll back the Vercel project to the corresponding release.
- Apply compatible schema expansions before releasing new code. For incompatible changes, stage an expand-and-contract migration over multiple releases. Reverting a container does not change the database schema.
- Monitor structured service logs and the SQS DLQ through AWS. Investigate a failed source or deployment before replaying any quarantined job. User-facing statuses remain in the library.
- Plan provider and image upgrades separately and verify the signed playback path with real AWS credentials after each change. Terraform validation can run without an AWS account. An AWS plan and deployment require real resource IDs and authorization.
