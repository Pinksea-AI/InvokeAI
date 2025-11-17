# Phase 2: AWS 인프라 설계

> 확장 가능하고 안전한 SaaS 인프라 구축

## 목차

1. [네트워크 아키텍처 (VPC)](#1-네트워크-아키텍처-vpc)
2. [컴퓨팅 리소스](#2-컴퓨팅-리소스)
3. [스토리지 전략](#3-스토리지-전략)
4. [GPU 인스턴스 관리](#4-gpu-인스턴스-관리)
5. [비용 최적화](#5-비용-최적화)

---

## 1. 네트워크 아키텍처 (VPC)

### 1.1 VPC 설계

**왜 VPC가 필요한가?**
- 격리된 네트워크 환경
- 보안 그룹으로 트래픽 제어
- 프라이빗 서브넷에 민감한 리소스 배치

```
┌─────────────────────────────────────────────────────────┐
│                    VPC (10.0.0.0/16)                     │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │           가용 영역 A (us-east-1a)                   │ │
│  │                                                      │ │
│  │  ┌──────────────────────────────────────────────┐  │ │
│  │  │  퍼블릭 서브넷 (10.0.1.0/24)                  │  │ │
│  │  │  - NAT Gateway                               │  │ │
│  │  │  - Application Load Balancer                │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                      │ │
│  │  ┌──────────────────────────────────────────────┐  │ │
│  │  │  프라이빗 서브넷 (10.0.11.0/24)               │  │ │
│  │  │  - ECS Fargate (API 서버)                    │  │ │
│  │  │  - EC2 (GPU 워커)                            │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                      │ │
│  │  ┌──────────────────────────────────────────────┐  │ │
│  │  │  데이터 서브넷 (10.0.21.0/24)                 │  │ │
│  │  │  - RDS (PostgreSQL)                          │  │ │
│  │  │  - ElastiCache (Redis)                       │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │           가용 영역 B (us-east-1b)                   │ │
│  │  (동일한 구조 반복 - 고가용성)                        │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Terraform 코드:**

```hcl
# terraform/vpc.tf
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "invokeai-vpc"
  }
}

# 인터넷 게이트웨이 (퍼블릭 서브넷용)
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

# 퍼블릭 서브넷 (AZ-A)
resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true

  tags = {
    Name = "public-subnet-a"
    Type = "public"
  }
}

# 프라이빗 서브넷 (AZ-A) - 애플리케이션
resource "aws_subnet" "private_app_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.11.0/24"
  availability_zone = "us-east-1a"

  tags = {
    Name = "private-app-subnet-a"
    Type = "private"
  }
}

# 데이터 서브넷 (AZ-A) - RDS, Redis
resource "aws_subnet" "private_data_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.21.0/24"
  availability_zone = "us-east-1a"

  tags = {
    Name = "private-data-subnet-a"
    Type = "data"
  }
}

# AZ-B도 동일하게 생성 (고가용성)
resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = true

  tags = {
    Name = "public-subnet-b"
  }
}

resource "aws_subnet" "private_app_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.12.0/24"
  availability_zone = "us-east-1b"

  tags = {
    Name = "private-app-subnet-b"
  }
}

resource "aws_subnet" "private_data_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.22.0/24"
  availability_zone = "us-east-1b"

  tags = {
    Name = "private-data-subnet-b"
  }
}

# NAT Gateway (프라이빗 서브넷의 인터넷 접근용)
resource "aws_eip" "nat_a" {
  domain = "vpc"
}

resource "aws_nat_gateway" "main_a" {
  allocation_id = aws_eip.nat_a.id
  subnet_id     = aws_subnet.public_a.id

  tags = {
    Name = "nat-gateway-a"
  }
}

# 라우팅 테이블 - 퍼블릭
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "public-route-table"
  }
}

# 라우팅 테이블 - 프라이빗
resource "aws_route_table" "private_a" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main_a.id
  }

  tags = {
    Name = "private-route-table-a"
  }
}

