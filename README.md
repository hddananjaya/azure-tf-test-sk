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

### 4. State machine design

- Keep states **small and idempotent** — Step Functions will retry on transient failures.
- Use **Choice** states instead of deeply nested conditionals.
- Pass data with `InputPath`, `OutputPath`, `ResultPath`, and `Parameters` — avoid huge payloads (256 KB state limit).
- Store large blobs in S3; pass only S3 keys/URIs in state input.

### 5. Error handling

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

### 6. Long-running and human tasks

- Durable Functions `waitForExternalEvent` → Step Functions **callback pattern** (`.waitForTaskToken`).
- Human approval flows → `waitForTaskToken` + API Gateway endpoint that calls `SendTaskSuccess` / `SendTaskFailure`.
- Timers → `Wait` state with `Seconds`, `Timestamp`, or `SecondsPath`.

### 7. Observability

- Enable **CloudWatch Logs** on the state machine (ALL or ERROR level).
- Use **X-Ray** tracing for end-to-end visibility.
- Replace Application Insights dependency tracking with structured logging in Lambda tasks.
- Set CloudWatch alarms on `ExecutionsFailed`, `ExecutionsTimedOut`, and `ExecutionThrottled`.

### 8. Security

- Use **IAM roles** per state machine — least privilege for each integration.
- Encrypt state machine definitions and execution history if handling sensitive data.
- For cross-account workflows, use resource-based policies or separate state machines per account.

### 9. Common pitfalls

- Exceeding the **256 KB** execution input/output limit — offload to S3.
- Non-idempotent Lambda tasks combined with retries causing duplicate side effects.
- Using Express workflows for workflows that need exactly-once semantics.
- Forgetting to handle `States.Timeout` in `Catch` blocks.

---

## Recommended Migration Order

1. **Inventory** — List Azure resources, dependencies, secrets, and SLAs.
2. **Network** — Stand up VPC, subnets, security groups, endpoints.
3. **Identity** — Map Azure AD apps to IAM roles (OIDC/SAML if needed).
4. **Data** — Migrate databases and blob storage first (often the longest pole).
5. **Containers** — Push images to ECR, create ECS task definitions and services.
6. **Workflows** — Port Logic Apps / Durable Functions to Step Functions state machines.
7. **Cutover** — DNS switch, drain Azure traffic, validate rollback path.
8. **Decommission** — Remove Azure resources after a soak period.

---

## Quick Validation Checklist

- [ ] Images in ECR, ECS tasks pull successfully
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
