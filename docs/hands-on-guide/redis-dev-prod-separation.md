# Redis 분리 구성: Dev Standalone vs Prod Sentinel

이 문서는 개발 환경과 운영 환경에서 **별도의 Redis 인스턴스**를 사용하는 구성을 설명합니다.

## 목차
1. [Redis 구성 전략](#redis-구성-전략)
2. [Terraform 모듈](#terraform-모듈)
3. [Kubernetes 연결 설정](#kubernetes-연결-설정)
4. [비용 분석](#비용-분석)
5. [운영 고려사항](#운영-고려사항)
6. [기존 문서 수정사항](#기존-문서-수정사항)

---

## Redis 구성 전략

### 아키텍처 개요

```
┌─────────────────────────────────────────┐
│ EKS Cluster (Shared)                    │
│                                         │
│  ┌──────────────┐                       │
│  │ Namespace:   │                       │
│  │    dev       │                       │
│  │              │                       │
│  │ Services ────┼──→ Redis Dev          │
│  │ Workers      │    (Standalone)       │
│  └──────────────┘    1 노드             │
│                      cache.t4g.medium   │
│                                         │
│  ┌──────────────┐                       │
│  │ Namespace:   │                       │
│  │    prod      │                       │
│  │              │                       │
│  │ Services ────┼──→ Redis Prod         │
│  │ Workers      │    (Sentinel)         │
│  └──────────────┘    3 노드 + 3 센티널  │
│                      cache.r6g.large    │
└─────────────────────────────────────────┘
```

### 구성 차이

| 특징 | Dev (Standalone) | Prod (Sentinel) |
|------|------------------|-----------------|
| **목적** | 개발/테스트 | 운영 서비스 |
| **가용성** | 단일 장애점 허용 | 자동 Failover |
| **노드 수** | 1 (Primary만) | 3 (Primary + 2 Replicas) |
| **센티널** | 없음 | 3개 (모니터링 + Failover) |
| **인스턴스 타입** | cache.t4g.medium (Graviton) | cache.r6g.large (Graviton) |
| **메모리** | 3.09 GiB | 13.07 GiB |
| **복제** | 없음 | 동기 복제 |
| **백업** | 선택사항 | 자동 백업 (7일) |
| **월 비용** | ~$48 | ~$308 |

---

## Terraform 모듈

### 1. Dev Redis (Standalone)

`infra/terraform/modules/elasticache-dev/main.tf`:
```hcl
# Dev Redis Standalone
resource "aws_elasticache_subnet_group" "dev" {
  name       = "pingvas-redis-dev-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "pingvas-redis-dev-subnet-group"
    Environment = "dev"
  }
}

resource "aws_security_group" "redis_dev" {
  name        = "pingvas-redis-dev-sg"
  description = "Security group for Dev Redis"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
    description = "Redis access from EKS dev namespace"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pingvas-redis-dev-sg"
  }
}

# Standalone Redis (단일 노드)
resource "aws_elasticache_cluster" "dev" {
  cluster_id           = "pingvas-redis-dev"
  engine               = "redis"
  engine_version       = "7.0"
  node_type            = "cache.t4g.medium"  # Graviton (ARM64)
  num_cache_nodes      = 1
  parameter_group_name = aws_elasticache_parameter_group.dev.name
  subnet_group_name    = aws_elasticache_subnet_group.dev.name
  security_group_ids   = [aws_security_group.redis_dev.id]
  port                 = 6379

  # 개발 환경: 암호화 비활성화 (성능 우선)
  at_rest_encryption_enabled = false
  transit_encryption_enabled = false

  # 백업 비활성화 (비용 절감)
  snapshot_retention_limit = 0

  # 유지보수 시간
  maintenance_window = "sun:05:00-sun:07:00"

  tags = {
    Name        = "pingvas-redis-dev"
    Environment = "dev"
    Type        = "standalone"
  }
}

# Parameter Group
resource "aws_elasticache_parameter_group" "dev" {
  name   = "pingvas-redis-dev-params"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  parameter {
    name  = "timeout"
    value = "300"
  }

  # 개발 환경: 느슨한 설정
  parameter {
    name  = "tcp-keepalive"
    value = "60"
  }
}
```

`infra/terraform/modules/elasticache-dev/outputs.tf`:
```hcl
output "redis_endpoint" {
  value       = aws_elasticache_cluster.dev.cache_nodes[0].address
  description = "Dev Redis endpoint"
}

output "redis_port" {
  value = aws_elasticache_cluster.dev.cache_nodes[0].port
}
```

---

### 2. Prod Redis (Sentinel)

`infra/terraform/modules/elasticache-prod/main.tf`:
```hcl
# Prod Redis Sentinel
resource "aws_elasticache_subnet_group" "prod" {
  name       = "pingvas-redis-prod-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "pingvas-redis-prod-subnet-group"
    Environment = "prod"
  }
}

resource "aws_security_group" "redis_prod" {
  name        = "pingvas-redis-prod-sg"
  description = "Security group for Prod Redis"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
    description = "Redis access from EKS prod namespace"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pingvas-redis-prod-sg"
  }
}

# Redis Replication Group (Sentinel)
resource "aws_elasticache_replication_group" "prod" {
  replication_group_id       = "pingvas-redis-prod"
  replication_group_description = "Production Redis with Sentinel"
  engine                     = "redis"
  engine_version             = "7.0"
  node_type                  = "cache.r6g.large"  # Graviton (ARM64)
  num_cache_clusters         = 3  # 1 Primary + 2 Replicas
  parameter_group_name       = aws_elasticache_parameter_group.prod.name
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.prod.name
  security_group_ids         = [aws_security_group.redis_prod.id]

  # 고가용성 설정
  automatic_failover_enabled = true
  multi_az_enabled           = true

  # 보안 설정
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token_enabled         = true
  auth_token                 = var.redis_auth_token  # Secrets Manager에서 가져오기

  # 백업 설정
  snapshot_retention_limit = 7
  snapshot_window          = "03:00-05:00"

  # 유지보수 시간
  maintenance_window = "mon:05:00-mon:07:00"

  # 로그 설정
  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_prod.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = {
    Name        = "pingvas-redis-prod"
    Environment = "prod"
    Type        = "sentinel"
  }
}

# Parameter Group (운영 최적화)
resource "aws_elasticache_parameter_group" "prod" {
  name   = "pingvas-redis-prod-params"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  parameter {
    name  = "timeout"
    value = "300"
  }

  # 운영 환경: 엄격한 설정
  parameter {
    name  = "tcp-keepalive"
    value = "300"
  }

  parameter {
    name  = "slowlog-log-slower-than"
    value = "10000"  # 10ms 이상 쿼리 로깅
  }

  parameter {
    name  = "slowlog-max-len"
    value = "128"
  }
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "redis_prod" {
  name              = "/aws/elasticache/pingvas-redis-prod"
  retention_in_days = 14

  tags = {
    Name = "pingvas-redis-prod-logs"
  }
}
```

`infra/terraform/modules/elasticache-prod/outputs.tf`:
```hcl
output "redis_primary_endpoint" {
  value       = aws_elasticache_replication_group.prod.primary_endpoint_address
  description = "Prod Redis primary endpoint"
}

output "redis_reader_endpoint" {
  value       = aws_elasticache_replication_group.prod.reader_endpoint_address
  description = "Prod Redis reader endpoint"
}

output "redis_configuration_endpoint" {
  value       = aws_elasticache_replication_group.prod.configuration_endpoint_address
  description = "Prod Redis configuration endpoint (for Sentinel)"
}

output "redis_port" {
  value = aws_elasticache_replication_group.prod.port
}
```

---

### 3. Shared 환경 Main 수정

`infra/terraform/environments/shared/main.tf`:
```hcl
# ... (VPC, EKS, RDS는 동일)

# Dev Redis (Standalone)
module "elasticache_dev" {
  source = "../../modules/elasticache-dev"

  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  allowed_cidr_blocks = [local.vpc_cidr]
}

# Prod Redis (Sentinel)
module "elasticache_prod" {
  source = "../../modules/elasticache-prod"

  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  allowed_cidr_blocks = [local.vpc_cidr]

  redis_auth_token = var.redis_auth_token  # Secrets Manager
}
```

`infra/terraform/environments/shared/outputs.tf`:
```hcl
# Redis Outputs
output "redis_dev_endpoint" {
  value       = module.elasticache_dev.redis_endpoint
  description = "Dev Redis endpoint (Standalone)"
}

output "redis_prod_primary_endpoint" {
  value       = module.elasticache_prod.redis_primary_endpoint
  description = "Prod Redis primary endpoint (Sentinel)"
}

output "redis_prod_reader_endpoint" {
  value       = module.elasticache_prod.redis_reader_endpoint
  description = "Prod Redis reader endpoint (Sentinel)"
}
```

---

## Kubernetes 연결 설정

### 1. Dev Namespace Secret

`k8s/secrets/dev-redis-config.yaml`:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: redis-config
  namespace: dev
type: Opaque
stringData:
  # Standalone 연결 (간단)
  REDIS_URL: "redis://pingvas-redis-dev.xxxxx.cache.amazonaws.com:6379/0"
  REDIS_HOST: "pingvas-redis-dev.xxxxx.cache.amazonaws.com"
  REDIS_PORT: "6379"
  REDIS_DB: "0"
  REDIS_PASSWORD: ""  # Dev는 인증 없음
```

---

### 2. Prod Namespace Secret

`k8s/secrets/prod-redis-config.yaml`:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: redis-config
  namespace: prod
type: Opaque
stringData:
  # Sentinel 연결 (복잡)
  REDIS_URL: "redis://:${AUTH_TOKEN}@pingvas-redis-prod.xxxxx.cache.amazonaws.com:6379/0"
  REDIS_HOST: "pingvas-redis-prod.xxxxx.cache.amazonaws.com"
  REDIS_PORT: "6379"
  REDIS_DB: "0"
  REDIS_PASSWORD: "${AUTH_TOKEN}"  # Secrets Manager에서 주입

  # Sentinel 설정
  REDIS_SENTINEL_ENABLED: "true"
  REDIS_MASTER_NAME: "pingvas-redis-prod"
  REDIS_SENTINELS: "sentinel1.xxxxx:26379,sentinel2.xxxxx:26379,sentinel3.xxxxx:26379"
```

---

### 3. 애플리케이션 코드 (Python)

**Dev 환경** (간단한 연결):
```python
import redis

redis_client = redis.from_url(
    os.getenv("REDIS_URL"),
    decode_responses=True
)
```

**Prod 환경** (Sentinel 연결):
```python
import redis
from redis.sentinel import Sentinel

if os.getenv("REDIS_SENTINEL_ENABLED") == "true":
    # Sentinel 연결
    sentinel_hosts = [
        tuple(s.split(':'))
        for s in os.getenv("REDIS_SENTINELS").split(',')
    ]

    sentinel = Sentinel(
        sentinel_hosts,
        socket_timeout=0.5,
        password=os.getenv("REDIS_PASSWORD")
    )

    # Master 연결 (쓰기)
    redis_client = sentinel.master_for(
        os.getenv("REDIS_MASTER_NAME"),
        socket_timeout=0.5,
        password=os.getenv("REDIS_PASSWORD"),
        db=int(os.getenv("REDIS_DB", 0)),
        decode_responses=True
    )

    # Slave 연결 (읽기, 선택사항)
    redis_reader = sentinel.slave_for(
        os.getenv("REDIS_MASTER_NAME"),
        socket_timeout=0.5,
        password=os.getenv("REDIS_PASSWORD"),
        db=int(os.getenv("REDIS_DB", 0)),
        decode_responses=True
    )
else:
    # Standalone 연결 (Dev)
    redis_client = redis.from_url(
        os.getenv("REDIS_URL"),
        decode_responses=True
    )
```

---

### 4. Celery Worker 설정

**Dev** (`services/worker/celery_config_dev.py`):
```python
broker_url = os.getenv("REDIS_URL")
result_backend = os.getenv("REDIS_URL")

# 간단한 설정
broker_connection_retry_on_startup = True
```

**Prod** (`services/worker/celery_config_prod.py`):
```python
# Sentinel 브로커 설정
broker_url = f"sentinel://{os.getenv('REDIS_SENTINELS')}"
broker_transport_options = {
    'master_name': os.getenv('REDIS_MASTER_NAME'),
    'password': os.getenv('REDIS_PASSWORD'),
    'sentinel_kwargs': {
        'password': os.getenv('REDIS_PASSWORD')
    }
}

# Sentinel 결과 백엔드
result_backend = f"sentinel://{os.getenv('REDIS_SENTINELS')}"
result_backend_transport_options = broker_transport_options

# 재시도 설정 (Sentinel Failover 대응)
broker_connection_retry_on_startup = True
broker_connection_max_retries = 10
```

---

## 비용 분석

### 월별 비용 상세

#### Dev Redis (Standalone)

| 항목 | 사양 | 시간당 | 월 비용 |
|------|------|--------|---------|
| cache.t4g.medium | 3.09 GiB | $0.068 | $49.64 |
| 백업 | 비활성화 | $0 | $0 |
| **소계** | | | **$49.64** |

---

#### Prod Redis (Sentinel)

| 항목 | 사양 | 시간당 | 월 비용 |
|------|------|--------|---------|
| cache.r6g.large (Primary) | 13.07 GiB | $0.211 | $154.03 |
| cache.r6g.large (Replica 1) | 13.07 GiB | $0.211 | $154.03 |
| cache.r6g.large (Replica 2) | 13.07 GiB | $0.211 | $154.03 |
| 백업 (7일) | ~10 GB | - | $5 |
| **소계** | | | **$467.09** |

---

### 전체 인프라 비용 (업데이트)

| 항목 | 수량 | 단가 | 월 비용 | 변경 |
|------|------|------|---------|------|
| **EKS Control Plane** | 1 | $72 | $72 | - |
| **System Nodes (t3.medium Spot)** | 2 | $9.12 | $18.24 | - |
| **RDS Aurora Serverless v2** | 2 | $87 | $174 | - |
| **Redis Dev (Standalone)** | 1 | $49.64 | $49.64 | +$49.64 |
| **Redis Prod (Sentinel)** | 3 | $155.70 | $467.09 | +$467.09 |
| **NAT Gateway** | 1 | $32.40 | $32.40 | - |
| **GPU Nodes (평균)** | - | - | $200 | - |
| **데이터 전송** | - | - | $60 | - |
| **S3 + CloudFront** | - | - | $80 | - |
| **총계** | | | **$1,153.37** | +$208.73 |

**비교**:
- 이전 단일 Redis: $945/월
- Redis 분리 후: $1,153/월
- 기존 별도 클러스터: $2,318/월

**여전히 50% 절감** ($1,165 절감)

---

### 비용 최적화 옵션

#### 옵션 1: Dev Redis 더 작게
```hcl
node_type = "cache.t4g.small"  # 1.37 GiB, $0.034/시간
# 월 비용: $24.82 (Dev Redis에서 $25 절감)
```

#### 옵션 2: Prod Replica 1개만
```hcl
num_cache_clusters = 2  # Primary + 1 Replica
# 월 비용: $313 (Prod Redis에서 $154 절감)
# 단, 가용성 낮음 (2-node Sentinel은 권장하지 않음)
```

#### 옵션 3: Reserved Instances (1년 약정)
```
cache.r6g.large Reserved (1년): $0.142/시간 (33% 할인)
Prod Redis 절감: 3 x ($0.211 - $0.142) x 730 = $151/월
```

---

## 운영 고려사항

### 1. Sentinel Failover 테스트

```bash
# Prod Redis Primary 노드 확인
aws elasticache describe-replication-groups \
  --replication-group-id pingvas-redis-prod \
  --query 'ReplicationGroups[0].NodeGroups[0].PrimaryEndpoint'

# Failover 테스트 (Primary 강제 전환)
aws elasticache test-failover \
  --replication-group-id pingvas-redis-prod \
  --node-group-id 0001

# Failover 시간: 보통 30초 ~ 1분
```

**애플리케이션 영향**:
- Sentinel이 자동으로 새 Primary 감지
- Redis client는 자동 재연결
- 짧은 순간 연결 끊김 (재시도 로직 필요)

---

### 2. 모니터링

**CloudWatch 메트릭**:
```python
# Dev Standalone
- CacheHits / CacheMisses
- CPUUtilization
- NetworkBytesIn/Out
- CurrConnections

# Prod Sentinel (추가 메트릭)
- ReplicationLag  # Replica 지연 시간
- MasterLinkHealthStatus  # Primary-Replica 연결 상태
- SaveInProgress  # 백업 진행 중
```

**알람 설정**:
```hcl
# Prod Redis: Replication Lag 알람
resource "aws_cloudwatch_metric_alarm" "redis_replication_lag" {
  alarm_name          = "prod-redis-replication-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "ReplicationLag"
  namespace           = "AWS/ElastiCache"
  period              = "60"
  statistic           = "Average"
  threshold           = "5"  # 5초 이상 지연
  alarm_description   = "Prod Redis replica is lagging"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    ReplicationGroupId = "pingvas-redis-prod"
  }
}
```

---

### 3. 백업 및 복구

**Prod Redis 수동 백업**:
```bash
# 수동 스냅샷 생성
aws elasticache create-snapshot \
  --replication-group-id pingvas-redis-prod \
  --snapshot-name prod-manual-backup-$(date +%Y%m%d)

# 스냅샷에서 복구 (새 클러스터 생성)
aws elasticache create-replication-group \
  --replication-group-id pingvas-redis-prod-restore \
  --snapshot-name prod-manual-backup-20250123
```

**Dev Redis**:
- 백업 비활성화 (데이터 손실 허용)
- 필요 시 애플리케이션 데이터 재생성

---

### 4. 마이그레이션 (Standalone → Sentinel)

Dev에서 Prod로 승격 시:

```bash
# 1. Dev Redis 데이터 덤프
redis-cli -h pingvas-redis-dev.xxxxx.cache.amazonaws.com BGSAVE

# 2. RDB 파일 다운로드
aws s3 cp s3://elasticache-backups/dev-dump.rdb /tmp/

# 3. Prod Redis로 복원
# (Sentinel 클러스터는 스냅샷에서 복원)
aws elasticache create-replication-group \
  --replication-group-id pingvas-redis-prod-new \
  --snapshot-name dev-migration
```

---

## 기존 문서 수정사항

### 1. single-cluster-cost-optimized-setup.md

**위치**: "## 단일 클러스터 Terraform" > "4. 공유 환경 Main 파일"

**수정 내용**:
```diff
-# ElastiCache (공유, DB 번호로 분리)
-module "elasticache" {
-  source = "../../modules/elasticache-shared"
+# Dev Redis (Standalone)
+module "elasticache_dev" {
+  source = "../../modules/elasticache-dev"

   vpc_id              = module.vpc.vpc_id
   private_subnet_ids  = module.vpc.private_subnet_ids
   allowed_cidr_blocks = [local.vpc_cidr]
+}

-  # 단일 Redis 클러스터 (DB 0: dev, DB 1: prod)
-  num_cache_nodes = 2
-  node_type       = "cache.r6g.large"
+# Prod Redis (Sentinel)
+module "elasticache_prod" {
+  source = "../../modules/elasticache-prod"
+
+  vpc_id              = module.vpc.vpc_id
+  private_subnet_ids  = module.vpc.private_subnet_ids
+  allowed_cidr_blocks = [local.vpc_cidr]
+  redis_auth_token    = var.redis_auth_token
 }
```

---

**위치**: "## 공유 RDS 구성" > "3. Redis DB 분리"

**전체 섹션 교체**:
```markdown
### 3. Redis 인스턴스 분리

Dev와 Prod는 **별도의 Redis 인스턴스**를 사용합니다:

**Dev**: Standalone (cache.t4g.medium)
- 연결: `redis://pingvas-redis-dev.xxxxx.cache.amazonaws.com:6379/0`
- 인증 없음
- 백업 없음

**Prod**: Sentinel (cache.r6g.large x 3)
- 연결: Sentinel 프로토콜
- 인증 필요 (AUTH token)
- 자동 백업 (7일)
- 자동 Failover

k8s/configmaps/redis-config.yaml:
\`\`\`yaml
# Dev
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-config
  namespace: dev
data:
  REDIS_URL: "redis://pingvas-redis-dev.xxxxx:6379/0"
  REDIS_SENTINEL_ENABLED: "false"

---
# Prod
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-config
  namespace: prod
data:
  REDIS_URL: "redis://:${TOKEN}@pingvas-redis-prod.xxxxx:6379/0"
  REDIS_SENTINEL_ENABLED: "true"
  REDIS_MASTER_NAME: "pingvas-redis-prod"
\`\`\`
```

---

**위치**: "## 비용 분석"

**Redis 비용 행 수정**:
```diff
-| **ElastiCache (cache.r6g.large)** | 2 | $154 | $308 | -$308 |
+| **Redis Dev (Standalone)** | 1 | $49.64 | $49.64 | -$258.36 |
+| **Redis Prod (Sentinel)** | 3 | $155.70 | $467.09 | +$159.09 |

-| **총계** | | | **$944.64** | **-$1,373.76** |
+| **총계** | | | **$1,153.37** | **-$1,165.03** |

-**절감율: 59.2%**
+**절감율: 50.2%**
```

---

### 2. migration-updates-required.md

**위치**: "Phase 2 수정 사항" 이후

**새 섹션 추가**:
```markdown
#### 6. Redis 연결 로직 수정

**위치**: "서비스 간 통신" 이후

**새 섹션 추가**:

\`\`\`markdown
### Redis 연결 설정

환경에 따라 다른 Redis 연결 방식 사용:

\`services/user-service/app/redis_client.py\`:
\`\`\`python
import os
import redis
from redis.sentinel import Sentinel

def get_redis_client():
    """환경에 따른 Redis 클라이언트 반환"""

    if os.getenv("REDIS_SENTINEL_ENABLED") == "true":
        # Prod: Sentinel 연결
        sentinel_hosts = [
            tuple(s.split(':'))
            for s in os.getenv("REDIS_SENTINELS").split(',')
        ]

        sentinel = Sentinel(
            sentinel_hosts,
            socket_timeout=0.5,
            password=os.getenv("REDIS_PASSWORD")
        )

        return sentinel.master_for(
            os.getenv("REDIS_MASTER_NAME"),
            socket_timeout=0.5,
            password=os.getenv("REDIS_PASSWORD"),
            db=int(os.getenv("REDIS_DB", 0)),
            decode_responses=True
        )
    else:
        # Dev: Standalone 연결
        return redis.from_url(
            os.getenv("REDIS_URL"),
            decode_responses=True
        )

# 전역 클라이언트
redis_client = get_redis_client()
\`\`\`
```

---

## 요약

### Redis 구성 변경

| 항목 | 이전 (잘못된 설계) | 현재 (올바른 설계) |
|------|-------------------|-------------------|
| Dev Redis | 공유 클러스터 DB 0 | 별도 Standalone 인스턴스 |
| Prod Redis | 공유 클러스터 DB 1 | 별도 Sentinel 인스턴스 (3노드) |
| 가용성 | Dev/Prod 동일 | Dev: 낮음, Prod: 높음 |
| 비용 | $308/월 | $517/월 (+$209) |
| 격리 수준 | 논리적 (DB 번호) | 물리적 (별도 인스턴스) |

### 장점

1. **완전한 격리**: Dev 장애가 Prod에 영향 없음
2. **맞춤형 구성**: 환경별 최적화 가능
3. **보안 강화**: Prod는 인증/암호화, Dev는 간소화
4. **비용 최적화**: Dev는 작은 인스턴스, Prod는 고가용성

### 추가 비용

- Redis 분리로 인한 추가 비용: **+$208.73/월**
- 전체 월 비용: **$1,153.37**
- 여전히 기존 대비 **50% 절감**

---

**작성일**: 2025-01-23
**작성자**: Claude (Anthropic)
**목적**: Redis Dev/Prod 분리 구성 반영
