# CI/CD 파이프라인 가이드

## 개요

이 문서는 Pingvas Studio의 CI/CD 파이프라인 설정을 설명합니다. GitHub Actions를 사용한 CI와 ArgoCD를 사용한 CD(GitOps)를 구현합니다.

---

## 파이프라인 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CI/CD Pipeline Flow                               │
│                                                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │  Code   │───▶│  Build  │───▶│  Test   │───▶│  Push   │───▶│ Update  │  │
│  │  Push   │    │  Image  │    │  & Scan │    │  ECR    │    │ Manifest│  │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘  │
│       │                                                            │        │
│       │                        GitHub Actions                      │        │
│       │                                                            │        │
│       ▼                                                            ▼        │
│  ┌─────────┐                                              ┌─────────────┐  │
│  │ GitHub  │                                              │  GitOps     │  │
│  │ Repo    │                                              │  Repo       │  │
│  └─────────┘                                              └─────────────┘  │
│                                                                  │          │
│                                                                  ▼          │
│                                                           ┌─────────┐      │
│                                                           │ ArgoCD  │      │
│                                                           │  Sync   │      │
│                                                           └─────────┘      │
│                                                                  │          │
│                                                                  ▼          │
│                                                           ┌─────────┐      │
│                                                           │   EKS   │      │
│                                                           │ Cluster │      │
│                                                           └─────────┘      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 레포지토리 구조

### 애플리케이션 레포지토리
```
pingvas-studio/
├── .github/
│   └── workflows/
│       ├── ci-backend.yml        # 백엔드 CI
│       ├── ci-frontend.yml       # 프론트엔드 CI
│       ├── ci-ai-worker.yml      # AI Worker CI
│       └── release.yml           # 릴리스 자동화
├── services/
│   ├── user-service/
│   ├── generation-service/
│   ├── payment-service/
│   ├── gallery-service/
│   └── ai-worker/
├── frontend/
│   └── web/
└── docker/
    └── Dockerfile.*
```

### GitOps 레포지토리
```
pingvas-gitops/
├── apps/
│   ├── base/
│   │   ├── user-service/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── kustomization.yaml
│   │   ├── generation-service/
│   │   ├── payment-service/
│   │   ├── gallery-service/
│   │   ├── ai-worker/
│   │   └── frontend/
│   └── overlays/
│       ├── dev/
│       │   └── kustomization.yaml
│       └── prod/
│           └── kustomization.yaml
├── infrastructure/
│   ├── argocd/
│   ├── ingress/
│   └── monitoring/
└── argocd-apps/
    ├── dev-apps.yaml
    └── prod-apps.yaml
```

---

## GitHub Actions 워크플로우

### 1. 백엔드 서비스 CI

```yaml
# .github/workflows/ci-backend.yml
name: Backend CI

on:
  push:
    branches: [main, develop]
    paths:
      - 'services/**'
      - '.github/workflows/ci-backend.yml'
  pull_request:
    branches: [main]
    paths:
      - 'services/**'

env:
  AWS_REGION: ap-northeast-2
  ECR_REGISTRY: 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.changes.outputs.services }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: changes
        with:
          filters: |
            user-service:
              - 'services/user-service/**'
            generation-service:
              - 'services/generation-service/**'
            payment-service:
              - 'services/payment-service/**'
            gallery-service:
              - 'services/gallery-service/**'

      - id: set-matrix
        run: |
          SERVICES=()
          if [ "${{ steps.changes.outputs.user-service }}" == "true" ]; then
            SERVICES+=("user-service")
          fi
          if [ "${{ steps.changes.outputs.generation-service }}" == "true" ]; then
            SERVICES+=("generation-service")
          fi
          if [ "${{ steps.changes.outputs.payment-service }}" == "true" ]; then
            SERVICES+=("payment-service")
          fi
          if [ "${{ steps.changes.outputs.gallery-service }}" == "true" ]; then
            SERVICES+=("gallery-service")
          fi
          echo "services=$(printf '%s\n' "${SERVICES[@]}" | jq -R . | jq -s -c .)" >> $GITHUB_OUTPUT

  test:
    needs: detect-changes
    if: needs.detect-changes.outputs.services != '[]'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: ${{ fromJson(needs.detect-changes.outputs.services) }}

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: 'pip'
          cache-dependency-path: services/${{ matrix.service }}/requirements.txt

      - name: Install dependencies
        run: |
          cd services/${{ matrix.service }}
          pip install -r requirements.txt
          pip install -r requirements-dev.txt

      - name: Run linting
        run: |
          cd services/${{ matrix.service }}
          ruff check .
          ruff format --check .

      - name: Run type checking
        run: |
          cd services/${{ matrix.service }}
          mypy .

      - name: Run tests
        run: |
          cd services/${{ matrix.service }}
          pytest --cov=. --cov-report=xml -v

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: services/${{ matrix.service }}/coverage.xml
          flags: ${{ matrix.service }}

  build-and-push:
    needs: [detect-changes, test]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: ${{ fromJson(needs.detect-changes.outputs.services) }}

    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: services/${{ matrix.service }}
          file: services/${{ matrix.service }}/Dockerfile
          push: true
          tags: |
            ${{ env.ECR_REGISTRY }}/${{ matrix.service }}:${{ github.sha }}
            ${{ env.ECR_REGISTRY }}/${{ matrix.service }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/arm64  # Graviton용

      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.ECR_REGISTRY }}/${{ matrix.service }}:${{ github.sha }}
          format: 'sarif'
          output: 'trivy-results.sarif'

      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'

  update-manifest:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Checkout GitOps repo
        uses: actions/checkout@v4
        with:
          repository: pingvas/pingvas-gitops
          token: ${{ secrets.GITOPS_TOKEN }}
          path: gitops

      - name: Update image tags
        run: |
          cd gitops
          for service in ${{ join(fromJson(needs.detect-changes.outputs.services), ' ') }}; do
            # Update prod overlay
            yq -i ".images[0].newTag = \"${{ github.sha }}\"" \
              apps/overlays/prod/${service}/kustomization.yaml
          done

      - name: Commit and push
        run: |
          cd gitops
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add .
          git commit -m "chore: update image tags to ${{ github.sha }}"
          git push
```

