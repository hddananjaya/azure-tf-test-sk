# Azure to AWS Migration Guide

General migration tips for moving workloads from Azure to **Amazon ECS** and **AWS Step Functions**.

## Service Mapping

| Azure | AWS | Notes |
|-------|-----|-------|
| Azure Container Instances (ACI) | ECS Fargate | Serverless containers, no cluster management |
| Azure Kubernetes Service (AKS) | ECS (EC2 or Fargate) or EKS | ECS is simpler; EKS if you need full Kubernetes |
| Azure App Service (containers) | ECS + ALB | App Service is PaaS; ECS gives more control |
| Azure Logic Apps | Step Functions | Visual/orchestrated workflows |
| Azure Durable Functions | Step Functions + Lambda | Stateful orchestration patterns |
| Azure Service Bus | SQS / SNS / EventBridge | Queue vs pub/sub vs event routing |
| Azure Key Vault | AWS Secrets Manager / SSM Parameter Store | Store secrets outside task definitions |
| Azure SQL Database / PostgreSQL / MySQL | Amazon RDS | Managed relational DB; engine-for-engine mapping |
| Azure AD / Microsoft Entra ID | Amazon Cognito User Pools (+ optional federation) | Workforce SSO; can federate Entra instead of replacing |
| Azure AD B2C | Amazon Cognito User Pools | Customer-facing sign-up/sign-in and social IdPs |
| Azure Monitor / App Insights | CloudWatch + X-Ray | Logs, metrics, traces |

---

## ECS Migration Tips

### 1. Container image registry

- Move images from **Azure Container Registry (ACR)** to **Amazon ECR**.
- Re-tag and push: `docker tag <acr-image> <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>`
- Use `aws ecr get-login-password` for authentication.
- Scan images in ECR and enable lifecycle policies to prune old tags.

### 2. Task definition vs Azure container config

Azure ACI uses a single JSON/YAML spec. ECS splits concerns:

- **Task definition** — CPU, memory, container image, env vars, secrets, logging
- **Service** — desired count, deployment strategy, load balancer attachment
- **Cluster** — logical grouping (Fargate clusters are lightweight)

Map ACI `resources.requests/limits` to ECS `cpu` and `memory` (Fargate has fixed combinations).

### 3. Networking

| Azure | AWS |
|-------|-----|
| Virtual Network (VNet) | VPC |
| Subnet | Subnet (public/private) |
| NSG | Security Group |
| Application Gateway | ALB / NLB |
| Private Endpoint | VPC endpoints (for ECR, S3, Secrets Manager) |

- Run ECS tasks in **private subnets**; place ALB in public subnets.
- Use **awsvpc** network mode (required for Fargate).
- Assign security groups at the task ENI level, not just the service.

### 4. Secrets and configuration

- Do **not** bake secrets into task definitions or environment variables in source control.
- Use **Secrets Manager** or **SSM Parameter Store** with `secrets` in the container definition.
- Map Azure App Configuration / Key Vault references to SSM paths or Secrets Manager ARNs.
- Use IAM task roles (not access keys) for AWS API access from containers.

### 5. Logging and monitoring

- Replace Azure Monitor / Log Analytics with **CloudWatch Logs**.
- Set `logConfiguration` in the task definition (`awslogs` driver).
- Create CloudWatch alarms on CPU, memory, and ALB target health.
- Enable **Container Insights** on the ECS cluster for deeper metrics.

### 6. Deployment strategy

- Azure Container Apps / App Service use slot swaps; ECS uses **rolling deployments** via services.
- Use **deployment circuit breaker** with rollback on failed deployments.
- For blue/green, use CodeDeploy or two services behind weighted ALB rules.
- Pin task definition revisions; avoid `:latest` image tags in production.

### 7. Autoscaling

- Azure scale rules → **ECS Service Auto Scaling** (target tracking on CPU/memory or custom CloudWatch metrics).
- For queue-driven workloads, scale on **SQS ApproximateNumberOfMessagesVisible**.
- Set `minCapacity` / `maxCapacity` and cooldown periods to avoid thrashing.

### 8. Common pitfalls

