# 기존 가이드 수정 필요 사항

이 문서는 **단일 클러스터 + 네임스페이스 분리 + 공유 RDS** 구성을 반영하기 위해 기존 가이드에서 수정이 필요한 부분을 상세하게 정리합니다.

## 목차
1. [Phase 1 수정 사항](#phase-1-수정-사항)
2. [Phase 2 수정 사항](#phase-2-수정-사항)
3. [Phase 3 수정 사항](#phase-3-수정-사항)
4. [Phase 4 수정 사항](#phase-4-수정-사항)
5. [Phase 5 수정 사항](#phase-5-수정-사항)
6. [Phase 6 수정 사항](#phase-6-수정-사항)
7. [아키텍처 문서 수정](#아키텍처-문서-수정)

---

## Phase 1 수정 사항

### 파일: `docs/hands-on-guide/phase-01-local-setup.md`

#### 1. Docker Desktop 리소스 설정 섹션 추가

**위치**: "사전 요구사항 설치" > "1. Docker Desktop 설치" 이후

**추가 내용**:
```markdown
### 1-1. Docker Desktop 리소스 설정 (맥북 M2 Max)

맥북 M2 Max 96GB 환경에 최적화된 설정:

**Docker Desktop > Settings > Resources**:
- **CPUs**: 8 cores
- **Memory**: 32 GB (시스템에 64GB 남김)
- **Swap**: 4 GB
- **Disk**: 100 GB

**macOS 전용 설정**:
- Settings > Features in Development
  - ✅ Use Rosetta for x86/amd64 emulation on Apple Silicon

이 설정으로 로컬에서 개발 환경 전체를 실행할 수 있습니다.
```

---

#### 2. ARM64 네이티브 이미지 설정

**위치**: "Docker Compose 로컬 인프라" > "1. docker-compose.dev.yaml 생성"

**수정 내용**:
```diff
 version: '3.8'

 services:
   # PostgreSQL 17.4
   postgres:
     image: postgres:17.4
+    platform: linux/arm64  # M2 Max 네이티브
     container_name: invokeai-postgres
```

모든 서비스에 `platform` 추가:
- `postgres`: `linux/arm64`
- `redis`: `linux/arm64`
- `localstack`: `linux/amd64` (x86만 지원, Rosetta 사용)
- `pgadmin`: `linux/arm64`
- `redis-commander`: `linux/arm64`

---

#### 3. 공유 RDS 스키마 반영

**위치**: "PostgreSQL 초기화 스크립트" > `init-db.sql`

**수정 내용**:
```diff
 -- Create schemas
 CREATE SCHEMA IF NOT EXISTS dev_pingvas;
-CREATE SCHEMA IF NOT EXISTS prod_pingvas;
+CREATE SCHEMA IF NOT EXISTS prod_pingvas;  # 로컬에서도 양쪽 스키마 생성

-# Set default schema to dev
+# 개발 시 dev 스키마 사용
 SET search_path TO dev_pingvas;
```

**추가 설명**:
```markdown
> **참고**: 로컬 환경에서도 dev/prod 스키마를 모두 생성하여 AWS 환경과 동일한 구조를 유지합니다.
> 실제 AWS에서는 단일 RDS 인스턴스에 두 스키마가 공존하며, 애플리케이션이 환경 변수로 스키마를 선택합니다.
```

---

#### 4. MPS GPU 테스트 섹션 추가

**위치**: "InvokeAI 로컬 실행" 이후

**새 섹션 추가**:
```markdown
## 맥북 M2 Max GPU (MPS) 테스트

M2 Max의 38-core GPU를 활용한 로컬 추론 테스트:

### 1. PyTorch MPS 지원 확인

\```bash
pip install torch torchvision torchaudio
python3 -c "import torch; print('MPS available:', torch.backends.mps.is_available())"
# MPS available: True
\```

### 2. 로컬 이미지 생성 테스트

\```python
import torch
from diffusers import StableDiffusionPipeline
import time

# MPS 디바이스 사용
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
    "A serene lake with mountains",
    num_inference_steps=30
).images[0]

duration = time.time() - start
print(f"Generation time: {duration:.2f}s")
image.save("test_mps.png")
\```

**성능 비교**:
- CPU (M2 Max 12-core): ~120초
- MPS (M2 Max 38-core GPU): ~15초 (8배 빠름)
- AWS g4dn.xlarge (NVIDIA T4): ~8초

> M2 Max MPS는 프로토타이핑과 개발 테스트에 충분한 성능을 제공합니다.
```

---

## Phase 2 수정 사항

### 파일: `docs/hands-on-guide/phase-02-microservices.md`

#### 1. 환경 변수에 스키마 추가

**위치**: "FastAPI 마이크로서비스 템플릿" > "3. 환경 변수 설정"

**수정 내용**:
```diff
 # Database
 DATABASE_URL=postgresql://pingvas_admin:dev_password_123@localhost:5432/pingvas_saas
+DB_SCHEMA=dev_pingvas
```

---

#### 2. 설정 파일에 스키마 필드 추가

**위치**: "4. 설정 파일" > `app/config.py`

**수정 내용**:
```diff
 class Settings(BaseSettings):
     # Database
     database_url: str
+    db_schema: str = "dev_pingvas"
```

---

#### 3. SQLAlchemy 모델에 스키마 명시

**위치**: "5. 데이터베이스 모델" > `app/models/user.py`

**수정 내용**:
```diff
 from app.db.base import Base
+from app.config import settings

 class User(Base):
     __tablename__ = "users"
-    __table_args__ = {"schema": "dev_pingvas"}
+    __table_args__ = {"schema": settings.db_schema}
```

**추가 설명**:
```markdown
> **중요**: 모든 모델에서 `__table_args__`에 동적으로 스키마를 설정합니다.
> 이렇게 하면 환경 변수 `DB_SCHEMA`만 변경하여 dev/prod 스키마를 전환할 수 있습니다.
```

---

#### 4. 연결 시 search_path 설정

**위치**: "7. 데이터베이스 연결" > `app/db/base.py`

**수정 내용**:
```diff
+from sqlalchemy import event
 from sqlalchemy import create_engine

 engine = create_engine(
     settings.database_url,
     pool_pre_ping=True,
 )

+@event.listens_for(engine, "connect")
+def set_search_path(dbapi_conn, connection_record):
+    """연결 시 스키마 search_path 설정"""
+    cursor = dbapi_conn.cursor()
+    cursor.execute(f"SET search_path TO {settings.db_schema}, public")
+    cursor.close()
+
 SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
```

---

#### 5. 서비스 간 통신 시 네임스페이스 반영

**위치**: "서비스 간 통신" > "2. 서비스 디스커버리"

**수정 내용**:
```diff
-async def get_user_tier(user_id: str) -> dict:
-    async with httpx.AsyncClient() as client:
-        response = await client.get(f"http://user-service:8001/api/v1/users/{user_id}/tier")
-        return response.json()
+async def get_user_tier(user_id: str, namespace: str = "dev") -> dict:
+    """
+    User Service에서 티어 조회
+    Args:
+        namespace: 'dev' or 'prod'
+    """
+    service_url = f"http://user-service.{namespace}.svc.cluster.local:8001"
+
+    async with httpx.AsyncClient() as client:
+        response = await client.get(f"{service_url}/api/v1/users/{user_id}/tier")
+        return response.json()
```

**환경 변수 추가**:
```python
# app/config.py
class Settings(BaseSettings):
    namespace: str = "dev"  # Kubernetes namespace
```

---

## Phase 3 수정 사항

### 파일: `docs/hands-on-guide/phase-03-aws-infra.md`

#### ⚠️ 이 Phase는 대부분 재작성 필요

**삭제할 섹션**:
- "Dev 환경 설정" → "Shared 환경 설정"으로 대체
- "Prod 환경 설정" → 삭제
- 별도 RDS 모듈 → 공유 RDS 모듈로 대체

---

#### 1. 디렉토리 구조 변경

**위치**: "Terraform 프로젝트 구조"

**수정 내용**:
```diff
 infra/terraform/
 ├── modules/
 │   ├── vpc/
-│   ├── eks/
+│   ├── eks-single/        # 단일 클러스터 모듈
-│   ├── rds/
+│   ├── rds-shared/        # 공유 RDS 모듈
-│   ├── elasticache/
+│   ├── elasticache-shared/
 │   ├── s3/
 │   └── efs/
 └── environments/
-    ├── dev/
-    └── prod/
+    └── shared/             # 통합 환경
+        ├── main.tf
+        ├── variables.tf
+        └── terraform.tfvars
```

---

#### 2. VPC 모듈 수정

**위치**: "VPC 및 네트워크" > `modules/vpc/main.tf`

**수정 내용**:
```diff
 # NAT Gateway
 resource "aws_nat_gateway" "main" {
-  count         = var.enable_nat_gateway ? length(var.azs) : 0
+  count         = var.single_nat_gateway ? 1 : length(var.azs)
   allocation_id = aws_eip.nat[count.index].id
   subnet_id     = aws_subnet.public[count.index].id
```

**variables.tf에 추가**:
```hcl
variable "single_nat_gateway" {
  description = "Use single NAT Gateway for cost savings"
  type        = bool
  default     = true
}
```

---

#### 3. EKS 모듈 → EKS Single 모듈

**위치**: 새 파일 생성 `modules/eks-single/main.tf`

**내용**: [single-cluster-cost-optimized-setup.md](./single-cluster-cost-optimized-setup.md)의 "단일 클러스터 Terraform" > "2. 단일 클러스터 모듈" 참조

---

#### 4. RDS 모듈 → RDS Shared 모듈

**위치**: 새 파일 생성 `modules/rds-shared/main.tf`

**주요 변경**:
```diff
 # RDS Aurora Cluster
 resource "aws_rds_cluster" "main" {
-  cluster_identifier = "${var.environment}-pingvas-aurora"
+  cluster_identifier = "pingvas-shared-aurora"

-  engine_mode = "provisioned"
+  # Aurora Serverless v2 for cost optimization
+  engine_mode = "provisioned"
+  serverlessv2_scaling_configuration {
+    max_capacity = 4.0
+    min_capacity = 0.5  # Scale to 0.5 ACU when idle
+  }
```

**인스턴스 수 감소**:
```diff
 # Cluster Instances
-resource "aws_rds_cluster_instance" "main" {
-  count              = var.instance_count
+resource "aws_rds_cluster_instance" "writer" {
   identifier         = "pingvas-shared-writer"
-  instance_class     = var.instance_class
+  instance_class     = "db.serverless"
+}

+resource "aws_rds_cluster_instance" "reader" {
+  identifier         = "pingvas-shared-reader"
+  instance_class     = "db.serverless"
+}
```

---

#### 5. ElastiCache 모듈 → ElastiCache Shared 모듈

**위치**: 새 파일 생성 `modules/elasticache-shared/main.tf`

**주요 변경**:
```diff
 resource "aws_elasticache_replication_group" "main" {
-  replication_group_id = "${var.environment}-pingvas-redis"
+  replication_group_id = "pingvas-shared-redis"

-  num_cache_clusters = var.num_cache_nodes
+  num_cache_clusters = 2  # Writer + Reader
```

**outputs.tf 수정**:
```hcl
output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
  description = "Use DB 0 for dev, DB 1 for prod"
}
```

---

#### 6. Shared 환경 Main 파일

**위치**: 새 파일 생성 `environments/shared/main.tf`

**전체 내용**: [single-cluster-cost-optimized-setup.md](./single-cluster-cost-optimized-setup.md)의 "4. 공유 환경 Main" 참조

---

#### 7. 배포 섹션 수정

**위치**: "인프라 배포" > "2. 배포 실행"

**수정 내용**:
```diff
-cd infra/terraform/environments/dev
+cd infra/terraform/environments/shared

 # 초기화
 terraform init

 # 계획 확인
 terraform plan

-# 배포 (약 20-30분 소요)
+# 배포 (약 25-35분 소요, 단일 클러스터)
 terraform apply
```

---

#### 8. 검증 섹션 수정

**위치**: "검증 및 테스트" > "1. EKS 클러스터 접속"

**수정 내용**:
```diff
 # kubeconfig 업데이트
-aws eks update-kubeconfig --name dev-pingvas-eks --region us-east-1
+aws eks update-kubeconfig --name pingvas-shared-eks --region us-east-1

 # 노드 확인
 kubectl get nodes

 # 네임스페이스 생성
 kubectl create namespace dev
 kubectl create namespace prod
+
+# ResourceQuota 적용
+kubectl apply -f k8s/namespaces/dev-quota.yaml
+kubectl apply -f k8s/namespaces/prod-quota.yaml
+
+# NetworkPolicy 적용
+kubectl apply -f k8s/network-policies/
```

---

## Phase 4 수정 사항

### 파일: `docs/hands-on-guide/phase-04-gpu-autoscaling.md`

#### 1. Karpenter NodePool에 네임스페이스 고려

**위치**: "GPU NodePool 구성" > "2. NodePool (GPU Spot)"

**수정 내용**:
```diff
 apiVersion: karpenter.sh/v1beta1
 kind: NodePool
 metadata:
   name: gpu-spot
 spec:
   template:
     metadata:
       labels:
         workload-type: gpu
         instance-lifecycle: spot
+        tier: shared  # dev/prod 공유
```

**제한 조정**:
```diff
   # Limits
-  limits:
-    nvidia.com/gpu: "20"  # 최대 20개 GPU
+  limits:
+    nvidia.com/gpu: "10"  # 단일 클러스터에서 제한
```

---

#### 2. Worker Deployment 네임스페이스별 배포

**위치**: "AI Worker Pod 배포" > "1. Worker Deployment"

**수정 내용**:
```diff
 apiVersion: apps/v1
 kind: Deployment
 metadata:
   name: invokeai-worker
-  namespace: dev
+  namespace: {{ NAMESPACE }}  # dev 또는 prod
 spec:
   replicas: 0
+
+  # 리소스 제한 (네임스페이스 ResourceQuota 고려)
   template:
     spec:
       containers:
         - name: worker
           resources:
             requests:
+              # Dev: 최대 3 GPU, Prod: 최대 15 GPU (ResourceQuota)
               nvidia.com/gpu: 1
               memory: 16Gi
               cpu: 4
```

**별도 매니페스트 생성**:
```bash
k8s/workers/
├── base/
│   └── invokeai-worker.yaml
└── overlays/
    ├── dev/
    │   └── kustomization.yaml
    └── prod/
        └── kustomization.yaml
```

---

#### 3. KEDA ScaledObject 네임스페이스별

**위치**: "HPA 설정" > "2. KEDA"

**수정 내용**:
```diff
 apiVersion: keda.sh/v1alpha1
 kind: ScaledObject
 metadata:
   name: invokeai-worker-scaler
-  namespace: dev
+  namespace: {{ NAMESPACE }}
 spec:
   scaleTargetRef:
     name: invokeai-worker

   minReplicaCount: 0
-  maxReplicaCount: 20
+  maxReplicaCount: {{ if eq NAMESPACE "dev" }}5{{ else }}15{{ end }}
```

---

## Phase 5 수정 사항

### 파일: `docs/hands-on-guide/phase-05-gitops-cicd.md`

#### 1. ApplicationSet 단일 클러스터 버전

**위치**: "ApplicationSet 설정" > "4. ApplicationSet"

**전체 교체**:
```diff
 apiVersion: argoproj.io/v1alpha1
 kind: ApplicationSet
 metadata:
   name: pingvas-services
   namespace: argocd
 spec:
   generators:
     - matrix:
         generators:
           # 환경 (dev, prod) - 단일 클러스터
           - list:
               elements:
                 - env: dev
-                  cluster: dev-pingvas-eks
                   namespace: dev
                   revision: main
+                  server: https://kubernetes.default.svc  # 같은 클러스터

                 - env: prod
-                  cluster: prod-pingvas-eks
                   namespace: prod
                   revision: main
+                  server: https://kubernetes.default.svc  # 같은 클러스터

           # 서비스 목록 (동일)
           - list:
               elements:
                 - service: user-service
                 - service: payment-service
                 - service: generation-service
                 - service: gallery-service
                 - service: model-service

   template:
     metadata:
       name: '{{env}}-{{service}}'

     spec:
       project: default

       source:
         repoURL: https://github.com/Pinksea-AI/InvokeAI.git
         targetRevision: '{{revision}}'
         path: k8s/overlays/{{env}}/{{service}}

       destination:
-        server: https://kubernetes.default.svc
+        server: '{{server}}'
         namespace: '{{namespace}}'

       syncPolicy:
         automated:
           prune: true
-          selfHeal: true
+          # Dev는 자동, Prod는 수동
+          selfHeal: '{{ if eq .env "dev" }}true{{ else }}false{{ end }}'
```

---

#### 2. Kustomize Overlays 수정

**위치**: "Kustomize Overlays" > "1. Prod Overlay"

**DB 연결 정보 수정**:
```diff
 secretGenerator:
   - name: db-credentials
     literals:
-      - url=postgresql://user:pass@rds-prod:5432/pingvas_saas
+      # 공유 RDS, prod 스키마 사용
+      - url=postgresql://prod_user:prod_password@pingvas-shared-writer.xxxxx.rds.amazonaws.com:5432/pingvas_saas?options=-c%20search_path=prod_pingvas

 configMapGenerator:
   - name: redis-config
     literals:
-      - url=redis://redis-prod:6379/0
+      # 공유 Redis, DB 1 사용
+      - url=redis://redis-primary.default.svc.cluster.local:6379/1
```

---

#### 3. GitHub Actions CD 워크플로우 수정

**위치**: "GitHub Actions Workflows" > "2. CD 워크플로우 (Dev 배포)"

**kubeconfig 명령 수정**:
```diff
       - name: Update kubeconfig
         run: |
-          aws eks update-kubeconfig --name dev-pingvas-eks --region $AWS_REGION
+          aws eks update-kubeconfig --name pingvas-shared-eks --region $AWS_REGION
```

**ArgoCD Sync 명령 수정**:
```diff
       - name: Trigger ArgoCD Sync
         run: |
           argocd app sync -l environment=dev
+          # Dev 네임스페이스만 동기화
```

---

#### 4. Prod 배포에 승인 단계 강조

**위치**: "3. CD 워크플로우 (Prod 배포)"

**추가 설명**:
```markdown
> **중요**: 단일 클러스터 환경에서는 Prod 배포가 Dev 환경에 영향을 줄 수 있으므로
> 반드시 수동 승인 단계를 거쳐야 합니다.
>
> GitHub Environment Protection Rules 설정:
> 1. Settings > Environments > production
> 2. Required reviewers: 최소 1명
> 3. Wait timer: 5분 (배포 전 검토 시간)
```

---

## Phase 6 수정 사항

### 파일: `docs/hands-on-guide/phase-06-security-monitoring.md`

#### 1. RLS 정책에 스키마 명시

**위치**: "Row-Level Security" > "1. RLS 정책 설정"

**수정 내용**:
```diff
 -- Enable RLS on sensitive tables
-ALTER TABLE dev_pingvas.users ENABLE ROW LEVEL SECURITY;
+-- Dev 스키마
+ALTER TABLE dev_pingvas.users ENABLE ROW LEVEL SECURITY;
+ALTER TABLE dev_pingvas.images ENABLE ROW LEVEL SECURITY;
+
+-- Prod 스키마
+ALTER TABLE prod_pingvas.users ENABLE ROW LEVEL SECURITY;
+ALTER TABLE prod_pingvas.images ENABLE ROW LEVEL SECURITY;

-CREATE POLICY users_select_own ON dev_pingvas.users
+-- Dev 정책
+CREATE POLICY users_select_own ON dev_pingvas.users
+FOR SELECT
+USING (id = current_setting('app.current_user_id')::UUID);
+
+-- Prod 정책 (동일하게 생성)
+CREATE POLICY users_select_own ON prod_pingvas.users
 FOR SELECT
 USING (id = current_setting('app.current_user_id')::UUID);
```

---

#### 2. Secrets Manager 스키마별 Secret

**위치**: "AWS Secrets Manager" > "1. Terraform Secrets 생성"

**추가 Secret**:
```diff
 # Database Credentials
+resource "aws_secretsmanager_secret" "db_credentials_dev" {
+  name = "shared/pingvas/db-credentials-dev"
+}
+
+resource "aws_secretsmanager_secret_version" "db_credentials_dev" {
+  secret_id = aws_secretsmanager_secret.db_credentials_dev.id
+  secret_string = jsonencode({
+    username = "dev_user"
+    password = var.db_dev_password
+    host     = var.db_host
+    port     = var.db_port
+    dbname   = var.db_name
+    schema   = "dev_pingvas"
+  })
+}
+
 resource "aws_secretsmanager_secret" "db_credentials" {
-  name = "${var.environment}/pingvas/db-credentials"
+  name = "shared/pingvas/db-credentials-prod"
 }

 resource "aws_secretsmanager_secret_version" "db_credentials" {
   secret_id = aws_secretsmanager_secret.db_credentials.id
   secret_string = jsonencode({
-    username = var.db_username
-    password = var.db_password
+    username = "prod_user"
+    password = var.db_prod_password
     host     = var.db_host
     port     = var.db_port
     dbname   = var.db_name
+    schema   = "prod_pingvas"
   })
 }
```

---

#### 3. Prometheus 메트릭에 네임스페이스 레이블

**위치**: "Prometheus & Grafana" > "2. Custom Metrics"

**수정 내용**:
```diff
 generation_requests_total = Counter(
     'generation_requests_total',
     'Total generation requests',
-    ['tier', 'status']
+    ['namespace', 'tier', 'status']  # 네임스페이스 추가
 )
```

**사용 시**:
```diff
-generation_requests_total.labels(tier=user.tier, status="started").inc()
+generation_requests_total.labels(
+    namespace=settings.namespace,  # "dev" or "prod"
+    tier=user.tier,
+    status="started"
+).inc()
```

---

#### 4. Grafana 대시보드 네임스페이스 분리

**위치**: "3. Grafana 대시보드"

**쿼리 수정**:
```diff
 {
   "expr": "rate(generation_requests_total[5m])",
-  "legendFormat": "{{tier}} - {{status}}"
+  "legendFormat": "[{{namespace}}] {{tier}} - {{status}}"
 }
```

**네임스페이스 변수 추가**:
```json
{
  "dashboard": {
    "templating": {
      "list": [
        {
          "name": "namespace",
          "type": "custom",
          "options": [
            {"text": "Dev", "value": "dev"},
            {"text": "Prod", "value": "prod"},
            {"text": "All", "value": ".*"}
          ],
          "current": {"text": "Prod", "value": "prod"}
        }
      ]
    }
  }
}
```

---

#### 5. CloudWatch 알람 네임스페이스별

**위치**: "CloudWatch 알람" > "1. Terraform CloudWatch 알람"

**Prod 전용 알람**:
```diff
 # API 5xx Errors
 resource "aws_cloudwatch_metric_alarm" "api_5xx_errors" {
-  alarm_name = "${var.environment}-api-5xx-errors"
+  alarm_name = "prod-api-5xx-errors"  # Prod만 알람

+  # Prod 네임스페이스 필터
   dimensions = {
-    LoadBalancer = var.alb_arn_suffix
+    LoadBalancer = var.alb_arn_suffix
+    Namespace    = "prod"
   }
 }
```

---

## 아키텍처 문서 수정

### 파일: `docs/01-architecture-overview.md`

#### 1. 인프라 다이어그램 수정

**위치**: "AWS 인프라 아키텍처" 섹션

**전체 교체**:
```mermaid
graph TB
    subgraph "AWS Cloud - Single Region (us-east-1)"
        subgraph "VPC (10.0.0.0/16)"
            subgraph "Public Subnets"
                NAT[NAT Gateway]
                ALB[Application Load Balancer]
            end

            subgraph "Private Subnets"
                subgraph "EKS Cluster (Shared)"
                    subgraph "Namespace: dev"
                        DevServices[Dev Services<br/>user/payment/generation]
                        DevWorkers[Dev GPU Workers]
                    end

                    subgraph "Namespace: prod"
                        ProdServices[Prod Services<br/>user/payment/generation]
                        ProdWorkers[Prod GPU Workers]
                    end

                    SystemNodes[System Nodes<br/>2x t3.medium Spot]
                end

                RDS[(RDS Aurora Serverless v2<br/>Writer + Reader<br/>Schema: dev_pingvas, prod_pingvas)]
                Redis[(ElastiCache Redis<br/>DB 0: dev, DB 1: prod)]
                EFS[EFS<br/>Shared Models]
            end
        end

        S3Dev[S3: dev-images]
        S3Prod[S3: prod-images]
        S3Models[S3: models-shared]
        CloudFront[CloudFront CDN]
    end

    Users[Users] --> ALB
    ALB --> DevServices
    ALB --> ProdServices
    DevServices --> RDS
    ProdServices --> RDS
    DevServices --> Redis
    ProdServices --> Redis
    DevWorkers --> EFS
    ProdWorkers --> EFS
    DevWorkers --> S3Dev
    ProdWorkers --> S3Prod
    CloudFront --> S3Dev
    CloudFront --> S3Prod
```

---

#### 2. 비용 분석 섹션 업데이트

**위치**: "비용 분석 및 최적화" 섹션

**전체 교체**: [single-cluster-cost-optimized-setup.md](./single-cluster-cost-optimized-setup.md)의 "비용 분석" 섹션 참조

---

### 파일: `docs/02-microservices-design.md`

#### 1. 서비스 간 통신 패턴 수정

**위치**: "서비스 간 통신" 섹션

**추가 내용**:
```markdown
### 네임스페이스 고려 사항

단일 클러스터에서 dev/prod 네임스페이스가 공존하므로, 서비스 호출 시 FQDN 사용:

\```python
# 잘못된 방법 (같은 네임스페이스만 접근)
url = "http://user-service:8001"

# 올바른 방법 (명시적 네임스페이스)
namespace = os.getenv("NAMESPACE", "dev")
url = f"http://user-service.{namespace}.svc.cluster.local:8001"
\```

**환경 변수 설정**:
- Dev 환경: `NAMESPACE=dev`
- Prod 환경: `NAMESPACE=prod`
```

---

### 파일: `docs/03-database-schema.md`

#### 1. 스키마 구조 명시

**위치**: 문서 서두

**추가 설명**:
```markdown
## 스키마 구조

단일 RDS 인스턴스에 두 개의 PostgreSQL 스키마 사용:

\```sql
-- Database: pingvas_saas
--   Schema: dev_pingvas   (개발 환경)
--   Schema: prod_pingvas  (운영 환경)
\```

각 스키마는 동일한 테이블 구조를 가지며, 애플리케이션은 환경 변수 `DB_SCHEMA`로
접근할 스키마를 선택합니다.

**장점**:
- 비용 절감: 단일 RDS 인스턴스
- 마이그레이션 동기화: 양쪽 스키마에 동시 적용 가능
- 데이터 격리: 스키마 수준 권한으로 분리
```

---

#### 2. 모든 CREATE TABLE 문에 스키마 명시

**위치**: 모든 테이블 정의

**수정 패턴**:
```diff
-CREATE TABLE users (
+-- Dev 스키마
+CREATE TABLE dev_pingvas.users (
+    ...
+);
+
+-- Prod 스키마
+CREATE TABLE prod_pingvas.users (
     ...
 );
```

---

### 파일: `docs/04-tier-based-qos.md`

수정 불필요 (네임스페이스와 무관한 비즈니스 로직)

---

### 파일: `docs/05-payment-integration.md`

수정 불필요 (네임스페이스와 무관한 외부 연동)

---

### 파일: `docs/06-credit-metering.md`

#### 1. 크레딧 차감 쿼리에 스키마 명시

**위치**: "원자적 크레딧 차감" 섹션

**수정 내용**:
```diff
 async def deduct_credits_atomic(user_id: str, amount: int):
+    schema = settings.db_schema  # "dev_pingvas" or "prod_pingvas"
+
     async with db.begin():
         result = await db.execute(
-            text("SELECT balance FROM credit_balances WHERE user_id = :user_id FOR UPDATE"),
+            text(f"SELECT balance FROM {schema}.credit_balances WHERE user_id = :user_id FOR UPDATE"),
             {"user_id": user_id}
         )
```

---

### 파일: `docs/07-eks-karpenter.md`

#### 1. NodePool 제한 조정

**위치**: "Karpenter 구성" > "NodePool 정의"

**수정 내용**:
```diff
 spec:
   limits:
-    cpu: 1000
-    memory: 1000Gi
-    nvidia.com/gpu: "20"
+    cpu: 200      # 단일 클러스터 제한
+    memory: 500Gi
+    nvidia.com/gpu: "10"  # Dev+Prod 합산 제한
```

---

### 파일: `docs/08-priority-queue.md`

수정 불필요 (Redis 큐 로직은 네임스페이스와 무관)

---

### 파일: `docs/09-storage-strategy.md`

#### 1. S3 버킷 구분 명시

**위치**: "S3 버킷 구조" 섹션

**수정 내용**:
```diff
 # S3 버킷 구성

-dev-pingvas-images/        # Dev 이미지
-prod-pingvas-images/       # Prod 이미지
+pingvas-dev-images/         # Dev 이미지
+pingvas-prod-images/        # Prod 이미지
-pingvas-models/            # AI 모델 (공유)
+pingvas-models-shared/      # AI 모델 (dev/prod 공유)
+pingvas-logs-shared/        # 로그 (공유)
```

---

### 파일: `docs/10-security-architecture.md`

#### 1. Network Policy 추가

**위치**: "네트워크 보안" 섹션

**새 섹션 추가**: [single-cluster-cost-optimized-setup.md](./single-cluster-cost-optimized-setup.md)의 "3. NetworkPolicy" 참조

---

#### 2. RLS 정책 스키마별 적용

**위치**: "Row-Level Security" 섹션

Phase 6 수정 사항의 "1. RLS 정책에 스키마 명시" 참조

---

### 파일: `docs/11-gitops-devops.md`

Phase 5 수정 사항 참조

---

### 파일: `docs/hands-on-guide/README.md`

#### 1. Phase 0 추가

**위치**: 문서 서두

**추가 내용**:
```markdown
## 시작하기 전에

### 환경 요구사항
- **로컬 개발 머신**: 맥북 프로 M2 Max 96GB (권장)
  - Docker Desktop 리소스: 32GB 메모리, 8 CPU
  - Rosetta 2 활성화 (x86 이미지 지원)
- **AWS 계정**: 관리자 권한
- **비용 예산**: 월 $700-1,000 (개발 + 운영 통합 환경)

### 아키텍처 방식

이 가이드는 **단일 클러스터 + 네임스페이스 분리** 구성을 사용합니다:
- ✅ 비용 최적화: 별도 클러스터 대비 59% 절감
- ✅ 단일 EKS 클러스터에 dev/prod 네임스페이스 분리
- ✅ 공유 RDS Aurora (스키마로 분리)
- ✅ 공유 Redis (DB 번호로 분리)

**Phase 0**: [단일 클러스터 비용 최적화 구성](./single-cluster-cost-optimized-setup.md) ⭐ **먼저 읽기**
```

---

#### 2. Phase 목차 업데이트

**위치**: "학습 경로"

**수정 내용**:
```diff
 ## 학습 경로

+**Phase 0 - 아키텍처 이해** (필수)
+- [단일 클러스터 비용 최적화 구성](./single-cluster-cost-optimized-setup.md)
+- 맥북 M2 Max 로컬 환경 설정
+- 네임스페이스 분리 전략
+- 공유 RDS/Redis 구성
+
 **Phase 1 - 로컬 개발 환경 구축** (1-2일)
-- Docker Compose로 PostgreSQL, Redis, LocalStack 실행
+- Docker Compose로 개발 인프라 실행 (ARM64 최적화)
+- M2 Max GPU (MPS) 테스트
```

---

## 적용 순서

### 1단계: 신규 문서 검토
1. ✅ [single-cluster-cost-optimized-setup.md](./single-cluster-cost-optimized-setup.md) 검토
2. ✅ 이 문서 (migration-updates-required.md) 검토

### 2단계: Phase 가이드 업데이트
1. Phase 1 수정 (맥북 M2 Max 최적화)
2. Phase 2 수정 (스키마 동적 설정)
3. **Phase 3 재작성** (단일 클러스터 Terraform)
4. Phase 4 수정 (네임스페이스 고려)
5. **Phase 5 재작성** (단일 클러스터 ArgoCD)
6. Phase 6 수정 (스키마별 보안)

### 3단계: 아키텍처 문서 업데이트
1. 01-architecture-overview.md (다이어그램 교체)
2. 02-microservices-design.md (네임스페이스 통신)
3. 03-database-schema.md (스키마 분리 명시)
4. 06-credit-metering.md (쿼리 수정)
5. 07-eks-karpenter.md (제한 조정)
6. 09-storage-strategy.md (버킷 구분)
7. 10-security-architecture.md (Network Policy)

### 4단계: 통합 테스트
1. 로컬 환경에서 전체 플로우 테스트
2. Terraform으로 AWS 인프라 배포
3. ArgoCD로 애플리케이션 배포
4. 네임스페이스 격리 검증

---

## 요약

### 주요 변경 사항

| 항목 | 기존 | 변경 후 |
|------|------|---------|
| EKS 클러스터 | dev, prod 별도 | 단일 클러스터 |
| 네임스페이스 | 각 클러스터 내 단일 | dev, prod 분리 |
| RDS | 2개 Aurora 클러스터 | 1개 Aurora Serverless v2 |
| 스키마 | 각 RDS에 단일 스키마 | dev_pingvas, prod_pingvas |
| Redis | 2개 클러스터 | 1개 클러스터, DB 0/1 분리 |
| NAT Gateway | 6개 | 1개 (또는 3개) |
| 월 비용 | ~$2,318 | ~$945 (59% 절감) |

### 영향 받는 파일 수

- **Phase 가이드**: 6개 파일 중 5개 수정 필요
- **아키텍처 문서**: 12개 파일 중 7개 수정 필요
- **신규 문서**: 2개 (이 문서 포함)

### 다음 작업

1. 이 문서를 기반으로 각 파일 순차적 수정
2. 수정된 내용으로 로컬 테스트
3. 커밋 및 푸시
4. 실제 AWS 배포로 검증

---

**작성일**: 2025-01-23
**작성자**: Claude (Anthropic)
**목적**: 단일 클러스터 비용 최적화 구성 반영
