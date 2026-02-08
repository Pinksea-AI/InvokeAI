# InvokeAI SaaS - AWS 배포 및 운영 가이드

> **문서 버전:** v2.0
> **최초 작성:** 2026-02-07 14:26 UTC
> **최종 수정:** 2026-02-08 12:00 UTC (Aurora PostgreSQL 전환, 멀티테넌트 격리, AWS 개발/운영 환경 추가)
> **대상 코드:** InvokeAI v6.11.1.post1 (Pinksea-AI fork)

---

## 목차
1. [AWS 인프라 아키텍처 상세](#1-aws-인프라-아키텍처-상세)
2. [네트워크 구성 (VPC)](#2-네트워크-구성-vpc)
3. [컨테이너 오케스트레이션 (ECS)](#3-컨테이너-오케스트레이션-ecs)
4. [GPU 워커 배포 전략](#4-gpu-워커-배포-전략)
5. [데이터베이스 (Aurora PostgreSQL Serverless v2)](#5-데이터베이스-aurora-postgresql-serverless-v2)
6. [캐시 및 세션 (ElastiCache)](#6-캐시-및-세션-elasticache)
7. [스토리지 (S3 + CloudFront)](#7-스토리지-s3--cloudfront)
8. [모니터링 및 로깅](#8-모니터링-및-로깅)
9. [CI/CD 파이프라인](#9-cicd-파이프라인)
10. [비용 예측 및 최적화](#10-비용-예측-및-최적화)
11. [Terraform IaC 핵심 코드](#11-terraform-iac-핵심-코드)
12. [멀티테넌트 SaaS 격리 아키텍처](#12-멀티테넌트-saas-격리-아키텍처)
13. [AWS 개발/스테이징/운영 환경 구성](#13-aws-개발스테이징운영-환경-구성)

---

## 1. AWS 인프라 아키텍처 상세

```mermaid
graph TB
    subgraph "Internet"
        USERS["Users"]
    end

    subgraph "AWS Cloud - ap-northeast-2 (Seoul)"
        subgraph "Edge Services"
            R53["Route 53"]
            CF["CloudFront CDN"]
            WAF["AWS WAF"]
            ACM["ACM Certificate"]
        end

        subgraph "VPC (10.0.0.0/16)"
            subgraph "Public Subnet A (10.0.1.0/24)"
                NAT_A["NAT Gateway A"]
                ALB_A["ALB Node A"]
            end

            subgraph "Public Subnet B (10.0.2.0/24)"
                NAT_B["NAT Gateway B"]
                ALB_B["ALB Node B"]
            end

            subgraph "Private Subnet A (10.0.11.0/24)"
                API_A["API Container A"]
                GW_A["GPU Worker A"]
            end

            subgraph "Private Subnet B (10.0.12.0/24)"
                API_B["API Container B"]
                GW_B["GPU Worker B"]
            end

            subgraph "Data Subnet A (10.0.21.0/24)"
                AURORA_W["Aurora Writer"]
                REDIS_A["Redis Primary"]
            end

            subgraph "Data Subnet B (10.0.22.0/24)"
                AURORA_R["Aurora Reader"]
                REDIS_B["Redis Replica"]
            end
        end

        subgraph "Serverless"
            SQS["SQS FIFO Queue"]
            COG["Cognito User Pool"]
            SM["Secrets Manager"]
            CW["CloudWatch"]
        end

        subgraph "Storage"
            S3_IMG["S3 - Images"]
            S3_MDL["S3 - Models"]
            S3_FE["S3 - Frontend"]
            EFS["EFS - Model Cache"]
        end
    end

    USERS --> R53
    R53 --> CF
    CF --> WAF
    WAF --> ALB_A
    WAF --> ALB_B
    CF --> S3_FE

    ALB_A --> API_A
    ALB_B --> API_B

    API_A --> SQS
    API_B --> SQS
    API_A --> AURORA_W
    API_B --> AURORA_W
    API_A --> AURORA_R
    API_B --> AURORA_R
    API_A --> REDIS_A
    API_B --> REDIS_A
    API_A --> COG

    SQS --> GW_A
    SQS --> GW_B
    GW_A --> S3_IMG
    GW_B --> S3_IMG
    GW_A --> EFS
    GW_B --> EFS

    AURORA_W -.->|"Auto Replication"| AURORA_R
    REDIS_A -.->|"Replication"| REDIS_B

    style GW_A fill:#ff6b6b,color:#fff
    style GW_B fill:#ff6b6b,color:#fff
    style AURORA_W fill:#4ecdc4,color:#fff
    style AURORA_R fill:#45b7d1,color:#fff
    style S3_IMG fill:#ffa502,color:#fff
```

---

## 2. 네트워크 구성 (VPC)

### 2.1 서브넷 설계

| 서브넷 | CIDR | 유형 | 용도 |
|--------|------|------|------|
| Public-A | 10.0.1.0/24 | Public | ALB, NAT Gateway |
| Public-B | 10.0.2.0/24 | Public | ALB, NAT Gateway |
| Private-A | 10.0.11.0/24 | Private | API Containers, GPU Workers |
| Private-B | 10.0.12.0/24 | Private | API Containers, GPU Workers |
| Data-A | 10.0.21.0/24 | Private | Aurora PostgreSQL, ElastiCache |
| Data-B | 10.0.22.0/24 | Private | Aurora PostgreSQL, ElastiCache |

### 2.2 보안 그룹

| 보안 그룹 | Inbound | Outbound | 용도 |
|-----------|---------|----------|------|
| sg-alb | 80, 443 from 0.0.0.0/0 | All | ALB |
| sg-api | 8080 from sg-alb | All | API 컨테이너 |
| sg-gpu | - | All | GPU 워커 (SQS polling) |
| sg-aurora | 5432 from sg-api, sg-gpu | - | Aurora PostgreSQL |
| sg-redis | 6379 from sg-api, sg-gpu | - | Redis |
| sg-efs | 2049 from sg-gpu | - | EFS (NFS) |

### 2.3 동기/비동기 처리 분리와 네트워크 설계

InvokeAI의 **동기 처리 중심 아키텍처**를 SaaS로 전환할 때, 네트워크 수준에서 동기/비동기 워크로드를 분리해야 합니다.

```mermaid
flowchart TB
    subgraph "비동기 워크로드 (API - ECS Fargate)"
        direction TB
        ALB["ALB<br/>(L7 로드밸런싱)"]
        API1["API Container 1<br/>asyncio + asyncpg"]
        API2["API Container 2<br/>asyncio + asyncpg"]

        ALB --> API1
        ALB --> API2
    end

    subgraph "비동기 데이터 계층"
        AURORA["Aurora PostgreSQL<br/>(Serverless v2, asyncpg 연결 풀)"]
        REDIS["ElastiCache Redis<br/>(비동기 pub/sub)"]
        S3["S3<br/>(aioboto3 비동기)"]
    end

    subgraph "큐 계층 (비동기→동기 경계)"
        SQS_STD["SQS Standard<br/>(일반 작업)"]
        SQS_PRI["SQS FIFO<br/>(우선순위 작업)"]
    end

    subgraph "동기 워크로드 (GPU - EC2 인스턴스)"
        direction TB
        W1["GPU Worker 1<br/>동기 PyTorch<br/>독립 모델 캐시"]
        W2["GPU Worker 2<br/>동기 PyTorch<br/>독립 모델 캐시"]
        EFS["EFS<br/>(공유 모델 파일)"]

        W1 --> EFS
        W2 --> EFS
    end

    API1 --> AURORA
    API2 --> AURORA
    API1 --> REDIS
    API2 --> REDIS
    API1 --> S3
    API1 --> SQS_STD
    API1 --> SQS_PRI

    SQS_STD --> W1
    SQS_PRI --> W2
    W1 --> S3
    W2 --> S3
    W1 --> REDIS
    W2 --> REDIS

    style API1 fill:#4ecdc4,color:#fff
    style API2 fill:#4ecdc4,color:#fff
    style W1 fill:#ff6b6b,color:#fff
    style W2 fill:#ff6b6b,color:#fff
    style SQS_STD fill:#ffa502,color:#fff
    style SQS_PRI fill:#ffa502,color:#fff
```

**분리 설계 원칙:**

| 워크로드 | 처리 방식 | 인프라 | 스케일링 기준 |
|----------|----------|--------|-------------|
| API 요청 처리 | 비동기 (asyncio) | ECS Fargate | 동시 연결 수 |
| DB 쿼리 | 비동기 (asyncpg) | Aurora PostgreSQL Serverless v2 | ACU 자동 스케일링 |
| 파일 I/O | 비동기 (aioboto3) | S3 | 요청 수 |
| 이벤트 브로드캐스트 | 비동기 (Redis pub/sub) | ElastiCache | 메시지 수 |
| GPU 추론 | **동기** (PyTorch) | EC2 GPU | SQS 큐 깊이 |
| 모델 로딩 | **동기** (safetensors) | EFS + GPU VRAM | GPU 메모리 |
| 이미지 디코딩 | **동기** (PIL - CPU 바운드) | GPU Worker CPU | - |

---

## 3. 컨테이너 오케스트레이션 (ECS)

### 3.1 API 서비스 (ECS Fargate) - 비동기 최적화

> **중요**: 현재 InvokeAI API 서버는 async 핸들러 내에서 동기 SQLite 호출을 하여 이벤트 루프를 블로킹합니다. SaaS에서는 모든 DB/파일 I/O를 비동기로 전환하여 Fargate 인스턴스의 동시 처리 성능을 극대화해야 합니다.

```dockerfile
# docker/Dockerfile.api
FROM python:3.12-slim

WORKDIR /app

# 시스템 의존성
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Python 의존성 설치 (GPU 불필요)
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv pip install --system ".[cpu]"

# 소스 코드 복사
COPY invokeai/ ./invokeai/

# 환경변수
ENV INVOKEAI_HOST=0.0.0.0
ENV INVOKEAI_PORT=8080
ENV INVOKEAI_DEVICE=cpu
ENV DEPLOYMENT_MODE=saas

# 헬스 체크
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8080/api/v1/app/version || exit 1

EXPOSE 8080
CMD ["python", "-m", "invokeai.app.run_app"]
```

### 3.2 ECS Task Definition (API)

```json
{
  "family": "invokeai-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "4096",
  "executionRoleArn": "arn:aws:iam::role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::role/invokeaiApiTaskRole",
  "containerDefinitions": [
    {
      "name": "invokeai-api",
      "image": "ECR_REPO_URI:latest",
      "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
      "environment": [
        {"name": "DEPLOYMENT_MODE", "value": "saas"},
        {"name": "DATABASE_URL", "value": "from-secrets"},
        {"name": "REDIS_URL", "value": "from-secrets"},
        {"name": "SQS_QUEUE_URL", "value": "from-secrets"},
        {"name": "S3_BUCKET", "value": "invokeai-saas-images"},
        {"name": "AWS_REGION", "value": "ap-northeast-2"}
      ],
      "secrets": [
        {"name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:..."},
        {"name": "STRIPE_SECRET_KEY", "valueFrom": "arn:aws:secretsmanager:..."},
        {"name": "COGNITO_CLIENT_SECRET", "valueFrom": "arn:aws:secretsmanager:..."}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/invokeai-api",
          "awslogs-region": "ap-northeast-2",
          "awslogs-stream-prefix": "api"
        }
      }
    }
  ]
}
```

---

## 4. GPU 워커 배포 전략

> **중요**: GPU 워커는 **동기 실행을 유지**합니다. PyTorch GPU 연산, 모델 로딩, 디노이징 루프는 본질적으로 동기적이며 비동기 전환이 불가능합니다. 대신 **프로세스 단위 수평 확장**으로 동시 처리를 달성합니다. 각 워커는 독립적인 모델 캐시를 갖고, SQS 큐에서 작업을 폴링하여 순차 실행합니다.

### 4.1 GPU 인스턴스 매핑

| GPU 티어 | 대상 플랜 | GPU 타입 | EC2 인스턴스 | GPU VRAM | 시간당 비용 | GPU 비용/초 |
|----------|----------|----------|-------------|----------|------------|------------|
| Basic | Trial / Starter / Tester | NVIDIA T4 | g4dn.xlarge | 16GB | ~$0.526/hr | ~$0.000146 |
| High-Performance | Pro / Studio | NVIDIA A10G | g5.xlarge | 24GB | ~$1.006/hr | ~$0.000279 |
| Dedicated | Enterprise | NVIDIA A100 | p4d.24xlarge | 40GB | ~$32.77/hr | ~$0.009103 |

**크레딧 경제학:**
- 1 크레딧 = 1초 GPU 시간
- GPU 원가: ~$0.0014/초 (T4 기준 가중 평균)
- 과금 단가: $0.005/초 (1 크레딧)
- 마진: ~72%

### 4.2 GPU 워커 Dockerfile

```dockerfile
# docker/Dockerfile.gpu-worker
FROM nvidia/cuda:12.8.0-runtime-ubuntu22.04

WORKDIR /app

# Python + 시스템 의존성
RUN apt-get update && apt-get install -y \
    python3.12 python3.12-venv python3-pip \
    libgl1-mesa-glx libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# PyTorch + InvokeAI 설치 (CUDA 포함)
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv pip install --system ".[cuda]"

# 소스 코드
COPY invokeai/ ./invokeai/

# EFS 마운트 포인트 (공유 모델)
RUN mkdir -p /models

ENV NVIDIA_VISIBLE_DEVICES=all
ENV DEPLOYMENT_MODE=saas
ENV MODEL_DIR=/models

CMD ["python", "-m", "invokeai.worker.gpu_worker"]
```

### 4.3 오토스케일링 정책

```mermaid
flowchart LR
    subgraph "Auto Scaling"
        CW["CloudWatch Alarm<br/>SQS Queue Depth > 10"]
        ASG["Auto Scaling Group"]
        MIN["Min: 1 instance"]
        MAX["Max: 10 instances"]
        DESIRED["Desired: Based on Queue"]
    end

    CW -->|"Scale Up"| ASG
    ASG --> MIN
    ASG --> MAX
    ASG --> DESIRED
```

**스케일링 규칙:**
- SQS 대기 메시지 > 10: +1 인스턴스 (5분 쿨다운)
- SQS 대기 메시지 > 50: +3 인스턴스 (3분 쿨다운)
- SQS 대기 메시지 < 3 (10분 유지): -1 인스턴스

---

## 5. 데이터베이스 (Aurora PostgreSQL Serverless v2)

> **왜 Aurora PostgreSQL Serverless v2인가?**
> InvokeAI는 로컬 단일 사용자용 SQLite를 사용하지만, 멀티테넌트 SaaS에서는 동시 접속, 데이터 격리, 고가용성이 필수입니다. Aurora PostgreSQL Serverless v2는 이 모든 요구사항을 충족하며, 트래픽에 따라 자동으로 스케일링됩니다.

### 5.1 Aurora PostgreSQL Serverless v2 설정

| 설정 | 값 |
|------|-----|
| 엔진 | Aurora PostgreSQL 16 (Serverless v2) |
| 최소 ACU | 0.5 ACU (유휴 시 비용 최소화) |
| 최대 ACU | 32 ACU (피크 트래픽 대응) |
| Writer 인스턴스 | 1 (AZ-A) |
| Reader 인스턴스 | 1 (AZ-B, 읽기 부하 분산 + 장애 조치) |
| 스토리지 | 자동 확장 (10GB~128TB, 사용한 만큼 과금) |
| 백업 보존 | 7일 (자동 스냅샷) |
| 암호화 | AWS KMS (저장 시 암호화, 전송 시 TLS) |
| Performance Insights | Enabled |
| 장애 조치 시간 | < 30초 (자동) |

**Aurora vs RDS 비교 (SaaS 관점):**

| 항목 | RDS PostgreSQL | Aurora PostgreSQL Serverless v2 |
|------|---------------|-------------------------------|
| 스케일링 | 수동 인스턴스 변경 (다운타임 필요) | **ACU 자동 스케일링 (무중단)** |
| 고가용성 | Multi-AZ (수동 페일오버) | **자동 페일오버 < 30초** |
| 복제본 | 최대 5개 (별도 설정) | **최대 15개 Reader (자동)** |
| 스토리지 | gp3 수동 할당 (100GB~) | **자동 확장 10GB~128TB** |
| 비용 (유휴) | 인스턴스 24/7 과금 | **0.5 ACU부터 (초당 과금)** |
| 연결 풀링 | 별도 PgBouncer 필요 | **RDS Proxy 내장 지원** |
| 멀티테넌트 RLS | 지원 | **지원 (동일 PostgreSQL)** |

### 5.2 Aurora 연결 설정

```python
# invokeai/app/services/shared/postgres/connection.py
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

# Aurora PostgreSQL Serverless v2 연결 문자열
# Writer 엔드포인트: 쓰기/읽기 (PRIMARY)
# Reader 엔드포인트: 읽기 전용 (REPLICA)
AURORA_WRITER_URL = "postgresql+asyncpg://invokeai_admin:{password}@invokeai-saas-db.cluster-xxxxx.ap-northeast-2.rds.amazonaws.com:5432/invokeai"
AURORA_READER_URL = "postgresql+asyncpg://invokeai_admin:{password}@invokeai-saas-db.cluster-ro-xxxxx.ap-northeast-2.rds.amazonaws.com:5432/invokeai"

# Writer 엔진 (INSERT/UPDATE/DELETE)
writer_engine = create_async_engine(
    AURORA_WRITER_URL,
    pool_size=20,
    max_overflow=10,
    pool_timeout=30,
    pool_recycle=1800,  # Aurora 유휴 연결 정리
    echo=False,
)

# Reader 엔진 (SELECT 전용 - 읽기 부하 분산)
reader_engine = create_async_engine(
    AURORA_READER_URL,
    pool_size=30,  # 읽기 요청이 더 많으므로 풀 크게
    max_overflow=15,
    pool_timeout=30,
    pool_recycle=1800,
    echo=False,
)

WriterSession = async_sessionmaker(writer_engine, expire_on_commit=False)
ReaderSession = async_sessionmaker(reader_engine, expire_on_commit=False)
```

### 5.3 초기 스키마 마이그레이션 스크립트

```sql
-- 01_initial_schema.sql
-- 기존 SQLite 스키마를 Aurora PostgreSQL로 변환 + SaaS 멀티테넌트 확장

-- 사용자 테이블
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    cognito_sub VARCHAR(255) UNIQUE NOT NULL,
    avatar_url TEXT,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_cognito_sub ON users(cognito_sub);

-- 이미지 테이블 (기존 + user_id + S3)
CREATE TABLE images (
    image_name VARCHAR(255) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    image_origin VARCHAR(50) NOT NULL,
    image_category VARCHAR(50) NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    session_id VARCHAR(255),
    node_id VARCHAR(255),
    metadata JSONB,
    is_intermediate BOOLEAN DEFAULT FALSE,
    starred BOOLEAN DEFAULT FALSE,
    has_workflow BOOLEAN DEFAULT FALSE,
    workflow JSONB,
    graph JSONB,
    s3_key VARCHAR(512),
    s3_thumbnail_key VARCHAR(512),
    file_size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_images_user_id ON images(user_id);
CREATE INDEX idx_images_created_at ON images(created_at);
CREATE INDEX idx_images_category ON images(image_category);
CREATE INDEX idx_images_starred ON images(starred);

-- 멀티테넌트 격리: RLS 활성화
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
CREATE POLICY images_user_isolation ON images
    USING (user_id = current_setting('app.current_user_id')::UUID);
CREATE POLICY images_admin_bypass ON images TO app_admin USING (TRUE);

-- 구독 플랜 테이블
CREATE TABLE subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    plan_type VARCHAR(20) NOT NULL DEFAULT 'paid',
    monthly_price DECIMAL(10,2) NOT NULL,
    annual_price DECIMAL(10,2),
    monthly_credits INTEGER NOT NULL,
    gpu_tier VARCHAR(30) NOT NULL,
    max_queues INTEGER NOT NULL DEFAULT 1,
    max_storage_gb INTEGER NOT NULL,
    model_access VARCHAR(30) NOT NULL DEFAULT 'sd_only',
    third_party_api_access BOOLEAN DEFAULT FALSE,
    lora_training BOOLEAN DEFAULT FALSE,
    collaboration BOOLEAN DEFAULT FALSE,
    node_editor_access BOOLEAN DEFAULT FALSE,
    api_access BOOLEAN DEFAULT FALSE,
    features JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 기본 플랜 데이터 삽입 (1 credit = 1초 GPU 시간)
INSERT INTO subscription_plans (name, slug, plan_type, monthly_price, monthly_credits, gpu_tier, max_queues, max_storage_gb, model_access, third_party_api_access, lora_training, collaboration, node_editor_access, api_access) VALUES
('Starter', 'starter', 'paid', 25.00, 5000, 'basic', 1, 20, 'sd_only', FALSE, FALSE, FALSE, TRUE, FALSE),
('Pro', 'pro', 'paid', 75.00, 15000, 'high_performance', 1, 100, 'flux_included', TRUE, FALSE, FALSE, TRUE, TRUE),
('Studio', 'studio', 'paid', 150.00, 30000, 'high_performance', 3, 200, 'flux_included', TRUE, FALSE, FALSE, TRUE, TRUE),
('Enterprise', 'enterprise', 'paid', 0, 0, 'dedicated', 0, 0, 'full', TRUE, TRUE, TRUE, TRUE, TRUE),
('Tester', 'tester', 'internal', 0, 50000, 'basic', 1, 20, 'flux_included', TRUE, FALSE, FALSE, TRUE, TRUE),
('Trial', 'trial', 'trial', 0, 500, 'basic', 1, 20, 'sd_only', FALSE, FALSE, FALSE, TRUE, FALSE);

-- Note: Enterprise 플랜은 custom 설정이므로 관리자가 별도 설정
-- Note: Tester 플랜은 관리자가 기존 유저에게 수동 부여

-- 사용자 구독 테이블
CREATE TABLE user_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    stripe_subscription_id VARCHAR(255),
    stripe_customer_id VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    trial_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_subs_user_id ON user_subscriptions(user_id);
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subs_user_isolation ON user_subscriptions
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- 크레딧 테이블
CREATE TABLE credits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    total_credits INTEGER NOT NULL,
    used_credits INTEGER NOT NULL DEFAULT 0,
    source VARCHAR(30) NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credits_user_id ON credits(user_id);
CREATE INDEX idx_credits_valid ON credits(valid_from, valid_until);
ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
CREATE POLICY credits_user_isolation ON credits
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- 크레딧 거래 내역
CREATE TABLE credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    credit_id UUID NOT NULL REFERENCES credits(id),
    amount INTEGER NOT NULL,
    transaction_type VARCHAR(30) NOT NULL,
    description TEXT NOT NULL,
    reference_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_tx_user_id ON credit_transactions(user_id);
CREATE INDEX idx_credit_tx_created ON credit_transactions(created_at);
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_tx_user_isolation ON credit_transactions
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- 사용 기록
CREATE TABLE usage_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    job_id VARCHAR(255),
    action_type VARCHAR(30) NOT NULL,
    model_used VARCHAR(255) NOT NULL,
    gpu_tier VARCHAR(20) NOT NULL,
    steps INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    batch_size INTEGER NOT NULL,
    compute_seconds FLOAT NOT NULL,
    credits_consumed INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_user_id ON usage_records(user_id);
CREATE INDEX idx_usage_created ON usage_records(created_at);
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_user_isolation ON usage_records
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- 결제
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    stripe_payment_intent_id VARCHAR(255) UNIQUE,
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    status VARCHAR(20) NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_user_isolation ON payments
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- 테스터 플랜 부여
CREATE TABLE tester_plan_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES users(id),
    target_user_id UUID NOT NULL REFERENCES users(id),
    credits_granted INTEGER NOT NULL DEFAULT 50000,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API 키
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    key_hash VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(8) NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_keys_user_isolation ON api_keys
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- updated_at 자동 갱신 함수
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 각 테이블에 트리거 적용
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_images_updated_at BEFORE UPDATE ON images FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_user_subs_updated_at BEFORE UPDATE ON user_subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_credits_updated_at BEFORE UPDATE ON credits FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

---

## 6. 캐시 및 세션 (ElastiCache)

### 6.1 Redis 용도

| 용도 | Key 패턴 | TTL | 설명 |
|------|---------|-----|------|
| 세션 토큰 | `session:{user_id}` | 1h | 사용자 세션 |
| 크레딧 캐시 | `credit_balance:{user_id}` | 5m | 크레딧 잔액 캐시 |
| 작업 상태 | `job:{job_id}:status` | 24h | GPU 작업 상태 |
| Rate Limit | `ratelimit:{user_id}:{endpoint}` | 1m | API 레이트 제한 |
| Socket.IO | `socketio:*` | - | Socket.IO Redis adapter |
| 모델 캐시 키 | `model_cache:{model_key}` | 1h | 모델 위치 캐시 |
| 플랜 캐시 | `plan:{user_id}` | 10m | 사용자 플랜 정보 캐시 |

### 6.2 Socket.IO Redis Adapter

```python
# Socket.IO를 여러 API 인스턴스 간 공유하기 위해 Redis adapter 사용
import socketio

# 기존 (단일 인스턴스):
# sio = socketio.AsyncServer(async_mode='asgi')

# SaaS (Redis adapter):
mgr = socketio.AsyncRedisManager(
    f"redis://{config.redis_host}:6379/0"
)
sio = socketio.AsyncServer(
    async_mode='asgi',
    client_manager=mgr,
)
```

---

## 7. 스토리지 (S3 + CloudFront)

### 7.1 S3 버킷 구조

```
invokeai-saas-images/
├── users/
│   ├── {user_id}/
│   │   ├── images/
│   │   │   ├── {image_name}.png
│   │   │   └── thumbnails/
│   │   │       └── {image_name}.webp
│   │   └── uploads/
│   │       └── {upload_id}.png
├── models/
│   ├── shared/              # 공용 기본 모델
│   │   ├── sd-1.5/
│   │   ├── sdxl/
│   │   └── flux/
│   └── users/               # 사용자 커스텀 모델
│       └── {user_id}/
└── system/
    ├── style_presets/
    └── default_workflows/
```

### 7.2 CloudFront 배포

```
CloudFront Distribution:
  - Origin 1: S3 (images) - /images/*
  - Origin 2: S3 (frontend) - /*
  - Origin 3: ALB (API) - /api/*

  Behaviors:
    /api/*:         -> ALB, no cache
    /images/*:      -> S3, cache 1 year (signed URLs)
    /static/*:      -> S3, cache 1 year
    /*:             -> S3 (frontend), cache 1 hour
```

---

## 8. 모니터링 및 로깅

### 8.1 CloudWatch 대시보드 구성

```mermaid
graph TB
    subgraph "CloudWatch Dashboard"
        subgraph "API Metrics"
            M1["Request Count"]
            M2["Latency P50/P90/P99"]
            M3["Error Rate (4xx/5xx)"]
            M4["Active Connections"]
        end

        subgraph "GPU Metrics"
            M5["GPU Utilization %"]
            M6["GPU Memory Usage"]
            M7["Job Processing Time"]
            M8["Queue Depth"]
        end

        subgraph "Business Metrics"
            M9["Active Users"]
            M10["Images Generated/hr"]
            M11["Credit Usage"]
            M12["Revenue MRR"]
        end

        subgraph "Infrastructure"
            M13["ECS CPU/Memory"]
            M14["Aurora ACU Usage"]
            M15["Redis Memory"]
            M16["S3 Storage Size"]
        end
    end
```

### 8.2 알람 설정

| 알람 | 조건 | 심각도 | 액션 |
|------|------|--------|------|
| API Error Rate | > 5% (5분) | Critical | SNS -> PagerDuty |
| API Latency | P99 > 5s | High | SNS -> Slack |
| GPU Queue Depth | > 100 | High | Auto Scale + SNS |
| Aurora ACU | > 80% max ACU (10분) | High | SNS -> Slack |
| Aurora Connections | > 80% max | Critical | SNS -> PagerDuty |
| Aurora Replication Lag | > 100ms | Medium | SNS -> Slack |
| Redis Memory | > 80% | Medium | SNS -> Slack |
| S3 Error Rate | > 1% | Medium | SNS -> Slack |
| Credit Balance Low | user credits < 10 | Info | Email to user |

---

## 9. CI/CD 파이프라인

### 9.1 GitHub Actions 워크플로우

```mermaid
flowchart LR
    subgraph "Development"
        PR["Pull Request"] --> LINT["Lint + Type Check"]
        LINT --> TEST["Unit Tests"]
        TEST --> BUILD["Docker Build"]
    end

    subgraph "Staging"
        BUILD --> ECR_S["Push to ECR<br/>(staging)"]
        ECR_S --> DEPLOY_S["Deploy to<br/>ECS Staging"]
        DEPLOY_S --> MIGRATE["Alembic<br/>DB Migration"]
        MIGRATE --> E2E["E2E Tests"]
    end

    subgraph "Production"
        E2E --> APPROVE["Manual Approval"]
        APPROVE --> ECR_P["Push to ECR<br/>(production)"]
        ECR_P --> MIGRATE_P["Alembic<br/>DB Migration"]
        MIGRATE_P --> DEPLOY_P["Deploy to<br/>ECS Production"]
        DEPLOY_P --> HEALTH["Health Check"]
        HEALTH --> DONE["Done"]
    end

    HEALTH -->|"Fail"| ROLLBACK["Auto Rollback"]
```

### 9.2 DB 마이그레이션 전략

```bash
# Alembic 마이그레이션은 ECS 배포 전에 별도 태스크로 실행
# 이렇게 하면 API 서버 롤백 시 DB 변경을 별도로 관리할 수 있음

# Staging에서 마이그레이션 실행
aws ecs run-task \
  --cluster invokeai-staging \
  --task-definition invokeai-migrate \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-aurora]}"

# Production에서 마이그레이션 실행 (승인 후)
aws ecs run-task \
  --cluster invokeai-production \
  --task-definition invokeai-migrate \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-aurora]}"
```

---

## 10. 비용 예측 및 최적화

### 10.1 월간 비용 예측 (100 DAU 기준)

| 서비스 | 스펙 | 월 예상 비용 |
|--------|------|-------------|
| **ECS Fargate (API)** | 2x (2vCPU, 4GB) 24/7 | ~$150 |
| **EC2 GPU Basic (T4)** | 2x g4dn.xlarge (Trial/Starter/Tester, 평균 12h/day) | ~$380 |
| **EC2 GPU High-Perf (A10G)** | 1x g5.xlarge (Pro/Studio, 평균 8h/day) | ~$240 |
| **Aurora PostgreSQL Serverless v2** | Writer 1 + Reader 1 (평균 4 ACU) | ~$350 |
| **ElastiCache Redis** | cache.r6g.large | ~$200 |
| **S3** | 500GB + 전송 | ~$20 |
| **CloudFront** | 1TB 전송 | ~$85 |
| **EFS** | 200GB (모델) | ~$60 |
| **SQS** | ~100K messages/month | ~$1 |
| **Cognito** | 100 MAU (free tier) | $0 |
| **Route 53** | 1 hosted zone | ~$1 |
| **CloudWatch** | 기본 메트릭 + 로그 | ~$30 |
| **WAF** | Basic rules | ~$10 |
| **Secrets Manager** | 5 secrets | ~$3 |
| **합계** | | **~$1,530/월** |

> **Aurora 비용 참고:** Serverless v2는 사용한 ACU만큼 과금. 유휴 시 0.5 ACU (~$43/월)까지 내려가고, 피크 시 자동으로 올라감. RDS 고정 인스턴스($400/월) 대비 초기 비용이 낮고, 트래픽 증가에 자동 대응.

### 10.2 비용 최적화 전략

1. **Spot 인스턴스**: GPU 워커에 Spot 활용 (최대 70% 절약)
2. **Aurora 자동 스케일링**: 유휴 시 0.5 ACU까지 자동 축소 (RDS 대비 ~50% 절약 가능)
3. **Savings Plans**: Fargate Compute Savings Plans (최대 20% 절약)
4. **S3 Lifecycle**: 30일 이상 미접근 이미지 → S3 Infrequent Access
5. **GPU 스케일 다운**: 새벽 시간대 GPU 인스턴스 축소

---

## 11. Terraform IaC 핵심 코드

### 11.1 VPC 모듈

```hcl
# terraform/modules/vpc/main.tf
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "invokeai-saas-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["ap-northeast-2a", "ap-northeast-2b"]
  public_subnets  = ["10.0.1.0/24", "10.0.2.0/24"]
  private_subnets = ["10.0.11.0/24", "10.0.12.0/24"]
  database_subnets = ["10.0.21.0/24", "10.0.22.0/24"]

  enable_nat_gateway     = true
  single_nat_gateway     = false
  one_nat_gateway_per_az = true

  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Environment = "production"
    Project     = "invokeai-saas"
  }
}
```

### 11.2 Aurora PostgreSQL Serverless v2 모듈

```hcl
# terraform/modules/aurora/main.tf

# Aurora 클러스터
resource "aws_rds_cluster" "invokeai" {
  cluster_identifier     = "invokeai-saas-db"
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"  # Serverless v2는 provisioned 모드 + serverlessv2_scaling
  engine_version         = "16.3"
  database_name          = "invokeai"
  master_username        = "invokeai_admin"
  master_password        = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.invokeai.name
  vpc_security_group_ids = [var.sg_aurora_id]

  storage_encrypted      = true
  kms_key_id             = var.kms_key_arn

  backup_retention_period = 7
  preferred_backup_window = "03:00-04:00"
  deletion_protection     = true

  # Serverless v2 스케일링 설정
  serverlessv2_scaling_configuration {
    min_capacity = 0.5   # 유휴 시 최소 ACU
    max_capacity = 32    # 피크 시 최대 ACU
  }

  tags = {
    Environment = "production"
    Project     = "invokeai-saas"
  }
}

# Writer 인스턴스
resource "aws_rds_cluster_instance" "writer" {
  identifier           = "invokeai-saas-db-writer"
  cluster_identifier   = aws_rds_cluster.invokeai.id
  instance_class       = "db.serverless"  # Serverless v2
  engine               = aws_rds_cluster.invokeai.engine
  engine_version       = aws_rds_cluster.invokeai.engine_version

  performance_insights_enabled = true

  tags = {
    Name = "invokeai-aurora-writer"
    Role = "writer"
  }
}

# Reader 인스턴스 (읽기 부하 분산 + 장애 조치)
resource "aws_rds_cluster_instance" "reader" {
  identifier           = "invokeai-saas-db-reader"
  cluster_identifier   = aws_rds_cluster.invokeai.id
  instance_class       = "db.serverless"  # Serverless v2
  engine               = aws_rds_cluster.invokeai.engine
  engine_version       = aws_rds_cluster.invokeai.engine_version

  performance_insights_enabled = true

  tags = {
    Name = "invokeai-aurora-reader"
    Role = "reader"
  }
}

# DB 서브넷 그룹
resource "aws_db_subnet_group" "invokeai" {
  name       = "invokeai-saas-db-subnet"
  subnet_ids = var.database_subnet_ids

  tags = {
    Environment = "production"
    Project     = "invokeai-saas"
  }
}
```

---

## 12. 멀티테넌트 SaaS 격리 아키텍처

> InvokeAI는 원래 로컬 단일 사용자용 SW입니다. SaaS로 전환하면 **여러 사용자가 회원가입 후 결제하고, 각자의 격리된 환경에서 선택한 플랜의 스펙에 따라 차별화된 서비스**를 받게 됩니다. 이 섹션에서는 그 격리 구조를 다룹니다.

### 12.1 격리 계층 구조

```mermaid
graph TB
    subgraph "멀티테넌트 격리 계층"
        direction TB
        L1["1. 인증 격리<br/>AWS Cognito JWT"]
        L2["2. 데이터 격리<br/>Aurora PostgreSQL RLS"]
        L3["3. 스토리지 격리<br/>S3 user_id prefix"]
        L4["4. 컴퓨트 격리<br/>플랜별 GPU 큐"]
        L5["5. 기능 격리<br/>플랜별 Feature Gating"]

        L1 --> L2 --> L3 --> L4 --> L5
    end

    subgraph "사용자 A (Pro Plan)"
        UA_DATA["images/boards/workflows<br/>RLS: user_id = A"]
        UA_S3["s3://bucket/users/A/"]
        UA_GPU["High-Perf GPU Queue<br/>15,000 credits/month"]
    end

    subgraph "사용자 B (Starter Plan)"
        UB_DATA["images/boards/workflows<br/>RLS: user_id = B"]
        UB_S3["s3://bucket/users/B/"]
        UB_GPU["Basic GPU Queue<br/>5,000 credits/month"]
    end

    L2 --> UA_DATA
    L2 --> UB_DATA
    L3 --> UA_S3
    L3 --> UB_S3
    L4 --> UA_GPU
    L4 --> UB_GPU

    style L1 fill:#7bed9f,color:#000
    style L2 fill:#4ecdc4,color:#fff
    style L3 fill:#ffa502,color:#fff
    style L4 fill:#ff6b6b,color:#fff
    style L5 fill:#a29bfe,color:#fff
```

### 12.2 인증 격리 (Layer 1)

```python
# 모든 API 요청에서 JWT 토큰으로 사용자 식별
# invokeai/app/api/middleware/auth.py

from fastapi import Request, HTTPException
import jwt

async def auth_middleware(request: Request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")

    payload = jwt.decode(token, COGNITO_PUBLIC_KEY, algorithms=["RS256"])
    request.state.user_id = payload["sub"]
    request.state.user_role = payload.get("custom:role", "user")
```

### 12.3 데이터 격리 (Layer 2) - Aurora PostgreSQL RLS

```python
# API 서버에서 각 요청마다 Aurora 세션 변수 설정
# invokeai/app/api/middleware/tenant.py

async def set_tenant_context(session, user_id: str):
    """Aurora PostgreSQL RLS를 위한 테넌트 컨텍스트 설정"""
    await session.execute(
        text(f"SET app.current_user_id = :uid"),
        {"uid": str(user_id)}
    )
    # 이후 모든 쿼리는 RLS 정책에 의해 자동 필터링
    # SELECT * FROM images → user_id = current_user만 반환
```

### 12.4 스토리지 격리 (Layer 3) - S3 Prefix

```python
# S3 키 생성 시 반드시 user_id prefix 사용
def get_s3_key(user_id: str, image_name: str) -> str:
    return f"users/{user_id}/images/{image_name}"

# IAM 정책으로 교차 접근 불가
# 사용자는 자신의 prefix 하위만 접근 가능
```

### 12.5 컴퓨트 격리 (Layer 4) - 플랜별 GPU 라우팅

```python
# SQS 큐를 GPU 티어별로 분리
GPU_QUEUES = {
    "basic": "invokeai-gpu-basic.fifo",           # T4 (Trial/Starter/Tester)
    "high_performance": "invokeai-gpu-highperf.fifo",  # A10G (Pro/Studio)
    "dedicated": "invokeai-gpu-dedicated.fifo",    # A100 (Enterprise)
}

async def route_job_to_queue(user_plan: str, job: dict):
    tier = PLAN_GPU_MAPPING[user_plan]
    queue_url = GPU_QUEUES[tier]
    await sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps(job))
```

### 12.6 기능 격리 (Layer 5) - 플랜별 Feature Gating

```python
# 플랜별 기능 접근 제어
PLAN_FEATURES = {
    "trial":      {"models": ["sd"], "queues": 1, "api": False, "flux": False},
    "starter":    {"models": ["sd"], "queues": 1, "api": False, "flux": False},
    "pro":        {"models": ["sd", "flux"], "queues": 1, "api": True, "flux": True},
    "studio":     {"models": ["sd", "flux"], "queues": 3, "api": True, "flux": True},
    "enterprise": {"models": ["sd", "flux", "custom"], "queues": -1, "api": True, "flux": True},
    "tester":     {"models": ["sd", "flux"], "queues": 1, "api": True, "flux": True},
}

async def check_feature_access(user_plan: str, feature: str) -> bool:
    return PLAN_FEATURES.get(user_plan, {}).get(feature, False)
```

---

## 13. AWS 개발/스테이징/운영 환경 구성

> SaaS는 로컬 설치 SW와 달리, **개발 → 스테이징 → 운영**의 3단계 환경에서 지속적으로 개발/배포/유지보수합니다. 이 섹션에서는 AWS 기반 환경 구성을 다룹니다.

### 13.1 3단계 환경 구성

```mermaid
graph LR
    subgraph "Development"
        DEV_ECS["ECS Fargate<br/>(1 task)"]
        DEV_AURORA["Aurora Serverless v2<br/>(0.5 ACU min)"]
        DEV_GPU["GPU: 없음<br/>(Mock Worker)"]
        DEV_S3["S3: dev-bucket"]
    end

    subgraph "Staging"
        STG_ECS["ECS Fargate<br/>(2 tasks)"]
        STG_AURORA["Aurora Serverless v2<br/>(0.5~8 ACU)"]
        STG_GPU["GPU: 1x g4dn.xlarge<br/>(T4)"]
        STG_S3["S3: staging-bucket"]
    end

    subgraph "Production"
        PRD_ECS["ECS Fargate<br/>(2+ tasks, auto-scale)"]
        PRD_AURORA["Aurora Serverless v2<br/>(0.5~32 ACU)"]
        PRD_GPU["GPU: 플랜별 auto-scale<br/>(T4/A10G/A100)"]
        PRD_S3["S3: prod-bucket"]
    end

    DEV_ECS -->|"PR 머지"| STG_ECS
    STG_ECS -->|"수동 승인"| PRD_ECS

    style DEV_ECS fill:#7bed9f,color:#000
    style STG_ECS fill:#ffa502,color:#fff
    style PRD_ECS fill:#ff6b6b,color:#fff
```

### 13.2 환경별 Aurora 설정

| 설정 | Development | Staging | Production |
|------|-------------|---------|------------|
| Aurora 클러스터 | invokeai-dev-db | invokeai-staging-db | invokeai-saas-db |
| Writer 인스턴스 | 1 (Serverless v2) | 1 (Serverless v2) | 1 (Serverless v2) |
| Reader 인스턴스 | 0 | 1 | 1~2 |
| 최소 ACU | 0.5 | 0.5 | 0.5 |
| 최대 ACU | 4 | 8 | 32 |
| 백업 보존 | 1일 | 3일 | 7일 |
| 삭제 보호 | No | Yes | Yes |
| Performance Insights | No | Yes | Yes |
| 월 예상 비용 | ~$45 | ~$90 | ~$350 |

### 13.3 환경변수 관리 (Secrets Manager)

```hcl
# terraform/environments/production/secrets.tf
resource "aws_secretsmanager_secret" "db_url" {
  name = "invokeai/production/database-url"
}

resource "aws_secretsmanager_secret_version" "db_url" {
  secret_id     = aws_secretsmanager_secret.db_url.id
  secret_string = "postgresql+asyncpg://invokeai_admin:${var.db_password}@${aws_rds_cluster.invokeai.endpoint}:5432/invokeai"
}

# 환경별 분리
# invokeai/dev/database-url
# invokeai/staging/database-url
# invokeai/production/database-url
```

### 13.4 Alembic DB 마이그레이션 운영

```bash
# 1. 개발 환경에서 마이그레이션 작성
alembic revision --autogenerate -m "add video_records table"

# 2. 로컬 테스트
alembic upgrade head

# 3. Staging Aurora에 적용 (CI/CD 자동)
DATABASE_URL=$STAGING_DB_URL alembic upgrade head

# 4. Production Aurora에 적용 (수동 승인 후)
DATABASE_URL=$PRODUCTION_DB_URL alembic upgrade head

# 롤백 (필요 시)
alembic downgrade -1
```

### 13.5 유지보수 및 기능 확장 개발 워크플로우

```mermaid
sequenceDiagram
    participant DEV as 개발자
    participant GH as GitHub
    participant CI as GitHub Actions
    participant STG as Staging 환경
    participant PRD as Production 환경

    DEV->>GH: Feature Branch PR 생성
    GH->>CI: PR Trigger → Lint, Test, Build
    CI-->>GH: Check 통과

    DEV->>GH: PR 머지 (develop → main)
    GH->>CI: Main 브랜치 CI 시작
    CI->>CI: Docker Build → ECR Push
    CI->>STG: Alembic Migration → ECS Deploy
    CI->>STG: E2E Tests 실행

    STG-->>CI: E2E 통과
    CI-->>DEV: Staging 배포 완료 알림

    DEV->>CI: Production 배포 승인
    CI->>PRD: Alembic Migration → ECS Deploy
    CI->>PRD: Health Check
    PRD-->>CI: 배포 완료

    Note over PRD: 문제 발생 시
    CI->>PRD: Auto Rollback (이전 Task Definition)
    CI->>DEV: 롤백 알림
```

### 13.6 운영 모니터링 체크리스트

| 주기 | 점검 항목 | 도구 |
|------|----------|------|
| **실시간** | API Error Rate, Aurora ACU, GPU Queue Depth | CloudWatch 알람 |
| **일간** | 사용자 활동, 크레딧 소비, 수익 | CloudWatch Dashboard |
| **주간** | Aurora Performance Insights, 슬로우 쿼리 | Performance Insights |
| **월간** | 비용 분석, Reserved Instance 검토, 보안 패치 | Cost Explorer, Inspector |
| **분기** | 인프라 리뷰, 스케일링 계획, DR 테스트 | Well-Architected Review |