# 서브넷 연결
resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private_app_a" {
  subnet_id      = aws_subnet.private_app_a.id
  route_table_id = aws_route_table.private_a.id
}
```

### 1.2 보안 그룹

```hcl
# terraform/security_groups.tf

# ALB 보안 그룹
resource "aws_security_group" "alb" {
  name        = "alb-sg"
  description = "Security group for Application Load Balancer"
  vpc_id      = aws_vpc.main.id

  # HTTPS 인바운드 (인터넷에서)
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS from internet"
  }

  # HTTP 인바운드 (HTTPS로 리다이렉트용)
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP from internet (redirect to HTTPS)"
  }

  # 모든 아웃바운드 허용
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "alb-security-group"
  }
}

# ECS 서비스 보안 그룹
resource "aws_security_group" "ecs_service" {
  name        = "ecs-service-sg"
  description = "Security group for ECS services"
  vpc_id      = aws_vpc.main.id

  # ALB로부터의 트래픽만 허용
  ingress {
    from_port       = 9090
    to_port         = 9090
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
    description     = "Traffic from ALB"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "ecs-service-security-group"
  }
}

# RDS 보안 그룹
resource "aws_security_group" "rds" {
  name        = "rds-sg"
  description = "Security group for RDS"
  vpc_id      = aws_vpc.main.id

  # ECS 서비스와 GPU 워커로부터만 접근 허용
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [
      aws_security_group.ecs_service.id,
      aws_security_group.gpu_worker.id,
    ]
    description = "PostgreSQL from application"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "rds-security-group"
  }
}

# Redis 보안 그룹
resource "aws_security_group" "redis" {
  name        = "redis-sg"
  description = "Security group for ElastiCache Redis"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [
      aws_security_group.ecs_service.id,
      aws_security_group.gpu_worker.id,
    ]
    description = "Redis from application"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "redis-security-group"
  }
}

# GPU 워커 보안 그룹
resource "aws_security_group" "gpu_worker" {
  name        = "gpu-worker-sg"
  description = "Security group for GPU worker instances"
  vpc_id      = aws_vpc.main.id

  # SSH (관리자만 - Bastion 호스트 통해서)
  ingress {
    from_port       = 22
    to_port         = 22
    protocol        = "tcp"
    security_groups = [aws_security_group.bastion.id]
    description     = "SSH from bastion"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "gpu-worker-security-group"
  }
}
```

---

## 2. 컴퓨팅 리소스

### 2.1 API 서버 (ECS Fargate)

**왜 Fargate?**
- ✅ 서버 관리 불필요 (서버리스 컨테이너)
- ✅ 자동 스케일링
- ✅ EC2보다 운영 간편
- ✅ CPU 기반 워크로드에 적합

```hcl
# terraform/ecs.tf

# ECS 클러스터
resource "aws_ecs_cluster" "main" {
  name = "invokeai-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"  # CloudWatch Container Insights
  }

  tags = {
    Name = "invokeai-ecs-cluster"
  }
}

# Task Definition
resource "aws_ecs_task_definition" "api" {
  family                   = "invokeai-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "2048"  # 2 vCPU
  memory                   = "4096"  # 4 GB
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name  = "api"
      image = "${aws_ecr_repository.api.repository_url}:latest"

      portMappings = [
        {
          containerPort = 9090
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "ENVIRONMENT"
          value = "production"
        },
        {
          name  = "DB_HOST"
          value = aws_db_instance.main.address
        },
        {
          name  = "REDIS_HOST"
          value = aws_elasticache_cluster.main.cache_nodes[0].address
        },
        {
          name  = "S3_BUCKET"
          value = aws_s3_bucket.images.bucket
        },
      ]

      secrets = [
        {
          name      = "DB_PASSWORD"
          valueFrom = aws_secretsmanager_secret.db_password.arn
        },
        {
          name      = "STRIPE_SECRET_KEY"
          valueFrom = aws_secretsmanager_secret.stripe_key.arn
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = "us-east-1"
          "awslogs-stream-prefix" = "api"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:9090/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])
}

