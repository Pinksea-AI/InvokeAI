# Phase 5: GitOps/CI/CD 파이프라인

이 가이드는 ArgoCD 기반 GitOps 및 GitHub Actions CI/CD 파이프라인을 구축하는 과정을 다룹니다.

## 목차
1. [ArgoCD 설치](#argocd-설치)
2. [ApplicationSet 설정](#applicationset-설정)
3. [Kustomize Overlays](#kustomize-overlays)
4. [GitHub Actions Workflows](#github-actions-workflows)
5. [Image Build & Push](#image-build--push)
6. [자동 배포 파이프라인](#자동-배포-파이프라인)
7. [Rollback 전략](#rollback-전략)

---

## ArgoCD 설치

### 1. ArgoCD 설치

```bash
# 네임스페이스 생성
kubectl create namespace argocd

# ArgoCD 설치
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 설치 확인
kubectl get pods -n argocd
```

---

### 2. ArgoCD CLI 설치

```bash
# macOS
brew install argocd

# Linux
curl -sSL -o argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
chmod +x argocd
sudo mv argocd /usr/local/bin/

# 확인
argocd version
```

---

### 3. ArgoCD 접속

```bash
# 초기 비밀번호 확인
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d

# Port Forward
kubectl port-forward svc/argocd-server -n argocd 8080:443

# 브라우저에서 접속: https://localhost:8080
# Username: admin
# Password: (위에서 확인한 비밀번호)

# CLI 로그인
argocd login localhost:8080
```

---

### 4. ArgoCD Ingress (선택)

`k8s/argocd/ingress.yaml`:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd-server-ingress
  namespace: argocd
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
spec:
  rules:
    - host: argocd.pingvas.studio
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: argocd-server
                port:
                  number: 443
  tls:
    - hosts:
        - argocd.pingvas.studio
      secretName: argocd-tls
```

```bash
kubectl apply -f k8s/argocd/ingress.yaml
```

---

## ApplicationSet 설정

### 1. 디렉토리 구조

```
k8s/
├── base/
│   ├── user-service/
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   └── kustomization.yaml
│   ├── payment-service/
│   ├── generation-service/
│   ├── gallery-service/
│   └── model-service/
└── overlays/
    ├── dev/
    │   ├── user-service/
    │   │   ├── kustomization.yaml
    │   │   └── patches/
    │   └── ...
    └── prod/
        └── ...
```

---

### 2. Base Manifests

`k8s/base/user-service/deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
  labels:
    app: user-service
spec:
  replicas: 2
  selector:
    matchLabels:
      app: user-service
  template:
    metadata:
      labels:
        app: user-service
    spec:
      containers:
        - name: user-service
          image: YOUR_ECR/user-service:latest
          ports:
            - containerPort: 8001
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url
            - name: REDIS_URL
              valueFrom:
                configMapKeyRef:
                  name: redis-config
                  key: url
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /health
              port: 8001
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 8001
            initialDelaySeconds: 5
            periodSeconds: 5
```

`k8s/base/user-service/service.yaml`:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: user-service
spec:
  selector:
    app: user-service
  ports:
    - protocol: TCP
      port: 8001
      targetPort: 8001
  type: ClusterIP
```

`k8s/base/user-service/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - deployment.yaml
  - service.yaml

commonLabels:
  app: user-service
  managed-by: kustomize
```

---

### 3. Dev Overlay

`k8s/overlays/dev/user-service/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: dev

bases:
  - ../../../base/user-service

images:
  - name: YOUR_ECR/user-service
    newTag: dev-latest

replicas:
  - name: user-service
    count: 1  # Dev는 1 replica

patches:
  - path: patches/resources.yaml

configMapGenerator:
  - name: redis-config
    literals:
      - url=redis://redis-dev:6379/0

secretGenerator:
  - name: db-credentials
    literals:
      - url=postgresql://user:pass@rds-dev:5432/pingvas_saas
```

`k8s/overlays/dev/user-service/patches/resources.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
spec:
  template:
    spec:
      containers:
        - name: user-service
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: 200m
              memory: 256Mi
```

---

### 4. ApplicationSet

`k8s/argocd/applicationset.yaml`:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pingvas-services
  namespace: argocd
spec:
  generators:
    # Matrix Generator: 환경 x 서비스
    - matrix:
        generators:
          # 환경 (dev, prod)
          - list:
              elements:
                - env: dev
                  cluster: dev-pingvas-eks
                  namespace: dev
                  revision: main
                - env: prod
                  cluster: prod-pingvas-eks
                  namespace: prod
                  revision: main

          # 서비스 목록
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
      labels:
        environment: '{{env}}'
        service: '{{service}}'

    spec:
      project: default

      source:
        repoURL: https://github.com/Pinksea-AI/InvokeAI.git
        targetRevision: '{{revision}}'
        path: k8s/overlays/{{env}}/{{service}}

      destination:
        server: https://kubernetes.default.svc
        namespace: '{{namespace}}'

      syncPolicy:
        automated:
          prune: true       # 삭제된 리소스 자동 제거
          selfHeal: true    # Drift 자동 수정
          allowEmpty: false

        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground

        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

**적용**:
```bash
kubectl apply -f k8s/argocd/applicationset.yaml
```

---

## Kustomize Overlays

### 1. Prod Overlay

`k8s/overlays/prod/user-service/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: prod

bases:
  - ../../../base/user-service

images:
  - name: YOUR_ECR/user-service
    newTag: v1.2.3  # Prod는 특정 버전

replicas:
  - name: user-service
    count: 3  # Prod는 3 replicas

patches:
  - path: patches/resources.yaml
  - path: patches/hpa.yaml

configMapGenerator:
  - name: redis-config
    literals:
      - url=redis://redis-prod:6379/0

secretGenerator:
  - name: db-credentials
    literals:
      - url=postgresql://user:pass@rds-prod:5432/pingvas_saas
```

`k8s/overlays/prod/user-service/patches/hpa.yaml`:
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: user-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: user-service
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

---

## GitHub Actions Workflows

### 1. CI 워크플로우 (빌드 & 테스트)

`.github/workflows/ci.yaml`:
```yaml
name: CI - Build and Test

on:
  pull_request:
    branches:
      - main
      - develop
    paths:
      - 'services/**'
      - 'k8s/**'

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      user-service: ${{ steps.filter.outputs.user-service }}
      payment-service: ${{ steps.filter.outputs.payment-service }}
      generation-service: ${{ steps.filter.outputs.generation-service }}

    steps:
      - uses: actions/checkout@v4

      - uses: dorny/paths-filter@v2
        id: filter
        with:
          filters: |
            user-service:
              - 'services/user-service/**'
            payment-service:
              - 'services/payment-service/**'
            generation-service:
              - 'services/generation-service/**'

  build-user-service:
    needs: detect-changes
    if: needs.detect-changes.outputs.user-service == 'true'
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.11'

      - name: Install dependencies
        working-directory: services/user-service
        run: |
          pip install uv
          uv pip install -r requirements.txt
          uv pip install pytest pytest-cov

      - name: Run tests
        working-directory: services/user-service
        run: |
          pytest --cov=app --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./services/user-service/coverage.xml
          flags: user-service

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image
        working-directory: services/user-service
        env:
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/user-service:$IMAGE_TAG .
          docker push $ECR_REGISTRY/user-service:$IMAGE_TAG
          docker tag $ECR_REGISTRY/user-service:$IMAGE_TAG $ECR_REGISTRY/user-service:dev-latest
          docker push $ECR_REGISTRY/user-service:dev-latest

      - name: Comment PR
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: '✅ User Service build successful!\nImage: `${{ env.ECR_REGISTRY }}/user-service:${{ github.sha }}`'
            })
```

---

### 2. CD 워크플로우 (Dev 배포)

`.github/workflows/cd-dev.yaml`:
```yaml
name: CD - Deploy to Dev

on:
  push:
    branches:
      - develop
    paths:
      - 'services/**'
      - 'k8s/**'

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Update kubeconfig
        run: |
          aws eks update-kubeconfig --name dev-pingvas-eks --region $AWS_REGION

      - name: Trigger ArgoCD Sync
        run: |
          # ArgoCD CLI 설치
          curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
          chmod +x /usr/local/bin/argocd

          # ArgoCD 로그인
          argocd login ${{ secrets.ARGOCD_SERVER }} \
            --username admin \
            --password ${{ secrets.ARGOCD_PASSWORD }} \
            --insecure

          # 모든 dev 앱 동기화
          argocd app sync -l environment=dev

      - name: Wait for deployment
        run: |
          argocd app wait -l environment=dev --health --timeout 600

      - name: Slack notification
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "✅ Dev deployment successful!",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*Dev Deployment*\nCommit: `${{ github.sha }}`\nAuthor: ${{ github.actor }}"
                  }
                }
              ]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

---

### 3. CD 워크플로우 (Prod 배포)

`.github/workflows/cd-prod.yaml`:
```yaml
name: CD - Deploy to Prod

on:
  release:
    types:
      - published

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production  # GitHub Environment (Approval 필요)

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name }}

      - name: Update Kustomize image tag
        run: |
          cd k8s/overlays/prod
          kustomize edit set image \
            $ECR_REGISTRY/user-service:${{ github.event.release.tag_name }}

      - name: Commit and push
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add k8s/overlays/prod
          git commit -m "chore: update prod image to ${{ github.event.release.tag_name }}"
          git push

      - name: Trigger ArgoCD Sync
        run: |
          argocd login ${{ secrets.ARGOCD_SERVER }} \
            --username admin \
            --password ${{ secrets.ARGOCD_PASSWORD }} \
            --insecure

          argocd app sync -l environment=prod

      - name: Wait for deployment
        run: |
          argocd app wait -l environment=prod --health --timeout 900

      - name: Run smoke tests
        run: |
          ./scripts/smoke-tests.sh prod

      - name: Slack notification
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "🚀 Production deployment successful!",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*Production Release*\nVersion: `${{ github.event.release.tag_name }}`\nRelease Notes: ${{ github.event.release.html_url }}"
                  }
                }
              ]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

---

## Image Build & Push

### 1. Multi-stage Dockerfile

`services/user-service/Dockerfile`:
```dockerfile
# Build stage
FROM python:3.11-slim AS builder

WORKDIR /build

# Install uv
RUN pip install uv

# Copy requirements
COPY requirements.txt .

# Install dependencies
RUN uv pip install --system -r requirements.txt

# Runtime stage
FROM python:3.11-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages

# Copy application code
COPY . .

# Non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD python -c "import requests; requests.get('http://localhost:8001/health')"

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
```

---

## 자동 배포 파이프라인

### 1. GitOps 플로우

```
Developer → Push to branch → GitHub Actions CI
                                    ↓
                           Build & Test & Push Image
                                    ↓
                           Update Kustomize overlay
                                    ↓
                           ArgoCD detects change
                                    ↓
                           Sync to Kubernetes
                                    ↓
                           Health Check
                                    ↓
                           Notify Slack
```

---

### 2. Image Promotion

```bash
# Dev에서 테스트 통과 후 Prod로 승격
docker tag $ECR_REGISTRY/user-service:dev-abc123 \
           $ECR_REGISTRY/user-service:v1.2.3

docker push $ECR_REGISTRY/user-service:v1.2.3

# Kustomize 업데이트
cd k8s/overlays/prod/user-service
kustomize edit set image $ECR_REGISTRY/user-service:v1.2.3

git add .
git commit -m "chore: promote user-service to v1.2.3"
git push
```

---

## Rollback 전략

### 1. ArgoCD Rollback

```bash
# 이전 버전으로 롤백
argocd app rollback dev-user-service <REVISION>

# 또는 UI에서 History → Rollback
```

---

### 2. Kubernetes Rollback

```bash
# Deployment 롤백
kubectl rollout undo deployment/user-service -n dev

# 특정 revision으로 롤백
kubectl rollout undo deployment/user-service -n dev --to-revision=2

# 롤백 상태 확인
kubectl rollout status deployment/user-service -n dev
```

---

### 3. 자동 롤백 (Argo Rollouts)

```bash
# Argo Rollouts 설치
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
```

`k8s/rollouts/user-service.yaml`:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: user-service
spec:
  replicas: 3
  strategy:
    canary:
      steps:
        - setWeight: 20   # 20% 트래픽
        - pause: {duration: 5m}
        - setWeight: 50
        - pause: {duration: 5m}
        - setWeight: 100

      analysis:
        templates:
          - templateName: success-rate
        startingStep: 1

  template:
    metadata:
      labels:
        app: user-service
    spec:
      containers:
        - name: user-service
          image: YOUR_ECR/user-service:latest
          # ... rest of spec
```

---

## 다음 단계

GitOps/CI/CD 파이프라인 구축이 완료되었습니다! 이제 보안 및 모니터링으로 넘어갑니다:

**👉 [Phase 6 - 보안 및 모니터링](./phase-06-security-monitoring.md)**

---

## 체크리스트

- [ ] ArgoCD 설치
- [ ] ApplicationSet 구성
- [ ] Kustomize Overlays 작성
- [ ] GitHub Actions CI 워크플로우
- [ ] GitHub Actions CD 워크플로우
- [ ] 자동 배포 테스트
- [ ] Rollback 테스트
- [ ] Slack 알림 연동
