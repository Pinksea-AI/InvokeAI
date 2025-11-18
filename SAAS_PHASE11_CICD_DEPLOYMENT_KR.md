# Phase 11: CI/CD & Deployment 가이드

## 목차
1. [개요](#개요)
2. [GitHub Actions CI 파이프라인](#github-actions-ci-파이프라인)
3. [Docker 이미지 빌드](#docker-이미지-빌드)
4. [Kubernetes 설정](#kubernetes-설정)
5. [ArgoCD GitOps 배포](#argocd-gitops-배포)
6. [환경 관리](#환경-관리)
7. [Database Migration](#database-migration)
8. [배포 전략](#배포-전략)
9. [Rollback 및 장애 복구](#rollback-및-장애-복구)
10. [테스트](#테스트)

---

## 개요

Phase 11에서는 자동화된 CI/CD 파이프라인과 GitOps 기반 배포 시스템을 구축합니다.

### CI/CD 파이프라인 흐름

```
1. Code Push (GitHub)
   ↓
2. GitHub Actions Trigger
   ↓
3. Lint & Unit Tests
   ↓
4. Build Docker Image
   ↓
5. Push to ECR
   ↓
6. Update Kubernetes Manifests (Git)
   ↓
7. ArgoCD Sync
   ↓
8. Deploy to Kubernetes
   ↓
9. Health Check & Smoke Tests
   ↓
10. Production Traffic
```

### 주요 목표
- **자동화**: 코드 푸시부터 배포까지 자동화
- **안전성**: 테스트, Linting, Security Scan
- **추적성**: 모든 배포 기록 및 롤백 가능
- **환경 분리**: Dev, Staging, Production
- **무중단 배포**: Rolling Update, Blue-Green

### 기술 스택
- **CI**: GitHub Actions
- **Container Registry**: Amazon ECR
- **Orchestration**: Kubernetes (EKS)
- **GitOps**: ArgoCD
- **IaC**: Terraform
- **Secret Management**: AWS Secrets Manager + Sealed Secrets

---

## GitHub Actions CI 파이프라인

### 1. CI 워크플로우

```yaml
# .github/workflows/ci.yml
name: CI Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

env:
  AWS_REGION: us-east-1
  ECR_REPOSITORY: pingvasai-api
  PYTHON_VERSION: '3.11'

jobs:
  lint:
    name: Lint Code
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: ${{ env.PYTHON_VERSION }}

      - name: Cache pip dependencies
        uses: actions/cache@v3
        with:
          path: ~/.cache/pip
          key: ${{ runner.os }}-pip-${{ hashFiles('**/requirements.txt') }}
          restore-keys: |
            ${{ runner.os }}-pip-

      - name: Install dependencies
        run: |
          pip install black flake8 mypy isort

      - name: Run Black (formatter)
        run: black --check app/

      - name: Run Flake8 (linter)
        run: flake8 app/ --max-line-length=120

      - name: Run isort (import sorting)
        run: isort --check-only app/

      - name: Run mypy (type checking)
        run: mypy app/

  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: test_db
          POSTGRES_USER: test_user
          POSTGRES_PASSWORD: test_pass
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 6379:6379

    steps:
      - uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: ${{ env.PYTHON_VERSION }}

      - name: Install dependencies
        run: |
          pip install -r requirements.txt
          pip install pytest pytest-cov pytest-asyncio

      - name: Run tests with coverage
        env:
          DATABASE_URL: postgresql://test_user:test_pass@localhost:5432/test_db
          REDIS_URL: redis://localhost:6379/0
        run: |
          pytest tests/ \
            --cov=app \
            --cov-report=xml \
            --cov-report=html \
            --cov-report=term-missing \
            --cov-fail-under=80

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage.xml
          flags: unittests
          name: codecov-umbrella

  security-scan:
    name: Security Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Run Bandit (security linter)
        run: |
          pip install bandit
          bandit -r app/ -f json -o bandit-report.json

      - name: Run Safety (dependency check)
        run: |
          pip install safety
          safety check --json

      - name: Run Trivy (container scan)
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
          format: 'sarif'
          output: 'trivy-results.sarif'

      - name: Upload Trivy results to GitHub Security
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'trivy-results.sarif'

  build-and-push:
    name: Build and Push Docker Image
    runs-on: ubuntu-latest
    needs: [lint, test, security-scan]
    if: github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop')
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

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v4
        with:
          images: ${{ steps.login-ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}
          tags: |
            type=ref,event=branch
            type=sha,prefix={{branch}}-
            type=semver,pattern={{version}}

      - name: Build and push Docker image
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            BUILD_DATE=${{ steps.meta.outputs.created }}
            VCS_REF=${{ github.sha }}
            VERSION=${{ steps.meta.outputs.version }}

      - name: Update Kubernetes manifests
        env:
          IMAGE_TAG: ${{ github.sha }}
        run: |
          git config user.name "GitHub Actions Bot"
          git config user.email "actions@github.com"

          cd k8s/overlays/${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}

          # Update image tag in kustomization.yaml
          kustomize edit set image \
            pingvasai-api=${{ steps.login-ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}

          git add kustomization.yaml
          git commit -m "Update image tag to ${{ github.sha }}"
          git push

  notify:
    name: Notify Deployment
    runs-on: ubuntu-latest
    needs: [build-and-push]
    if: always()
    steps:
      - name: Slack Notification
        uses: 8398a7/action-slack@v3
        with:
          status: ${{ job.status }}
          text: |
            CI Pipeline ${{ job.status }}
            Branch: ${{ github.ref }}
            Commit: ${{ github.sha }}
            Author: ${{ github.actor }}
          webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
        if: always()
```

### 2. CD 워크플로우 (ArgoCD Sync Trigger)

```yaml
# .github/workflows/cd.yml
name: CD Pipeline

on:
  push:
    branches: [main]
    paths:
      - 'k8s/**'

jobs:
  argocd-sync:
    name: Trigger ArgoCD Sync
    runs-on: ubuntu-latest
    steps:
      - name: Install ArgoCD CLI
        run: |
          curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
          chmod +x /usr/local/bin/argocd

      - name: Login to ArgoCD
        env:
          ARGOCD_SERVER: ${{ secrets.ARGOCD_SERVER }}
          ARGOCD_AUTH_TOKEN: ${{ secrets.ARGOCD_AUTH_TOKEN }}
        run: |
          argocd login $ARGOCD_SERVER \
            --auth-token=$ARGOCD_AUTH_TOKEN \
            --insecure

      - name: Sync ArgoCD Application
        run: |
          argocd app sync pingvasai-production \
            --force \
            --prune \
            --timeout 600

      - name: Wait for sync completion
        run: |
          argocd app wait pingvasai-production \
            --health \
            --timeout 600

      - name: Get sync status
        run: |
          argocd app get pingvasai-production
```

---

## Docker 이미지 빌드

### 1. Multi-stage Dockerfile

```dockerfile
# Dockerfile
# Stage 1: Builder
FROM python:3.11-slim as builder

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --user -r requirements.txt

# Stage 2: Runtime
FROM python:3.11-slim

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Python packages from builder
COPY --from=builder /root/.local /root/.local

# Make sure scripts in .local are usable
ENV PATH=/root/.local/bin:$PATH

# Copy application code
COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic.ini .

# Create non-root user
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app

USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Metadata
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

LABEL org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.source="https://github.com/pingvasai/api" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.title="PingvasAI API" \
      org.opencontainers.image.description="AI Image Generation API"

# Expose port
EXPOSE 8000

# Run application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### 2. Docker Compose (로컬 개발)

```yaml
# docker-compose.yml
version: '3.8'

services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/pingvasai
      - REDIS_URL=redis://redis:6379/0
    volumes:
      - ./app:/app/app
    depends_on:
      - postgres
      - redis
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

  worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/pingvasai
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      - postgres
      - redis
    command: celery -A app.worker worker --loglevel=info

  postgres:
    image: postgres:15
    environment:
      - POSTGRES_DB=pingvasai
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### 3. .dockerignore

```
# .dockerignore
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
ENV/
.venv/
.git/
.github/
.gitignore
*.md
tests/
*.pytest_cache
.coverage
htmlcov/
.mypy_cache/
.ruff_cache/
*.log
.env
.env.local
docker-compose*.yml
Dockerfile*
k8s/
terraform/
```

---

## Kubernetes 설정

### 1. Kustomize 구조

```
k8s/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── configmap.yaml
│   ├── hpa.yaml
│   └── ingress.yaml
└── overlays/
    ├── development/
    │   ├── kustomization.yaml
    │   └── patches/
    ├── staging/
    │   ├── kustomization.yaml
    │   └── patches/
    └── production/
        ├── kustomization.yaml
        └── patches/
```

### 2. Base Deployment

```yaml
# k8s/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pingvasai-api
  labels:
    app: pingvasai-api
    component: backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: pingvasai-api
  template:
    metadata:
      labels:
        app: pingvasai-api
        component: backend
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8000"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: pingvasai-api

      # Init Container: Database Migration
      initContainers:
        - name: db-migration
          image: pingvasai-api:latest
          command: ['alembic', 'upgrade', 'head']
          envFrom:
            - secretRef:
                name: pingvasai-secrets
            - configMapRef:
                name: pingvasai-config

      containers:
        - name: api
          image: pingvasai-api:latest
          ports:
            - containerPort: 8000
              name: http
              protocol: TCP

          envFrom:
            - secretRef:
                name: pingvasai-secrets
            - configMapRef:
                name: pingvasai-config

          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace

          resources:
            requests:
              memory: "512Mi"
              cpu: "500m"
            limits:
              memory: "1Gi"
              cpu: "1000m"

          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3

          readinessProbe:
            httpGet:
              path: /ready
              port: 8000
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3

          startupProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 0
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 30

          volumeMounts:
            - name: app-config
              mountPath: /app/config
              readOnly: true

      volumes:
        - name: app-config
          configMap:
            name: pingvasai-config

      # Pod Anti-Affinity (다른 노드에 분산)
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values:
                        - pingvasai-api
                topologyKey: kubernetes.io/hostname

      # Graceful Shutdown
      terminationGracePeriodSeconds: 60
```

### 3. Service

```yaml
# k8s/base/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: pingvasai-api
  labels:
    app: pingvasai-api
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 8000
      protocol: TCP
      name: http
  selector:
    app: pingvasai-api
```

### 4. HorizontalPodAutoscaler

```yaml
# k8s/base/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pingvasai-api-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pingvasai-api
  minReplicas: 3
  maxReplicas: 20
  metrics:
    # CPU 사용률 기반
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

    # 메모리 사용률 기반
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80

    # 커스텀 메트릭: Request per second
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"

  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 15
        - type: Pods
          value: 4
          periodSeconds: 15
      selectPolicy: Max
```

### 5. Ingress (ALB)

```yaml
# k8s/base/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: pingvasai-api
  annotations:
    # AWS Load Balancer Controller
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'

    # Certificate
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789:certificate/xxx

    # Health Check
    alb.ingress.kubernetes.io/healthcheck-path: /health
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: '15'
    alb.ingress.kubernetes.io/healthcheck-timeout-seconds: '5'
    alb.ingress.kubernetes.io/healthy-threshold-count: '2'
    alb.ingress.kubernetes.io/unhealthy-threshold-count: '2'

    # WAF
    alb.ingress.kubernetes.io/wafv2-acl-arn: arn:aws:wafv2:us-east-1:123456789:regional/webacl/xxx
spec:
  rules:
    - host: api.pingvasai.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: pingvasai-api
                port:
                  number: 80
```

### 6. ConfigMap

```yaml
# k8s/base/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pingvasai-config
data:
  ENVIRONMENT: "production"
  LOG_LEVEL: "INFO"
  CORS_ORIGINS: "https://pingvasai.com,https://www.pingvasai.com"
  REDIS_MAX_CONNECTIONS: "50"
  CELERY_BROKER_POOL_LIMIT: "10"
```

### 7. Sealed Secrets

```yaml
# k8s/base/sealed-secret.yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: pingvasai-secrets
  namespace: default
spec:
  encryptedData:
    DATABASE_URL: AgC... # Encrypted
    AWS_ACCESS_KEY_ID: AgD... # Encrypted
    AWS_SECRET_ACCESS_KEY: AgE... # Encrypted
    JWT_SECRET_KEY: AgF... # Encrypted
  template:
    metadata:
      name: pingvasai-secrets
      namespace: default
    type: Opaque
```

### 8. Kustomization

```yaml
# k8s/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - deployment.yaml
  - service.yaml
  - configmap.yaml
  - sealed-secret.yaml
  - hpa.yaml
  - ingress.yaml

images:
  - name: pingvasai-api
    newName: 123456789.dkr.ecr.us-east-1.amazonaws.com/pingvasai-api
    newTag: latest

commonLabels:
  app: pingvasai-api
  managed-by: kustomize
```

### 9. Production Overlay

```yaml
# k8s/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

bases:
  - ../../base

namespace: production

replicas:
  - name: pingvasai-api
    count: 5

patches:
  - path: patches/deployment-patch.yaml
  - path: patches/hpa-patch.yaml

configMapGenerator:
  - name: pingvasai-config
    behavior: merge
    literals:
      - ENVIRONMENT=production
      - LOG_LEVEL=WARNING
```

```yaml
# k8s/overlays/production/patches/deployment-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pingvasai-api
spec:
  template:
    spec:
      containers:
        - name: api
          resources:
            requests:
              memory: "1Gi"
              cpu: "1000m"
            limits:
              memory: "2Gi"
              cpu: "2000m"
```

---

## ArgoCD GitOps 배포

### 1. ArgoCD 설치

```bash
# ArgoCD 설치 (Kubernetes)
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# ArgoCD CLI 설치
curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
chmod +x /usr/local/bin/argocd

# Admin 비밀번호 조회
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d

# Port Forward (로컬 접속)
kubectl port-forward svc/argocd-server -n argocd 8080:443

# Login
argocd login localhost:8080
```

### 2. ArgoCD Application

```yaml
# argocd/application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: pingvasai-production
  namespace: argocd
spec:
  project: default

  source:
    repoURL: https://github.com/pingvasai/infrastructure
    targetRevision: main
    path: k8s/overlays/production

  destination:
    server: https://kubernetes.default.svc
    namespace: production

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

  revisionHistoryLimit: 10

  # Health Check
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas  # HPA가 관리
```

### 3. ArgoCD AppProject

```yaml
# argocd/appproject.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: pingvasai
  namespace: argocd
spec:
  description: PingvasAI Project

  sourceRepos:
    - https://github.com/pingvasai/*

  destinations:
    - namespace: '*'
      server: https://kubernetes.default.svc

  clusterResourceWhitelist:
    - group: '*'
      kind: '*'

  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'

  roles:
    - name: developer
      description: Developer role
      policies:
        - p, proj:pingvasai:developer, applications, get, pingvasai/*, allow
        - p, proj:pingvasai:developer, applications, sync, pingvasai/*, allow
      groups:
        - developers

    - name: admin
      description: Admin role
      policies:
        - p, proj:pingvasai:admin, applications, *, pingvasai/*, allow
      groups:
        - admins
```

### 4. ArgoCD Notifications (Slack)

```yaml
# argocd/argocd-notifications-cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  service.slack: |
    token: $slack-token

  template.app-deployed: |
    message: |
      Application {{.app.metadata.name}} is now running new version.
      {{if eq .serviceType "slack"}}:white_check_mark:{{end}} Deployment completed!

      *Application:* {{.app.metadata.name}}
      *Sync Status:* {{.app.status.sync.status}}
      *Health Status:* {{.app.status.health.status}}
      *Revision:* {{.app.status.sync.revision}}
      *Author:* {{(call .repo.GetCommitMetadata .app.status.sync.revision).Author}}

  template.app-health-degraded: |
    message: |
      {{if eq .serviceType "slack"}}:exclamation:{{end}} Application {{.app.metadata.name}} has degraded.
      Application details: {{.context.argocdUrl}}/applications/{{.app.metadata.name}}.

  trigger.on-deployed: |
    - when: app.status.sync.status == 'Synced'
      send: [app-deployed]

  trigger.on-health-degraded: |
    - when: app.status.health.status == 'Degraded'
      send: [app-health-degraded]

  subscriptions: |
    - recipients:
      - slack:deployments
      triggers:
      - on-deployed
      - on-health-degraded
```

---

## 환경 관리

### 1. 환경 분리 전략

| 환경 | 목적 | 브랜치 | 배포 방식 | 스케일 |
|------|------|--------|-----------|--------|
| Development | 개발/테스트 | develop | 자동 배포 | 소규모 (1-2 pods) |
| Staging | 프로덕션 시뮬레이션 | staging | 자동 배포 | 중규모 (2-3 pods) |
| Production | 실제 서비스 | main | 수동 승인 후 배포 | 대규모 (5-20 pods) |

### 2. 환경별 설정 관리

```python
# app/config.py
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # Environment
    ENVIRONMENT: str = "development"

    # Database
    DATABASE_URL: str
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20

    # Redis
    REDIS_URL: str

    # AWS
    AWS_REGION: str = "us-east-1"
    AWS_ACCESS_KEY_ID: str
    AWS_SECRET_ACCESS_KEY: str

    # Security
    JWT_SECRET_KEY: str
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 15

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]

    # Feature Flags
    FEATURE_EMAIL_VERIFICATION: bool = True
    FEATURE_2FA: bool = True

    class Config:
        env_file = f".env.{os.getenv('ENVIRONMENT', 'development')}"
        case_sensitive = True


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
```

### 3. Feature Flags (LaunchDarkly)

```python
# app/services/feature_flags.py
from launchdarkly import Context, Config, LDClient
from functools import lru_cache


class FeatureFlagService:
    """Feature Flag 관리"""

    def __init__(self):
        config = Config(sdk_key=settings.LAUNCHDARKLY_SDK_KEY)
        self.client = LDClient(config=config)

    def is_enabled(self, flag_key: str, user_id: str = None, default: bool = False) -> bool:
        """Feature Flag 확인"""

        context = Context.builder(user_id or "anonymous").build()

        return self.client.variation(flag_key, context, default)

    def close(self):
        self.client.close()


@lru_cache()
def get_feature_flags() -> FeatureFlagService:
    return FeatureFlagService()


# 사용 예제
@router.post("/generate")
async def generate_image(request: GenerateRequest):
    ff = get_feature_flags()

    # 새로운 모델 점진적 롤아웃
    if ff.is_enabled("new_flux_model", str(request.user_id)):
        model = "flux-pro-v2"
    else:
        model = "flux-pro"

    # ...
```

---

## Database Migration

### 1. Alembic 설정

```python
# alembic/env.py
from alembic import context
from sqlalchemy import engine_from_config, pool
from app.models import Base
from app.config import settings

config = context.config

# Override sqlalchemy.url from environment
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)

target_metadata = Base.metadata


def run_migrations_online():
    """Run migrations in 'online' mode."""

    connectable = engine_from_config(
        config.get_section(config.config_ini_section),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )

        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
```

### 2. Migration Job (Kubernetes)

```yaml
# k8s/jobs/migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: migration
          image: pingvasai-api:latest
          command: ['alembic', 'upgrade', 'head']
          envFrom:
            - secretRef:
                name: pingvasai-secrets
            - configMapRef:
                name: pingvasai-config
      backoffLimit: 3
```

### 3. 안전한 Migration 전략

```python
# migrations/versions/001_add_user_credits.py
"""Add user credits

Revision ID: 001
Revises: None
Create Date: 2025-01-01 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


def upgrade():
    # 1. 새 컬럼 추가 (NULL 허용)
    op.add_column('users',
        sa.Column('credits_balance', sa.Integer(), nullable=True)
    )

    # 2. 기존 데이터에 기본값 설정
    op.execute("UPDATE users SET credits_balance = 0 WHERE credits_balance IS NULL")

    # 3. NOT NULL 제약 추가
    op.alter_column('users', 'credits_balance', nullable=False)

    # 4. 인덱스 추가
    op.create_index('idx_users_credits', 'users', ['credits_balance'])


def downgrade():
    op.drop_index('idx_users_credits', 'users')
    op.drop_column('users', 'credits_balance')
```

---

## 배포 전략

### 1. Rolling Update (기본)

```yaml
# k8s/base/deployment.yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1         # 동시에 추가할 수 있는 최대 Pod 수
      maxUnavailable: 0   # 동시에 사용 불가능한 최대 Pod 수
```

### 2. Blue-Green 배포

```yaml
# k8s/overlays/production/blue-green/service-blue.yaml
apiVersion: v1
kind: Service
metadata:
  name: pingvasai-api-blue
spec:
  selector:
    app: pingvasai-api
    version: blue
  ports:
    - port: 80
      targetPort: 8000

---
# k8s/overlays/production/blue-green/service-green.yaml
apiVersion: v1
kind: Service
metadata:
  name: pingvasai-api-green
spec:
  selector:
    app: pingvasai-api
    version: green
  ports:
    - port: 80
      targetPort: 8000

---
# k8s/overlays/production/blue-green/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: pingvasai-api
spec:
  rules:
    - host: api.pingvasai.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: pingvasai-api-blue  # 트래픽 전환: blue <-> green
                port:
                  number: 80
```

**배포 프로세스:**
```bash
# 1. Green 환경에 새 버전 배포
kubectl apply -k k8s/overlays/production/blue-green/deployment-green.yaml

# 2. Green 환경 Health Check
kubectl wait --for=condition=available deployment/pingvasai-api-green --timeout=300s

# 3. Smoke Test
curl https://api-green.pingvasai.com/health

# 4. 트래픽 전환 (Ingress 업데이트)
kubectl patch ingress pingvasai-api -p '{"spec":{"rules":[{"host":"api.pingvasai.com","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"pingvasai-api-green","port":{"number":80}}}}]}}]}}'

# 5. 모니터링 (10분)
# 문제 없으면 Blue 환경 제거

# 6. Rollback (문제 발생 시)
kubectl patch ingress pingvasai-api -p '{"spec":{"rules":[{"host":"api.pingvasai.com","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"pingvasai-api-blue","port":{"number":80}}}}]}}]}}'
```

### 3. Canary 배포 (Flagger)

```yaml
# k8s/flagger/canary.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: pingvasai-api
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pingvasai-api

  service:
    port: 80
    targetPort: 8000

  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 10

    metrics:
      # Success Rate
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m

      # Request Duration (p99)
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m

    webhooks:
      # Load Test
      - name: load-test
        url: http://flagger-loadtester/
        timeout: 5s
        metadata:
          cmd: "hey -z 1m -q 10 -c 2 http://pingvasai-api-canary/health"

      # Slack Notification
      - name: slack
        url: https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
        metadata:
          message: "Canary deployment for pingvasai-api"
```

---

## Rollback 및 장애 복구

### 1. Kubernetes Rollback

```bash
# Deployment 히스토리 확인
kubectl rollout history deployment/pingvasai-api

# 이전 버전으로 롤백
kubectl rollout undo deployment/pingvasai-api

# 특정 리비전으로 롤백
kubectl rollout undo deployment/pingvasai-api --to-revision=3

# 롤백 상태 확인
kubectl rollout status deployment/pingvasai-api
```

### 2. ArgoCD Rollback

```bash
# ArgoCD History 확인
argocd app history pingvasai-production

# 특정 리비전으로 롤백
argocd app rollback pingvasai-production 5

# Sync 상태 확인
argocd app get pingvasai-production
```

### 3. 자동 Rollback (ArgoCD)

```yaml
# argocd/application.yaml
spec:
  syncPolicy:
    automated:
      prune: true
      selfHeal: true  # 자동 복구
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

### 4. 장애 복구 Runbook

```markdown
# Runbook: API 응답 없음

## 증상
- API 엔드포인트 응답 없음 (503/504)
- Grafana에서 Request Rate 0

## 진단
1. Pod 상태 확인:
   ```bash
   kubectl get pods -l app=pingvasai-api
   ```

2. Pod 로그 확인:
   ```bash
   kubectl logs -l app=pingvasai-api --tail=100
   ```

3. Events 확인:
   ```bash
   kubectl get events --sort-by='.lastTimestamp'
   ```

## 복구 절차
1. **즉시 롤백**:
   ```bash
   kubectl rollout undo deployment/pingvasai-api
   ```

2. **데이터베이스 확인**:
   ```bash
   kubectl exec -it postgres-0 -- psql -U user -d pingvasai -c "SELECT 1;"
   ```

3. **Redis 확인**:
   ```bash
   kubectl exec -it redis-0 -- redis-cli PING
   ```

4. **Scale Up (긴급)**:
   ```bash
   kubectl scale deployment/pingvasai-api --replicas=10
   ```

## 사후 조치
- RCA (Root Cause Analysis) 문서 작성
- 재발 방지 대책 수립
```

---

## 테스트

### 1. Smoke Test

```python
# tests/smoke_test.py
import requests
import pytest


@pytest.fixture
def api_url():
    return "https://api.pingvasai.com"


def test_health_check(api_url):
    """Health check 엔드포인트 테스트"""
    response = requests.get(f"{api_url}/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_authentication(api_url):
    """인증 테스트"""
    response = requests.post(
        f"{api_url}/api/v1/auth/login",
        json={"email": "test@example.com", "password": "test123"}
    )
    assert response.status_code in [200, 401]


def test_image_generation(api_url, auth_token):
    """이미지 생성 API 테스트"""
    response = requests.post(
        f"{api_url}/api/v1/generate",
        headers={"Authorization": f"Bearer {auth_token}"},
        json={"prompt": "test image", "model": "flux-dev"}
    )
    assert response.status_code in [200, 202]
```

### 2. Load Test (k6)

```javascript
// tests/load_test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 100 },  // Ramp up
    { duration: '5m', target: 100 },  // Stay at 100 RPS
    { duration: '2m', target: 200 },  // Spike
    { duration: '5m', target: 200 },
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95% < 500ms
    http_req_failed: ['rate<0.01'],    // Error rate < 1%
  },
};

export default function () {
  const url = 'https://api.pingvasai.com/health';
  const response = http.get(url);

  check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(1);
}
```

```bash
# k6 실행
k6 run --out influxdb=http://localhost:8086/k6 tests/load_test.js
```

---

## Phase 11 완료

### 구현 완료 항목

✅ **GitHub Actions CI/CD**
- Lint, Test, Security Scan
- Docker 이미지 빌드 및 Push
- Kubernetes 매니페스트 자동 업데이트
- Slack 알림

✅ **Docker 이미지**
- Multi-stage Dockerfile
- Health Check
- 비root 사용자
- .dockerignore

✅ **Kubernetes**
- Kustomize 구조 (Base + Overlays)
- Deployment, Service, Ingress
- HPA (CPU, Memory, Custom Metrics)
- Liveness/Readiness/Startup Probes
- Sealed Secrets

✅ **ArgoCD GitOps**
- Application 정의
- 자동 Sync + Self-Heal
- Slack 알림
- AppProject RBAC

✅ **환경 관리**
- Development, Staging, Production 분리
- 환경별 설정 관리
- Feature Flags (LaunchDarkly)

✅ **Database Migration**
- Alembic 설정
- Migration Job (PreSync Hook)
- 안전한 Migration 전략

✅ **배포 전략**
- Rolling Update
- Blue-Green 배포
- Canary 배포 (Flagger)

✅ **Rollback & 복구**
- Kubernetes Rollback
- ArgoCD Rollback
- 장애 복구 Runbook

✅ **테스트**
- Smoke Test
- Load Test (k6)

---

**전체 Phase 완료! 🎉**
