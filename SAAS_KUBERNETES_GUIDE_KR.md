# InvokeAI Kubernetes SaaS 구축 가이드

> EKS 기반 구독형 SaaS - 개발계/운영계 네임스페이스 분리

## 📋 목차

1. [아키텍처 개요](#1-아키텍처-개요)
2. [EKS 클러스터 구축](#2-eks-클러스터-구축)
3. [네임스페이스 전략](#3-네임스페이스-전략)
4. [Aurora PostgreSQL 공유 전략](#4-aurora-postgresql-공유-전략)
5. [애플리케이션 배포](#5-애플리케이션-배포)
6. [GPU 워커 구성](#6-gpu-워커-구성)
7. [Ingress 및 로드밸런싱](#7-ingress-및-로드밸런싱)
8. [Auto Scaling](#8-auto-scaling)
9. [모니터링 및 로깅](#9-모니터링-및-로깅)
10. [CI/CD 파이프라인](#10-cicd-파이프라인)

---

## 1. 아키텍처 개요

### 1.1 전체 구조

```
┌─────────────────────────────────────────────────────────────┐
│                    Route 53 (DNS)                            │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│              CloudFront (CDN)                                │
│  - 정적 파일 캐싱                                             │
│  - SSL/TLS 종료                                              │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│         AWS Application Load Balancer                       │
│  (Kubernetes Ingress Controller가 자동 생성)                 │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│                  EKS Cluster                                 │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │         Namespace: prod (운영계)                    │    │
│  │  ┌──────────────┐  ┌──────────────┐               │    │
│  │  │ API Server   │  │ GPU Worker   │               │    │
│  │  │ (Deployment) │  │ (Deployment) │               │    │
│  │  │  Replicas: 3 │  │  Replicas: 2 │               │    │
│  │  └──────────────┘  └──────────────┘               │    │
│  │                                                     │    │
│  │  ┌──────────────┐  ┌──────────────┐               │    │
│  │  │   Redis      │  │   Celery     │               │    │
│  │  │ (StatefulSet)│  │ (Deployment) │               │    │
│  │  └──────────────┘  └──────────────┘               │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │         Namespace: dev (개발계)                     │    │
│  │  ┌──────────────┐  ┌──────────────┐               │    │
│  │  │ API Server   │  │ GPU Worker   │               │    │
│  │  │ (Deployment) │  │ (Deployment) │               │    │
│  │  │  Replicas: 1 │  │  Replicas: 1 │               │    │
│  │  └──────────────┘  └──────────────┘               │    │
│  │                                                     │    │
│  │  ┌──────────────┐                                  │    │
│  │  │   Redis      │                                  │    │
│  │  │ (StatefulSet)│                                  │    │
│  │  └──────────────┘                                  │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │   Shared Resources (kube-system 등)                 │    │
│  │  - Ingress Controller                               │    │
│  │  - Metrics Server                                   │    │
│  │  - Cluster Autoscaler                               │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│              외부 AWS 서비스                                  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Aurora DB   │  │     S3       │  │   Cognito    │     │
│  │ (PostgreSQL) │  │  (이미지)    │  │    (인증)    │     │
│  │              │  │              │  │              │     │
│  │ ┌──────────┐ │  └──────────────┘  └──────────────┘     │
│  │ │   prod   │ │                                          │
│  │ │  schema  │ │                                          │
│  │ └──────────┘ │                                          │
│  │ ┌──────────┐ │                                          │
│  │ │   dev    │ │                                          │
│  │ │  schema  │ │                                          │
│  │ └──────────┘ │                                          │
│  └──────────────┘                                          │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 ECS vs Kubernetes 비교

| 항목 | ECS (이전) | Kubernetes (현재) |
|-----|-----------|------------------|
| **오케스트레이션** | ECS Tasks/Services | Deployments/StatefulSets |
| **로드밸런싱** | ALB 수동 설정 | Ingress (ALB 자동 생성) |
| **스케일링** | ASG + ECS Service | HPA + Cluster Autoscaler |
| **설정 관리** | ECS Task Definition | ConfigMap + Secret |
| **로깅** | CloudWatch Logs | FluentBit → CloudWatch |
| **모니터링** | CloudWatch | Prometheus + Grafana |
| **배포 전략** | Blue-Green (수동) | Rolling Update (자동) |
| **멀티 환경** | 별도 클러스터 | Namespace 분리 |

---

## 2. EKS 클러스터 구축

### 2.1 Terraform으로 EKS 생성

```hcl
# terraform/eks.tf

# EKS 모듈 사용 (공식 모듈)
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 19.0"

  cluster_name    = "invokeai-cluster"
  cluster_version = "1.28"

  # VPC 설정
  vpc_id     = aws_vpc.main.id
  subnet_ids = [
    aws_subnet.private_app_a.id,
    aws_subnet.private_app_b.id,
    aws_subnet.private_app_c.id,
  ]

  # 클러스터 엔드포인트 접근
  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true

  # OIDC Provider (IRSA용)
  enable_irsa = true

  # CloudWatch 로깅
  cluster_enabled_log_types = [
    "api",
    "audit",
    "authenticator",
    "controllerManager",
    "scheduler",
  ]

  # 노드 그룹 정의
  eks_managed_node_groups = {
    # 일반 워크로드 노드 (API 서버, Redis 등)
    general = {
      name = "general-nodes"

      instance_types = ["t3.large"]
      capacity_type  = "ON_DEMAND"

      min_size     = 2
      max_size     = 10
      desired_size = 3

      labels = {
        role = "general"
      }

      taints = []

      # EBS CSI Driver용 IAM 정책
      iam_role_additional_policies = {
        AmazonEBSCSIDriverPolicy = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
      }
    }

    # GPU 워크로드 노드
    gpu = {
      name = "gpu-nodes"

      # GPU 인스턴스
      instance_types = ["g5.xlarge"]
      ami_type       = "AL2_x86_64_GPU"  # GPU AMI
      capacity_type  = "SPOT"             # Spot 인스턴스로 비용 절감

      min_size     = 0
      max_size     = 10
      desired_size = 1

      labels = {
        role        = "gpu-worker"
        gpu         = "true"
        nvidia.com/gpu = "true"
      }

      taints = [
        {
          key    = "nvidia.com/gpu"
          value  = "true"
          effect = "NoSchedule"
        }
      ]

      # GPU 인스턴스에 적합한 설정
      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size = 200  # 모델 저장용
            volume_type = "gp3"
            encrypted   = true
          }
        }
      }
    }
  }

  # AWS Load Balancer Controller용 IAM 역할
  enable_cluster_creator_admin_permissions = true

  tags = {
    Environment = "production"
    Terraform   = "true"
  }
}

# OIDC Provider (IRSA - IAM Roles for Service Accounts)
data "tls_certificate" "eks" {
  url = module.eks.cluster_oidc_issuer_url
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = module.eks.cluster_oidc_issuer_url
}
```

### 2.2 필수 애드온 설치

```hcl
# terraform/eks_addons.tf

# EBS CSI Driver (Persistent Volume용)
resource "aws_eks_addon" "ebs_csi" {
  cluster_name = module.eks.cluster_name
  addon_name   = "aws-ebs-csi-driver"
  addon_version = "v1.25.0-eksbuild.1"
}

# VPC CNI (네트워킹)
resource "aws_eks_addon" "vpc_cni" {
  cluster_name = module.eks.cluster_name
  addon_name   = "vpc-cni"
  addon_version = "v1.15.0-eksbuild.2"
}

# kube-proxy
resource "aws_eks_addon" "kube_proxy" {
  cluster_name = module.eks.cluster_name
  addon_name   = "kube-proxy"
  addon_version = "v1.28.2-eksbuild.2"
}

# CoreDNS
resource "aws_eks_addon" "coredns" {
  cluster_name = module.eks.cluster_name
  addon_name   = "coredns"
  addon_version = "v1.10.1-eksbuild.6"
}
```

### 2.3 kubectl 설정

```bash
# kubeconfig 업데이트
aws eks update-kubeconfig \
  --region us-east-1 \
  --name invokeai-cluster

# 클러스터 확인
kubectl cluster-info
kubectl get nodes

# 출력 예시:
# NAME                          STATUS   ROLES    AGE   VERSION
# ip-10-0-11-123.ec2.internal   Ready    <none>   5m    v1.28.2-eks-...
# ip-10-0-12-124.ec2.internal   Ready    <none>   5m    v1.28.2-eks-...
```

---

## 3. 네임스페이스 전략

### 3.1 네임스페이스 생성

```yaml
# k8s/namespaces/prod.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: prod
  labels:
    name: prod
    environment: production
---
apiVersion: v1
kind: Namespace
metadata:
  name: dev
  labels:
    name: dev
    environment: development
```

```bash
kubectl apply -f k8s/namespaces/
```

### 3.2 ResourceQuota (리소스 제한)

```yaml
# k8s/namespaces/dev-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: dev-quota
  namespace: dev
spec:
  hard:
    # CPU/메모리 제한
    requests.cpu: "10"        # 최대 10 CPU 요청
    requests.memory: 20Gi     # 최대 20GB 메모리 요청
    limits.cpu: "20"          # 최대 20 CPU 제한
    limits.memory: 40Gi       # 최대 40GB 메모리 제한

    # GPU 제한
    requests.nvidia.com/gpu: "2"  # 최대 2 GPU

    # Pod 수 제한
    pods: "50"                # 최대 50개 Pod

    # PVC 제한
    persistentvolumeclaims: "10"
    requests.storage: 100Gi
---
# k8s/namespaces/prod-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: prod-quota
  namespace: prod
spec:
  hard:
    requests.cpu: "50"
    requests.memory: 100Gi
    limits.cpu: "100"
    limits.memory: 200Gi
    requests.nvidia.com/gpu: "10"
    pods: "200"
    persistentvolumeclaims: "50"
    requests.storage: 500Gi
```

### 3.3 NetworkPolicy (네트워크 격리)

```yaml
# k8s/namespaces/dev-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dev-isolation
  namespace: dev
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress

  ingress:
    # dev 네임스페이스 내부 트래픽 허용
    - from:
        - namespaceSelector:
            matchLabels:
              name: dev

    # Ingress Controller에서의 트래픽 허용
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx

  egress:
    # DNS 허용
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
      ports:
        - protocol: UDP
          port: 53

    # 외부 AWS 서비스 허용 (Aurora, S3 등)
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443
        - protocol: TCP
          port: 5432  # PostgreSQL
        - protocol: TCP
          port: 6379  # Redis
```

---

## 4. Aurora PostgreSQL 공유 전략

### 4.1 스키마 분리 방식

**장점:**
- 단일 DB 연결
- 데이터 물리적 분리
- 백업/복원 간편

```sql
-- Aurora DB에서 실행

-- 1. 스키마 생성
CREATE SCHEMA IF NOT EXISTS prod;
CREATE SCHEMA IF NOT EXISTS dev;

-- 2. 사용자 생성 (스키마별)
CREATE USER invokeai_prod WITH PASSWORD 'secure_password_prod';
CREATE USER invokeai_dev WITH PASSWORD 'secure_password_dev';

-- 3. 권한 부여
GRANT ALL PRIVILEGES ON SCHEMA prod TO invokeai_prod;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA prod TO invokeai_prod;
ALTER DEFAULT PRIVILEGES IN SCHEMA prod GRANT ALL ON TABLES TO invokeai_prod;

GRANT ALL PRIVILEGES ON SCHEMA dev TO invokeai_dev;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA dev TO invokeai_dev;
ALTER DEFAULT PRIVILEGES IN SCHEMA dev GRANT ALL ON TABLES TO invokeai_dev;

-- 4. Search Path 설정
ALTER USER invokeai_prod SET search_path TO prod, public;
ALTER USER invokeai_dev SET search_path TO dev, public;

-- 5. 테이블 생성 (각 스키마에)
-- prod 스키마
CREATE TABLE prod.users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    -- ... (나머지 필드)
);

CREATE TABLE prod.images (
    image_name VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(36) REFERENCES prod.users(id),
    -- ... (나머지 필드)
);

-- dev 스키마 (동일한 구조)
CREATE TABLE dev.users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    -- ...
);

CREATE TABLE dev.images (
    image_name VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(36) REFERENCES dev.users(id),
    -- ...
);
```

### 4.2 Terraform으로 Aurora 생성

```hcl
# terraform/aurora.tf

# Aurora Cluster (PostgreSQL 호환)
resource "aws_rds_cluster" "main" {
  cluster_identifier      = "invokeai-aurora-cluster"
  engine                  = "aurora-postgresql"
  engine_version          = "15.4"
  engine_mode             = "provisioned"

  database_name           = "invokeai"
  master_username         = "admin"
  master_password         = random_password.aurora_master.result

  # 네트워크
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.aurora.id]

  # 백업
  backup_retention_period = 7
  preferred_backup_window = "03:00-04:00"

  # 고가용성
  availability_zones = [
    "us-east-1a",
    "us-east-1b",
    "us-east-1c",
  ]

  # 스냅샷
  skip_final_snapshot     = false
  final_snapshot_identifier = "invokeai-final-snapshot"

  # 암호화
  storage_encrypted = true
  kms_key_id        = aws_kms_key.aurora.arn

  # 성능 개선
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Serverless v2 (비용 절감)
  serverlessv2_scaling_configuration {
    min_capacity = 0.5  # 0.5 ACU (약 1GB RAM)
    max_capacity = 16   # 16 ACU (약 32GB RAM)
  }

  tags = {
    Name = "invokeai-aurora-cluster"
  }
}

# Aurora 인스턴스
resource "aws_rds_cluster_instance" "main" {
  count = 2  # Writer 1개 + Reader 1개

  identifier         = "invokeai-aurora-${count.index}"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"  # Serverless v2
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version

  # 성능 모니터링
  performance_insights_enabled = true
  monitoring_interval          = 60
  monitoring_role_arn          = aws_iam_role.rds_monitoring.arn
}

# DB Subnet Group
resource "aws_db_subnet_group" "main" {
  name       = "invokeai-aurora-subnet-group"
  subnet_ids = [
    aws_subnet.private_data_a.id,
    aws_subnet.private_data_b.id,
    aws_subnet.private_data_c.id,
  ]
}

# 보안 그룹
resource "aws_security_group" "aurora" {
  name        = "aurora-sg"
  description = "Security group for Aurora cluster"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
    description     = "PostgreSQL from EKS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

### 4.3 Kubernetes Secret (DB 연결 정보)

```yaml
# k8s/secrets/prod-db-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: prod
type: Opaque
stringData:
  DB_HOST: "invokeai-aurora-cluster.cluster-xxxxx.us-east-1.rds.amazonaws.com"
  DB_PORT: "5432"
  DB_NAME: "invokeai"
  DB_USER: "invokeai_prod"
  DB_PASSWORD: "secure_password_prod"
  DB_SCHEMA: "prod"
---
# k8s/secrets/dev-db-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: dev
type: Opaque
stringData:
  DB_HOST: "invokeai-aurora-cluster.cluster-xxxxx.us-east-1.rds.amazonaws.com"
  DB_PORT: "5432"
  DB_NAME: "invokeai"
  DB_USER: "invokeai_dev"
  DB_PASSWORD: "secure_password_dev"
  DB_SCHEMA: "dev"
```

**또는 AWS Secrets Manager 사용 (권장):**

```yaml
# k8s/secrets/external-secrets.yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  namespace: prod
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: prod
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: db-credentials
    creationPolicy: Owner
  data:
    - secretKey: DB_PASSWORD
      remoteRef:
        key: invokeai/prod/database
        property: password
```

### 4.4 애플리케이션 코드 수정

```python
# invokeai/app/services/config/config_default.py
from pydantic_settings import BaseSettings


class InvokeAIAppConfig(BaseSettings):
    # ... 기존 설정

    # DB 설정
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "invokeai"
    db_user: str = "invokeai"
    db_password: str = ""
    db_schema: str = "public"  # ✅ 추가: 스키마 지정

    @property
    def database_url(self) -> str:
        """SQLAlchemy connection string"""
        # ✅ search_path 포함
        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
            f"?options=-c%20search_path={self.db_schema}"
        )
```

**또는 SQLAlchemy에서 직접 설정:**

```python
# invokeai/app/services/shared/database.py
from sqlalchemy import create_engine, event


def create_db_engine(config: InvokeAIAppConfig):
    """DB 엔진 생성"""

    engine = create_engine(
        config.database_url,
        pool_size=10,
        max_overflow=20,
    )

    # 연결 시 스키마 설정
    @event.listens_for(engine, "connect")
    def set_search_path(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute(f"SET search_path TO {config.db_schema}, public")
        cursor.close()

    return engine
```

---

## 5. 애플리케이션 배포

### 5.1 ConfigMap (환경 설정)

```yaml
# k8s/prod/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: invokeai-config
  namespace: prod
data:
  ENVIRONMENT: "production"
  LOG_LEVEL: "INFO"

  # S3
  S3_BUCKET: "invokeai-images-prod"
  S3_REGION: "us-east-1"

  # Redis
  REDIS_HOST: "redis-service.prod.svc.cluster.local"
  REDIS_PORT: "6379"

  # Cognito
  COGNITO_REGION: "us-east-1"
  COGNITO_USER_POOL_ID: "us-east-1_XXXXXXXXX"

  # 기타
  CELERY_BROKER_URL: "redis://redis-service.prod.svc.cluster.local:6379/0"
```

### 5.2 API Server Deployment

```yaml
# k8s/prod/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: prod
  labels:
    app: api-server
    version: v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server

  # 롤링 업데이트 전략
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # 최대 1개 추가 Pod
      maxUnavailable: 0  # 최소 3개 유지

  template:
    metadata:
      labels:
        app: api-server
        version: v1
    spec:
      serviceAccountName: api-server-sa

      # Init Container (DB 마이그레이션)
      initContainers:
        - name: migrate
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/invokeai-api:latest
          command: ["alembic", "upgrade", "head"]
          envFrom:
            - configMapRef:
                name: invokeai-config
            - secretRef:
                name: db-credentials

      containers:
        - name: api
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/invokeai-api:latest

          ports:
            - containerPort: 9090
              name: http
              protocol: TCP

          # 환경 변수
          envFrom:
            - configMapRef:
                name: invokeai-config
            - secretRef:
                name: db-credentials

          env:
            # Pod 정보
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace

          # 리소스 제한
          resources:
            requests:
              cpu: "500m"      # 0.5 CPU
              memory: "1Gi"
            limits:
              cpu: "2000m"     # 2 CPU
              memory: "4Gi"

          # Health Check
          livenessProbe:
            httpGet:
              path: /api/v1/health
              port: 9090
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3

          readinessProbe:
            httpGet:
              path: /api/v1/ready
              port: 9090
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3

          # Graceful Shutdown
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
---
# k8s/prod/api-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: prod
  labels:
    app: api-server
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 9090
      protocol: TCP
      name: http
  selector:
    app: api-server
```

### 5.3 Redis StatefulSet

```yaml
# k8s/prod/redis-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: prod
spec:
  serviceName: redis-service
  replicas: 1
  selector:
    matchLabels:
      app: redis

  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine

          ports:
            - containerPort: 6379
              name: redis

          command:
            - redis-server
            - --appendonly yes
            - --requirepass $(REDIS_PASSWORD)

          env:
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: redis-secret
                  key: password

          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "1Gi"

          volumeMounts:
            - name: redis-data
              mountPath: /data

          livenessProbe:
            exec:
              command:
                - redis-cli
                - ping
            initialDelaySeconds: 30
            periodSeconds: 10

  # PersistentVolume 요청
  volumeClaimTemplates:
    - metadata:
        name: redis-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3  # EBS GP3
        resources:
          requests:
            storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: redis-service
  namespace: prod
spec:
  type: ClusterIP
  clusterIP: None  # Headless Service
  ports:
    - port: 6379
      targetPort: 6379
  selector:
    app: redis
```

---

## 6. GPU 워커 구성

### 6.1 GPU Node 확인

```bash
# GPU 노드 확인
kubectl get nodes -l role=gpu-worker

# GPU 리소스 확인
kubectl describe node <gpu-node-name> | grep nvidia.com/gpu

# 출력 예시:
# nvidia.com/gpu:     1
```

### 6.2 NVIDIA Device Plugin 설치

```bash
# NVIDIA Device Plugin 배포
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.14.3/nvidia-device-plugin.yml

# 확인
kubectl get pods -n kube-system | grep nvidia-device-plugin
```

### 6.3 GPU Worker Deployment

```yaml
# k8s/prod/gpu-worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gpu-worker
  namespace: prod
  labels:
    app: gpu-worker
spec:
  replicas: 2
  selector:
    matchLabels:
      app: gpu-worker

  template:
    metadata:
      labels:
        app: gpu-worker
    spec:
      serviceAccountName: gpu-worker-sa

      # GPU 노드에만 스케줄링
      nodeSelector:
        role: gpu-worker

      # Taint 허용
      tolerations:
        - key: nvidia.com/gpu
          operator: Equal
          value: "true"
          effect: NoSchedule

      # Init Container (모델 다운로드)
      initContainers:
        - name: download-models
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/invokeai-worker:latest
          command: ["/bin/sh", "-c"]
          args:
            - |
              echo "Checking models..."
              if [ ! -f /models/.initialized ]; then
                echo "Downloading models from S3..."
                aws s3 sync s3://invokeai-models-bucket/models /models
                touch /models/.initialized
              fi
          volumeMounts:
            - name: models
              mountPath: /models
          envFrom:
            - configMapRef:
                name: invokeai-config

      containers:
        - name: worker
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/invokeai-worker:latest

          command: ["celery", "-A", "invokeai.app.services.celery_app", "worker"]
          args:
            - --loglevel=info
            - --concurrency=1
            - --queue=gpu_tasks
            - --max-tasks-per-child=10  # 메모리 누수 방지

          # 환경 변수
          envFrom:
            - configMapRef:
                name: invokeai-config
            - secretRef:
                name: db-credentials

          env:
            - name: WORKER_TYPE
              value: "gpu"
            - name: CUDA_VISIBLE_DEVICES
              value: "0"

          # GPU 리소스 요청
          resources:
            requests:
              cpu: "2000m"
              memory: "8Gi"
              nvidia.com/gpu: "1"  # GPU 1개 요청
            limits:
              cpu: "4000m"
              memory: "16Gi"
              nvidia.com/gpu: "1"  # GPU 1개 제한

          # Health Check (GPU 작업은 오래 걸릴 수 있음)
          livenessProbe:
            exec:
              command:
                - /bin/sh
                - -c
                - "celery -A invokeai.app.services.celery_app inspect ping -d celery@$HOSTNAME"
            initialDelaySeconds: 60
            periodSeconds: 30
            timeoutSeconds: 10
            failureThreshold: 5

          # 볼륨 마운트
          volumeMounts:
            - name: models
              mountPath: /models
            - name: shm
              mountPath: /dev/shm  # 공유 메모리 (PyTorch)

      # 볼륨
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: models-pvc
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 4Gi
---
# k8s/prod/models-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: models-pvc
  namespace: prod
spec:
  accessModes:
    - ReadWriteMany  # 여러 Pod에서 공유
  storageClassName: efs  # EFS 사용 (모델 공유용)
  resources:
    requests:
      storage: 100Gi
```

### 6.4 EFS 설정 (모델 공유용)

**Terraform으로 EFS 생성:**

```hcl
# terraform/efs.tf

# EFS 파일 시스템
resource "aws_efs_file_system" "models" {
  creation_token = "invokeai-models"
  encrypted      = true

  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"  # Infrequent Access로 이동
  }

  tags = {
    Name = "invokeai-models"
  }
}

# EFS 마운트 타겟 (각 AZ)
resource "aws_efs_mount_target" "models" {
  count = 3

  file_system_id  = aws_efs_file_system.models.id
  subnet_id       = [
    aws_subnet.private_app_a.id,
    aws_subnet.private_app_b.id,
    aws_subnet.private_app_c.id,
  ][count.index]
  security_groups = [aws_security_group.efs.id]
}

# EFS 보안 그룹
resource "aws_security_group" "efs" {
  name        = "efs-sg"
  description = "Security group for EFS"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
    description     = "NFS from EKS"
  }
}
```

**EFS CSI Driver 설치:**

```bash
# Helm으로 EFS CSI Driver 설치
helm repo add aws-efs-csi-driver https://kubernetes-sigs.github.io/aws-efs-csi-driver/
helm repo update

helm install aws-efs-csi-driver aws-efs-csi-driver/aws-efs-csi-driver \
  --namespace kube-system \
  --set controller.serviceAccount.create=true \
  --set controller.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::123456789:role/EFSCSIDriverRole"
```

**StorageClass 생성:**

```yaml
# k8s/storage/efs-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs
provisioner: efs.csi.aws.com
parameters:
  provisioningMode: efs-ap
  fileSystemId: fs-xxxxxxxxx  # EFS ID
  directoryPerms: "700"
```

### 6.5 우선순위 큐 설정

```python
# invokeai/app/services/celery_app.py
from celery import Celery
from kombu import Queue, Exchange

app = Celery("invokeai")

# 우선순위 큐 설정
app.conf.task_queues = [
    # 고우선순위: Enterprise 사용자
    Queue(
        "gpu_tasks_high",
        Exchange("gpu_tasks_high"),
        routing_key="gpu.high",
        priority=10,
    ),
    # 중간 우선순위: Pro 사용자
    Queue(
        "gpu_tasks_medium",
        Exchange("gpu_tasks_medium"),
        routing_key="gpu.medium",
        priority=5,
    ),
    # 낮은 우선순위: Free 사용자
    Queue(
        "gpu_tasks_low",
        Exchange("gpu_tasks_low"),
        routing_key="gpu.low",
        priority=1,
    ),
]

app.conf.task_default_priority = 5
```

**사용자 플랜에 따른 큐 선택:**

```python
# invokeai/app/api/routers/images.py
from invokeai.app.services.celery_app import app as celery_app
from invokeai.app.services.subscription import get_user_plan

@router.post("/generate")
async def generate_image(
    prompt: str,
    user_id: str = Depends(get_current_user_id),
):
    # 사용자 플랜 확인
    plan = await get_user_plan(user_id)

    # 플랜에 따른 큐 선택
    queue_map = {
        "enterprise": "gpu_tasks_high",
        "pro": "gpu_tasks_medium",
        "free": "gpu_tasks_low",
    }

    queue = queue_map.get(plan, "gpu_tasks_low")

    # Celery 작업 전송
    task = celery_app.send_task(
        "invokeai.tasks.generate_image",
        args=[user_id, prompt],
        queue=queue,
    )

    return {"task_id": task.id}
```

---

## 7. Ingress 및 로드밸런싱

### 7.1 AWS Load Balancer Controller 설치

```bash
# IAM Policy 생성 (Terraform으로 미리 생성)
# terraform/lb_controller.tf

# Helm으로 설치
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=invokeai-cluster \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::123456789:role/AmazonEKSLoadBalancerControllerRole"

# 확인
kubectl get pods -n kube-system | grep aws-load-balancer-controller
```

### 7.2 Ingress (운영계)

```yaml
# k8s/prod/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: prod
  annotations:
    # ALB 설정
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip

    # SSL/TLS
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789:certificate/xxxxx
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'

    # Health Check
    alb.ingress.kubernetes.io/healthcheck-path: /api/v1/health
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: '15'
    alb.ingress.kubernetes.io/healthcheck-timeout-seconds: '5'
    alb.ingress.kubernetes.io/healthy-threshold-count: '2'
    alb.ingress.kubernetes.io/unhealthy-threshold-count: '2'

    # 성능
    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=60

    # WAF (선택사항)
    alb.ingress.kubernetes.io/wafv2-acl-arn: arn:aws:wafv2:us-east-1:123456789:regional/webacl/invokeai-waf/xxxxx

    # 태그
    alb.ingress.kubernetes.io/tags: Environment=production,Application=invokeai

spec:
  rules:
    - host: api.invokeai.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
```

### 7.3 Ingress (개발계)

```yaml
# k8s/dev/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: dev
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789:certificate/xxxxx
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'

    # 개발계는 Basic Auth 추가 (보안)
    alb.ingress.kubernetes.io/auth-type: cognito
    alb.ingress.kubernetes.io/auth-idp-cognito: '{"UserPoolArn":"arn:aws:cognito-idp:us-east-1:123456789:userpool/xxxxx","UserPoolClientId":"xxxxx","UserPoolDomain":"invokeai-dev"}'

spec:
  rules:
    - host: dev-api.invokeai.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
```

### 7.4 CloudFront 연동 (선택사항)

```hcl
# terraform/cloudfront.tf

# CloudFront Distribution
resource "aws_cloudfront_distribution" "api" {
  enabled = true
  comment = "InvokeAI API Distribution"

  # ALB를 Origin으로
  origin {
    domain_name = aws_lb.main.dns_name  # ALB DNS
    origin_id   = "alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # 기본 캐시 동작 (API는 캐싱 안 함)
  default_cache_behavior {
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Host"]

      cookies {
        forward = "all"
      }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # 정적 파일 캐싱 (이미지 등)
  ordered_cache_behavior {
    path_pattern           = "/static/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400   # 1일
    max_ttl     = 31536000  # 1년
  }

  # SSL/TLS
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.main.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # Geo Restriction (선택사항)
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
```

---

## 8. Auto Scaling

### 8.1 Horizontal Pod Autoscaler (HPA)

**Metrics Server 설치:**

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# 확인
kubectl get deployment metrics-server -n kube-system
```

**API Server HPA:**

```yaml
# k8s/prod/api-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: prod
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server

  minReplicas: 3
  maxReplicas: 20

  metrics:
    # CPU 기반 스케일링
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

    # 메모리 기반 스케일링
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80

  # 스케일링 동작
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # 5분 대기
      policies:
        - type: Percent
          value: 50  # 한 번에 50%만 축소
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0  # 즉시 확장
      policies:
        - type: Percent
          value: 100  # 한 번에 2배 확장 가능
          periodSeconds: 15
        - type: Pods
          value: 4  # 최대 4개씩 추가
          periodSeconds: 15
      selectPolicy: Max  # 더 큰 값 선택
```

**GPU Worker HPA:**

```yaml
# k8s/prod/gpu-worker-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: gpu-worker-hpa
  namespace: prod
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: gpu-worker

  minReplicas: 1
  maxReplicas: 10

  metrics:
    # GPU 메모리 사용률 (Custom Metric)
    - type: Pods
      pods:
        metric:
          name: gpu_memory_utilization
        target:
          type: AverageValue
          averageValue: "80"

    # Queue 길이 기반 (Custom Metric)
    - type: External
      external:
        metric:
          name: redis_queue_length
          selector:
            matchLabels:
              queue: gpu_tasks
        target:
          type: AverageValue
          averageValue: "5"  # Queue에 5개 이상이면 스케일업

  behavior:
    scaleDown:
      stabilizationWindowSeconds: 600  # 10분 대기 (GPU 비쌈)
      policies:
        - type: Pods
          value: 1  # 한 번에 1개씩만 축소
          periodSeconds: 300  # 5분마다
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 2  # 한 번에 2개씩 추가
          periodSeconds: 60
```

### 8.2 Cluster Autoscaler

```bash
# Helm으로 Cluster Autoscaler 설치
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm repo update

helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  --namespace kube-system \
  --set autoDiscovery.clusterName=invokeai-cluster \
  --set awsRegion=us-east-1 \
  --set rbac.serviceAccount.create=true \
  --set rbac.serviceAccount.name=cluster-autoscaler \
  --set rbac.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::123456789:role/ClusterAutoscalerRole" \
  --set extraArgs.balance-similar-node-groups=true \
  --set extraArgs.skip-nodes-with-system-pods=false
```

**Cluster Autoscaler 설정:**

```yaml
# k8s/cluster-autoscaler-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |
    10:
      - .*-general-.*
    50:
      - .*-gpu-.*
```

### 8.3 Karpenter (대안 - 더 빠른 스케일링)

```bash
# Karpenter 설치 (Cluster Autoscaler 대신)
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version v0.32.0 \
  --namespace karpenter \
  --create-namespace \
  --set settings.aws.clusterName=invokeai-cluster \
  --set settings.aws.defaultInstanceProfile=KarpenterNodeInstanceProfile \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::123456789:role/KarpenterControllerRole"
```

**Karpenter Provisioner:**

```yaml
# k8s/karpenter/provisioner.yaml
apiVersion: karpenter.sh/v1alpha5
kind: Provisioner
metadata:
  name: default
spec:
  # 제약조건
  requirements:
    - key: karpenter.sh/capacity-type
      operator: In
      values: ["spot", "on-demand"]
    - key: kubernetes.io/arch
      operator: In
      values: ["amd64"]
    - key: node.kubernetes.io/instance-type
      operator: In
      values: ["t3.large", "t3.xlarge", "t3.2xlarge"]

  limits:
    resources:
      cpu: 100
      memory: 200Gi

  providerRef:
    name: default

  # TTL 설정
  ttlSecondsAfterEmpty: 300  # 빈 노드 5분 후 제거
  ttlSecondsUntilExpired: 86400  # 24시간 후 교체
---
# GPU Provisioner
apiVersion: karpenter.sh/v1alpha5
kind: Provisioner
metadata:
  name: gpu
spec:
  requirements:
    - key: karpenter.sh/capacity-type
      operator: In
      values: ["spot"]  # Spot만 사용
    - key: node.kubernetes.io/instance-type
      operator: In
      values: ["g5.xlarge", "g5.2xlarge"]
    - key: nvidia.com/gpu
      operator: Exists

  taints:
    - key: nvidia.com/gpu
      value: "true"
      effect: NoSchedule

  limits:
    resources:
      nvidia.com/gpu: "10"

  ttlSecondsAfterEmpty: 600  # GPU는 10분 대기
```

---

## 9. 모니터링 및 로깅

### 9.1 Prometheus + Grafana 설치

```bash
# kube-prometheus-stack 설치
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.retention=30d \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=100Gi \
  --set grafana.adminPassword=admin123 \
  --set grafana.ingress.enabled=true \
  --set grafana.ingress.hosts[0]=grafana.invokeai.com
```

### 9.2 커스텀 메트릭 수집

**ServiceMonitor (API Server):**

```yaml
# k8s/monitoring/api-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api-server
  namespace: prod
  labels:
    app: api-server
spec:
  selector:
    matchLabels:
      app: api-server
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

**Prometheus 룰:**

```yaml
# k8s/monitoring/prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: invokeai-alerts
  namespace: monitoring
spec:
  groups:
    - name: invokeai
      interval: 30s
      rules:
        # API 서버 다운
        - alert: APIServerDown
          expr: up{job="api-server"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "API Server is down"
            description: "API Server {{ $labels.pod }} has been down for 1 minute"

        # GPU 워커 다운
        - alert: GPUWorkerDown
          expr: up{job="gpu-worker"} == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU Worker is down"

        # High CPU
        - alert: HighCPUUsage
          expr: rate(container_cpu_usage_seconds_total{namespace="prod"}[5m]) > 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High CPU usage detected"

        # High Memory
        - alert: HighMemoryUsage
          expr: container_memory_usage_bytes{namespace="prod"} / container_spec_memory_limit_bytes{namespace="prod"} > 0.9
          for: 5m
          labels:
            severity: warning

        # Queue 백로그
        - alert: HighQueueBacklog
          expr: redis_queue_length{queue="gpu_tasks"} > 100
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High queue backlog detected"
```

### 9.3 로깅 (FluentBit → CloudWatch)

```bash
# AWS for FluentBit 설치
helm repo add aws https://aws.github.io/eks-charts
helm repo update

helm install aws-for-fluent-bit aws/aws-for-fluent-bit \
  --namespace kube-system \
  --set serviceAccount.create=true \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::123456789:role/FluentBitRole" \
  --set cloudWatch.enabled=true \
  --set cloudWatch.region=us-east-1 \
  --set cloudWatch.logGroupName=/aws/eks/invokeai-cluster/logs
```

**FluentBit 커스텀 설정:**

```yaml
# k8s/logging/fluentbit-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: kube-system
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     info
        Daemon        off

    [INPUT]
        Name              tail
        Path              /var/log/containers/*_prod_*.log
        Parser            docker
        Tag               prod.*
        Refresh_Interval  5

    [INPUT]
        Name              tail
        Path              /var/log/containers/*_dev_*.log
        Parser            docker
        Tag               dev.*
        Refresh_Interval  5

    [FILTER]
        Name                kubernetes
        Match               *
        Kube_URL            https://kubernetes.default.svc:443
        Kube_Tag_Prefix     kube.var.log.containers.
        Merge_Log           On
        Keep_Log            Off

    [OUTPUT]
        Name                cloudwatch_logs
        Match               prod.*
        region              us-east-1
        log_group_name      /aws/eks/invokeai/prod
        auto_create_group   true

    [OUTPUT]
        Name                cloudwatch_logs
        Match               dev.*
        region              us-east-1
        log_group_name      /aws/eks/invokeai/dev
        auto_create_group   true
```

### 9.4 Grafana 대시보드

**InvokeAI 커스텀 대시보드:**

```json
{
  "dashboard": {
    "title": "InvokeAI Production Dashboard",
    "panels": [
      {
        "title": "API Server CPU",
        "targets": [
          {
            "expr": "rate(container_cpu_usage_seconds_total{namespace=\"prod\",pod=~\"api-server-.*\"}[5m])"
          }
        ]
      },
      {
        "title": "GPU Worker Status",
        "targets": [
          {
            "expr": "up{job=\"gpu-worker\",namespace=\"prod\"}"
          }
        ]
      },
      {
        "title": "Queue Length",
        "targets": [
          {
            "expr": "redis_queue_length{namespace=\"prod\"}"
          }
        ]
      },
      {
        "title": "Image Generation Rate",
        "targets": [
          {
            "expr": "rate(image_generation_total{namespace=\"prod\"}[5m])"
          }
        ]
      }
    ]
  }
}
```

---

## 10. CI/CD 파이프라인

### 10.1 GitHub Actions (전체 파이프라인)

```yaml
# .github/workflows/deploy.yml
name: Deploy to EKS

on:
  push:
    branches:
      - main  # 운영 배포
      - develop  # 개발 배포

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: 123456789.dkr.ecr.us-east-1.amazonaws.com
  EKS_CLUSTER_NAME: invokeai-cluster

jobs:
  # 1. 테스트
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
          pip install -r requirements-dev.txt

      - name: Run tests
        run: |
          pytest tests/ -v --cov=invokeai

      - name: Lint
        run: |
          ruff check .
          black --check .

  # 2. 빌드 및 푸시
  build:
    needs: test
    runs-on: ubuntu-latest
    outputs:
      image_tag: ${{ steps.meta.outputs.tags }}
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v1

      - name: Docker meta
        id: meta
        uses: docker/metadata-action@v4
        with:
          images: ${{ env.ECR_REGISTRY }}/invokeai-api
          tags: |
            type=ref,event=branch
            type=sha,prefix={{branch}}-

      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # 3. 배포 (운영)
  deploy-prod:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://api.invokeai.com
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Update kubeconfig
        run: |
          aws eks update-kubeconfig --name ${{ env.EKS_CLUSTER_NAME }} --region ${{ env.AWS_REGION }}

      - name: Deploy to prod
        run: |
          # 이미지 태그 업데이트
          kubectl set image deployment/api-server \
            api=${{ needs.build.outputs.image_tag }} \
            -n prod

          # 롤아웃 확인
          kubectl rollout status deployment/api-server -n prod --timeout=10m

      - name: Run smoke tests
        run: |
          # Health check
          kubectl run smoke-test --image=curlimages/curl --rm -it --restart=Never -- \
            curl -f http://api-service.prod.svc.cluster.local/api/v1/health

  # 4. 배포 (개발)
  deploy-dev:
    needs: build
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    environment:
      name: development
      url: https://dev-api.invokeai.com
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Update kubeconfig
        run: |
          aws eks update-kubeconfig --name ${{ env.EKS_CLUSTER_NAME }} --region ${{ env.AWS_REGION }}

      - name: Deploy to dev
        run: |
          kubectl set image deployment/api-server \
            api=${{ needs.build.outputs.image_tag }} \
            -n dev

          kubectl rollout status deployment/api-server -n dev --timeout=5m
```

### 10.2 DB 마이그레이션 (별도 Job)

```yaml
# .github/workflows/db-migrate.yml
name: Database Migration

on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment'
        required: true
        type: choice
        options:
          - dev
          - prod

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Update kubeconfig
        run: |
          aws eks update-kubeconfig --name invokeai-cluster --region us-east-1

      - name: Run migration
        run: |
          kubectl run db-migrate-${{ github.run_id }} \
            --image=123456789.dkr.ecr.us-east-1.amazonaws.com/invokeai-api:latest \
            --restart=Never \
            --namespace=${{ inputs.environment }} \
            --env-from=configmap/invokeai-config \
            --env-from=secret/db-credentials \
            --command -- alembic upgrade head

          # 로그 확인
          kubectl logs -f db-migrate-${{ github.run_id }} -n ${{ inputs.environment }}

          # 정리
          kubectl delete pod db-migrate-${{ github.run_id }} -n ${{ inputs.environment }}
```

### 10.3 Rollback 스크립트

```bash
# scripts/rollback.sh
#!/bin/bash

NAMESPACE=${1:-prod}
DEPLOYMENT=${2:-api-server}

echo "Rolling back $DEPLOYMENT in $NAMESPACE namespace..."

# 이전 버전으로 롤백
kubectl rollout undo deployment/$DEPLOYMENT -n $NAMESPACE

# 롤백 확인
kubectl rollout status deployment/$DEPLOYMENT -n $NAMESPACE

echo "Rollback completed!"

# 현재 상태 확인
kubectl get pods -n $NAMESPACE -l app=$DEPLOYMENT
```

---

## 11. 비용 최적화 체크리스트

### 11.1 컴퓨팅

- [ ] GPU 워커는 Spot 인스턴스 사용
- [ ] Karpenter로 빠른 스케일링 (노드 낭비 최소화)
- [ ] HPA로 Pod 자동 스케일링
- [ ] 야간/주말 최소 레플리카 설정
- [ ] Reserved Instances (1년 약정 시 40% 할인)

### 11.2 스토리지

- [ ] EFS Infrequent Access (30일 후 자동 이동)
- [ ] S3 Lifecycle Policy (90일 후 Glacier)
- [ ] EBS GP3 사용 (GP2보다 20% 저렴)
- [ ] 불필요한 스냅샷 삭제

### 11.3 네트워크

- [ ] CloudFront로 S3 요청 감소
- [ ] NAT Gateway 최소화 (VPC Endpoint 사용)
- [ ] 데이터 전송 최적화 (압축)

### 11.4 데이터베이스

- [ ] Aurora Serverless v2 (사용량에 따라 자동 스케일)
- [ ] Read Replica로 읽기 분산
- [ ] Connection Pooling (PgBouncer)

---

## 12. 보안 체크리스트

### 12.1 네트워크

- [ ] Private Subnet에 Worker 배치
- [ ] Security Group 최소 권한
- [ ] NetworkPolicy로 Pod 간 격리
- [ ] WAF 설정 (SQL Injection, XSS 방어)

### 12.2 인증/인가

- [ ] IRSA (IAM Roles for Service Accounts)
- [ ] Secrets Manager로 민감 정보 관리
- [ ] Pod에 IAM 역할 직접 할당 금지

### 12.3 데이터

- [ ] Aurora 암호화 (KMS)
- [ ] EBS 암호화
- [ ] S3 버킷 암호화
- [ ] TLS/SSL 통신

---

## 13. 트러블슈팅

### 13.1 Pod가 Pending 상태

```bash
# 이벤트 확인
kubectl describe pod <pod-name> -n <namespace>

# 노드 리소스 확인
kubectl top nodes

# 흔한 원인:
# 1. 리소스 부족 → Cluster Autoscaler 확인
# 2. Taints 불일치 → tolerations 확인
# 3. PVC 연결 실패 → PVC 상태 확인
```

### 13.2 GPU Pod가 스케줄링 안 됨

```bash
# GPU 노드 확인
kubectl get nodes -l nvidia.com/gpu=true

# NVIDIA Device Plugin 확인
kubectl get pods -n kube-system | grep nvidia

# GPU 리소스 확인
kubectl describe node <gpu-node> | grep nvidia.com/gpu
```

### 13.3 DB 연결 실패

```bash
# Secret 확인
kubectl get secret db-credentials -n prod -o yaml

# DB 연결 테스트
kubectl run psql-test --rm -it --image=postgres:15 --restart=Never -- \
  psql -h <aurora-endpoint> -U invokeai_prod -d invokeai

# Security Group 확인 (EKS → Aurora)
```

---

## 14. 참고 자료

### AWS 문서

- [EKS Best Practices](https://aws.github.io/aws-eks-best-practices/)
- [Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/)
- [EFS Performance](https://docs.aws.amazon.com/efs/latest/ug/performance.html)

### Kubernetes 문서

- [HPA Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [GPU Support](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

### 도구

- [k9s](https://k9scli.io/) - Kubernetes CLI UI
- [Lens](https://k8slens.dev/) - Kubernetes IDE
- [kubectx/kubens](https://github.com/ahmetb/kubectx) - Context/Namespace 전환

---

**작성 완료!** 🎉

이 가이드는 InvokeAI를 EKS 기반 구독형 SaaS로 전환하는 완전한 로드맵입니다.

**다음 단계:**
1. Terraform으로 인프라 구축
2. 네임스페이스 및 Aurora 설정
3. 애플리케이션 배포
4. 모니터링 구성
5. CI/CD 파이프라인 설정

**예상 소요 시간:** 8-10주

**행운을 빕니다!** 🚀