# ECS Service
resource "aws_ecs_service" "api" {
  name            = "invokeai-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2  # 최소 2개 (고가용성)
  launch_type     = "FARGATE"

  network_configuration {
    subnets = [
      aws_subnet.private_app_a.id,
      aws_subnet.private_app_b.id,
    ]
    security_groups  = [aws_security_group.ecs_service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 9090
  }

  # 배포 설정
  deployment_configuration {
    maximum_percent         = 200  # 롤링 업데이트 시 최대 200%
    minimum_healthy_percent = 100  # 최소 100% 유지
  }

  # 자동 스케일링 (나중에 설정)
  # ...

  depends_on = [aws_lb_listener.https]
}
```

**Docker 이미지 빌드:**

```dockerfile
# Dockerfile
FROM python:3.11-slim

# 시스템 의존성
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python 의존성
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 코드
COPY invokeai/ ./invokeai/

# 비루트 사용자로 실행 (보안)
RUN useradd -m -u 1000 invokeai && \
    chown -R invokeai:invokeai /app
USER invokeai

# 헬스 체크 엔드포인트
EXPOSE 9090

CMD ["uvicorn", "invokeai.app.run_app:app", "--host", "0.0.0.0", "--port", "9090"]
```

### 2.2 Application Load Balancer

```hcl
# terraform/alb.tf

# ALB
resource "aws_lb" "main" {
  name               = "invokeai-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]

  subnets = [
    aws_subnet.public_a.id,
    aws_subnet.public_b.id,
  ]

  enable_deletion_protection = true  # 실수로 삭제 방지
  enable_http2               = true

  tags = {
    Name = "invokeai-alb"
  }
}

# Target Group
resource "aws_lb_target_group" "api" {
  name        = "invokeai-api-tg"
  port        = 9090
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"  # Fargate는 IP 타입 사용

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/api/v1/health"
    matcher             = "200"
  }

  deregistration_delay = 30  # 연결 종료 대기 시간

  tags = {
    Name = "invokeai-api-target-group"
  }
}

# HTTPS Listener
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = aws_acm_certificate.main.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# HTTP Listener (HTTPS로 리다이렉트)
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
```

---

## 3. 스토리지 전략

### 3.1 S3 (이미지 저장)

**왜 S3?**
- ✅ 무제한 스토리지
- ✅ 고가용성 (99.999999999%)
- ✅ 저렴한 비용
- ✅ CloudFront 통합 (CDN)

```hcl
# terraform/s3.tf

# 이미지 버킷
resource "aws_s3_bucket" "images" {
  bucket = "invokeai-images-${var.environment}"

  tags = {
    Name = "invokeai-images"
  }
}

# 버전 관리 (선택적 - 실수 삭제 방지)
resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id

  versioning_configuration {
    status = "Enabled"
  }
}

# 암호화
resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 퍼블릭 액세스 차단 (보안)
resource "aws_s3_bucket_public_access_block" "images" {
  bucket = aws_s3_bucket.images.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# 수명 주기 정책 (비용 절감)
resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    id     = "delete-temp-files"
    status = "Enabled"

    filter {
      prefix = "temp/"
    }

    expiration {
      days = 1  # 임시 파일은 1일 후 삭제
    }
  }

  rule {
    id     = "transition-to-glacier"
    status = "Enabled"

    filter {
      prefix = "users/"
    }

    # 90일 후 Glacier로 이동 (저렴한 스토리지)
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
  }
}

