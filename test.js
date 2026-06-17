/**
 * Azure → AWS migration tips validator and quick reference.
 * Run: node test.js
 */

const ecsTips = [
  {
    id: 'ecs-registry',
    category: 'ECS',
    azure: 'Azure Container Registry (ACR)',
    aws: 'Amazon ECR',
    tip: 'Re-tag and push all images to ECR before cutover. Enable image scanning.',
    priority: 'high',
  },
  {
    id: 'ecs-networking',
    category: 'ECS',
    azure: 'VNet + NSG',
    aws: 'VPC + Security Groups',
    tip: 'Run Fargate tasks in private subnets with VPC endpoints for ECR and CloudWatch.',
    priority: 'high',
  },
  {
    id: 'ecs-secrets',
    category: 'ECS',
    azure: 'Azure Key Vault',
    aws: 'Secrets Manager / SSM Parameter Store',
    tip: 'Reference secrets by ARN in task definitions. Use IAM task roles, never static keys.',
    priority: 'high',
  },
  {
    id: 'ecs-scaling',
    category: 'ECS',
    azure: 'Azure autoscale rules',
    aws: 'ECS Service Auto Scaling',
    tip: 'Use target tracking on CPU/memory or custom metrics. Set min/max capacity and cooldowns.',
    priority: 'medium',
  },
  {
    id: 'ecs-deploy',
    category: 'ECS',
    azure: 'Deployment slots',
    aws: 'Rolling deploy + circuit breaker',
    tip: 'Enable deployment circuit breaker rollback. Pin image tags, avoid :latest in prod.',
    priority: 'medium',
  },
  {
    id: 'ecs-logging',
    category: 'ECS',
    azure: 'Azure Monitor / Log Analytics',
    aws: 'CloudWatch Logs + Container Insights',
    tip: 'Configure awslogs driver in task definition. Create alarms on error rate and task health.',
    priority: 'medium',
  },
];

const cognitoTips = [
  {
    id: 'cognito-mapping',
    category: 'Cognito',
    azure: 'Azure AD / Entra app registration',
    aws: 'Cognito User Pool app client',
    tip: 'Map client ID, redirect URIs, and scopes. Federate Entra via SAML/OIDC if full user migration is risky.',
    priority: 'high',
  },
  {
    id: 'cognito-alb',
    category: 'Cognito',
    azure: 'App Service Easy Auth / Front Door + Entra',
    aws: 'ALB Authenticate Cognito action',
    tip: 'Protect ECS services at the load balancer. Ensure traffic cannot bypass ALB to tasks.',
    priority: 'high',
  },
  {
    id: 'cognito-jwt',
    category: 'Cognito',
    azure: 'MSAL token validation in API',
    aws: 'aws-jwt-verify + Cognito issuer',
    tip: 'Validate iss, aud, exp, and scopes in API middleware. Never trust unverified JWT claims.',
    priority: 'high',
  },
  {
    id: 'cognito-b2c',
    category: 'Cognito',
    azure: 'Azure AD B2C user flows',
    aws: 'Cognito hosted UI + Lambda triggers',
    tip: 'Replace custom policies with PreSignUp, CustomMessage, and PreTokenGeneration triggers.',
    priority: 'medium',
  },
  {
    id: 'cognito-groups',
    category: 'Cognito',
    azure: 'App roles / Entra groups',
    aws: 'Cognito groups + RBAC claims',
    tip: 'Emit cognito:groups in tokens and enforce authorization in app code or Identity Pool role mapping.',
    priority: 'medium',
  },
  {
    id: 'cognito-migration',
    category: 'Cognito',
    azure: 'Entra user directory',
    aws: 'Bulk import or federation',
    tip: 'Use CSV import, JIT Lambda, or dual-login period. Plan password reset if hashes cannot move.',
    priority: 'medium',
  },
];