- Wrong CPU/memory combo for Fargate (must match [supported pairs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html)).
- Missing IAM permissions for ECR pull (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`).
- Tasks in private subnets without NAT Gateway or VPC endpoints (cannot reach ECR/CloudWatch).
- Health check path/port mismatch between container and ALB target group.

---

## Step Functions Migration Tips

### 1. Workflow mapping

| Azure | Step Functions |
|-------|----------------|
| Logic Apps (sequential) | Standard workflow, sequential states |
| Logic Apps (parallel branches) | `Parallel` state |
| Durable Functions (orchestrator) | Standard workflow with `Task` + `Choice` |
| Retry policies | `Retry` and `Catch` on individual states |
| Timers / delays | `Wait` state |

### 2. Choose workflow type

- **Standard** — long-running, exactly-once, up to 1 year. Best for orchestration migrated from Durable Functions.
- **Express** — high-volume, short-lived (< 5 min), at-least-once. Best for high-throughput event fan-out.

### 3. Replace Azure connectors

Logic App connectors map to Step Functions **Task** states invoking AWS services:

| Logic App connector | AWS equivalent |
|--------------------|----------------|
| HTTP / REST | Lambda, or `arn:aws:states:::http:invoke` (callback pattern) |
| Service Bus | SQS `SendMessage` / `ReceiveMessage` |
| Blob Storage | S3 `GetObject` / `PutObject` |
| SQL / Cosmos DB | Lambda proxy, or SDK integration where available |
| Send email | SES via Lambda or direct integration |

Prefer **AWS SDK service integrations** (`arn:aws:states:::sqs:sendMessage`) over Lambda wrappers when possible — fewer moving parts, built-in retries.

### 4. How Lambda params load

When a **Task** state invokes Lambda, Step Functions builds the payload **before** `Invoke` runs:

1. **`InputPath`** (optional) — slices the current state input (default: `$`, the whole object).
2. **`Parameters`** — maps that slice into the Lambda `Payload` using JSONPath and intrinsic functions.
3. **Lambda handler** — receives the payload as the `event` argument (Node: `exports.handler = async (event) => …`).

Example state:

```json
"ProcessOrder": {
  "Type": "Task",
  "Resource": "arn:aws:states:::lambda:invoke",
  "Parameters": {
    "FunctionName": "process-order",
    "Payload": {
      "orderId.$": "$.order.id",
      "customer.$": "$.customer"
    }
  },
  "ResultSelector": {
    "status.$": "$.Payload.status"
  },
  "ResultPath": "$.result",
  "Next": "Done"
}
```

With execution input `{ "order": { "id": "123" }, "customer": "alice" }`, Lambda's `event` is:

```json
{ "orderId": "123", "customer": "alice" }
```

After the task, **`ResultPath`** merges the Lambda response into state at `$.result` (here, only `status` via `ResultSelector`).

- Keys ending in `.$` pull values from the input; static keys pass literals.
- Without `Parameters.Payload`, the filtered input is sent as-is.
- **`OutputPath`** (default `$`) controls what the *next* state receives.

### 5. State machine design

- Keep states **small and idempotent** — Step Functions will retry on transient failures.
- Use **Choice** states instead of deeply nested conditionals.
- Pass data with `InputPath`, `OutputPath`, `ResultPath`, and `Parameters` — avoid huge payloads (256 KB state limit).
- Store large blobs in S3; pass only S3 keys/URIs in state input.

### 6. Error handling

```json
"Retry": [{
  "ErrorEquals": ["States.TaskFailed", "States.Timeout"],
  "IntervalSeconds": 2,
  "MaxAttempts": 3,
  "BackoffRate": 2.0
}],
"Catch": [{
  "ErrorEquals": ["States.ALL"],
  "Next": "HandleFailure",
  "ResultPath": "$.error"
}]
```

- Map Azure Logic App "run after" failure branches to `Catch` blocks.
- Use **Dead Letter Queues** (SQS DLQ) for tasks that must not be lost.

### 7. Long-running and human tasks

- Durable Functions `waitForExternalEvent` → Step Functions **callback pattern** (`.waitForTaskToken`).
- Human approval flows → `waitForTaskToken` + API Gateway endpoint that calls `SendTaskSuccess` / `SendTaskFailure`.
- Timers → `Wait` state with `Seconds`, `Timestamp`, or `SecondsPath`.

### 8. Observability

- Enable **CloudWatch Logs** on the state machine (ALL or ERROR level).
- Use **X-Ray** tracing for end-to-end visibility.
- Replace Application Insights dependency tracking with structured logging in Lambda tasks.
- Set CloudWatch alarms on `ExecutionsFailed`, `ExecutionsTimedOut`, and `ExecutionThrottled`.

### 9. Security

- Use **IAM roles** per state machine — least privilege for each integration.
- Encrypt state machine definitions and execution history if handling sensitive data.
- For cross-account workflows, use resource-based policies or separate state machines per account.

### 10. Common pitfalls

- Exceeding the **256 KB** execution input/output limit — offload to S3.
- Non-idempotent Lambda tasks combined with retries causing duplicate side effects.
- Using Express workflows for workflows that need exactly-once semantics.
- Forgetting to handle `States.Timeout` in `Catch` blocks.

---

## RDS Migration Tips

### 1. Engine mapping

| Azure | RDS engine |
|-------|------------|
| Azure SQL Database | RDS for SQL Server |
| Azure Database for PostgreSQL | RDS for PostgreSQL |
| Azure Database for MySQL | RDS for MySQL |
| Azure Database for MariaDB | RDS for MariaDB |

Match major version, collation, and timezone settings before cutover.

### 2. Migration approaches

| Approach | Best for |
|----------|----------|
| **AWS DMS** (Database Migration Service) | Ongoing replication with minimal downtime |
| **Native backup/restore** (`.bak`, `pg_dump`, `mysqldump`) | Smaller DBs or one-time bulk move |
| **RDS snapshot + share/copy** | Same-engine moves already on AWS |

Typical flow: provision RDS → replicate or restore → validate row counts and app queries → cutover DNS/connection string → keep Azure read-only until soak period ends.

### 3. Networking and access from ECS

- Place RDS in **private subnets**; do not assign a public IP in production.
- Security group: allow inbound **only** from the ECS task security group on the DB port (1433, 5432, 3306, etc.).
- Use a **DB subnet group** spanning at least two AZs for Multi-AZ.
- Optional: **RDS Proxy** in front of RDS for connection pooling from many Fargate tasks.

### 4. Credentials and connection strings

- Store host, port, database name, username, and password in **Secrets Manager** (not task env vars in git).
- Reference the secret in the ECS task definition `secrets` block; apps read `DATABASE_URL` or individual vars at startup.
- Rotate credentials with Secrets Manager rotation; update ECS tasks to pick up new values on redeploy.

Example task definition secret reference:

```json
"secrets": [{
  "name": "DATABASE_URL",
  "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:prod/rds/app:DATABASE_URL::"
}]
```

### 5. Operations checklist

- Enable **automated backups** and set `backup-retention` to match your RPO.
- Turn on **Multi-AZ** for production failover.
- Add **read replicas** if Azure used geo/read scaling (Cosmos-style patterns stay on DynamoDB; standard SQL read scale maps to replicas).
- Monitor with **CloudWatch** (`CPUUtilization`, `FreeStorageSpace`, `DatabaseConnections`) and enable **Enhanced Monitoring** / Performance Insights for slow-query tuning.
- Test failover and restore from snapshot before decommissioning Azure.

### 6. Common pitfalls

- ECS tasks in private subnets with no route to RDS (wrong SG or subnet group).
- Hard-coded Azure connection strings left in container images or Step Functions payloads.
- Engine version or charset mismatch causing silent data truncation after import.
- Undersized storage/IOPS — RDS storage autoscaling helps, but plan baseline IOPS up front.

---

## Cognito Migration Tips

### 1. What maps where

| Azure | Cognito |
|-------|---------|
| App registration (client ID / secret) | **User pool app client** |
| Tenant ID / authority URL | **User pool ID** + issuer `https://cognito-idp.<region>.amazonaws.com/<poolId>` |
| Redirect URIs / logout URLs | App client callback/sign-out URLs |
| API permissions / scopes | **Resource server** + custom scopes (e.g. `api/read`) |
| App roles / group claims | **Cognito groups** (included in ID/access token via `cognito:groups`) |
| Conditional Access / MFA | User pool **MFA**, advanced security, WAF on ALB |
| B2C user flows (sign-up, reset password) | Hosted UI + **Lambda triggers** (`PreSignUp`, `CustomMessage`, etc.) |
| MSAL (`acquireTokenSilent`) | Amplify Auth, `aws-jwt-verify`, or OIDC library against Cognito/OIDC |

**Two patterns:**

- **Replace** — users live in Cognito; migrate passwords via bulk import or reset-on-first-login.
- **Federate** — keep Entra as IdP; Cognito (or ALB/API Gateway) trusts Entra via **SAML/OIDC**. Lower cutover risk for enterprise SSO.

### 2. ECS + ALB (common web app pattern)

Protect an ECS service behind ALB with Cognito **before** traffic hits your containers:

1. Create a **User pool** + app client (authorization code + PKCE for SPAs).
2. Create an **ALB listener rule** with action **Authenticate Cognito** → then forward to target group.
3. ALB sets session cookies; your app receives `X-Amzn-Oidc-*` headers (identity token claims).

Containers can trust ALB-injected headers **only** if traffic cannot bypass the ALB (no direct task IP access).

### 3. API / microservices (JWT validation)

For APIs on ECS, API Gateway, or Lambda:

- Issue **access tokens** (JWT) from Cognito with audience = app client or custom resource-server scope.
- Validate in middleware with **`aws-jwt-verify`** (Node) or equivalent — check `iss`, `aud`, `exp`, and required scopes/groups.
- Do **not** parse JWTs without signature verification; do not trust client-sent user IDs without token validation.

Example env vars on ECS (non-secret):

```json
"environment": [
  { "name": "COGNITO_REGION", "value": "us-east-1" },
  { "name": "COGNITO_USER_POOL_ID", "value": "us-east-1_AbCdEfGhI" },
  { "name": "COGNITO_APP_CLIENT_ID", "value": "1a2b3c4d5e6f7g8h9i0j" }
]
```

Store app client **secret** (if used) in Secrets Manager; prefer **public clients + PKCE** for browser/mobile apps.

### 4. User and group migration

| Method | When to use |
|--------|-------------|
| **CSV bulk import** | One-time move; passwords must be re-set unless importing hash (limited formats) |
| **Federation to Entra** | Keep Azure passwords/MFA during transition |
| **Just-in-time (JIT)** | `PreAuthentication` / `PostAuthentication` Lambda creates local user on first SSO login |
| **Dual login period** | Entra + Cognito both accepted; deprecate Azure app registration after soak |

Map Azure **security groups / app roles** to Cognito **groups**, then to IAM policies (Identity Pool) or app-level RBAC from `cognito:groups` claims.

### 5. Cognito Identity Pools (optional)

Use when apps need **AWS credentials** in the browser or on device (S3 upload, direct AWS API):

- **User pool** = who the user is (authentication).
- **Identity pool** = temporary AWS creds (authorization to AWS resources).

Map Azure “managed identity for workloads” separately: ECS tasks use **IAM task roles**, not Identity Pools.

### 6. Lambda triggers (B2C parity)

Replace B2C custom policies with User Pool Lambda triggers:

| Trigger | Typical use |
|---------|-------------|
| `PreSignUp` | Auto-confirm, block disposable domains, sync to CRM |
| `PostConfirmation` | Seed RDS profile row, send welcome event to EventBridge |
| `PreTokenGeneration` | Inject custom claims (tenant ID, subscription tier) |
| `CustomMessage` | Branded email/SMS for verification and reset |
| `UserMigration` | Authenticate against legacy Azure DB on first login |

Keep triggers **idempotent** and fast — they run on every sign-in or token issue.

### 7. Step Functions and machine-to-machine

- **Human steps** — user JWT from Cognito; API validates token before starting execution.
- **Service-to-service** — prefer **IAM roles** (ECS task role, Lambda execution role) over embedding Cognito client credentials in state machines.
- If OAuth client credentials are required, store client secret in Secrets Manager and fetch in Lambda at runtime — never in state machine JSON.

### 8. Operations checklist

- Enable **Advanced Security** (compromised credentials, adaptive auth) for production pools.
- Configure **token lifetimes** (access/id/refresh) to match former Azure token policies.
- Set **domain** (Cognito hosted domain or custom domain + ACM cert) before cutover DNS.
- Log auth events to **CloudWatch** (`UserAuthentication`, `ForgotPassword`, etc.) and alarm on anomaly spikes.
- Test sign-up, sign-in, MFA, password reset, token refresh, and **global sign-out** before decommissioning Entra app.

### 9. Common pitfalls

- Redirect URI mismatch (`http` vs `https`, trailing slash) — #1 login failure after migration.
- Validating tokens against wrong **issuer** or **pool ID** after multi-region deploy.
- ALB authenticate action without HTTPS-only listeners — session cookies exposed.
- Putting Cognito **client secrets** in ECS task definitions or Step Functions input.
- Assuming Cognito groups automatically grant IAM access — you must map groups in Identity Pool or enforce RBAC in app code.

---

## Recommended Migration Order

1. **Inventory** — List Azure resources, dependencies, secrets, and SLAs.
2. **Network** — Stand up VPC, subnets, security groups, endpoints.
3. **Identity** — Stand up Cognito user pool (or Entra federation), app clients, groups; wire ALB authenticate or API JWT validation.
4. **Data** — Migrate databases and blob storage first (often the longest pole).
5. **Containers** — Push images to ECR, create ECS task definitions and services.
6. **Workflows** — Port Logic Apps / Durable Functions to Step Functions state machines.
7. **Cutover** — DNS switch, drain Azure traffic, validate rollback path.
8. **Decommission** — Remove Azure resources after a soak period.

---

## Quick Validation Checklist

- [ ] Images in ECR, ECS tasks pull successfully
- [ ] RDS reachable from ECS tasks (SG + private subnet); credentials in Secrets Manager
- [ ] Cognito sign-in, token refresh, and API JWT validation tested; groups/scopes match Azure roles
- [ ] Secrets in Secrets Manager / SSM, not in plain env vars
- [ ] ALB health checks passing, tasks in private subnets
- [ ] CloudWatch Logs receiving container output
- [ ] Step Functions executions succeed end-to-end
- [ ] Retry/Catch blocks tested with injected failures
- [ ] Autoscaling rules verified under load
- [ ] Rollback procedure documented and tested

---

## Running Tests

```bash
node test.js
```

The test file validates migration tip structures and prints a quick reference summary.



Skip to Main Content


Search
[Option+S]

16



United States (N. Virginia)

skillfully-llm-dev (835072332483)
AdministratorAccess/akila.dananjaya@skillful.ly

Amazon Elastic Container Service
Clusters
hirednow-backend-prod-cluster
Services
rest-api-service-2
Tasks
Amazon Elastic Container Service
Clusters
hirednow-backend-prod-cluster
Services
rest-api-service-2
Tasks





Amazon Elastic Container Service
Favourites and recents
New
Express Mode
Clusters
Namespaces
Task definitions
Daemon task definitions
Account settings
AWS Resource Explorer
AWS Batch
Amazon ECR
Repositories
Online learning workshop
Documentation
Discover products
Subscriptions
Tell us what you think
rest-api-service-2 Info
Last updated
17 June 2026, 12:28 (UTC+5:30)

Refresh completed


Add to favourites
Delete service
Update service

Service overview Info
Status
Active
Tasks (1 Desired)
0 pending
|
1 running
Task definition: revision
hirednow-backend-prod-td:30
Deployment status
Success

Health and metrics
Tasks
Logs
Deployments
Events
Configuration and networking
Service auto scaling
Event history
Tags

Tasks (1/1)
Last updated
17 June 2026, 12:29 (UTC+5:30)


Stop
Filter desired status

Any desired status
Filter launch type

Any launch type

1


Task selection	
Task
	
Last status
	
Desired status
	
Task definition
	
Health status
	
Started by
	
Started at
	
Container instances
	
Launch type
	
Platform version
	
CPU
	
Memory
	
Created at
	
Private IP
	
Public IP

Task selection	
Task
	
Last status
	
Desired status
	
Task definition
	
Health status
	
Started by
	
Started at
	
Container instances
	
Launch type
	
Platform version
	
CPU
	
Memory
	
Created at
	
Private IP
	
Public IP

1b6d3eb6e5d9404b96687eae1ade9f8f

Running
Running
hirednow-backend-prod-td:30
Unknown
ecs-svc/6972510522496468118
8 hours ago
-
Fargate
1.4.0
2 vCPU
4 GiB
8 hours ago
172.31.46.188
54.174.71.244
Containers for task 1b6d3eb6e5d9404b96687eae1ade9f8f


CloudShell
Feedback
© 2026, Amazon Web Services, Inc. or its affiliates.
Privacy
Terms
Cookie preferences
Last updated 17 June 2026, 12:28 (UTC+5:30)
Last updated 17 June 2026, 12:29 (UTC+5:30)Refresh complete