# CORS 설정 (프론트엔드 업로드용)
resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "DELETE"]
    allowed_origins = ["https://yourdomain.com"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
```

**백엔드 S3 통합:**

```python
# invokeai/app/services/images/image_files_s3.py
import boto3
from io import BytesIO
from PIL import Image


class S3ImageFileStorage:
    """S3 기반 이미지 저장소"""

    def __init__(self, bucket_name: str, region: str = "us-east-1"):
        self.bucket_name = bucket_name
        self.s3_client = boto3.client("s3", region_name=region)

    def save(
        self,
        user_id: str,
        image_name: str,
        image: Image.Image,
        image_category: str = "general",
    ) -> str:
        """S3에 이미지 저장"""

        # S3 키 (경로) 생성
        # 예: users/user-123/images/general/abc-def-ghi.png
        s3_key = f"users/{user_id}/images/{image_category}/{image_name}.png"

        # PIL Image → Bytes
        buffer = BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        buffer.seek(0)

        # S3 업로드
        self.s3_client.put_object(
            Bucket=self.bucket_name,
            Key=s3_key,
            Body=buffer.getvalue(),
            ContentType="image/png",
            # 메타데이터
            Metadata={
                "user_id": user_id,
                "image_name": image_name,
                "category": image_category,
            },
            # 서버 사이드 암호화
            ServerSideEncryption="AES256",
        )

        return s3_key

    def get(self, s3_key: str) -> Image.Image:
        """S3에서 이미지 로드"""

        # S3 다운로드
        response = self.s3_client.get_object(
            Bucket=self.bucket_name,
            Key=s3_key,
        )

        # Bytes → PIL Image
        image_bytes = response["Body"].read()
        image = Image.open(BytesIO(image_bytes))

        return image

    def delete(self, s3_key: str):
        """S3에서 이미지 삭제"""

        self.s3_client.delete_object(
            Bucket=self.bucket_name,
            Key=s3_key,
        )

    def generate_presigned_url(
        self,
        s3_key: str,
        expiration: int = 3600,
    ) -> str:
        """
        서명된 URL 생성 (일시적 다운로드 링크)

        프론트엔드에서 직접 S3에 접근하도록 허용
        """

        url = self.s3_client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket_name, "Key": s3_key},
            ExpiresIn=expiration,
        )

        return url
```

**API에서 서명된 URL 반환:**

```python
# invokeai/app/api/routers/images.py
@router.get("/{image_name}/url")
async def get_image_url(
    image_name: str,
    user: TokenData = Depends(get_current_user),
    images: ImageService = Depends(ApiDependencies.images),
    s3_storage: S3ImageFileStorage = Depends(ApiDependencies.s3_storage),
) -> ImageUrlResponse:
    """
    이미지 다운로드 URL 생성

    S3에 직접 접근하도록 서명된 URL 반환
    (서버를 거치지 않아 대역폭 절약)
    """

    # 1. 이미지 메타데이터 조회 (권한 체크 포함)
    image_dto = images.get(image_name, user_id=user.user_id)

    # 2. 서명된 URL 생성 (1시간 유효)
    url = s3_storage.generate_presigned_url(
        s3_key=image_dto.s3_key,
        expiration=3600,
    )

    return ImageUrlResponse(url=url, expires_in=3600)
```

### 3.2 ElastiCache (Redis)

**왜 Redis?**
- ✅ Celery 작업 큐
- ✅ 세션 저장
- ✅ 캐싱 (모델 메타데이터 등)
- ✅ Rate Limiting

```hcl
# terraform/elasticache.tf

# Redis 서브넷 그룹
resource "aws_elasticache_subnet_group" "main" {
  name       = "invokeai-redis-subnet-group"
  subnet_ids = [
    aws_subnet.private_data_a.id,
    aws_subnet.private_data_b.id,
  ]
}

# Redis 클러스터
resource "aws_elasticache_cluster" "main" {
  cluster_id           = "invokeai-redis"
  engine               = "redis"
  engine_version       = "7.0"
  node_type            = "cache.t3.medium"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  # 자동 백업
  snapshot_retention_limit = 5
  snapshot_window          = "03:00-05:00"

  # 유지보수 윈도우
  maintenance_window = "sun:05:00-sun:07:00"

  tags = {
    Name = "invokeai-redis"
  }
}

