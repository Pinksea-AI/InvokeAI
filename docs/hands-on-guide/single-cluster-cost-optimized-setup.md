# 단일 클러스터 비용 최적화 구성 가이드

이 가이드는 **단일 EKS 클러스터 + 네임스페이스 분리 + 공유 RDS** 구성으로 비용을 최적화하면서 개발과 운영 환경을 구축하는 방법을 설명합니다.

## 목차
1. [아키텍처 개요](#아키텍처-개요)
2. [맥북 M2 Max 로컬 환경](#맥북-m2-max-로컬-환경)
3. [단일 클러스터 Terraform](#단일-클러스터-terraform)
4. [네임스페이스 분리 전략](#네임스페이스-분리-전략)
5. [공유 RDS 구성](#공유-rds-구성)
6. [비용 분석](#비용-분석)
7. [운영 시 주의사항](#운영-시-주의사항)

---

## 아키텍처 개요

### 기존 아키텍처 vs 최적화 아키텍처

**기존 (비용 높음)**:
```
┌─────────────────────────────────────┐
│ Dev EKS Cluster                     │
│ - System Nodes: 2x t3.medium        │
│ - GPU Nodes: 0~5x g4dn.xlarge       │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Dev RDS Aurora (2 instances)        │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ Prod EKS Cluster                    │
│ - System Nodes: 3x t3.medium        │
│ - GPU Nodes: 0~10x g4dn.xlarge      │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Prod RDS Aurora (2 instances)       │
└─────────────────────────────────────┘

월 비용: ~$1,800
```

**최적화 (비용 절감)**:
```
┌─────────────────────────────────────────────────┐
│ Single EKS Cluster                              │
│                                                 │
│  ┌──────────────┐      ┌──────────────┐       │
│  │ Namespace:   │      │ Namespace:   │       │
│  │    dev       │      │    prod      │       │
│  │              │      │              │       │
│  │ Services     │      │ Services     │       │
│  │ Workers      │      │ Workers      │       │
│  └──────────────┘      └──────────────┘       │
│                                                 │
│ System Nodes: 2x t3.medium (공유)              │
│ GPU Nodes: Karpenter 자동 스케일링 (공유)      │
└─────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────┐
│ Shared RDS Aurora (1 writer, 1 reader)         │
│ - DB: pingvas_saas                              │
│   - Schema: dev_pingvas (개발)                 │
│   - Schema: prod_pingvas (운영)                │
└─────────────────────────────────────────────────┘

월 비용: ~$680 (62% 절감)
```

### 주요 차이점

| 항목 | 기존 | 최적화 |
|------|------|--------|
| EKS 클러스터 | 2개 | 1개 |
| Control Plane 비용 | $144/월 | $72/월 |
| System 노드 | 5개 | 2개 |
| RDS 인스턴스 | 4개 | 2개 |
| Redis 클러스터 | 2개 | 1개 (dev/prod DB 분리) |
| NAT Gateway | 6개 | 3개 |
| 데이터 전송 | 별도 | 공유 |

---

## 맥북 M2 Max 로컬 환경

### 1. Rosetta 2 설정 (x86 이미지 지원)

```bash
# Rosetta 2 설치 (이미 설치되어 있을 수 있음)
softwareupdate --install-rosetta

# Docker Desktop 설정
# Settings > Features in Development > Use Rosetta for x86/amd64 emulation (체크)
```

---

### 2. Docker Desktop 리소스 할당

맥북 M2 Max 96GB 환경에서 권장 설정:

**Docker Desktop > Preferences > Resources**:
```
CPUs: 8 cores (개발 환경용)
Memory: 32 GB (시스템에 64GB 남김)
Swap: 4 GB
Disk: 100 GB
```

---

### 3. ARM64 네이티브 이미지 사용

로컬 개발 시 ARM64 이미지 사용으로 성능 향상:

`docker-compose.dev.yaml` (ARM64 최적화):
```yaml
version: '3.8'

services:
  postgres:
    image: postgres:17.4
    platform: linux/arm64  # M2 네이티브
    # ... rest of config

  redis:
    image: redis:7.2-alpine
    platform: linux/arm64
    # ... rest of config

  # LocalStack은 x86만 지원
  localstack:
    image: localstack/localstack:latest
    platform: linux/amd64  # Rosetta 2로 실행
    # ... rest of config
```

---

### 4. Python 개발 환경 (ARM64)

```bash
# Python 3.11 ARM64 네이티브 설치
brew install python@3.11

# 확인
python3.11 --version
file $(which python3.11)
# /opt/homebrew/bin/python3.11: Mach-O 64-bit executable arm64

# PyTorch ARM64 (MPS 지원)
pip3 install torch torchvision torchaudio

# 테스트
python3 -c "import torch; print(torch.backends.mps.is_available())"
# True (Metal Performance Shaders 사용 가능)
```

---

### 5. 로컬에서 MPS 활용 테스트

M2 Max의 GPU (38-core)를 활용한 로컬 테스트:

`test_local_mps.py`:
```python
import torch
from diffusers import StableDiffusionPipeline
import time

# MPS (Metal Performance Shaders) 디바이스 사용
device = "mps" if torch.backends.mps.is_available() else "cpu"
print(f"Using device: {device}")

# 모델 로드
pipe = StableDiffusionPipeline.from_pretrained(
    "runwayml/stable-diffusion-v1-5",
    torch_dtype=torch.float16
).to(device)

# 이미지 생성
start = time.time()
image = pipe(
    "A beautiful sunset over mountains",
    num_inference_steps=30
).images[0]

duration = time.time() - start
print(f"Generation time: {duration:.2f}s")

image.save("output.png")
```

**성능 비교**:
- CPU (M2 Max): ~120초
- MPS (M2 Max GPU): ~15초 (8배 빠름)
- AWS g4dn.xlarge (T4): ~8초

---

## 단일 클러스터 Terraform

### 1. 디렉토리 구조

```
infra/terraform/
├── modules/
│   ├── vpc/
│   ├── eks-single/         # 단일 클러스터 모듈
│   ├── rds-shared/         # 공유 RDS 모듈
│   ├── elasticache-shared/ # 공유 Redis 모듈
│   └── s3/
└── environments/
    └── shared/             # dev+prod 통합 환경
        ├── main.tf
        ├── variables.tf
        └── terraform.tfvars
```

---

### 2. 단일 클러스터 모듈

`infra/terraform/modules/eks-single/main.tf`:
```hcl
# EKS Cluster (단일)
resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = concat(var.public_subnet_ids, var.private_subnet_ids)
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  tags = {
    Name        = var.cluster_name
    Environment = "shared"  # dev + prod
  }
}

# System Node Group (공유)
resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-system"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = var.private_subnet_ids

  scaling_config {
    desired_size = 2
    max_size     = 4
    min_size     = 2
  }

  instance_types = ["t3.medium"]
  capacity_type  = "SPOT"  # 비용 절감

  labels = {
    role = "system"
    tier = "shared"
  }

  # Taints 없음 (dev/prod 워크로드 모두 허용)

  tags = {
    Name = "${var.cluster_name}-system-shared"
  }
}

# Karpenter Node IAM Role (GPU 노드용)
# ... (Phase 4와 동일하지만 shared로 태그)
```

---

### 3. 공유 RDS 모듈

`infra/terraform/modules/rds-shared/main.tf`:
```hcl
# RDS Aurora Cluster (단일, dev+prod 공유)
resource "aws_rds_cluster" "shared" {
  cluster_identifier      = "pingvas-shared-aurora"
  engine                  = "aurora-postgresql"
  engine_version          = "15.4"
  database_name           = "pingvas_saas"
  master_username         = var.master_username
  master_password         = var.master_password

  # 비용 최적화: Serverless v2
  engine_mode             = "provisioned"
  serverlessv2_scaling_configuration {
    max_capacity = 4.0  # 최대 4 ACU
    min_capacity = 0.5  # 최소 0.5 ACU (개발 시간 외 절감)
  }

  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]

  backup_retention_period = 7
  preferred_backup_window = "03:00-04:00"

  enabled_cloudwatch_logs_exports = ["postgresql"]
  storage_encrypted               = true

  # 운영 중에는 deletion_protection = true
  deletion_protection = false
  skip_final_snapshot = false
  final_snapshot_identifier = "pingvas-shared-final-snapshot-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"

  tags = {
    Name        = "pingvas-shared-aurora"
    Environment = "shared"
    Purpose     = "dev-and-prod"
  }
}

# Writer Instance (Serverless v2)
resource "aws_rds_cluster_instance" "writer" {
  identifier         = "pingvas-shared-writer"
  cluster_identifier = aws_rds_cluster.shared.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.shared.engine
  engine_version     = aws_rds_cluster.shared.engine_version

  performance_insights_enabled = true

  tags = {
    Name = "pingvas-shared-writer"
    Role = "writer"
  }
}

# Reader Instance (Serverless v2)
resource "aws_rds_cluster_instance" "reader" {
  identifier         = "pingvas-shared-reader"
  cluster_identifier = aws_rds_cluster.shared.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.shared.engine
  engine_version     = aws_rds_cluster.shared.engine_version

  performance_insights_enabled = true

  tags = {
    Name = "pingvas-shared-reader"
    Role = "reader"
  }
}
```

---

### 4. 공유 환경 Main

`infra/terraform/environments/shared/main.tf`:
```hcl
terraform {
  required_version = ">= 1.6"

  backend "s3" {
    bucket = "pingvas-terraform-state"
    key    = "shared/terraform.tfstate"  # 단일 state 파일
    region = "us-east-1"
  }
}

provider "aws" {
  region = "us-east-1"
}

locals {
  cluster_name = "pingvas-shared-eks"
  vpc_cidr     = "10.0.0.0/16"
}

# VPC
module "vpc" {
  source = "../../modules/vpc"

  environment        = "shared"
  vpc_cidr           = local.vpc_cidr
  cluster_name       = local.cluster_name
  enable_nat_gateway = true

  # 비용 절감: NAT Gateway 1개만 (고가용성 필요시 3개)
  single_nat_gateway = true
}

# EKS (단일 클러스터)
module "eks" {
  source = "../../modules/eks-single"

  cluster_name       = local.cluster_name
  kubernetes_version = "1.28"
  public_subnet_ids  = module.vpc.public_subnet_ids
  private_subnet_ids = module.vpc.private_subnet_ids
}

# RDS (공유)
module "rds" {
  source = "../../modules/rds-shared"

  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  allowed_cidr_blocks = [local.vpc_cidr]

  master_username = "pingvas_admin"
  master_password = var.db_password  # Secrets Manager에서 가져오기
}

# ElastiCache (공유, DB 번호로 분리)
module "elasticache" {
  source = "../../modules/elasticache-shared"

  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  allowed_cidr_blocks = [local.vpc_cidr]

  # 단일 Redis 클러스터 (DB 0: dev, DB 1: prod)
  num_cache_nodes = 2  # 고가용성
  node_type       = "cache.r6g.large"
}

# S3 (환경별 버킷)
module "s3" {
  source = "../../modules/s3"

  buckets = {
    dev_images  = "pingvas-dev-images"
    prod_images = "pingvas-prod-images"
    models      = "pingvas-models-shared"  # 모델은 공유
    logs        = "pingvas-logs-shared"
  }
}

# EFS (공유 모델 저장소)
module "efs" {
  source = "../../modules/efs"

  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  allowed_cidr_blocks = [local.vpc_cidr]

  tags = {
    Name = "pingvas-models-shared-efs"
  }
}
```

`infra/terraform/environments/shared/terraform.tfvars`:
```hcl
# DB 비밀번호는 환경변수로 설정
# export TF_VAR_db_password="your_secure_password"
```

---

## 네임스페이스 분리 전략

### 1. 네임스페이스 생성

`k8s/namespaces/namespaces.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: dev
  labels:
    environment: dev
    istio-injection: enabled  # Service Mesh 사용 시
---
apiVersion: v1
kind: Namespace
metadata:
  name: prod
  labels:
    environment: prod
    istio-injection: enabled
```

---

### 2. ResourceQuota (네임스페이스별 리소스 제한)

`k8s/namespaces/dev-quota.yaml`:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: dev-quota
  namespace: dev
spec:
  hard:
    requests.cpu: "20"        # 최대 20 CPU
    requests.memory: 50Gi     # 최대 50GB 메모리
    requests.nvidia.com/gpu: "3"  # 최대 3 GPU
    pods: "50"                # 최대 50 pods
    services: "20"
    persistentvolumeclaims: "10"
```

`k8s/namespaces/prod-quota.yaml`:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: prod-quota
  namespace: prod
spec:
  hard:
    requests.cpu: "50"        # 최대 50 CPU
    requests.memory: 200Gi    # 최대 200GB 메모리
    requests.nvidia.com/gpu: "15"  # 최대 15 GPU
    pods: "200"
    services: "50"
    persistentvolumeclaims: "30"
```

---

### 3. NetworkPolicy (네임스페이스 간 격리)

`k8s/network-policies/deny-cross-namespace.yaml`:
```yaml
# Dev 네임스페이스: Prod로의 트래픽 차단
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-to-prod
  namespace: dev
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    # 같은 네임스페이스 허용
    - to:
      - namespaceSelector:
          matchLabels:
            environment: dev

    # 외부 인터넷 허용 (DNS, AWS APIs 등)
    - to:
      - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443
        - protocol: UDP
          port: 53

    # RDS/Redis 접근 허용 (VPC CIDR)
    - to:
      - ipBlock:
          cidr: 10.0.0.0/16

---
# Prod 네임스페이스: Dev로의 트래픽 차단
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-to-dev
  namespace: prod
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
      - namespaceSelector:
          matchLabels:
            environment: prod
    - to:
      - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443
        - protocol: UDP
          port: 53
    - to:
      - ipBlock:
          cidr: 10.0.0.0/16
```

---

### 4. PriorityClass (Prod 우선순위)

`k8s/priority/priority-classes.yaml`:
```yaml
# Prod 워크로드: 높은 우선순위
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: prod-high
value: 1000000
globalDefault: false
description: "High priority for production workloads"

---
# Prod 시스템: 매우 높은 우선순위
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: prod-critical
value: 2000000
globalDefault: false
description: "Critical priority for production system workloads"

---
# Dev 워크로드: 낮은 우선순위
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: dev-low
value: 100000
globalDefault: false
description: "Low priority for development workloads"
```

**Deployment에 적용**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
  namespace: prod
spec:
  template:
    spec:
      priorityClassName: prod-high  # 우선순위 지정
      containers:
        - name: user-service
          # ...
```

---

## 공유 RDS 구성

### 1. 데이터베이스 스키마 분리

```sql
-- 초기 설정 (Terraform 이후 수동 실행 또는 init container)

-- Dev 스키마
CREATE SCHEMA IF NOT EXISTS dev_pingvas;

-- Prod 스키마
CREATE SCHEMA IF NOT EXISTS prod_pingvas;

-- Dev 전용 사용자 (선택)
CREATE USER dev_user WITH PASSWORD 'dev_password';
GRANT ALL PRIVILEGES ON SCHEMA dev_pingvas TO dev_user;
GRANT USAGE ON SCHEMA dev_pingvas TO dev_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA dev_pingvas
  GRANT ALL ON TABLES TO dev_user;

-- Prod 전용 사용자
CREATE USER prod_user WITH PASSWORD 'prod_password';
GRANT ALL PRIVILEGES ON SCHEMA prod_pingvas TO prod_user;
GRANT USAGE ON SCHEMA prod_pingvas TO prod_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA prod_pingvas
  GRANT ALL ON TABLES TO prod_user;

-- 기본 search_path 설정
ALTER USER dev_user SET search_path TO dev_pingvas, public;
ALTER USER prod_user SET search_path TO prod_pingvas, public;
```

---

### 2. K8s Secret (환경별)

`k8s/secrets/dev-db-credentials.yaml`:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: dev
type: Opaque
stringData:
  DATABASE_URL: "postgresql://dev_user:dev_password@pingvas-shared-writer.xxxxx.us-east-1.rds.amazonaws.com:5432/pingvas_saas?options=-c%20search_path=dev_pingvas"
  DB_SCHEMA: "dev_pingvas"
```

`k8s/secrets/prod-db-credentials.yaml`:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: prod
type: Opaque
stringData:
  DATABASE_URL: "postgresql://prod_user:prod_password@pingvas-shared-writer.xxxxx.us-east-1.rds.amazonaws.com:5432/pingvas_saas?options=-c%20search_path=prod_pingvas"
  DB_SCHEMA: "prod_pingvas"
```

---

### 3. Redis DB 분리

Redis는 단일 클러스터이지만 DB 번호로 분리:

**Dev**: `redis://redis-primary:6379/0`
**Prod**: `redis://redis-primary:6379/1`

`k8s/configmaps/redis-config.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-config
  namespace: dev
data:
  REDIS_URL: "redis://redis-primary.default.svc.cluster.local:6379/0"
  REDIS_DB: "0"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-config
  namespace: prod
data:
  REDIS_URL: "redis://redis-primary.default.svc.cluster.local:6379/1"
  REDIS_DB: "1"
```

---

### 4. 데이터베이스 마이그레이션

환경별 마이그레이션 관리:

`db/migrations/run-migration.sh`:
```bash
#!/bin/bash

ENVIRONMENT=$1  # dev or prod

if [ "$ENVIRONMENT" = "dev" ]; then
    export DATABASE_URL="postgresql://dev_user:dev_password@<RDS_ENDPOINT>:5432/pingvas_saas"
    export DB_SCHEMA="dev_pingvas"
elif [ "$ENVIRONMENT" = "prod" ]; then
    export DATABASE_URL="postgresql://prod_user:prod_password@<RDS_ENDPOINT>:5432/pingvas_saas"
    export DB_SCHEMA="prod_pingvas"
else
    echo "Usage: $0 {dev|prod}"
    exit 1
fi

# Alembic migration
cd services/user-service
alembic upgrade head

echo "Migration completed for $ENVIRONMENT"
```

---

## 비용 분석

### 월별 비용 비교

#### 기존 아키텍처 (별도 클러스터)

| 항목 | 수량 | 단가 | 월 비용 |
|------|------|------|---------|
| **EKS Control Plane** | 2 | $72 | $144 |
| **System Nodes (t3.medium)** | 5 | $30.40 | $152 |
| **RDS Aurora (db.r6g.large)** | 4 | $208 | $832 |
| **ElastiCache (cache.r6g.large)** | 4 | $154 | $616 |
| **NAT Gateway** | 6 | $32.40 | $194.40 |
| **GPU Nodes (평균)** | | | $200 |
| **데이터 전송** | | | $100 |
| **S3 + CloudFront** | | | $80 |
| **총계** | | | **$2,318.40** |

---

#### 최적화 아키텍처 (단일 클러스터)

| 항목 | 수량 | 단가 | 월 비용 | 절감 |
|------|------|------|---------|------|
| **EKS Control Plane** | 1 | $72 | $72 | -$72 |
| **System Nodes (t3.medium Spot)** | 2 | $9.12 | $18.24 | -$133.76 |
| **RDS Aurora Serverless v2** | 2 | $87 | $174 | -$658 |
| **ElastiCache (cache.r6g.large)** | 2 | $154 | $308 | -$308 |
| **NAT Gateway** | 1 | $32.40 | $32.40 | -$162 |
| **GPU Nodes (평균)** | | | $200 | $0 |
| **데이터 전송** | | | $60 | -$40 |
| **S3 + CloudFront** | | | $80 | $0 |
| **총계** | | | **$944.64** | **-$1,373.76** |

**절감율: 59.2%**

---

### 비용 절감 전략

1. **Aurora Serverless v2**
   - 개발 시간 외 자동 Scale-to-Zero (0.5 ACU)
   - 운영 중에만 스케일 업 (최대 4 ACU)
   - 고정 인스턴스 대비 70% 절감

2. **Spot Instances**
   - System 노드: Spot으로 70% 절감
   - GPU 노드: 이미 Spot 사용

3. **단일 NAT Gateway**
   - 개발 환경에서는 고가용성보다 비용 우선
   - 운영 안정화 후 3개로 확장 고려

4. **공유 리소스**
   - EFS: 단일 파일시스템 (모델 공유)
   - S3: 이미지는 분리, 모델은 공유

---

## 운영 시 주의사항

### 1. 리소스 경합 방지

**ResourceQuota 모니터링**:
```bash
# 네임스페이스별 리소스 사용량 확인
kubectl describe quota -n dev
kubectl describe quota -n prod

# 실시간 모니터링
watch kubectl top nodes
watch kubectl top pods -n prod
```

**알람 설정**:
```yaml
# Prometheus Alert
- alert: DevResourceQuotaExceeded
  expr: kube_resourcequota{namespace="dev",type="used"} / kube_resourcequota{namespace="dev",type="hard"} > 0.9
  for: 5m
  annotations:
    summary: "Dev namespace is using >90% of quota"
```

---

### 2. 데이터베이스 접근 제어

**애플리케이션 레벨 검증**:
```python
# services/user-service/app/db/base.py

from sqlalchemy import event, create_engine

engine = create_engine(settings.database_url)

@event.listens_for(engine, "connect")
def enforce_schema(dbapi_conn, connection_record):
    """
    연결 시 스키마 강제
    """
    cursor = dbapi_conn.cursor()

    # 환경에 맞는 스키마만 접근 가능
    if settings.environment == "dev":
        cursor.execute("SET search_path TO dev_pingvas, public")
    elif settings.environment == "prod":
        cursor.execute("SET search_path TO prod_pingvas, public")
    else:
        raise ValueError(f"Invalid environment: {settings.environment}")

    cursor.close()
```

**RDS Parameter Group**:
```hcl
resource "aws_db_parameter_group" "main" {
  name   = "pingvas-shared-params"
  family = "aurora-postgresql15"

  parameter {
    name  = "log_statement"
    value = "ddl"  # DDL 쿼리 로깅 (스키마 변경 감지)
  }

  parameter {
    name  = "log_connections"
    value = "1"  # 연결 로깅
  }
}
```

---

### 3. 배포 순서 (Prod 영향 최소화)

**ArgoCD ApplicationSet 우선순위**:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pingvas-services
spec:
  generators:
    - list:
        elements:
          # Dev 먼저 배포
          - env: dev
            namespace: dev
            syncWave: "1"

          # Prod는 나중에 배포 (수동 승인)
          - env: prod
            namespace: prod
            syncWave: "2"

  template:
    spec:
      syncPolicy:
        automated:
          prune: true
          selfHeal: '{{ if eq .env "dev" }}true{{ else }}false{{ end }}'

        # Prod는 수동 승인 필요
        syncOptions:
          - CreateNamespace=true
```

**GitHub Actions (승인 단계)**:
```yaml
# .github/workflows/cd-prod.yaml

jobs:
  deploy-prod:
    runs-on: ubuntu-latest
    environment: production  # Requires approval

    steps:
      - name: Wait for approval
        uses: trstringer/manual-approval@v1
        with:
          secret: ${{ secrets.GITHUB_TOKEN }}
          approvers: user1,user2
          minimum-approvals: 1
          issue-title: "Deploying v${{ github.ref_name }} to production"
```

---

### 4. 모니터링 분리

**Grafana 대시보드 분리**:
```json
{
  "dashboard": {
    "title": "Production Metrics",
    "panels": [
      {
        "title": "Prod Namespace CPU",
        "targets": [{
          "expr": "sum(rate(container_cpu_usage_seconds_total{namespace=\"prod\"}[5m]))"
        }]
      }
    ]
  }
}
```

**AlertManager 라우팅**:
```yaml
# alertmanager-config.yaml
route:
  routes:
    # Prod 알람: 즉시 발송
    - match:
        namespace: prod
      receiver: pagerduty-prod
      group_wait: 10s
      repeat_interval: 5m

    # Dev 알람: Slack만
    - match:
        namespace: dev
      receiver: slack-dev
      group_wait: 5m
      repeat_interval: 1h
```

---

### 5. 백업 전략

**Prod 스키마만 정기 백업**:
```bash
# backup-prod-schema.sh

#!/bin/bash

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="prod_backup_${TIMESTAMP}.sql"

# Prod 스키마만 덤프
pg_dump \
  -h pingvas-shared-writer.xxxxx.rds.amazonaws.com \
  -U prod_user \
  -d pingvas_saas \
  -n prod_pingvas \
  --format=custom \
  --file=/backups/${BACKUP_FILE}

# S3 업로드
aws s3 cp /backups/${BACKUP_FILE} s3://pingvas-backups/prod/

# 로컬 파일 삭제 (7일 이상)
find /backups -name "prod_backup_*.sql" -mtime +7 -delete

echo "Backup completed: ${BACKUP_FILE}"
```

**CronJob으로 자동화**:
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: prod-db-backup
  namespace: prod
spec:
  schedule: "0 2 * * *"  # 매일 오전 2시
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: postgres:15
              command: ["/scripts/backup-prod-schema.sh"]
              volumeMounts:
                - name: backup-script
                  mountPath: /scripts
          restartPolicy: OnFailure
```

---

### 6. 장애 격리

**Circuit Breaker 패턴**:
```python
# services/generation-service/app/utils/circuit_breaker.py

from circuitbreaker import circuit

@circuit(failure_threshold=5, recovery_timeout=60)
def call_payment_service(user_id: str):
    """
    Payment Service 호출 (실패 시 Circuit Open)
    """
    response = httpx.get(
        f"http://payment-service.{NAMESPACE}.svc.cluster.local:8002/api/v1/credits/balance/{user_id}",
        timeout=5.0
    )
    return response.json()
```

---

## 체크리스트

### 로컬 환경
- [ ] 맥북 M2 Max Docker Desktop 설정 (32GB 메모리)
- [ ] Rosetta 2 활성화
- [ ] ARM64 네이티브 이미지 사용
- [ ] MPS GPU 테스트 성공

### AWS 인프라
- [ ] 단일 EKS 클러스터 생성
- [ ] Spot 인스턴스로 System 노드 구성
- [ ] Aurora Serverless v2 구성
- [ ] 스키마 분리 (dev_pingvas, prod_pingvas)
- [ ] 단일 Redis 클러스터 (DB 0, 1 분리)

### Kubernetes 설정
- [ ] 네임스페이스 생성 (dev, prod)
- [ ] ResourceQuota 적용
- [ ] NetworkPolicy 적용
- [ ] PriorityClass 설정
- [ ] 환경별 Secret/ConfigMap 생성

### 운영
- [ ] 리소스 모니터링 대시보드
- [ ] Prod 알람 설정
- [ ] 백업 자동화
- [ ] 배포 승인 프로세스

---

## 다음 단계

단일 클러스터 구성이 완료되면:

1. **Phase 1 수정판**: M2 Max 최적화 로컬 환경
2. **Phase 3 수정판**: 단일 클러스터 Terraform 적용
3. **Phase 5 수정판**: 네임스페이스 기반 ArgoCD 설정

**👉 다음 문서: [기존 가이드 수정 사항](./migration-updates-required.md)**
