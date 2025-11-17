# Phase 4-8: 고급 주제 및 운영

> 스케일링, 배포, 모니터링, 보안

## 목차

- [Phase 4: 리소스 격리 및 할당량](#phase-4-리소스-격리-및-할당량)
- [Phase 5: 스케일링 전략](#phase-5-스케일링-전략)
- [Phase 6: 배포 및 CI/CD](#phase-6-배포-및-cicd)
- [Phase 7: 모니터링 및 운영](#phase-7-모니터링-및-운영)
- [Phase 8: 보안 강화](#phase-8-보안-강화)

---

## Phase 4: 리소스 격리 및 할당량

### 4.1 작업 우선순위 시스템

**목표**: Pro 사용자는 Free 사용자보다 빠르게 처리

```python
# invokeai/app/services/queue/priority_queue.py
from enum import IntEnum


class QueuePriority(IntEnum):
    """우선순위 정의 (높을수록 먼저 처리)"""
    FREE = 0
    PRO = 10
    ENTERPRISE = 100


def get_priority_for_user(subscription_tier: str) -> int:
    """사용자 구독 플랜에 따른 우선순위"""
    priority_map = {
        "free": QueuePriority.FREE,
        "pro": QueuePriority.PRO,
        "enterprise": QueuePriority.ENTERPRISE,
    }
    return priority_map.get(subscription_tier, QueuePriority.FREE)
```

**Celery에서 우선순위 적용:**

```python
# invokeai/app/celery_app.py
from celery import Celery


app = Celery("invokeai")

app.conf.update(
    broker_url="redis://redis:6379/0",
    result_backend="redis://redis:6379/1",

    # 우선순위 설정
    task_queue_max_priority=100,
    task_default_priority=0,

    # 라우팅
    task_routes={
        "invokeai.tasks.generate_image": {
            "queue": "gpu-generation",
        },
    },
)


@app.task(bind=True, max_retries=3)
def generate_image(self, task_params: dict):
    """이미지 생성 작업"""

    # 우선순위는 작업 큐에 추가할 때 설정됨
    # apply_async(priority=10)

    user_id = task_params["user_id"]
    workflow = task_params["workflow"]

    # ... 생성 로직
```

**큐에 작업 추가 시 우선순위 설정:**

```python
# invokeai/app/api/routers/session_queue.py
@router.post("/enqueue_batch")
async def enqueue_batch(
    queue_batch: EnqueueBatchParams,
    user: TokenData = Depends(get_current_user),
):
    # 사용자 구독 플랜에 따른 우선순위
    priority = get_priority_for_user(user.subscription_tier)

    # Celery 작업 큐에 추가
    task = generate_image.apply_async(
        args=[{
            "user_id": user.user_id,
            "workflow": queue_batch.graph,
        }],
        priority=priority,  # ✅ 우선순위 적용
        queue="gpu-generation",
    )

    return {"task_id": task.id, "priority": priority}
```

### 4.2 동시 작업 제한

```python
# invokeai/app/services/concurrency/limiter.py
import redis
from typing import Optional


class ConcurrencyLimiter:
    """동시 작업 수 제한"""

    def __init__(self, redis_client: redis.Redis):
        self._redis = redis_client

    async def acquire(
        self,
        user_id: str,
        subscription_tier: str,
    ) -> bool:
        """
        작업 슬롯 획득 시도

        Returns:
            성공 여부
        """

        # 플랜별 동시 작업 한도
        limits = {
            "free": 1,        # Free: 1개씩만
            "pro": 3,         # Pro: 3개 동시
            "enterprise": 10,  # Enterprise: 10개 동시
        }

        max_concurrent = limits.get(subscription_tier, 1)

        # Redis에서 현재 실행 중인 작업 수 조회
        key = f"concurrent:{user_id}"
        current = int(self._redis.get(key) or 0)

        if current >= max_concurrent:
            return False  # 한도 초과

        # 작업 카운트 증가 (24시간 TTL)
        self._redis.incr(key)
        self._redis.expire(key, 86400)

        return True

    async def release(self, user_id: str):
        """작업 슬롯 해제"""
        key = f"concurrent:{user_id}"
        self._redis.decr(key)
```

**사용 예시:**

```python
@router.post("/enqueue_batch")
async def enqueue_batch(
    queue_batch: EnqueueBatchParams,
    user: TokenData = Depends(get_current_user),
    limiter: ConcurrencyLimiter = Depends(ApiDependencies.concurrency_limiter),
):
    # 동시 작업 한도 체크
    if not await limiter.acquire(user.user_id, user.subscription_tier):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many concurrent requests. Please wait for current tasks to complete.",
        )

    # 작업 큐에 추가
    task = generate_image.apply_async(...)

    return {"task_id": task.id}
```

---

## Phase 5: 스케일링 전략

### 5.1 수평 스케일링 (Horizontal Scaling)

**ECS Service Auto Scaling:**

```hcl
# terraform/ecs_autoscaling.tf

# API 서버 Auto Scaling
resource "aws_appautoscaling_target" "ecs_service" {
  max_capacity       = 10
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# CPU 기반 스케일링
resource "aws_appautoscaling_policy" "ecs_cpu" {
  name               = "cpu-autoscaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs_service.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs_service.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs_service.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = 70.0  # CPU 70% 유지

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    scale_in_cooldown  = 300  # 5분
    scale_out_cooldown = 60   # 1분
  }
}

# 요청 수 기반 스케일링
resource "aws_appautoscaling_policy" "ecs_requests" {
  name               = "requests-autoscaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs_service.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs_service.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs_service.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = 1000.0  # 컨테이너당 1000 req/min

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"
    }
  }
}
```

**GPU 워커 Auto Scaling (큐 깊이 기반):**

```hcl
# terraform/gpu_autoscaling.tf

# CloudWatch 알람 - 큐 깊이 높음
resource "aws_cloudwatch_metric_alarm" "queue_depth_high" {
  alarm_name          = "gpu-queue-depth-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = "60"
  statistic           = "Average"
  threshold           = "10"  # 큐에 10개 이상
  alarm_description   = "Scale up GPU workers"

  dimensions = {
    QueueName = "invokeai-gpu-queue"
  }

  alarm_actions = [aws_autoscaling_policy.gpu_scale_up.arn]
}

# CloudWatch 알람 - 큐 깊이 낮음
resource "aws_cloudwatch_metric_alarm" "queue_depth_low" {
  alarm_name          = "gpu-queue-depth-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = "5"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = "60"
  statistic           = "Average"
  threshold           = "2"  # 큐에 2개 미만
  alarm_description   = "Scale down GPU workers"

  dimensions = {
    QueueName = "invokeai-gpu-queue"
  }

  alarm_actions = [aws_autoscaling_policy.gpu_scale_down.arn]
}

# Scale Up 정책
resource "aws_autoscaling_policy" "gpu_scale_up" {
  name                   = "gpu-scale-up"
  scaling_adjustment     = 2  # 2대씩 증가
  adjustment_type        = "ChangeInCapacity"
  cooldown              = 300  # 5분 대기
  autoscaling_group_name = aws_autoscaling_group.gpu_workers.name
}

# Scale Down 정책
resource "aws_autoscaling_policy" "gpu_scale_down" {
  name                   = "gpu-scale-down"
  scaling_adjustment     = -1  # 1대씩 감소
  adjustment_type        = "ChangeInCapacity"
  cooldown              = 600  # 10분 대기
  autoscaling_group_name = aws_autoscaling_group.gpu_workers.name
}
```

### 5.2 캐싱 전략

**1) 모델 메타데이터 캐싱:**

```python
# invokeai/app/services/models/model_cache.py
import redis
import json
from typing import Optional


class ModelMetadataCache:
    """모델 메타데이터 Redis 캐싱"""

    def __init__(self, redis_client: redis.Redis):
        self._redis = redis_client
        self._ttl = 3600  # 1시간

    def get(self, model_key: str) -> Optional[dict]:
        """캐시에서 모델 정보 조회"""
        cache_key = f"model:metadata:{model_key}"
        data = self._redis.get(cache_key)

        if data:
            return json.loads(data)
        return None

    def set(self, model_key: str, metadata: dict):
        """캐시에 모델 정보 저장"""
        cache_key = f"model:metadata:{model_key}"
        self._redis.setex(
            cache_key,
            self._ttl,
            json.dumps(metadata),
        )

    def invalidate(self, model_key: str):
        """캐시 무효화"""
        cache_key = f"model:metadata:{model_key}"
        self._redis.delete(cache_key)
```

**2) API 응답 캐싱:**

```python
# invokeai/app/api/routers/models.py
from functools import lru_cache


@router.get("/models")
@cache(expire=300)  # 5분 캐시
async def list_models(
    type: Optional[str] = None,
    base: Optional[str] = None,
):
    """모델 목록 조회 (캐시됨)"""

    # ... 로직
```

**3) CloudFront CDN:**

```hcl
# terraform/cloudfront.tf

# CloudFront Distribution
resource "aws_cloudfront_distribution" "main" {
  enabled = true

  # Origin - S3 (이미지)
  origin {
    domain_name = aws_s3_bucket.images.bucket_regional_domain_name
    origin_id   = "S3-images"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.main.cloudfront_access_identity_path
    }
  }

  # Origin - ALB (API)
  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = "ALB-api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # 캐시 동작 - 이미지
  ordered_cache_behavior {
    path_pattern     = "/images/*"
    target_origin_id = "S3-images"

    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400   # 1일
    max_ttl     = 31536000 # 1년
    compress    = true

    viewer_protocol_policy = "redirect-to-https"
  }

  # 캐시 동작 - API (캐시 안 함)
  default_cache_behavior {
    target_origin_id = "ALB-api"

    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]

    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies {
        forward = "all"
      }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0

    viewer_protocol_policy = "redirect-to-https"
  }

  # SSL 인증서
  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate.main.arn
    ssl_support_method  = "sni-only"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
```

---

## Phase 6: 배포 및 CI/CD

### 6.1 GitHub Actions CI/CD 파이프라인

```yaml
# .github/workflows/deploy-prod.yml
name: Deploy to Production

on:
  push:
    branches: [main]

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: ${{ secrets.ECR_REGISTRY }}
  ECS_CLUSTER: invokeai-cluster
  ECS_SERVICE: invokeai-api

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: |
          pip install -r requirements.txt
          pip install pytest pytest-cov

      - name: Run tests
        run: |
          pytest tests/ --cov=invokeai --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v3

  build-and-push:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v1

      - name: Build, tag, and push image to Amazon ECR
        id: build-image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/invokeai-api:$IMAGE_TAG .
          docker push $ECR_REGISTRY/invokeai-api:$IMAGE_TAG
          docker tag $ECR_REGISTRY/invokeai-api:$IMAGE_TAG $ECR_REGISTRY/invokeai-api:latest
          docker push $ECR_REGISTRY/invokeai-api:latest
          echo "image=$ECR_REGISTRY/invokeai-api:$IMAGE_TAG" >> $GITHUB_OUTPUT

      - name: Fill in the new image ID in the Amazon ECS task definition
        id: task-def
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-definition.json
          container-name: api
          image: ${{ steps.build-image.outputs.image }}

      - name: Deploy Amazon ECS task definition
        uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.task-def.outputs.task-definition }}
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true

  migrate-database:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Run database migrations
        run: |
          # Bastion 호스트를 통해 마이그레이션 실행
          # 또는 ECS Task로 실행
          aws ecs run-task \
            --cluster ${{ env.ECS_CLUSTER }} \
            --task-definition invokeai-migrate \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx]}"
```

### 6.2 Blue-Green 배포

```yaml
# .github/workflows/blue-green-deploy.yml
deploy:
  runs-on: ubuntu-latest
  steps:
    # ... (빌드 단계)

    - name: Create new target group (Green)
      run: |
        aws elbv2 create-target-group \
          --name invokeai-api-green \
          --protocol HTTP \
          --port 9090 \
          --vpc-id $VPC_ID

    - name: Deploy to Green environment
      run: |
        aws ecs update-service \
          --cluster invokeai-cluster \
          --service invokeai-api-green \
          --task-definition invokeai-api:${{ github.sha }}

    - name: Wait for Green environment to be healthy
      run: |
        aws ecs wait services-stable \
          --cluster invokeai-cluster \
          --services invokeai-api-green

    - name: Run smoke tests
      run: |
        ./scripts/smoke-test.sh https://green.api.yourdomain.com

    - name: Switch traffic to Green
      run: |
        # ALB 리스너 규칙 수정
        aws elbv2 modify-listener \
          --listener-arn $LISTENER_ARN \
          --default-actions Type=forward,TargetGroupArn=$GREEN_TG_ARN

    - name: Monitor for 10 minutes
      run: sleep 600

    - name: Rollback if errors detected
      if: failure()
      run: |
        aws elbv2 modify-listener \
          --listener-arn $LISTENER_ARN \
          --default-actions Type=forward,TargetGroupArn=$BLUE_TG_ARN
```

### 6.3 데이터베이스 마이그레이션

```python
# alembic/versions/002_add_feature_x.py
"""Add feature X

Revision ID: 002
Revises: 001
"""
from alembic import op
import sqlalchemy as sa


def upgrade():
    # 새 컬럼 추가 (NULL 허용)
    op.add_column('users', sa.Column('new_feature', sa.String(255), nullable=True))

    # 기본값 설정
    op.execute("UPDATE users SET new_feature = 'default_value'")

    # NOT NULL 제약 추가
    op.alter_column('users', 'new_feature', nullable=False)

    # 인덱스 추가
    op.create_index('idx_users_new_feature', 'users', ['new_feature'])


def downgrade():
    # 롤백 로직
    op.drop_index('idx_users_new_feature', table_name='users')
    op.drop_column('users', 'new_feature')
```

**배포 스크립트:**

```bash
#!/bin/bash
# scripts/deploy.sh

set -e

# 1. 백업
echo "Creating database backup..."
aws rds create-db-snapshot \
  --db-instance-identifier invokeai-db \
  --db-snapshot-identifier invokeai-$(date +%Y%m%d-%H%M%S)

# 2. 마이그레이션
echo "Running database migrations..."
docker run --rm \
  -e DATABASE_URL=$DATABASE_URL \
  invokeai-api:latest \
  alembic upgrade head

# 3. 배포
echo "Deploying new version..."
aws ecs update-service \
  --cluster invokeai-cluster \
  --service invokeai-api \
  --force-new-deployment

echo "Deployment complete!"
```

---

## Phase 7: 모니터링 및 운영

### 7.1 CloudWatch 메트릭 및 알람

```hcl
# terraform/monitoring.tf

# CloudWatch Dashboard
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "InvokeAI-Production"

  dashboard_body = jsonencode({
    widgets = [
      # API 응답 시간
      {
        type = "metric"
        properties = {
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", {stat = "Average"}]
          ]
          period = 300
          stat   = "Average"
          region = "us-east-1"
          title  = "API Response Time"
        }
      },

      # 에러율
      {
        type = "metric"
        properties = {
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", {stat = "Sum"}]
          ]
          period = 300
          stat   = "Sum"
          region = "us-east-1"
          title  = "5XX Errors"
        }
      },

      # GPU 사용률
      {
        type = "metric"
        properties = {
          metrics = [
            ["CWAgent", "gpu_utilization", {stat = "Average"}]
          ]
          period = 60
          stat   = "Average"
          region = "us-east-1"
          title  = "GPU Utilization"
        }
      },

      # 큐 깊이
      {
        type = "metric"
        properties = {
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", {stat = "Average"}]
          ]
          period = 60
          stat   = "Average"
          region = "us-east-1"
          title  = "Queue Depth"
        }
      },
    ]
  })
}

# 알람 - API 응답 시간 높음
resource "aws_cloudwatch_metric_alarm" "api_latency_high" {
  alarm_name          = "api-latency-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = "300"
  statistic           = "Average"
  threshold           = "1.0"  # 1초
  alarm_description   = "API response time is too high"

  alarm_actions = [aws_sns_topic.alerts.arn]
}

# 알람 - 에러율 높음
resource "aws_cloudwatch_metric_alarm" "error_rate_high" {
  alarm_name          = "error-rate-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = "300"
  statistic           = "Sum"
  threshold           = "10"  # 5분에 10개 이상
  alarm_description   = "Too many 5XX errors"

  alarm_actions = [aws_sns_topic.alerts.arn]
}

# SNS Topic (알림)
resource "aws_sns_topic" "alerts" {
  name = "invokeai-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = "alerts@yourdomain.com"
}

# Slack 통합 (선택)
resource "aws_sns_topic_subscription" "alerts_slack" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.slack_notifier.arn
}
```

### 7.2 로깅 (CloudWatch Logs)

```python
# invokeai/app/util/logger.py
import logging
import watchtower  # CloudWatch Logs handler


def setup_logging(environment: str):
    """로깅 설정"""

    logger = logging.getLogger("invokeai")
    logger.setLevel(logging.INFO)

    # 콘솔 핸들러
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(
        logging.Formatter(
            "[%(asctime)s] %(levelname)s [%(name)s:%(lineno)s] %(message)s"
        )
    )
    logger.addHandler(console_handler)

    # CloudWatch Logs 핸들러 (프로덕션만)
    if environment == "production":
        cloudwatch_handler = watchtower.CloudWatchLogHandler(
            log_group="/aws/ecs/invokeai",
            stream_name="api-server",
        )
        logger.addHandler(cloudwatch_handler)

    return logger
```

**구조화된 로깅:**

```python
import structlog


logger = structlog.get_logger()

logger.info(
    "image_generated",
    user_id=user_id,
    image_name=image_name,
    model="sdxl",
    resolution="1024x1024",
    generation_time_sec=15.2,
)
```

### 7.3 에러 추적 (Sentry)

```python
# invokeai/app/run_app.py
import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration


if app_config.environment == "production":
    sentry_sdk.init(
        dsn="https://xxx@sentry.io/xxx",
        environment=app_config.environment,

        # 성능 모니터링
        traces_sample_rate=0.1,  # 10% 샘플링

        # 릴리스 추적
        release=f"invokeai@{app_config.version}",

        # 통합
        integrations=[FastApiIntegration()],

        # 필터링
        before_send=before_send_handler,
    )


def before_send_handler(event, hint):
    """민감한 정보 필터링"""

    # Authorization 헤더 제거
    if "request" in event:
        if "headers" in event["request"]:
            event["request"]["headers"].pop("Authorization", None)

    return event
```

**커스텀 메트릭:**

```python
from sentry_sdk import capture_message, set_tag, set_context


# 태그 설정
set_tag("subscription_tier", user.subscription_tier)
set_tag("gpu_instance_type", "g5.xlarge")

# 컨텍스트 추가
set_context("generation_params", {
    "model": "sdxl",
    "steps": 30,
    "resolution": "1024x1024",
})

# 이벤트 캡처
capture_message("Generation completed", level="info")
```

---

## Phase 8: 보안 강화

### 8.1 WAF (Web Application Firewall)

```hcl
# terraform/waf.tf

# WAF Web ACL
resource "aws_wafv2_web_acl" "main" {
  name  = "invokeai-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  # Rate Limiting (DDoS 방어)
  rule {
    name     = "rate-limit"
    priority = 1

    statement {
      rate_based_statement {
        limit              = 2000  # IP당 5분에 2000 req
        aggregate_key_type = "IP"
      }
    }

    action {
      block {}
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # SQL Injection 차단
  rule {
    name     = "sql-injection"
    priority = 2

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesSQLiRuleSet"
      }
    }

    override_action {
      none {}
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "sql-injection"
      sampled_requests_enabled   = true
    }
  }

  # XSS 차단
  rule {
    name     = "xss"
    priority = 3

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    override_action {
      none {}
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "xss"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "invokeai-waf"
    sampled_requests_enabled   = true
  }
}

# WAF와 ALB 연결
resource "aws_wafv2_web_acl_association" "main" {
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
```

### 8.2 Secrets 관리

```python
# invokeai/app/util/secrets.py
import boto3
import json
from functools import lru_cache


class SecretsManager:
    """AWS Secrets Manager 통합"""

    def __init__(self, region: str = "us-east-1"):
        self._client = boto3.client("secretsmanager", region_name=region)

    @lru_cache(maxsize=128)
    def get_secret(self, secret_name: str) -> dict:
        """Secret 조회 (캐시됨)"""

        response = self._client.get_secret_value(SecretId=secret_name)

        if "SecretString" in response:
            return json.loads(response["SecretString"])
        else:
            # Binary secret
            return response["SecretBinary"]


# 사용 예시
secrets = SecretsManager()

db_credentials = secrets.get_secret("invokeai/database")
# {"username": "admin", "password": "..."}

stripe_key = secrets.get_secret("invokeai/stripe")
# {"secret_key": "sk_live_..."}
```

### 8.3 데이터 암호화

**1) 전송 중 암호화 (TLS):**

```hcl
# ALB에서 TLS 1.2+ 강제
resource "aws_lb_listener" "https" {
  # ...
  ssl_policy = "ELBSecurityPolicy-TLS-1-2-2017-01"
}

# RDS - SSL 연결 강제
resource "aws_db_instance" "main" {
  # ...
  ca_cert_identifier = "rds-ca-2019"
}
```

**2) 저장 시 암호화:**