# 프로덕션에서는 Redis Replication Group 사용 (고가용성)
resource "aws_elasticache_replication_group" "main_ha" {
  replication_group_id       = "invokeai-redis-ha"
  replication_group_description = "InvokeAI Redis cluster with replication"

  engine               = "redis"
  engine_version       = "7.0"
  node_type            = "cache.r6g.large"
  num_cache_clusters   = 2  # 1 primary + 1 replica

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  automatic_failover_enabled = true
  multi_az_enabled          = true

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  tags = {
    Name = "invokeai-redis-ha"
  }
}
```

---

## 4. GPU 인스턴스 관리

### 4.1 GPU 인스턴스 선택

**AWS GPU 인스턴스 옵션:**

| 인스턴스 타입 | GPU | VRAM | vCPU | RAM | 시간당 비용* | 용도 |
|------------|-----|------|------|-----|-----------|------|
| **g4dn.xlarge** | T4 | 16GB | 4 | 16GB | $0.526 | 개발/테스트 |
| **g4dn.2xlarge** | T4 | 16GB | 8 | 32GB | $0.752 | 소규모 프로덕션 |
| **g5.xlarge** | A10G | 24GB | 4 | 16GB | $1.006 | 균형잡힌 선택 ✅ |
| **g5.2xlarge** | A10G | 24GB | 8 | 32GB | $1.212 | 중규모 |
| **p3.2xlarge** | V100 | 16GB | 8 | 61GB | $3.06 | 고성능 (비쌈) |
| **p4d.24xlarge** | A100 | 40GB×8 | 96 | 1152GB | $32.77 | 엔터프라이즈 |

*비용은 us-east-1 기준, 변동 가능

**추천: g5.xlarge**
- A10G GPU (SDXL 등 최신 모델 지원)
- 24GB VRAM (충분함)
- 적정 가격
- Spot 인스턴스로 70% 절약 가능

### 4.2 GPU 워커 Auto Scaling

```hcl
# terraform/gpu_workers.tf

# Launch Template
resource "aws_launch_template" "gpu_worker" {
  name_prefix   = "invokeai-gpu-worker-"
  image_id      = data.aws_ami.gpu_ami.id  # Deep Learning AMI
  instance_type = "g5.xlarge"

  # IAM Role
  iam_instance_profile {
    name = aws_iam_instance_profile.gpu_worker.name
  }

  # 네트워크
  network_interfaces {
    associate_public_ip_address = false
    security_groups            = [aws_security_group.gpu_worker.id]
    delete_on_termination      = true
  }

  # 사용자 데이터 (부팅 시 실행)
  user_data = base64encode(templatefile("${path.module}/gpu_worker_userdata.sh", {
    redis_host   = aws_elasticache_cluster.main.cache_nodes[0].address
    s3_bucket    = aws_s3_bucket.images.bucket
    db_host      = aws_db_instance.main.address
    region       = var.aws_region
  }))

  # 스토리지
  block_device_mappings {
    device_name = "/dev/sda1"

    ebs {
      volume_size           = 200  # GB (모델 저장용)
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name = "invokeai-gpu-worker"
      Type = "gpu-worker"
    }
  }
}

# Auto Scaling Group
resource "aws_autoscaling_group" "gpu_workers" {
  name                = "invokeai-gpu-workers"
  vpc_zone_identifier = [
    aws_subnet.private_app_a.id,
    aws_subnet.private_app_b.id,
  ]

  # 용량
  min_size         = 1   # 최소 1대 (항상 실행)
  max_size         = 10  # 최대 10대
  desired_capacity = 2   # 기본 2대

  # Launch Template
  launch_template {
    id      = aws_launch_template.gpu_worker.id
    version = "$Latest"
  }

  # 헬스 체크
  health_check_type         = "EC2"
  health_check_grace_period = 300

  # 인스턴스 교체 전략
  termination_policies = ["OldestInstance"]

  # 태그
  tag {
    key                 = "Name"
    value               = "invokeai-gpu-worker"
    propagate_at_launch = true
  }
}