const stepFunctionsTips = [
  {
    id: 'sfn-mapping',
    category: 'Step Functions',
    azure: 'Azure Logic Apps',
    aws: 'Step Functions Standard workflow',
    tip: 'Map sequential actions to Task states, parallel branches to Parallel state.',
    priority: 'high',
  },
  {
    id: 'sfn-durable',
    category: 'Step Functions',
    azure: 'Durable Functions orchestrator',
    aws: 'Step Functions + Lambda',
    tip: 'Replace orchestrator/activity pattern with Task states. Use waitForTaskToken for human steps.',
    priority: 'high',
  },
  {
    id: 'sfn-integrations',
    category: 'Step Functions',
    azure: 'Logic App connectors',
    aws: 'AWS SDK service integrations',
    tip: 'Prefer native integrations (SQS, S3, DynamoDB) over Lambda wrappers when possible.',
    priority: 'high',
  },
  {
    id: 'sfn-errors',
    category: 'Step Functions',
    azure: 'Run-after failure branches',
    aws: 'Retry + Catch blocks',
    tip: 'Make tasks idempotent. Add DLQ for poison messages. Test timeout handling.',
    priority: 'high',
  },
  {
    id: 'sfn-payload',
    category: 'Step Functions',
    azure: 'Large workflow variables',
    aws: 'S3 offload pattern',
    tip: 'Keep state payload under 256 KB. Store blobs in S3, pass only keys in state input.',
    priority: 'medium',
  },
  {
    id: 'sfn-express',
    category: 'Step Functions',
    azure: 'High-throughput triggers',
    aws: 'Express workflows',
    tip: 'Use Express for short, high-volume flows. Standard for exactly-once long orchestration.',
    priority: 'medium',
  },
];

const serviceMap = [
  { azure: 'ACI', aws: 'ECS Fargate' },
  { azure: 'AKS', aws: 'ECS or EKS' },
  { azure: 'App Service (containers)', aws: 'ECS + ALB' },
  { azure: 'Logic Apps', aws: 'Step Functions' },
  { azure: 'Durable Functions', aws: 'Step Functions + Lambda' },
  { azure: 'Service Bus', aws: 'SQS / SNS / EventBridge' },
  { azure: 'Key Vault', aws: 'Secrets Manager / SSM' },
  { azure: 'Azure AD / Entra ID', aws: 'Cognito User Pools' },
  { azure: 'Azure AD B2C', aws: 'Cognito User Pools' },
];

const migrationChecklist = [
  'Images pushed to ECR and pullable by ECS tasks',
  'Secrets stored in Secrets Manager or SSM',
  'ECS tasks in private subnets with proper SG rules',
  'ALB health checks passing',
  'CloudWatch Logs receiving container output',
  'Cognito login, token refresh, and API JWT checks passing',
  'Step Functions state machine executes end-to-end',
  'Retry/Catch blocks tested with injected failures',
  'Autoscaling verified under load',
  'Rollback procedure documented',
];

// --- Validators ---

function validateTip(tip) {
  const required = ['id', 'category', 'azure', 'aws', 'tip', 'priority'];
  const missing = required.filter((key) => !tip[key]);
  if (missing.length > 0) {
    throw new Error(`Tip "${tip.id || 'unknown'}" missing fields: ${missing.join(', ')}`);
  }
  if (!['high', 'medium', 'low'].includes(tip.priority)) {
    throw new Error(`Tip "${tip.id}" has invalid priority: ${tip.priority}`);
  }
}

function validateAll(tips, label) {
  tips.forEach(validateTip);
  console.log(`✓ ${label}: ${tips.length} tips validated`);
}

function groupByPriority(tips) {
  return tips.reduce((acc, t) => {
    acc[t.priority] = (acc[t.priority] || 0) + 1;
    return acc;
  }, {});
}

function printSection(title, tips) {
  console.log(`\n── ${title} ──`);
  tips.forEach((t) => {
    console.log(`  [${t.priority.toUpperCase()}] ${t.azure} → ${t.aws}`);
    console.log(`         ${t.tip}`);
  });
}

// --- Run ---

function main() {
  console.log('Azure → AWS Migration Tips — Test Runner\n');

  validateAll(ecsTips, 'ECS tips');
  validateAll(stepFunctionsTips, 'Step Functions tips');
  validateAll(cognitoTips, 'Cognito tips');

  const allTips = [...ecsTips, ...stepFunctionsTips, ...cognitoTips];
  const priorities = groupByPriority(allTips);
  console.log(`✓ Priority breakdown: high=${priorities.high}, medium=${priorities.medium}, low=${priorities.low || 0}`);

  console.log(`✓ Service map: ${serviceMap.length} mappings`);
  console.log(`✓ Checklist: ${migrationChecklist.length} items`);

  printSection('ECS Migration Tips', ecsTips);
  printSection('Step Functions Migration Tips', stepFunctionsTips);
  printSection('Cognito Migration Tips', cognitoTips);

  console.log('\n── Service Mapping ──');
  serviceMap.forEach((m) => console.log(`  ${m.azure} → ${m.aws}`));

  console.log('\n── Pre-Cutover Checklist ──');
  migrationChecklist.forEach((item, i) => console.log(`  ${i + 1}. [ ] ${item}`));

  console.log('\n✓ All tests passed\n');
}

main();
