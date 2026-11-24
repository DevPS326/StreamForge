# Estimated monthly AWS costs

Illustrative us-east-1 on-demand Linux/x86 estimate as of 19 November 2026. The workload assumes 730 hours each for an API with 0.5 vCPU / 1 GB and a worker with 2 vCPU / 4 GB, 100 GB of originals and derived media, 200 GB of viewer transfer, and 1 million HTTPS CDN requests. This is a model, not a measured bill.

| Cost item                                                                             |            Estimate |
| ------------------------------------------------------------------------------------- | ------------------: |
| Fargate compute and RAM at $0.04048/vCPU-hour and $0.004445/GB-hour                   |              $90.10 |
| Public ALB at $0.0225/hour and 50 LCU-hours at $0.008                                 |              $16.83 |
| S3 Standard at $0.023/GB-month for 100 GB                                             |               $2.30 |
| S3 operations, assuming 20,000 PUT and 200,000 GET requests                           |               $0.18 |
| CloudFront, conservative $0.085/GB and $0.01 per 10,000 requests before any allowance |              $18.00 |
| Four Secrets Manager secrets and modest SQS/CloudWatch/ECR use                        |            about $7 |
| Existing or separate single-AZ PostgreSQL allocation including storage                |      budget $20–$40 |
| **Subtotal before network egress infrastructure**                                     | **about $155–$175** |

A dedicated single public NAT gateway can add roughly $33/month before per-GB and public IPv4 costs. Equivalent VPC endpoints have their own hourly costs. Add DNS, public IPv4 addresses, data transfer outside the stated footprint, taxes, and Vercel plan charges based on the actual deployment. [AWS Fargate and ALB pricing example](https://docs.aws.amazon.com/solutions/latest/prebid-server-deployment-on-aws/cost1.html) · [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) · [RDS for PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/) · [AWS VPC pricing](https://aws.amazon.com/vpc/pricing/)

Terraform initializes application desired counts to zero, limits steady-state replica configuration, keeps logs for 14 days, and sets a monthly AWS Budget with notifications. The budget is an alert threshold. Original retention and CDN egress dominate as the library and audience grow. Use owner deletion, the storage quota, and incomplete multipart lifecycle cleanup to limit unnecessary storage.
