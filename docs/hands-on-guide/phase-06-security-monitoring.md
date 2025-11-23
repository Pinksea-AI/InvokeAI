# Phase 6: 보안 및 모니터링

이 가이드는 보안 강화 및 운영 모니터링 시스템을 구축하는 과정을 다룹니다.

## 목차
1. [AWS WAF 설정](#aws-waf-설정)
2. [Row-Level Security](#row-level-security)
3. [AWS Secrets Manager](#aws-secrets-manager)
4. [Prometheus & Grafana](#prometheus--grafana)
5. [CloudWatch 알람](#cloudwatch-알람)
6. [로그 집계](#로그-집계)
7. [보안 스캔 자동화](#보안-스캔-자동화)

---

## AWS WAF 설정

### 1. Terraform WAF 모듈

`infra/terraform/modules/waf/main.tf`:
```hcl
# WAF Web ACL
resource "aws_wafv2_web_acl" "main" {
  name  = "${var.environment}-pingvas-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  # Rule 1: Rate Limiting
  rule {
    name     = "RateLimit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000  # 2000 requests per 5 minutes
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitRule"
      sampled_requests_enabled   = true
    }
  }

  # Rule 2: AWS Managed Rules - Core Rule Set
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        # Exclude specific rules if needed
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSetMetric"
      sampled_requests_enabled   = true
    }
  }

  # Rule 3: SQL Injection Protection
  rule {
    name     = "SQLInjectionProtection"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "SQLInjectionProtectionMetric"
      sampled_requests_enabled   = true
    }
  }

  # Rule 4: IP Reputation List
  rule {
    name     = "IPReputationList"
    priority = 4

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "IPReputationListMetric"
      sampled_requests_enabled   = true
    }
  }

  # Rule 5: Geo Blocking (선택)
  rule {
    name     = "GeoBlocking"
    priority = 5

    action {
      block {}
    }

    statement {
      geo_match_statement {
        country_codes = ["CN", "RU"]  # 예: 중국, 러시아 차단
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "GeoBlockingMetric"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.environment}PingvasWAF"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "${var.environment}-pingvas-waf"
  }
}

# Associate WAF with ALB
resource "aws_wafv2_web_acl_association" "main" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
```

---

### 2. WAF 로깅

```hcl
# Kinesis Firehose for WAF Logs
resource "aws_kinesis_firehose_delivery_stream" "waf_logs" {
  name        = "aws-waf-logs-${var.environment}-pingvas"
  destination = "s3"

  s3_configuration {
    role_arn   = aws_iam_role.firehose.arn
    bucket_arn = aws_s3_bucket.waf_logs.arn
    prefix     = "waf-logs/"

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = "/aws/kinesisfirehose/waf-logs"
      log_stream_name = "S3Delivery"
    }
  }
}

# Configure WAF logging
resource "aws_wafv2_web_acl_logging_configuration" "main" {
  resource_arn            = aws_wafv2_web_acl.main.arn
  log_destination_configs = [aws_kinesis_firehose_delivery_stream.waf_logs.arn]
}
```

---

## Row-Level Security

### 1. RLS 정책 설정

`db/migrations/004_enable_rls.sql`:
```sql
-- Enable RLS on sensitive tables
ALTER TABLE dev_pingvas.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_pingvas.images ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_pingvas.boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_pingvas.credit_transactions ENABLE ROW LEVEL SECURITY;

-- Users table: 자신의 레코드만 조회
CREATE POLICY users_select_own ON dev_pingvas.users
FOR SELECT
USING (id = current_setting('app.current_user_id')::UUID);

CREATE POLICY users_update_own ON dev_pingvas.users
FOR UPDATE
USING (id = current_setting('app.current_user_id')::UUID);

-- Images table: 자신의 이미지만 조회/수정/삭제
CREATE POLICY images_select_own ON dev_pingvas.images
FOR SELECT
USING (
    user_id = current_setting('app.current_user_id')::UUID
    OR is_public = TRUE
);

CREATE POLICY images_insert_own ON dev_pingvas.images
FOR INSERT
WITH CHECK (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY images_update_own ON dev_pingvas.images
FOR UPDATE
USING (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY images_delete_own ON dev_pingvas.images
FOR DELETE
USING (user_id = current_setting('app.current_user_id')::UUID);

-- Boards table
CREATE POLICY boards_select_own ON dev_pingvas.boards
FOR SELECT
USING (
    user_id = current_setting('app.current_user_id')::UUID
    OR is_public = TRUE
);

CREATE POLICY boards_insert_own ON dev_pingvas.boards
FOR INSERT
WITH CHECK (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY boards_update_own ON dev_pingvas.boards
FOR UPDATE
USING (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY boards_delete_own ON dev_pingvas.boards
FOR DELETE
USING (user_id = current_setting('app.current_user_id')::UUID);

-- Credit Transactions: 자신의 거래 내역만 조회
CREATE POLICY credit_transactions_select_own ON dev_pingvas.credit_transactions
FOR SELECT
USING (user_id = current_setting('app.current_user_id')::UUID);

-- Admin role bypass
CREATE POLICY admin_all_access ON dev_pingvas.users
FOR ALL
TO admin_role
USING (TRUE)
WITH CHECK (TRUE);
```

---

### 2. 애플리케이션에서 RLS 활성화

`services/user-service/app/db/base.py`:
```python
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

engine = create_engine(settings.database_url)

@event.listens_for(engine, "connect")
def set_search_path(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("SET search_path TO dev_pingvas, public")
    cursor.close()

def get_db():
    db = SessionLocal()
    try:
        # Set current user ID for RLS
        if hasattr(g, 'current_user_id'):
            db.execute(text(f"SET app.current_user_id = '{g.current_user_id}'"))
        yield db
    finally:
        db.close()
```

---

## AWS Secrets Manager

### 1. Terraform Secrets 생성

`infra/terraform/modules/secrets/main.tf`:
```hcl
# Database Credentials
resource "aws_secretsmanager_secret" "db_credentials" {
  name = "${var.environment}/pingvas/db-credentials"

  tags = {
    Name = "${var.environment}-db-credentials"
  }
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id

  secret_string = jsonencode({
    username = var.db_username
    password = var.db_password
    host     = var.db_host
    port     = var.db_port
    dbname   = var.db_name
  })
}

# JWT Secret
resource "aws_secretsmanager_secret" "jwt_secret" {
  name = "${var.environment}/pingvas/jwt-secret"
}

resource "random_password" "jwt_secret" {
  length  = 64
  special = true
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_password.jwt_secret.result
}

# Lemon Squeezy API Key
resource "aws_secretsmanager_secret" "lemon_squeezy" {
  name = "${var.environment}/pingvas/lemon-squeezy"
}
```

---

### 2. EKS에서 Secrets Manager 사용 (External Secrets Operator)

```bash
# Helm 설치
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets \
  external-secrets/external-secrets \
  -n external-secrets-system \
  --create-namespace
```

**SecretStore**:

`k8s/secrets/secretstore.yaml`:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  namespace: dev
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
```

**ExternalSecret**:

`k8s/secrets/db-credentials.yaml`:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: dev
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore

  target:
    name: db-credentials
    creationPolicy: Owner

  data:
    - secretKey: DATABASE_URL
      remoteRef:
        key: dev/pingvas/db-credentials
        property: url
```

---

## Prometheus & Grafana

### 1. Prometheus Stack 설치

```bash
# Helm repo 추가
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# kube-prometheus-stack 설치
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --values k8s/monitoring/prometheus-values.yaml
```

`k8s/monitoring/prometheus-values.yaml`:
```yaml
prometheus:
  prometheusSpec:
    retention: 15d
    storageSpec:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 50Gi

    additionalScrapeConfigs:
      # Redis Exporter
      - job_name: 'redis'
        static_configs:
          - targets: ['redis-exporter:9121']

      # PostgreSQL Exporter
      - job_name: 'postgres'
        static_configs:
          - targets: ['postgres-exporter:9187']

      # Custom Metrics
      - job_name: 'generation-service'
        kubernetes_sd_configs:
          - role: pod
            namespaces:
              names:
                - dev
                - prod
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_label_app]
            action: keep
            regex: generation-service

grafana:
  adminPassword: "admin123"  # Change in production!

  datasources:
    datasources.yaml:
      apiVersion: 1
      datasources:
        - name: Prometheus
          type: prometheus
          url: http://prometheus-kube-prometheus-prometheus:9090
          isDefault: true

  dashboardProviders:
    dashboardproviders.yaml:
      apiVersion: 1
      providers:
        - name: 'default'
          orgId: 1
          folder: ''
          type: file
          disableDeletion: false
          editable: true
          options:
            path: /var/lib/grafana/dashboards/default

  dashboards:
    default:
      kubernetes-cluster:
        gnetId: 7249
        revision: 1
        datasource: Prometheus

      nvidia-gpu:
        gnetId: 14574
        revision: 1
        datasource: Prometheus
```

---

### 2. Custom Metrics (FastAPI)

`services/generation-service/app/metrics.py`:
```python
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from fastapi import APIRouter

router = APIRouter()

# Metrics
generation_requests_total = Counter(
    'generation_requests_total',
    'Total generation requests',
    ['tier', 'status']
)

generation_duration_seconds = Histogram(
    'generation_duration_seconds',
    'Generation duration in seconds',
    ['tier', 'model'],
    buckets=[10, 30, 60, 120, 300, 600]
)

queue_length_gauge = Gauge(
    'queue_length',
    'Current queue length',
    ['tier']
)

credits_consumed_total = Counter(
    'credits_consumed_total',
    'Total credits consumed',
    ['tier', 'user_id']
)

@router.get("/metrics")
def metrics():
    return generate_latest()
```

**Usage**:
```python
from app.metrics import generation_requests_total, generation_duration_seconds

@router.post("/api/v1/generation/create")
async def create_generation(request: GenerationRequest, user: User):
    # Increment request counter
    generation_requests_total.labels(tier=user.tier, status="started").inc()

    start_time = time.time()

    try:
        # ... generation logic ...

        # Record duration
        duration = time.time() - start_time
        generation_duration_seconds.labels(tier=user.tier, model=request.model).observe(duration)

        generation_requests_total.labels(tier=user.tier, status="success").inc()

    except Exception as e:
        generation_requests_total.labels(tier=user.tier, status="failed").inc()
        raise
```

---

### 3. Grafana 대시보드

`k8s/monitoring/dashboards/generation-dashboard.json`:
```json
{
  "dashboard": {
    "title": "InvokeAI Generation Dashboard",
    "panels": [
      {
        "id": 1,
        "title": "Generation Requests Rate",
        "targets": [
          {
            "expr": "rate(generation_requests_total[5m])",
            "legendFormat": "{{tier}} - {{status}}"
          }
        ],
        "type": "graph"
      },
      {
        "id": 2,
        "title": "Queue Length by Tier",
        "targets": [
          {
            "expr": "queue_length",
            "legendFormat": "{{tier}}"
          }
        ],
        "type": "graph"
      },
      {
        "id": 3,
        "title": "Average Generation Duration (p50, p95, p99)",
        "targets": [
          {
            "expr": "histogram_quantile(0.50, rate(generation_duration_seconds_bucket[5m]))",
            "legendFormat": "p50"
          },
          {
            "expr": "histogram_quantile(0.95, rate(generation_duration_seconds_bucket[5m]))",
            "legendFormat": "p95"
          },
          {
            "expr": "histogram_quantile(0.99, rate(generation_duration_seconds_bucket[5m]))",
            "legendFormat": "p99"
          }
        ]
      },
      {
        "id": 4,
        "title": "GPU Utilization",
        "targets": [
          {
            "expr": "DCGM_FI_DEV_GPU_UTIL",
            "legendFormat": "{{gpu}} - {{pod}}"
          }
        ]
      },
      {
        "id": 5,
        "title": "Credits Consumed (Last 24h)",
        "targets": [
          {
            "expr": "increase(credits_consumed_total[24h])",
            "legendFormat": "{{tier}}"
          }
        ],
        "type": "stat"
      }
    ]
  }
}
```

---

## CloudWatch 알람

### 1. Terraform CloudWatch 알람

`infra/terraform/modules/alarms/main.tf`:
```hcl
# SNS Topic for Alarms
resource "aws_sns_topic" "alarms" {
  name = "${var.environment}-pingvas-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# EKS Cluster CPU Alarm
resource "aws_cloudwatch_metric_alarm" "eks_cpu_high" {
  alarm_name          = "${var.environment}-eks-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "node_cpu_utilization"
  namespace           = "ContainerInsights"
  period              = "300"
  statistic           = "Average"
  threshold           = "80"
  alarm_description   = "EKS cluster CPU utilization is above 80%"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    ClusterName = var.cluster_name
  }
}

# RDS CPU Alarm
resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name          = "${var.environment}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = "300"
  statistic           = "Average"
  threshold           = "80"
  alarm_description   = "RDS CPU utilization is above 80%"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    DBClusterIdentifier = var.db_cluster_id
  }
}

# RDS Connections Alarm
resource "aws_cloudwatch_metric_alarm" "rds_connections_high" {
  alarm_name          = "${var.environment}-rds-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = "300"
  statistic           = "Average"
  threshold           = "80"
  alarm_description   = "RDS connections are above 80"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    DBClusterIdentifier = var.db_cluster_id
  }
}

# API 5xx Errors
resource "aws_cloudwatch_metric_alarm" "api_5xx_errors" {
  alarm_name          = "${var.environment}-api-5xx-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = "300"
  statistic           = "Sum"
  threshold           = "10"
  alarm_description   = "API is returning 5xx errors"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }
}
```

---

## 로그 집계

### 1. Fluent Bit 설치

```bash
helm repo add fluent https://fluent.github.io/helm-charts
helm repo update

helm install fluent-bit fluent/fluent-bit \
  --namespace logging \
  --create-namespace \
  --values k8s/logging/fluent-bit-values.yaml
```

`k8s/logging/fluent-bit-values.yaml`:
```yaml
config:
  outputs: |
    [OUTPUT]
        Name cloudwatch_logs
        Match kube.*
        region us-east-1
        log_group_name /aws/eks/dev-pingvas-eks/logs
        log_stream_prefix fluent-bit-
        auto_create_group true

    [OUTPUT]
        Name s3
        Match kube.*
        region us-east-1
        bucket dev-pingvas-logs
        total_file_size 100M
        upload_timeout 1m
        s3_key_format /$TAG[2]/$TAG[0]/%Y/%m/%d/$UUID.gz
        store_dir /tmp/fluent-bit/s3

  filters: |
    [FILTER]
        Name parser
        Match kube.*
        Key_Name log
        Parser json
        Reserve_Data On

    [FILTER]
        Name kubernetes
        Match kube.*
        Kube_URL https://kubernetes.default.svc:443
        Kube_CA_File /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        Kube_Token_File /var/run/secrets/kubernetes.io/serviceaccount/token
```

---

### 2. CloudWatch Logs Insights 쿼리

```sql
-- 최근 1시간 에러 로그
fields @timestamp, @message
| filter @message like /ERROR/
| sort @timestamp desc
| limit 100

-- 티어별 요청 통계
fields tier, count(*) as request_count
| filter @message like /generation/
| stats count() by tier

-- 평균 응답 시간
fields @timestamp, duration_ms
| filter @message like /request_completed/
| stats avg(duration_ms) as avg_duration by bin(5m)
```

---

## 보안 스캔 자동화

### 1. Trivy 컨테이너 스캔

`.github/workflows/security-scan.yaml`:
```yaml
name: Security Scan

on:
  schedule:
    - cron: '0 0 * * *'  # Daily
  push:
    branches:
      - main

jobs:
  trivy-scan:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.ECR_REGISTRY }}/user-service:latest
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'

      - name: Upload Trivy results to GitHub Security
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'trivy-results.sarif'

      - name: Slack notification on vulnerabilities
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "⚠️ Security vulnerabilities detected in container images!"
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

---

### 2. OWASP Dependency Check

```yaml
  dependency-check:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Run OWASP Dependency Check
        uses: dependency-check/Dependency-Check_Action@main
        with:
          project: 'InvokeAI SaaS'
          path: '.'
          format: 'HTML'

      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: dependency-check-report
          path: ${{ github.workspace }}/reports
```

---

## 다음 단계

모든 Phase가 완료되었습니다! 🎉

이제 다음을 수행하세요:
1. 로컬 환경에서 전체 시스템 테스트
2. AWS 인프라 배포
3. 프로덕션 배포
4. 모니터링 및 최적화

**참고 자료**:
- [아키텍처 설계 문서](../../01-architecture-overview.md)
- [마이크로서비스 설계](../../02-microservices-design.md)
- [데이터베이스 스키마](../../03-database-schema.md)

---

## 체크리스트

- [ ] AWS WAF 설정
- [ ] RLS 정책 적용
- [ ] Secrets Manager 연동
- [ ] Prometheus & Grafana 설치
- [ ] 커스텀 메트릭 구현
- [ ] CloudWatch 알람 설정
- [ ] Fluent Bit 로그 수집
- [ ] 보안 스캔 자동화
- [ ] 대시보드 구성
- [ ] 알람 테스트

**축하합니다! InvokeAI SaaS 플랫폼 구축이 완료되었습니다!** 🚀