### 2. 프론트엔드 CI

```yaml
# .github/workflows/ci-frontend.yml
name: Frontend CI

on:
  push:
    branches: [main, develop]
    paths:
      - 'frontend/**'
      - '.github/workflows/ci-frontend.yml'
  pull_request:
    branches: [main]
    paths:
      - 'frontend/**'

env:
  AWS_REGION: ap-northeast-2
  ECR_REGISTRY: 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
          cache-dependency-path: frontend/web/pnpm-lock.yaml

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install dependencies
        run: |
          cd frontend/web
          pnpm install --frozen-lockfile

      - name: Run linting
        run: |
          cd frontend/web
          pnpm lint

      - name: Run type checking
        run: |
          cd frontend/web
          pnpm typecheck

      - name: Run tests
        run: |
          cd frontend/web
          pnpm test:coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: frontend/web/coverage/lcov.info
          flags: frontend

  build-storybook:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install dependencies
        run: |
          cd frontend/web
          pnpm install --frozen-lockfile

      - name: Build Storybook
        run: |
          cd frontend/web
          pnpm build-storybook

      - name: Run Chromatic
        uses: chromaui/action@latest
        with:
          projectToken: ${{ secrets.CHROMATIC_PROJECT_TOKEN }}
          workingDir: frontend/web

  build-and-push:
    needs: lint-and-test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: frontend/web
          file: frontend/web/Dockerfile
          push: true
          tags: |
            ${{ env.ECR_REGISTRY }}/frontend:${{ github.sha }}
            ${{ env.ECR_REGISTRY }}/frontend:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            VITE_API_URL=https://api.pingvas.studio
            VITE_WS_URL=wss://api.pingvas.studio

      - name: Update GitOps manifest
        run: |
          # GitOps 레포 클론 및 업데이트
          git clone https://${{ secrets.GITOPS_TOKEN }}@github.com/pingvas/pingvas-gitops.git
          cd pingvas-gitops
          yq -i ".images[0].newTag = \"${{ github.sha }}\"" \
            apps/overlays/prod/frontend/kustomization.yaml
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add .
          git commit -m "chore: update frontend image to ${{ github.sha }}"
          git push
```

### 3. AI Worker CI

```yaml
# .github/workflows/ci-ai-worker.yml
name: AI Worker CI

on:
  push:
    branches: [main, develop]
    paths:
      - 'services/ai-worker/**'
      - '.github/workflows/ci-ai-worker.yml'
  pull_request:
    branches: [main]
    paths:
      - 'services/ai-worker/**'

env:
  AWS_REGION: ap-northeast-2
  ECR_REGISTRY: 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: |
          cd services/ai-worker
          pip install -r requirements.txt
          pip install -r requirements-dev.txt

      - name: Run tests (CPU only)
        run: |
          cd services/ai-worker
          pytest tests/unit -v

  build-and-push:
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push (CUDA)
        uses: docker/build-push-action@v6
        with:
          context: services/ai-worker
          file: services/ai-worker/Dockerfile.cuda
          push: true
          tags: |
            ${{ env.ECR_REGISTRY }}/ai-worker:${{ github.sha }}-cuda
            ${{ env.ECR_REGISTRY }}/ai-worker:latest-cuda
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64  # GPU는 x86만

      - name: Update GitOps manifest
        run: |
          git clone https://${{ secrets.GITOPS_TOKEN }}@github.com/pingvas/pingvas-gitops.git
          cd pingvas-gitops
          yq -i ".images[0].newTag = \"${{ github.sha }}-cuda\"" \
            apps/overlays/prod/ai-worker/kustomization.yaml
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add .
          git commit -m "chore: update ai-worker image to ${{ github.sha }}-cuda"
          git push
```

---

## ArgoCD 설정

### Application 정의