```hcl
# S3 - 서버 사이드 암호화
resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.id
    }
  }
}

# RDS - 암호화 활성화
resource "aws_db_instance" "main" {
  # ...
  storage_encrypted = true
  kms_key_id        = aws_kms_key.rds.arn
}

# EBS (GPU 워커) - 암호화
resource "aws_launch_template" "gpu_worker" {
  # ...
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      encrypted   = true
      kms_key_id  = aws_kms_key.ebs.arn
    }
  }
}
```

### 8.4 GDPR/개인정보 보호

```python
# invokeai/app/api/routers/user.py
@router.delete("/me")
async def delete_account(
    user: TokenData = Depends(get_current_user),
    user_service: UserService = Depends(ApiDependencies.user_service),
):
    """
    계정 삭제 (GDPR Right to be Forgotten)

    모든 개인 데이터 삭제
    """

    # 1. Stripe 구독 취소
    if user.stripe_subscription_id:
        stripe.Subscription.delete(user.stripe_subscription_id)

    # 2. S3에서 모든 이미지 삭제
    await delete_user_s3_data(user.user_id)

    # 3. DB에서 개인정보 제거
    await user_service.anonymize_user(user.user_id)

    # 4. 감사 로그
    logger.info(f"User account deleted: {user.user_id}")

    return {"status": "deleted"}


@router.get("/me/data")
async def export_data(
    user: TokenData = Depends(get_current_user),
):
    """
    데이터 내보내기 (GDPR Data Portability)

    모든 개인 데이터를 JSON으로 반환
    """

    data = {
        "user": {...},
        "images": [...],
        "workflows": [...],
        "subscription": {...},
    }

    return StreamingResponse(
        iter([json.dumps(data)]),
        media_type="application/json",
        headers={
            "Content-Disposition": "attachment; filename=my_data.json"
        },
    )
```

