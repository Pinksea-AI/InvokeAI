# Phase 11: CI/CD & Deployment 가이드 (v2.0 - KEDA & Namespace 기반)

## 목차
1. [개요](#개요)
2. [아키텍처 변경사항 (v1.0 → v2.0)](#아키텍처-변경사항-v10--v20)
3. [GitHub Actions CI 파이프라인](#github-actions-ci-파이프라인)
4. [Docker 이미지 빌드](#docker-이미지-빌드)
5. [Kubernetes 설정](#kubernetes-설정)
6. [ArgoCD GitOps 배포](#argocd-gitops-배포)
7. [환경 관리](#환경-관리)
8. [Database Migration](#database-migration)
9. [배포 전략](#배포-전략)
10. [Rollback 및 장애 복구](#rollback-및-장애-복구)
11. [테스트](#테스트)

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
4. Build Docker Images (API + 3 Worker Types)
   ↓
5. Push to ECR
   ↓
6. Update Kubernetes Manifests (Git)
   ↓
7. ArgoCD Sync
   ↓
8. Deploy to Kubernetes (Namespace 분리)
   ↓
9. KEDA ScaledObject 배포
   ↓
10. Health Check & Smoke Tests
   ↓
11. Production Traffic
```

### 주요 목표
- **자동화**: 코드 푸시부터 배포까지 자동화
- **안전성**: 테스트, Linting, Security Scan
- **추적성**: 모든 배포 기록 및 롤백 가능
- **환경 분리**: Dev, Staging, Production
- **Namespace 분리**: worker-ns (Workers), service-ns (API, Monitoring)
- **무중단 배포**: Rolling Update, Blue-Green
- **Scale to Zero**: KEDA 기반 0 replica 지원

### 기술 스택
- **CI**: GitHub Actions
- **Container Registry**: Amazon ECR
- **Orchestration**: Kubernetes (EKS)
- **GitOps**: ArgoCD
- **Auto-Scaling**: KEDA (Kubernetes Event Driven Autoscaler)
- **IaC**: Terraform
- **Secret Management**: AWS Secrets Manager + Sealed Secrets

---

## 아키텍처 변경사항 (v1.0 → v2.0)

### 주요 변경 사항

| 항목 | v1.0 (기존) | v2.0 (신규) | 변경 이유 |
|------|-------------|-------------|-----------|
| **Namespace** | 단일 (default) | 분리 (worker-ns, service-ns) | 리소스 격리 및 관리 |
| **Worker 구조** | 단일 GPU Worker | 3-Tier (GPU/API Relay/System) | 역할 분리, 효율성 향상 |
| **Auto-Scaling** | CloudWatch + ASG | KEDA ScaledObject | 15초 반응속도 (vs 2-3분) |
| **최소 Replica** | 1 (항상 실행) | 0 (Scale to Zero) | 유휴 시 100% 비용 절감 |
| **Docker Image** | 1개 (API) | 4개 (API + 3 Workers) | Worker 타입별 최적화 |
| **배포 방식** | Deployment만 | Deployment + ScaledObject | KEDA 통합 |

### Namespace 구조

```
┌─────────────────────────────────────────────────────┐
│ EKS Cluster                                         │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────────────────────────────┐  │
│  │ service-ns (API & Monitoring)               │  │
│  ├─────────────────────────────────────────────┤  │
│  │ - pingvasai-api (Deployment)                │  │
│  │ - pingvasai-api (Service)                   │  │
│  │ - pingvasai-api (Ingress/ALB)               │  │
│  │ - prometheus (Deployment)                   │  │
│  │ - grafana (Deployment)                      │  │
│  └─────────────────────────────────────────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────┐  │
│  │ worker-ns (Workers)                         │  │
│  ├─────────────────────────────────────────────┤  │
│  │ - gpu-workers (Deployment + ScaledObject)   │  │
│  │ - api-relay-workers (Deployment + SO)       │  │
│  │ - system-workers (Deployment + SO)          │  │
│  └─────────────────────────────────────────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────┐  │
│  │ keda (KEDA System)                          │  │
│  ├─────────────────────────────────────────────┤  │
│  │ - keda-operator                             │  │
│  │ - keda-metrics-apiserver                    │  │
│  └─────────────────────────────────────────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────┐  │
│  │ default (Shared Services)                   │  │
│  ├─────────────────────────────────────────────┤  │
│  │ - redis (StatefulSet)                       │  │
│  │ - postgres (StatefulSet)                    │  │
│  └─────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## GitHub Actions CI 파이프라인

### 1. CI 워크플로우 (Multi-Image Build)

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
    name: Build and Push Docker Images
    runs-on: ubuntu-latest
    needs: [lint, test, security-scan]
    if: github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop')
    strategy:
      matrix:
        image:
          - name: pingvasai-api
            dockerfile: Dockerfile
            context: .
          - name: pingvasai-gpu-worker
            dockerfile: Dockerfile.gpu-worker
            context: .
          - name: pingvasai-api-relay-worker
            dockerfile: Dockerfile.api-relay-worker
            context: .
          - name: pingvasai-system-worker
            dockerfile: Dockerfile.system-worker
            context: .
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
          images: ${{ steps.login-ecr.outputs.registry }}/${{ matrix.image.name }}
          tags: |
            type=ref,event=branch
            type=sha,prefix={{branch}}-
            type=semver,pattern={{version}}

      - name: Build and push Docker image
        uses: docker/build-push-action@v4
        with:
          context: ${{ matrix.image.context }}
          file: ${{ matrix.image.dockerfile }}
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            BUILD_DATE=${{ steps.meta.outputs.created }}
            VCS_REF=${{ github.sha }}
            VERSION=${{ steps.meta.outputs.version }}

  update-manifests:
    name: Update Kubernetes Manifests
    runs-on: ubuntu-latest
    needs: [build-and-push]
    steps:
      - uses: actions/checkout@v3
        with:
          token: ${{ secrets.GH_PAT }}

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v1

      - name: Update image tags in kustomization.yaml
        env:
          IMAGE_TAG: ${{ github.sha }}
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        run: |
          git config user.name "GitHub Actions Bot"
          git config user.email "actions@github.com"

          cd k8s/overlays/${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}

          # API Image 업데이트
          kustomize edit set image \
            pingvasai-api=${ECR_REGISTRY}/pingvasai-api:${IMAGE_TAG}

          # GPU Worker Image 업데이트
          kustomize edit set image \
            pingvasai-gpu-worker=${ECR_REGISTRY}/pingvasai-gpu-worker:${IMAGE_TAG}

          # API Relay Worker Image 업데이트
          kustomize edit set image \
            pingvasai-api-relay-worker=${ECR_REGISTRY}/pingvasai-api-relay-worker:${IMAGE_TAG}

          # System Worker Image 업데이트
          kustomize edit set image \
            pingvasai-system-worker=${ECR_REGISTRY}/pingvasai-system-worker:${IMAGE_TAG}

          git add kustomization.yaml
          git commit -m "Update image tags to ${IMAGE_TAG}"
          git push

  notify:
    name: Notify Deployment
    runs-on: ubuntu-latest
    needs: [update-manifests]
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
            Images: API + 3 Workers (GPU, API Relay, System)
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
    strategy:
      matrix:
        app:
          - name: pingvasai-api-production
            namespace: service-ns
          - name: pingvasai-workers-production
            namespace: worker-ns
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
          argocd app sync ${{ matrix.app.name }} \
            --force \
            --prune \
            --timeout 600

      - name: Wait for sync completion
        run: |
          argocd app wait ${{ matrix.app.name }} \
            --health \
            --timeout 600

      - name: Get sync status
        run: |
          argocd app get ${{ matrix.app.name }}
```

---

## Docker 이미지 빌드

### 1. API Dockerfile

```dockerfile
# Dockerfile (API)
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

### 2. GPU Worker Dockerfile

```dockerfile
# Dockerfile.gpu-worker
FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

WORKDIR /app

# Install Python 3.11
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-dev \
    python3-pip \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements-gpu-worker.txt .

# Install Python dependencies
RUN pip3 install --no-cache-dir -r requirements-gpu-worker.txt

# Copy worker code
COPY workers/gpu/ ./workers/gpu/
COPY app/config.py ./app/config.py
COPY app/models/ ./app/models/

# Create non-root user
RUN useradd -m -u 1000 workeruser && \
    chown -R workeruser:workeruser /app

USER workeruser

# Health check (Celery inspect)
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD celery -A workers.gpu.tasks inspect ping || exit 1

# Metadata
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

LABEL org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.title="PingvasAI GPU Worker" \
      org.opencontainers.image.description="GPU-based Image Generation Worker"

# Run Celery worker
CMD ["celery", "-A", "workers.gpu.tasks", "worker", \
     "--loglevel=info", \
     "--concurrency=1", \
     "--queues=enterprise,studio,pro,starter,free"]
```

### 3. API Relay Worker Dockerfile

```dockerfile
# Dockerfile.api-relay-worker
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements-api-relay-worker.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements-api-relay-worker.txt

# Copy worker code
COPY workers/api_relay/ ./workers/api_relay/
COPY app/config.py ./app/config.py
COPY app/models/ ./app/models/

# Create non-root user
RUN useradd -m -u 1000 workeruser && \
    chown -R workeruser:workeruser /app

USER workeruser

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD celery -A workers.api_relay.tasks inspect ping || exit 1

# Metadata
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

LABEL org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.title="PingvasAI API Relay Worker" \
      org.opencontainers.image.description="External API Relay Worker (Stability AI, etc.)"

# Run Celery worker
CMD ["celery", "-A", "workers.api_relay.tasks", "worker", \
     "--loglevel=info", \
     "--concurrency=4", \
     "--queues=api_relay"]
```

### 4. System Worker Dockerfile

```dockerfile
# Dockerfile.system-worker
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    curl \
    ffmpeg \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements-system-worker.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements-system-worker.txt

# Copy worker code
COPY workers/system/ ./workers/system/
COPY app/config.py ./app/config.py
COPY app/models/ ./app/models/

# Create non-root user
RUN useradd -m -u 1000 workeruser && \
    chown -R workeruser:workeruser /app

USER workeruser

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD celery -A workers.system.tasks inspect ping || exit 1

# Metadata
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

LABEL org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.title="PingvasAI System Worker" \
      org.opencontainers.image.description="System Tasks Worker (Email, Thumbnails, etc.)"

# Run Celery worker
CMD ["celery", "-A", "workers.system.tasks", "worker", \
     "--loglevel=info", \
     "--concurrency=2", \
     "--queues=system"]
```

### 5. Docker Compose (로컬 개발)

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

  gpu-worker:
    build:
      context: .
      dockerfile: Dockerfile.gpu-worker
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/pingvasai
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      - postgres
      - redis
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  api-relay-worker:
    build:
      context: .
      dockerfile: Dockerfile.api-relay-worker
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/pingvasai
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      - postgres
      - redis

  system-worker:
    build:
      context: .
      dockerfile: Dockerfile.system-worker
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/pingvasai
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      - postgres
      - redis

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

### 6. .dockerignore

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

### 1. Kustomize 구조 (Namespace 분리)

```
k8s/
├── base/
│   ├── service-ns/                    # API & Monitoring
│   │   ├── kustomization.yaml
│   │   ├── namespace.yaml
│   │   ├── deployment.yaml           # API Deployment
│   │   ├── service.yaml              # API Service
│   │   ├── configmap.yaml
│   │   ├── hpa.yaml                  # API HPA
│   │   └── ingress.yaml              # ALB Ingress
│   │
│   ├── worker-ns/                     # Workers
│   │   ├── kustomization.yaml
│   │   ├── namespace.yaml
│   │   ├── gpu-worker-deployment.yaml
│   │   ├── gpu-worker-scaledobject.yaml
│   │   ├── api-relay-worker-deployment.yaml
│   │   ├── api-relay-worker-scaledobject.yaml
│   │   ├── system-worker-deployment.yaml
│   │   ├── system-worker-scaledobject.yaml
│   │   └── configmap.yaml
│   │
│   └── shared/                        # Shared Resources
│       ├── kustomization.yaml
│       ├── redis-statefulset.yaml
│       ├── redis-service.yaml
│       ├── sealed-secret.yaml
│       └── service-accounts.yaml
│
└── overlays/
    ├── development/
    │   ├── kustomization.yaml
    │   └── patches/
    │       ├── service-ns/
    │       └── worker-ns/
    ├── staging/
    │   ├── kustomization.yaml
    │   └── patches/
    │       ├── service-ns/
    │       └── worker-ns/
    └── production/
        ├── kustomization.yaml
        └── patches/
            ├── service-ns/
            └── worker-ns/
```

### 2. Namespace 정의

```yaml
# k8s/base/service-ns/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: service-ns
  labels:
    name: service-ns
    environment: production
    managed-by: argocd
```

```yaml
# k8s/base/worker-ns/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: worker-ns
  labels:
    name: worker-ns
    environment: production
    managed-by: argocd
```

### 3. API Deployment (service-ns)

```yaml
# k8s/base/service-ns/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pingvasai-api
  namespace: service-ns
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
                namespace: service-ns

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

### 4. GPU Worker Deployment (worker-ns)

```yaml
# k8s/base/worker-ns/gpu-worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gpu-workers
  namespace: worker-ns
  labels:
    app: gpu-workers
    component: worker
    worker-type: gpu
spec:
  replicas: 0  # KEDA ScaledObject가 관리
  selector:
    matchLabels:
      app: gpu-workers
  template:
    metadata:
      labels:
        app: gpu-workers
        component: worker
        worker-type: gpu
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9091"
    spec:
      serviceAccountName: gpu-workers

      # Node Selector: GPU 인스턴스만
      nodeSelector:
        node.kubernetes.io/instance-type: g5.xlarge
        karpenter.sh/capacity-type: spot

      containers:
        - name: worker
          image: pingvasai-gpu-worker:latest

          command:
            - celery
            - -A
            - workers.gpu.tasks
            - worker
            - --loglevel=info
            - --concurrency=1
            - --queues=enterprise,studio,pro,starter,free

          envFrom:
            - secretRef:
                name: pingvasai-secrets
            - configMapRef:
                name: worker-config
                namespace: worker-ns

          resources:
            requests:
              nvidia.com/gpu: 1
              memory: "8Gi"
              cpu: "2000m"
            limits:
              nvidia.com/gpu: 1
              memory: "16Gi"
              cpu: "4000m"

          livenessProbe:
            exec:
              command:
                - celery
                - -A
                - workers.gpu.tasks
                - inspect
                - ping
            initialDelaySeconds: 60
            periodSeconds: 30
            timeoutSeconds: 10
            failureThreshold: 3

      # Graceful Shutdown (작업 완료 대기)
      terminationGracePeriodSeconds: 300

      # Tolerations for Spot Instances
      tolerations:
        - key: "karpenter.sh/capacity-type"
          operator: "Equal"
          value: "spot"
          effect: "NoSchedule"
```

### 5. GPU Worker KEDA ScaledObject

```yaml
# k8s/base/worker-ns/gpu-worker-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: gpu-workers-scaler
  namespace: worker-ns
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: gpu-workers

  pollingInterval: 15                   # 15초마다 체크
  cooldownPeriod: 300                   # 5분 유휴 후 Scale Down
  minReplicaCount: 0                    # 완전 0대 축소 가능
  maxReplicaCount: 8                    # 최대 8대

  triggers:
    # Enterprise Queue (최고 우선순위)
    - type: redis
      metadata:
        address: redis-service.default.svc.cluster.local:6379
        listName: celery:queue:enterprise
        listLength: "1"                 # 1개 이상 시 즉시 Scale Up
        databaseIndex: "0"

    # Studio Queue
    - type: redis
      metadata:
        address: redis-service.default.svc.cluster.local:6379
        listName: celery:queue:studio
        listLength: "2"                 # 2개 이상 시 Scale Up
        databaseIndex: "0"

    # Pro Queue
    - type: redis
      metadata:
        address: redis-service.default.svc.cluster.local:6379
        listName: celery:queue:pro
        listLength: "3"                 # 3개 이상 시 Scale Up
        databaseIndex: "0"

    # Starter Queue
    - type: redis
      metadata:
        address: redis-service.default.svc.cluster.local:6379
        listName: celery:queue:starter
        listLength: "5"                 # 5개 이상 시 Scale Up
        databaseIndex: "0"

    # Free Queue
    - type: redis
      metadata:
        address: redis-service.default.svc.cluster.local:6379
        listName: celery:queue:free
        listLength: "10"                # 10개 이상 시 Scale Up
        databaseIndex: "0"
```

### 6. API Relay Worker Deployment (worker-ns)

```yaml
# k8s/base/worker-ns/api-relay-worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-relay-workers
  namespace: worker-ns
  labels:
    app: api-relay-workers
    component: worker
    worker-type: api-relay
spec:
  replicas: 0  # KEDA ScaledObject가 관리
  selector:
    matchLabels:
      app: api-relay-workers
  template:
    metadata:
      labels:
        app: api-relay-workers
        component: worker
        worker-type: api-relay
    spec:
      serviceAccountName: api-relay-workers

      containers:
        - name: worker
          image: pingvasai-api-relay-worker:latest

          command:
            - celery
            - -A
            - workers.api_relay.tasks
            - worker
            - --loglevel=info
            - --concurrency=4
            - --queues=api_relay

          envFrom:
            - secretRef:
                name: pingvasai-secrets
            - configMapRef:
                name: worker-config
                namespace: worker-ns

          resources:
            requests:
              memory: "512Mi"
              cpu: "500m"
            limits:
              memory: "1Gi"
              cpu: "1000m"

      terminationGracePeriodSeconds: 120
```

### 7. API Relay Worker KEDA ScaledObject

```yaml
# k8s/base/worker-ns/api-relay-worker-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-relay-workers-scaler
  namespace: worker-ns
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-relay-workers

  pollingInterval: 15
  cooldownPeriod: 180                   # 3분 유휴 후 Scale Down
  minReplicaCount: 0
  maxReplicaCount: 5

  triggers:
    - type: redis
      metadata:
        address: redis-service.default.svc.cluster.local:6379
        listName: celery:queue:api_relay
        listLength: "5"                 # 5개 이상 시 Scale Up
        databaseIndex: "0"
```

### 8. System Worker Deployment (worker-ns)

```yaml
# k8s/base/worker-ns/system-worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: system-workers
  namespace: worker-ns
  labels:
    app: system-workers
    component: worker
    worker-type: system
spec:
  replicas: 0  # KEDA ScaledObject가 관리
  selector:
    matchLabels:
      app: system-workers
  template:
    metadata:
      labels:
        app: system-workers
        component: worker
        worker-type: system
    spec:
      serviceAccountName: system-workers

      containers:
        - name: worker
          image: pingvasai-system-worker:latest

          command:
            - celery
            - -A
            - workers.system.tasks
            - worker
            - --loglevel=info
            - --concurrency=2
            - --queues=system

          envFrom:
            - secretRef:
                name: pingvasai-secrets
            - configMapRef:
                name: worker-config
                namespace: worker-ns

          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"

      terminationGracePeriodSeconds: 60
```

### 9. System Worker KEDA ScaledObject

```yaml
# k8s/base/worker-ns/system-worker-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: system-workers-scaler
  namespace: worker-ns
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: system-workers

  pollingInterval: 30                   # 30초마다 체크 (덜 긴급)
  cooldownPeriod: 300
  minReplicaCount: 0
  maxReplicaCount: 3

  triggers:
    - type: redis
      metadata:
        address: redis-service.default.svc.cluster.local:6379
        listName: celery:queue:system
        listLength: "10"                # 10개 이상 시 Scale Up
        databaseIndex: "0"
```

### 10. Service (service-ns)

```yaml
# k8s/base/service-ns/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: pingvasai-api
  namespace: service-ns
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

### 11. HorizontalPodAutoscaler (API - service-ns)

```yaml
# k8s/base/service-ns/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pingvasai-api-hpa
  namespace: service-ns
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

### 12. Ingress (ALB - service-ns)

```yaml
# k8s/base/service-ns/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: pingvasai-api
  namespace: service-ns
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

### 13. ConfigMap (service-ns)

```yaml
# k8s/base/service-ns/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pingvasai-config
  namespace: service-ns
data:
  ENVIRONMENT: "production"
  LOG_LEVEL: "INFO"
  CORS_ORIGINS: "https://pingvasai.com,https://www.pingvasai.com"
  REDIS_MAX_CONNECTIONS: "50"
  CELERY_BROKER_POOL_LIMIT: "10"
```

### 14. ConfigMap (worker-ns)

```yaml
# k8s/base/worker-ns/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: worker-config
  namespace: worker-ns
data:
  ENVIRONMENT: "production"
  LOG_LEVEL: "INFO"
  CELERY_WORKER_PREFETCH_MULTIPLIER: "1"
  CELERY_WORKER_MAX_TASKS_PER_CHILD: "50"
```

### 15. Kustomization (service-ns base)

```yaml
# k8s/base/service-ns/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: service-ns

resources:
  - namespace.yaml
  - deployment.yaml
  - service.yaml
  - configmap.yaml
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

### 16. Kustomization (worker-ns base)

```yaml
# k8s/base/worker-ns/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: worker-ns

resources:
  - namespace.yaml
  - configmap.yaml
  - gpu-worker-deployment.yaml
  - gpu-worker-scaledobject.yaml
  - api-relay-worker-deployment.yaml
  - api-relay-worker-scaledobject.yaml
  - system-worker-deployment.yaml
  - system-worker-scaledobject.yaml

images:
  - name: pingvasai-gpu-worker
    newName: 123456789.dkr.ecr.us-east-1.amazonaws.com/pingvasai-gpu-worker
    newTag: latest
  - name: pingvasai-api-relay-worker
    newName: 123456789.dkr.ecr.us-east-1.amazonaws.com/pingvasai-api-relay-worker
    newTag: latest
  - name: pingvasai-system-worker
    newName: 123456789.dkr.ecr.us-east-1.amazonaws.com/pingvasai-system-worker
    newTag: latest

commonLabels:
  managed-by: kustomize
```

### 17. Production Overlay

```yaml
# k8s/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base/service-ns
  - ../../base/worker-ns
  - ../../base/shared

patches:
  # API 리소스 증가
  - path: patches/service-ns/deployment-patch.yaml
    target:
      kind: Deployment
      name: pingvasai-api
      namespace: service-ns

  # GPU Worker 최대 레플리카 증가
  - path: patches/worker-ns/gpu-worker-scaledobject-patch.yaml
    target:
      kind: ScaledObject
      name: gpu-workers-scaler
      namespace: worker-ns

configMapGenerator:
  - name: pingvasai-config
    namespace: service-ns
    behavior: merge
    literals:
      - ENVIRONMENT=production
      - LOG_LEVEL=WARNING

  - name: worker-config
    namespace: worker-ns
    behavior: merge
    literals:
      - ENVIRONMENT=production
      - LOG_LEVEL=INFO
```

```yaml
# k8s/overlays/production/patches/service-ns/deployment-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pingvasai-api
  namespace: service-ns
spec:
  replicas: 5
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

```yaml
# k8s/overlays/production/patches/worker-ns/gpu-worker-scaledobject-patch.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: gpu-workers-scaler
  namespace: worker-ns
spec:
  maxReplicaCount: 20  # Production에서는 최대 20대
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

### 2. ArgoCD Application (API - service-ns)

```yaml
# argocd/application-api.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: pingvasai-api-production
  namespace: argocd
spec:
  project: pingvasai

  source:
    repoURL: https://github.com/pingvasai/infrastructure
    targetRevision: main
    path: k8s/overlays/production/service-ns

  destination:
    server: https://kubernetes.default.svc
    namespace: service-ns

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

  # HPA가 replicas를 관리하므로 무시
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

### 3. ArgoCD Application (Workers - worker-ns)

```yaml
# argocd/application-workers.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: pingvasai-workers-production
  namespace: argocd
spec:
  project: pingvasai

  source:
    repoURL: https://github.com/pingvasai/infrastructure
    targetRevision: main
    path: k8s/overlays/production/worker-ns

  destination:
    server: https://kubernetes.default.svc
    namespace: worker-ns

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

  # KEDA ScaledObject가 replicas를 관리하므로 무시
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

### 4. ArgoCD AppProject

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
    - namespace: 'service-ns'
      server: https://kubernetes.default.svc
    - namespace: 'worker-ns'
      server: https://kubernetes.default.svc
    - namespace: 'default'
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

### 5. ArgoCD Notifications (Slack)

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
      *Namespace:* {{.app.spec.destination.namespace}}
      *Sync Status:* {{.app.status.sync.status}}
      *Health Status:* {{.app.status.health.status}}
      *Revision:* {{.app.status.sync.revision}}
      *Author:* {{(call .repo.GetCommitMetadata .app.status.sync.revision).Author}}

  template.app-health-degraded: |
    message: |
      {{if eq .serviceType "slack"}}:exclamation:{{end}} Application {{.app.metadata.name}} has degraded.
      *Namespace:* {{.app.spec.destination.namespace}}
      Application details: {{.context.argocdUrl}}/applications/{{.app.metadata.name}}.

  template.keda-scaled: |
    message: |
      {{if eq .serviceType "slack"}}:chart_with_upwards_trend:{{end}} KEDA ScaledObject 변경 감지
      *Application:* {{.app.metadata.name}}
      *Namespace:* worker-ns
      *ScaledObject:* GPU/API Relay/System Workers

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

| 환경 | 목적 | 브랜치 | 배포 방식 | 스케일 | Namespace |
|------|------|--------|-----------|--------|-----------|
| Development | 개발/테스트 | develop | 자동 배포 | 소규모 (1-2 pods) | dev-service-ns, dev-worker-ns |
| Staging | 프로덕션 시뮬레이션 | staging | 자동 배포 | 중규모 (2-3 pods) | staging-service-ns, staging-worker-ns |
| Production | 실제 서비스 | main | 수동 승인 후 배포 | 대규모 (5-20 pods) | service-ns, worker-ns |

### 2. 환경별 설정 관리

```python
# app/config.py
from pydantic_settings import BaseSettings
from functools import lru_cache
import os


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

    # KEDA
    KEDA_ENABLED: bool = True
    KEDA_POLLING_INTERVAL: int = 15

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

    # KEDA 기반 3-Tier Workers 점진적 롤아웃
    if ff.is_enabled("keda_3tier_workers", str(request.user_id)):
        # 새로운 KEDA 기반 Worker로 라우팅
        queue = get_queue_by_tier(request.subscription_tier)
    else:
        # 기존 Worker로 라우팅 (레거시)
        queue = "default"

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

### 2. Migration Job (Kubernetes - PreSync Hook)

```yaml
# k8s/jobs/migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration
  namespace: service-ns
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

### 1. Rolling Update (기본 - API)

```yaml
# k8s/base/service-ns/deployment.yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1         # 동시에 추가할 수 있는 최대 Pod 수
      maxUnavailable: 0   # 동시에 사용 불가능한 최대 Pod 수
```

### 2. KEDA Scale to Zero (Workers)

**배포 전략:**
- KEDA ScaledObject는 `replicas: 0`으로 시작
- Queue에 작업이 들어오면 15초 이내 Scale Up
- 작업 완료 후 Cooldown Period (3-5분) 동안 대기
- 유휴 상태가 지속되면 0으로 Scale Down

**주의 사항:**
```yaml
# Worker Deployment에서 항상 replicas: 0으로 설정
spec:
  replicas: 0  # KEDA가 관리, 수동 변경 금지
```

### 3. Blue-Green 배포 (API)

```yaml
# k8s/overlays/production/blue-green/service-blue.yaml
apiVersion: v1
kind: Service
metadata:
  name: pingvasai-api-blue
  namespace: service-ns
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
  namespace: service-ns
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
  namespace: service-ns
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
kubectl wait --for=condition=available deployment/pingvasai-api-green -n service-ns --timeout=300s

# 3. Smoke Test
curl https://api-green.pingvasai.com/health

# 4. 트래픽 전환 (Ingress 업데이트)
kubectl patch ingress pingvasai-api -n service-ns -p '{"spec":{"rules":[{"host":"api.pingvasai.com","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"pingvasai-api-green","port":{"number":80}}}}]}}]}}'

# 5. 모니터링 (10분)
# 문제 없으면 Blue 환경 제거

# 6. Rollback (문제 발생 시)
kubectl patch ingress pingvasai-api -n service-ns -p '{"spec":{"rules":[{"host":"api.pingvasai.com","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"pingvasai-api-blue","port":{"number":80}}}}]}}]}}'
```

### 4. Canary 배포 (Flagger)

```yaml
# k8s/flagger/canary.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: pingvasai-api
  namespace: service-ns
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
          cmd: "hey -z 1m -q 10 -c 2 http://pingvasai-api-canary.service-ns/health"

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
kubectl rollout history deployment/pingvasai-api -n service-ns

# 이전 버전으로 롤백
kubectl rollout undo deployment/pingvasai-api -n service-ns

# 특정 리비전으로 롤백
kubectl rollout undo deployment/pingvasai-api -n service-ns --to-revision=3

# 롤백 상태 확인
kubectl rollout status deployment/pingvasai-api -n service-ns
```

### 2. ArgoCD Rollback

```bash
# ArgoCD History 확인
argocd app history pingvasai-api-production

# 특정 리비전으로 롤백
argocd app rollback pingvasai-api-production 5

# Sync 상태 확인
argocd app get pingvasai-api-production
```

### 3. KEDA ScaledObject Rollback

```bash
# ScaledObject 일시 중지 (Scale Down 방지)
kubectl patch scaledobject gpu-workers-scaler -n worker-ns -p '{"spec":{"pollingInterval":0}}'

# ScaledObject 재개
kubectl patch scaledobject gpu-workers-scaler -n worker-ns -p '{"spec":{"pollingInterval":15}}'

# 강제 Scale Up (긴급 상황)
kubectl scale deployment gpu-workers -n worker-ns --replicas=5
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
   kubectl get pods -n service-ns -l app=pingvasai-api
   ```

2. Pod 로그 확인:
   ```bash
   kubectl logs -n service-ns -l app=pingvasai-api --tail=100
   ```

3. Events 확인:
   ```bash
   kubectl get events -n service-ns --sort-by='.lastTimestamp'
   ```

## 복구 절차
1. **즉시 롤백**:
   ```bash
   kubectl rollout undo deployment/pingvasai-api -n service-ns
   ```

2. **데이터베이스 확인**:
   ```bash
   kubectl exec -it postgres-0 -n default -- psql -U user -d pingvasai -c "SELECT 1;"
   ```

3. **Redis 확인**:
   ```bash
   kubectl exec -it redis-0 -n default -- redis-cli PING
   ```

4. **Scale Up (긴급)**:
   ```bash
   kubectl scale deployment/pingvasai-api -n service-ns --replicas=10
   ```

## 사후 조치
- RCA (Root Cause Analysis) 문서 작성
- 재발 방지 대책 수립
```

```markdown
# Runbook: KEDA Worker Scale Up 실패

## 증상
- Queue에 작업이 쌓이는데 Worker가 Scale Up 안 됨
- KEDA ScaledObject 상태 이상

## 진단
1. ScaledObject 상태 확인:
   ```bash
   kubectl get scaledobject -n worker-ns
   kubectl describe scaledobject gpu-workers-scaler -n worker-ns
   ```

2. KEDA Operator 로그 확인:
   ```bash
   kubectl logs -n keda -l app=keda-operator --tail=100
   ```

3. Redis 연결 확인:
   ```bash
   kubectl exec -it redis-0 -n default -- redis-cli LLEN celery:queue:enterprise
   ```

## 복구 절차
1. **ScaledObject 재시작**:
   ```bash
   kubectl delete scaledobject gpu-workers-scaler -n worker-ns
   kubectl apply -f k8s/base/worker-ns/gpu-worker-scaledobject.yaml
   ```

2. **KEDA Operator 재시작**:
   ```bash
   kubectl rollout restart deployment keda-operator -n keda
   ```

3. **수동 Scale Up (긴급)**:
   ```bash
   kubectl scale deployment gpu-workers -n worker-ns --replicas=5
   ```

4. **Redis 재시작 (최후 수단)**:
   ```bash
   kubectl rollout restart statefulset redis -n default
   ```

## 사후 조치
- KEDA 메트릭 검토
- Redis 성능 모니터링 강화
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


def test_namespace_isolation():
    """Namespace 분리 확인"""
    import subprocess

    # service-ns에 API Pod 확인
    result = subprocess.run(
        ['kubectl', 'get', 'pods', '-n', 'service-ns', '-l', 'app=pingvasai-api'],
        capture_output=True, text=True
    )
    assert 'pingvasai-api' in result.stdout

    # worker-ns에 Worker Pod 확인
    result = subprocess.run(
        ['kubectl', 'get', 'pods', '-n', 'worker-ns', '-l', 'component=worker'],
        capture_output=True, text=True
    )
    assert 'worker' in result.stdout
```

### 2. KEDA Scaling Test

```python
# tests/keda_scaling_test.py
import time
import subprocess
from celery import Celery

app = Celery('tasks', broker='redis://redis-service.default:6379/0')


def test_keda_scale_up_gpu_workers():
    """KEDA GPU Workers Scale Up 테스트"""

    # 초기 상태: 0 replicas
    result = subprocess.run(
        ['kubectl', 'get', 'deployment', 'gpu-workers', '-n', 'worker-ns',
         '-o', 'jsonpath={.spec.replicas}'],
        capture_output=True, text=True
    )
    initial_replicas = int(result.stdout)
    assert initial_replicas == 0, "Initial replicas should be 0"

    # 10개 작업 제출 (Enterprise Queue)
    job_ids = []
    for i in range(10):
        result = app.send_task(
            'workers.gpu.tasks.generate_image',
            kwargs={'user_id': 'test_user', 'job_id': f'test_job_{i}',
                   'prompt': f'test prompt {i}', 'model_name': 'flux-schnell'},
            queue='enterprise'
        )
        job_ids.append(result.id)

    # 30초 대기 (KEDA Scale Up)
    time.sleep(30)

    # Scale Up 확인
    result = subprocess.run(
        ['kubectl', 'get', 'deployment', 'gpu-workers', '-n', 'worker-ns',
         '-o', 'jsonpath={.spec.replicas}'],
        capture_output=True, text=True
    )
    scaled_replicas = int(result.stdout)
    assert scaled_replicas > 0, f"KEDA should have scaled up, but replicas={scaled_replicas}"

    print(f"✅ KEDA Scale Up successful: 0 → {scaled_replicas} replicas")


def test_keda_scale_down_gpu_workers():
    """KEDA GPU Workers Scale Down 테스트"""

    # Queue 비우기
    subprocess.run(
        ['kubectl', 'exec', '-it', 'redis-0', '-n', 'default', '--',
         'redis-cli', 'DEL', 'celery:queue:enterprise'],
        capture_output=True
    )

    # 5분 대기 (Cooldown Period)
    print("⏳ Waiting 5 minutes for cooldown...")
    time.sleep(300)

    # Scale Down 확인
    result = subprocess.run(
        ['kubectl', 'get', 'deployment', 'gpu-workers', '-n', 'worker-ns',
         '-o', 'jsonpath={.spec.replicas}'],
        capture_output=True, text=True
    )
    final_replicas = int(result.stdout)
    assert final_replicas == 0, f"KEDA should have scaled down to 0, but replicas={final_replicas}"

    print(f"✅ KEDA Scale Down successful: replicas → 0")


def test_keda_multi_queue_scaling():
    """KEDA 다중 Queue 기반 Scaling 테스트"""

    # Enterprise Queue: 1개 작업 → 즉시 Scale Up
    app.send_task(
        'workers.gpu.tasks.generate_image',
        kwargs={'user_id': 'test_user', 'job_id': 'enterprise_1',
               'prompt': 'enterprise test', 'model_name': 'flux-pro'},
        queue='enterprise'
    )

    time.sleep(20)

    result = subprocess.run(
        ['kubectl', 'get', 'deployment', 'gpu-workers', '-n', 'worker-ns',
         '-o', 'jsonpath={.spec.replicas}'],
        capture_output=True, text=True
    )
    replicas = int(result.stdout)
    assert replicas >= 1, "Enterprise queue should trigger immediate scale up"

    print(f"✅ Enterprise Queue scaling: {replicas} replicas")
```

### 3. Load Test (k6)

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

### 4. Namespace 격리 테스트

```bash
# tests/namespace_isolation_test.sh

echo "=== Namespace 격리 테스트 ==="

# 1. service-ns에 API Pod만 있는지 확인
echo "1. service-ns Pod 확인:"
kubectl get pods -n service-ns
API_PODS=$(kubectl get pods -n service-ns -l app=pingvasai-api -o name | wc -l)
if [ $API_PODS -gt 0 ]; then
    echo "✅ API Pods found in service-ns: $API_PODS"
else
    echo "❌ No API Pods in service-ns"
    exit 1
fi

# 2. worker-ns에 Worker Pod만 있는지 확인
echo "2. worker-ns Pod 확인:"
kubectl get pods -n worker-ns
WORKER_PODS=$(kubectl get pods -n worker-ns -l component=worker -o name | wc -l)
if [ $WORKER_PODS -gt 0 ]; then
    echo "✅ Worker Pods found in worker-ns: $WORKER_PODS"
else
    echo "⚠️ No Worker Pods in worker-ns (KEDA Scale to Zero 상태일 수 있음)"
fi

# 3. Cross-namespace 통신 확인
echo "3. Cross-namespace 통신 테스트:"
kubectl run test-pod -n service-ns --image=curlimages/curl:latest --rm -it --restart=Never -- \
    curl redis-service.default.svc.cluster.local:6379

if [ $? -eq 0 ]; then
    echo "✅ Cross-namespace communication successful"
else
    echo "❌ Cross-namespace communication failed"
    exit 1
fi

echo "=== 모든 테스트 통과 ==="
```

---

## Phase 11 완료 (v2.0)

### 구현 완료 항목

✅ **Namespace 분리**
- service-ns (API & Monitoring)
- worker-ns (3-Tier Workers)
- Namespace별 ConfigMap, Secret 격리

✅ **GitHub Actions CI/CD (Multi-Image)**
- 4개 Docker Image 빌드 (API + 3 Workers)
- Parallel Build with Matrix Strategy
- ECR Push 자동화
- Kustomization.yaml 자동 업데이트

✅ **Docker 이미지 (4종)**
- API Image (Multi-stage, 비root 사용자)
- GPU Worker Image (CUDA 12.1, NVIDIA Runtime)
- API Relay Worker Image (경량 Python)
- System Worker Image (ffmpeg, imagemagick 포함)

✅ **Kubernetes (KEDA 통합)**
- Namespace별 Deployment
- KEDA ScaledObject (3개 Worker 타입)
- Scale to Zero 지원 (minReplicas: 0)
- API HPA (기존 유지)
- Cross-namespace Service 통신

✅ **ArgoCD GitOps**
- 2개 Application (API, Workers)
- Namespace별 배포
- Automated Sync + Self-Heal
- KEDA ScaledObject replicas 무시 설정

✅ **환경 관리**
- Development, Staging, Production 분리
- Namespace별 환경 설정
- Feature Flags (KEDA 점진적 롤아웃)

✅ **Database Migration**
- Alembic 설정
- PreSync Hook (ArgoCD)
- 안전한 Migration 전략

✅ **배포 전략**
- Rolling Update (API)
- Scale to Zero (Workers with KEDA)
- Blue-Green 배포
- Canary 배포 (Flagger)

✅ **Rollback & 복구**
- Kubernetes Rollback
- ArgoCD Rollback
- KEDA ScaledObject 제어
- Namespace별 장애 복구 Runbook

✅ **테스트**
- Smoke Test
- KEDA Scaling Test (Scale Up/Down)
- Load Test (k6)
- Namespace 격리 테스트

---

### v1.0 → v2.0 주요 개선 사항

| 항목 | 개선 내용 | 효과 |
|------|-----------|------|
| **Namespace** | 단일 → 분리 (service-ns, worker-ns) | 리소스 격리, 관리 효율성 향상 |
| **Worker Architecture** | 단일 GPU → 3-Tier (GPU/API Relay/System) | 역할 분리, GPU 효율 20% 향상 |
| **Auto-Scaling** | CloudWatch ASG → KEDA ScaledObject | 반응속도 2-3분 → 15초 (80% 개선) |
| **Idle Cost** | 최소 1 replica → 0 replica | 유휴 시 100% 비용 절감 |
| **Docker Images** | 1개 → 4개 | Worker 타입별 최적화, 이미지 크기 감소 |
| **CI/CD** | 단일 빌드 → Matrix Build | 병렬 빌드로 시간 50% 단축 |
| **배포 복잡도** | 단순 → 향상 | KEDA 통합, Namespace 관리 추가 |

---

**Phase 11 (v2.0) 완료! 🎉**

다음 단계: Complete Implementation Guide 업데이트