```yaml
# argocd-apps/prod-apps.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pingvas-prod-apps
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - name: user-service
            namespace: pingvas-prod
          - name: generation-service
            namespace: pingvas-prod
          - name: payment-service
            namespace: pingvas-prod
          - name: gallery-service
            namespace: pingvas-prod
          - name: ai-worker
            namespace: pingvas-prod
          - name: frontend
            namespace: pingvas-prod

  template:
    metadata:
      name: '{{name}}-prod'
    spec:
      project: pingvas-prod
      source:
        repoURL: https://github.com/pingvas/pingvas-gitops.git
        targetRevision: main
        path: apps/overlays/prod/{{name}}
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{namespace}}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
          allowEmpty: false
        syncOptions:
          - CreateNamespace=true
          - PruneLast=true
          - ApplyOutOfSyncOnly=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

### ArgoCD Project

```yaml
# argocd-apps/project-prod.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: pingvas-prod
  namespace: argocd
spec:
  description: Pingvas Studio Production Environment

  sourceRepos:
    - https://github.com/pingvas/pingvas-gitops.git
    - https://github.com/pingvas/pingvas-studio.git

  destinations:
    - namespace: pingvas-prod
      server: https://kubernetes.default.svc
    - namespace: monitoring
      server: https://kubernetes.default.svc

  clusterResourceWhitelist:
    - group: ''
      kind: Namespace

  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'

  roles:
    - name: developer
      description: Developer access
      policies:
        - p, proj:pingvas-prod:developer, applications, get, pingvas-prod/*, allow
        - p, proj:pingvas-prod:developer, applications, sync, pingvas-prod/*, allow
      groups:
        - pingvas-developers
```

---

## 환경별 배포 전략

### Development (자동 배포)
```yaml
# apps/overlays/dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: pingvas-dev

resources:
  - ../../base/user-service
  - ../../base/generation-service
  - ../../base/payment-service
  - ../../base/gallery-service
  - ../../base/ai-worker
  - ../../base/frontend

images:
  - name: user-service
    newName: 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/user-service
    newTag: develop-latest
  # ... 다른 서비스들

patches:
  - patch: |-
      - op: replace
        path: /spec/replicas
        value: 1
    target:
      kind: Deployment
```

### Production (수동 승인)
```yaml
# apps/overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: pingvas-prod

resources:
  - ../../base/user-service
  - ../../base/generation-service
  - ../../base/payment-service
  - ../../base/gallery-service
  - ../../base/ai-worker
  - ../../base/frontend

images:
  - name: user-service
    newName: 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/user-service
    newTag: abc123def  # 특정 커밋 해시

patches:
  - patch: |-
      - op: replace
        path: /spec/replicas
        value: 3
    target:
      kind: Deployment
      name: user-service
```

---

## 롤백 절차

### ArgoCD UI 통한 롤백
1. ArgoCD UI 접속
2. Application 선택
3. History and Rollback 클릭
4. 이전 버전 선택 후 Rollback

### CLI 통한 롤백
```bash
# 히스토리 확인
argocd app history user-service-prod

# 특정 리비전으로 롤백
argocd app rollback user-service-prod 5

# GitOps 방식 롤백 (권장)
cd pingvas-gitops
git revert HEAD
git push
```

---

## 시크릿 관리

### External Secrets Operator

```yaml
# external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: pingvas-secrets
  namespace: pingvas-prod
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: pingvas-secrets
    creationPolicy: Owner
  data:
    - secretKey: DATABASE_URL
      remoteRef:
        key: pingvas/prod/database
        property: url
    - secretKey: REDIS_URL
      remoteRef:
        key: pingvas/prod/redis
        property: url
    - secretKey: LEMON_SQUEEZY_API_KEY
      remoteRef:
        key: pingvas/prod/lemon-squeezy
        property: api_key
```

---

## 모니터링 및 알림

### GitHub Actions 알림 (Slack)

```yaml
# .github/workflows/notify.yml
- name: Notify Slack on failure
  if: failure()
  uses: slackapi/slack-github-action@v1
  with:
    channel-id: 'C0123456789'
    payload: |
      {
        "text": "CI Failed: ${{ github.repository }}",
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "*Workflow:* ${{ github.workflow }}\n*Branch:* ${{ github.ref }}\n*Author:* ${{ github.actor }}"
            }
          }
        ]
      }
  env:
    SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
```

### ArgoCD 알림

```yaml
# argocd-notifications-cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  trigger.on-sync-succeeded: |
    - when: app.status.sync.status == 'Synced'
      send: [slack-success]

  trigger.on-sync-failed: |
    - when: app.status.sync.status == 'OutOfSync'
      send: [slack-failure]

  template.slack-success: |
    message: |
      :white_check_mark: *{{ .app.metadata.name }}* synced successfully
      Revision: {{ .app.status.sync.revision }}

  template.slack-failure: |
    message: |
      :x: *{{ .app.metadata.name }}* sync failed
      Revision: {{ .app.status.sync.revision }}
```

---

## 다음 단계

- [GitOps 가이드](./01-gitops-guide.md)에서 ArgoCD 상세 설정 확인
- [모니터링 설정](./03-monitoring.md)에서 파이프라인 메트릭 확인
- [로컬 개발](../guides/01-local-development.md)에서 개발 환경 설정