# Spot 인스턴스 사용 (70% 비용 절감)
resource "aws_autoscaling_group" "gpu_workers_spot" {
  name                = "invokeai-gpu-workers-spot"
  vpc_zone_identifier = [
    aws_subnet.private_app_a.id,
    aws_subnet.private_app_b.id,
  ]

  # Spot 인스턴스 믹스
  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 1  # 최소 1대는 On-Demand
      on_demand_percentage_above_base_capacity = 0  # 나머지는 100% Spot
      spot_allocation_strategy                 = "price-capacity-optimized"
    }

    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.gpu_worker.id
        version            = "$Latest"
      }

      # Spot 대안 인스턴스 타입
      override {
        instance_type = "g5.xlarge"
      }
      override {
        instance_type = "g4dn.2xlarge"
      }
    }
  }

  min_size         = 0
  max_size         = 20
  desired_capacity = 5

  health_check_type         = "EC2"
  health_check_grace_period = 300
}

# 큐 기반 Auto Scaling 정책
resource "aws_autoscaling_policy" "gpu_workers_scale_up" {
  name                   = "scale-up-on-queue-depth"
  autoscaling_group_name = aws_autoscaling_group.gpu_workers.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    customized_metric_specification {
      metric_dimension {
        name  = "QueueName"
        value = "invokeai-generation-queue"
      }

      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      statistic   = "Average"
    }

    target_value = 5.0  # 큐에 5개 이상 작업이 있으면 스케일 업
  }
}
```

**GPU 워커 부팅 스크립트:**

```bash
#!/bin/bash
# gpu_worker_userdata.sh

set -e

# 1. NVIDIA 드라이버 확인 (Deep Learning AMI에는 이미 설치됨)
nvidia-smi

# 2. Docker 시작
systemctl start docker
systemctl enable docker

# 3. 모델 다운로드 (S3에서)
aws s3 sync s3://invokeai-models/sdxl /opt/invokeai/models/sdxl

# 4. Celery Worker 시작
docker run -d \
  --name invokeai-worker \
  --gpus all \
  -e REDIS_HOST=${redis_host} \
  -e S3_BUCKET=${s3_bucket} \
  -e DB_HOST=${db_host} \
  -e AWS_REGION=${region} \
  ${ecr_repo}/invokeai-worker:latest \
  celery -A invokeai.app.celery_app worker \
    --loglevel=info \
    --concurrency=1 \
    --queue=gpu-generation

# 5. CloudWatch 에이전트 시작 (모니터링)
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/config.json
```

---

## 5. 비용 최적화

### 5.1 월간 비용 추정 (초기 단계)

```
컴퓨팅:
- ECS Fargate (API 서버): 2 tasks × $50/month = $100
- GPU 워커 (g5.xlarge Spot): 2 instances × $250/month = $500

데이터베이스:
- RDS PostgreSQL (db.t3.medium): $70/month

캐시:
- ElastiCache Redis (cache.t3.medium): $45/month

스토리지:
- S3 (1TB): $23/month
- RDS 스토리지 (100GB): $12/month

네트워크:
- ALB: $18/month
- 데이터 전송 (1TB): $90/month

기타:
- CloudWatch Logs: $15/month
- Secrets Manager: $2/month

총계: ~$875/month
```

### 5.2 비용 절감 팁

**1) Reserved Instances / Savings Plans**
```hcl
# 1년 약정 시 40% 할인
# Compute Savings Plan 권장
```

**2) Spot 인스턴스**
```
GPU 워커를 Spot으로 실행하여 70% 절감
주의: 중단될 수 있으므로 작업 재시도 로직 필수
```

**3) S3 Lifecycle Policy**
```hcl
# 90일 이후 Glacier로 이동
# 비활성 사용자 데이터는 삭제
```

**4) Auto Scaling 적극 활용**
```
야간/주말에는 GPU 워커 최소화
피크 타임에만 스케일 업
```

**5) CloudFront CDN**
```
이미지를 CloudFront로 캐싱하여 S3 요청 감소
```

---

이제 Phase 3: 구독 및 결제 시스템을 계속 작성할까요?
