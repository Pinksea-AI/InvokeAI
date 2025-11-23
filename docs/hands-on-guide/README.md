# InvokeAI SaaS 플랫폼 - 핸즈온 개발 가이드

이 가이드는 **신입 개발자도 복붙으로 따라하며 InvokeAI를 SaaS 플랫폼으로 전환**할 수 있도록 작성된 단계별 실습 가이드입니다.

---

## 📋 전체 개발 로드맵

### Phase 1: 로컬 개발 환경 구축 (1-2일)
로컬 머신에서 전체 시스템을 실행하고 테스트할 수 있는 환경을 구축합니다.

**핵심 작업**:
- Docker Compose로 PostgreSQL, Redis, S3 (LocalStack) 실행
- InvokeAI 오픈소스 코드 이해 및 실행
- 기본 FastAPI 마이크로서비스 템플릿 생성

**산출물**:
- `docker-compose.dev.yaml`
- 로컬 개발 환경 실행 가이드

**상세 가이드**: [Phase 1 - 로컬 개발 환경 구축](./phase-01-local-setup.md)

---

### Phase 2: 마이크로서비스 개발 (1-2주)
InvokeAI를 5개의 마이크로서비스로 분리하고 각 서비스를 개발합니다.

**핵심 작업**:
- User Service: 회원가입/로그인, OAuth (Google/Discord)
- Payment Service: Lemon Squeezy 결제 연동, Webhook 처리
- Generation Service: 이미지 생성 요청 접수, 큐 관리
- Gallery Service: 이미지 메타데이터 관리, 보드 기능
- Model Service: AI 모델 관리, 다운로드

**산출물**:
- 각 서비스별 FastAPI 애플리케이션
- PostgreSQL 스키마 마이그레이션
- API 문서 (OpenAPI)

**상세 가이드**: [Phase 2 - 마이크로서비스 개발](./phase-02-microservices.md)

---

### Phase 3: AWS 인프라 구축 (3-5일)
Terraform으로 AWS 클라우드 인프라를 프로비저닝합니다.

**핵심 작업**:
- VPC, Subnet, NAT Gateway 구성
- EKS 클러스터 생성
- RDS Aurora PostgreSQL 구축
- ElastiCache Redis (Sentinel) 구축
- S3 버킷 생성 (이미지, 모델, 로그)
- EFS 생성 (모델 캐시)
- CloudFront CDN 설정
- Route 53 DNS 설정

**산출물**:
- Terraform 코드 (`infra/terraform/`)
- AWS 인프라 다이어그램

**상세 가이드**: [Phase 3 - AWS 인프라 구축](./phase-03-aws-infra.md)

---

### Phase 4: GPU 오토스케일링 (2-3일)
Karpenter를 사용한 GPU 노드 동적 프로비저닝을 구현합니다.

**핵심 작업**:
- Karpenter 설치 및 설정
- GPU NodePool 구성 (Spot 인스턴스)
- AI Worker Pod 배포
- Spot Interruption Handler 설정
- HPA (Horizontal Pod Autoscaler) 설정

**산출물**:
- Karpenter NodePool YAML
- Worker Deployment YAML
- 오토스케일링 테스트 결과

**상세 가이드**: [Phase 4 - GPU 오토스케일링](./phase-04-gpu-autoscaling.md)

---

### Phase 5: GitOps/CI/CD 파이프라인 (2-3일)
ArgoCD 기반 GitOps 및 GitHub Actions CI/CD 파이프라인을 구축합니다.

**핵심 작업**:
- ArgoCD 설치
- ApplicationSet 설정 (모든 마이크로서비스)
- GitHub Actions Workflow 작성 (빌드/테스트/배포)
- Kustomize Overlay (dev/prod 환경 분리)
- Slack 알림 설정

**산출물**:
- ArgoCD Application YAML
- GitHub Actions Workflows
- Kustomize Overlays

**상세 가이드**: [Phase 5 - GitOps/CI/CD 파이프라인](./phase-05-gitops-cicd.md)

---

### Phase 6: 보안 및 모니터링 (2-3일)
보안 강화 및 운영 모니터링 시스템을 구축합니다.

