# Deploying Voice Lab (Malaysia region)

The owner chose hosting in a Malaysian region (2026-10-10), so recordings and debtor data stay in the country. This page
compares the clouds that can do that, recommends one, and lists every step to run Voice Lab there. Nothing on this page
has been run yet: it is the plan for step 2 of the live Twilio test (call events reaching us).

## Which cloud (checked 2026-10-10)

| Cloud | Malaysian region | Containers there | Managed PostgreSQL there | Verdict |
| --- | --- | --- | --- | --- |
| AWS | Asia Pacific (Malaysia), `ap-southeast-5`, open since August 2024, three availability zones | ECS on Fargate: listed for `ap-southeast-5` in AWS's Fargate region table | RDS for PostgreSQL: instance types announced for the region (Dec 2024, May 2025); Multi-AZ clusters listed | **Recommended**: everything Voice Lab needs is confirmed in-country |
| Azure | Malaysia West, generally available since 28 May 2025, three availability zones | Not confirmed per service | Not confirmed (no source found for Azure Database for PostgreSQL in Malaysia West) | Possible later; check "products available by region" first |
| Google Cloud | Announced (2022), ground broken (2024); no evidence it is open | — | — | Not an option yet |

App Runner availability in `ap-southeast-5` is unconfirmed, so the plan uses ECS on Fargate. Check the AWS
"Services by Region" page before starting, in case anything has changed. Prices are not quoted here (CLAUDE.md: read
current pricing, never hardcode it); use the AWS pricing calculator for `ap-southeast-5`.

Sources: [AWS Malaysia region launch](https://aws.amazon.com/blogs/aws/now-open-aws-asia-pacific-malaysia-region/),
[Fargate regions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate-Regions.html),
[RDS instances in Malaysia](https://aws.amazon.com/about-aws/whats-new/2024/12/amazon-rds-postgresql-mysql-mariadb-instances-malaysia/),
[Azure Malaysia West](https://www.azurespeed.com/Information/AzureRegions/MalaysiaWest).

## What runs where (AWS, `ap-southeast-5`)

- **App**: the repository's `Dockerfile` image, pushed to ECR, run as an ECS Fargate service (two tasks, in two
  availability zones). It serves the API, the webhooks and the console at `/admin/`.
- **Database**: RDS for PostgreSQL 16, Multi-AZ, encrypted, automated backups kept in the region. The app connects as
  the owner role; per-request roles (`voicelab_internal`, `voicelab_client`) are created by the first migration.
- **Public address**: an Application Load Balancer with an ACM certificate for a domain you own (for example
  `voice.example.my`). This is `PUBLIC_BASE_URL`; Twilio and Telnyx send call events to it. HTTPS only.
- **Secrets**: AWS Secrets Manager holds `VOICELAB_SECRET_KEY` and `DATABASE_URL`, injected into the task. Provider
  credentials stay encrypted in the database (never in environment variables on the server).
- **Logs**: CloudWatch Logs in the region. The app never logs phone numbers, secrets or provider error text unscrubbed.
- **Scheduled jobs**: EventBridge Scheduler calls the app's internal endpoints with a staff token kept in Secrets
  Manager (see the schedule below). Nothing in the app runs them by itself.

## Settings

| Setting | Where | Value |
| --- | --- | --- |
| `DATABASE_URL` | Secrets Manager | The RDS connection string (TLS on) |
| `VOICELAB_SECRET_KEY` | Secrets Manager | `openssl rand -base64 32`. Keep an offline copy: losing it makes stored provider credentials unreadable |
| `PUBLIC_BASE_URL` | Task environment | `https://voice.example.my` (no trailing slash) |
| `PORT` | Task environment | `3000` (the load balancer forwards to it) |
| `RECONCILE_TOLERANCE_PCT` | Task environment | `2` |

## Scheduled jobs

Each is a `POST` to the app with the scheduler's staff token. Suggested cadence; adjust once real traffic is seen.

| Job | Endpoint | Every |
| --- | --- | --- |
| Place due case callbacks | `/internal/cases/dispatch` | 1 minute |
| Give up waiting callers | `/internal/queue/expire` | 1 minute |
| Flag dropped calls | `/internal/faults/sweep` | 5 minutes |
| Abandon stalled workflow runs | `/internal/workflow-runs/sweep` | 15 minutes |
| Reconcile call costs with providers | `/internal/reconcile/run` | 1 hour |
| Learning loop (audio, drift) | `/internal/learning/sweep` | 1 hour |
| Payment checks, per client | `/internal/tenants/:id/cases/check-payments` | 1 hour |
| Case ageing, per client | `/internal/tenants/:id/cases/sweep-ageing` | daily |
| Appointment reminders, per client | `/internal/tenants/:id/appointments/sweep-reminders` | 15 minutes |
| Extra channel charges, per client | `/internal/tenants/:id/channel-charges` | monthly |

## Steps

1. **Account**: an AWS account with `ap-southeast-5` enabled (it is an opt-in region), billing alerts on.
2. **Network**: a VPC in `ap-southeast-5` with public subnets (load balancer) and private subnets (tasks, database) in
   two availability zones.
3. **Database**: create the RDS PostgreSQL 16 instance (Multi-AZ, encrypted, deletion protection on).
4. **Image**: build the `Dockerfile` and push it to ECR in `ap-southeast-5`.
5. **Secrets**: store `DATABASE_URL` and `VOICELAB_SECRET_KEY` in Secrets Manager.
6. **Migrate and bootstrap**: run one task with `npm run migrate`, then `npm run bootstrap` for the first admin (as
   `scripts/setup.sh` does locally).
7. **Service**: create the ECS service (two tasks) behind the load balancer; health check `GET /health`.
8. **Domain**: point the domain at the load balancer; issue the ACM certificate; set `PUBLIC_BASE_URL`.
9. **Scheduler**: create the scheduled jobs above.
10. **Twilio, step 2 of the live test**: add the Twilio provider in the console (credentials are checked on save), add a
    Twilio number, set its voice webhook to Voice Lab, declare the do-not-call position for Malaysia, add rates and the
    FX rate, then place one outbound test call from the console to a phone you hold. Proven when the call's events
    arrive signed, the call is priced once, and reconciliation matches Twilio's own figure.

## Decisions this needs from the owner

- Cloud: AWS `ap-southeast-5` (recommended) or wait for Azure Malaysia West to be confirmed for PostgreSQL.
- Who owns the AWS account and the domain.
- Backup retention and who may restore.