---

## 요약 체크리스트

### 런치 전 필수 항목

- [ ] **인증 및 권한**
  - [ ] AWS Cognito 설정
  - [ ] JWT 검증 구현
  - [ ] 사용자별 데이터 격리

- [ ] **인프라**
  - [ ] VPC 및 서브넷 구성
  - [ ] RDS PostgreSQL 설정
  - [ ] S3 버킷 생성
  - [ ] ElastiCache Redis 설정
  - [ ] ECS Fargate 배포
  - [ ] GPU 워커 Auto Scaling

- [ ] **결제**
  - [ ] Stripe 통합
  - [ ] Webhook 설정
  - [ ] 할당량 시스템

- [ ] **모니터링**
  - [ ] CloudWatch 대시보드
  - [ ] 알람 설정
  - [ ] Sentry 에러 추적

- [ ] **보안**
  - [ ] WAF 설정
  - [ ] SSL/TLS 인증서
  - [ ] Secrets Manager
  - [ ] 암호화 (전송/저장)

- [ ] **운영**
  - [ ] CI/CD 파이프라인
  - [ ] 백업 전략
  - [ ] 재해 복구 계획
  - [ ] 문서화

### 예상 비용 (월간)

| 항목 | 비용 |
|-----|------|
| 컴퓨팅 (ECS + GPU) | $500-800 |
| 데이터베이스 | $70 |
| 스토리지 (S3) | $50 |
| 네트워크 | $100 |
| 기타 | $50 |
| **총계** | **$770-1070/월** |

*사용량에 따라 변동

---

축하합니다! 이제 InvokeAI를 구독형 SaaS로 전환하는 모든 단계를 완료했습니다! 🎉