**핵심 작업**:
- AWS WAF 설정
- Row-Level Security (RLS) 적용
- AWS Secrets Manager 연동
- Prometheus + Grafana 구축
- CloudWatch 알람 설정
- 로그 집계 (ELK 또는 CloudWatch Logs Insights)

**산출물**:
- WAF 규칙
- Grafana 대시보드
- CloudWatch 알람

**상세 가이드**: [Phase 6 - 보안 및 모니터링](./phase-06-security-monitoring.md)

---

## 🛠️ 사전 요구사항

### 필수 도구
- **Docker Desktop** (20.10+)
- **kubectl** (1.28+)
- **Terraform** (1.6+)
- **Helm** (3.12+)
- **AWS CLI** (2.15+)
- **Node.js** (18+) + pnpm
- **Python** (3.11+) + uv

### 필수 계정
- **AWS 계정** (루트 계정 X, IAM 사용자)
- **GitHub 계정**
- **Lemon Squeezy 계정**
- **Google Cloud Console** (OAuth용)
- **Discord Developer Portal** (OAuth용)

### 권장 IDE
- **VS Code** + Extensions:
  - Python
  - Docker
  - Kubernetes
  - Terraform
  - YAML

---

## 📊 예상 일정 및 난이도

| Phase | 예상 소요 시간 | 난이도 | 필수 여부 |
|-------|--------------|--------|----------|
| Phase 1 | 1-2일 | ⭐ 쉬움 | 필수 |
| Phase 2 | 1-2주 | ⭐⭐⭐ 중간 | 필수 |
| Phase 3 | 3-5일 | ⭐⭐⭐⭐ 어려움 | 필수 |
| Phase 4 | 2-3일 | ⭐⭐⭐⭐ 어려움 | 필수 |
| Phase 5 | 2-3일 | ⭐⭐⭐ 중간 | 필수 |
| Phase 6 | 2-3일 | ⭐⭐⭐ 중간 | 권장 |

**총 예상 기간**: **3-4주** (풀타임 작업 기준)

---

## 💡 학습 팁

### 1. 순서대로 진행
Phase 1 → 6까지 순서대로 진행하세요. 각 Phase는 이전 Phase를 기반으로 합니다.

### 2. 코드 복붙 전 이해
모든 코드와 설정에는 주석이 포함되어 있습니다. 복붙하기 전에 먼저 읽고 이해하세요.

### 3. 문제 해결
- 각 Phase의 "자주 발생하는 오류" 섹션을 참고하세요
- GitHub Issues에 질문을 올려주세요
- AWS/Kubernetes 공식 문서를 참고하세요

### 4. 테스트
각 Phase마다 테스트 섹션이 있습니다. 반드시 테스트 후 다음 Phase로 진행하세요.

---

## 📚 참고 자료

### 공식 문서
- [InvokeAI 공식 문서](https://invoke-ai.github.io/InvokeAI/)
- [FastAPI 공식 문서](https://fastapi.tiangolo.com/)
- [AWS EKS 문서](https://docs.aws.amazon.com/eks/)
- [Karpenter 문서](https://karpenter.sh/)
- [ArgoCD 문서](https://argo-cd.readthedocs.io/)

### 아키텍처 설계 문서
- [01. 전체 아키텍처 개요](../01-architecture-overview.md)
- [02. 마이크로서비스 설계](../02-microservices-design.md)
- [03. 데이터베이스 스키마](../03-database-schema.md)
- [04. 구독 등급별 차별화](../04-tier-based-qos.md)
- [05. 결제 연동](../05-payment-integration.md)
- [06. 크레딧 엔진](../06-credit-metering.md)
- [07. EKS + Karpenter](../07-eks-karpenter.md)
- [08. 우선순위 큐](../08-priority-queue.md)
- [09. 스토리지 전략](../09-storage-strategy.md)
- [10. 보안 아키텍처](../10-security-architecture.md)
- [11. GitOps/DevOps](../11-gitops-devops.md)

---

## 🚀 시작하기

준비가 되었다면 Phase 1부터 시작하세요!

**👉 [Phase 1 - 로컬 개발 환경 구축 시작하기](./phase-01-local-setup.md)**

---

## 💬 피드백 및 기여

이 가이드에 대한 피드백이나 개선 제안이 있다면:
- GitHub Issues에 등록해 주세요
- Pull Request를 보내주세요

Happy Coding! 🎨✨
