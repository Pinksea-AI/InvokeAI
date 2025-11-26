# Pingvas Studio - InvokeAI SaaS 전환 프로젝트 종합 가이드

## 프로젝트 개요

### 목표
InvokeAI 오픈소스를 기반으로 멀티테넌트 SaaS 플랫폼 "Pingvas Studio"를 구축합니다.
- 구독 기반 결제 시스템 (Lemon Squeezy)
- GPU 리소스의 효율적 공유 및 과금
- 티어별 기능 차별화
- 실시간 이미지 생성 진행률 제공

### 기술 스택 요약

| 계층 | 기술 | 용도 |
|------|------|------|
| **Frontend** | React 18 + Vite + TypeScript | SPA 웹 애플리케이션 |
| **상태관리** | Redux Toolkit + RTK Query | 전역 상태 및 API 캐싱 |
| **실시간** | Socket.IO | WebSocket 기반 진행률 업데이트 |
| **API Gateway** | Nginx Ingress | 라우팅, 로드밸런싱, WebSocket 프록시 |
| **Backend Services** | FastAPI + Python 3.12 | 마이크로서비스 API |
| **AI Worker** | InvokeAI + PyTorch | GPU 기반 이미지 생성 |
| **Database** | Aurora PostgreSQL 17.4 | 멀티테넌트 데이터 저장 |
| **Cache/Queue** | ElastiCache Redis | 세션, 캐시, 작업 큐 |
| **Storage** | S3 + EFS | 이미지/모델 저장소 |
| **Container** | EKS + Karpenter | 오케스트레이션 및 오토스케일링 |
| **IaC** | Terraform | 인프라 코드화 |
| **GitOps** | ArgoCD | 자동 배포 |
| **모니터링** | CloudWatch + Prometheus | 메트릭 수집 |

---

## 구독 상품 정책

### 요금제 구조

| 플랜 | 월 요금 | 크레딧 | 스토리지 | 큐 | 주요 기능 |
|------|---------|--------|----------|-----|----------|
| **Starter** | $25 | 5,000 | 20GB | 1개 | Generate, Canvas, Upscaling, Workflows, SD 모델 |
| **Pro** | $75 | 15,000 | 100GB | 1개 | Starter + Flux 모델, 제3자 API (nano-banana) |
| **Studio** | $150 | 30,000 | 200GB | 3개 | Pro + 멀티큐, LoRA 커스텀 학습 (예정) |
| **Enterprise** | 협의 | 협의 | 협의 | 협의 | Studio + 전용 인프라, SLA |

### 크레딧 정책
- **GPU 사용**: 1초당 1 크레딧 소모
- **외부 API (nano-banana)**: 1회 요청당 20 크레딧 소모
- **연간 결제**: 할인 적용 (별도 협의)

### 기능 제한 매트릭스

| 기능 | Starter | Pro | Studio | Enterprise |
|------|---------|-----|--------|------------|
| Generate | ✅ | ✅ | ✅ | ✅ |
| Canvas | ✅ | ✅ | ✅ | ✅ |
| Upscaling | ✅ | ✅ | ✅ | ✅ |
| Workflows | ✅ | ✅ | ✅ | ✅ |
| SD 1.5/2.0/XL | ✅ | ✅ | ✅ | ✅ |
| Flux 모델 | ❌ | ✅ | ✅ | ✅ |
| nano-banana API | ❌ | ✅ | ✅ | ✅ |
| 멀티 큐 | ❌ | ❌ | 3개 | 무제한 |
| LoRA 학습 | ❌ | ❌ | ✅ (예정) | ✅ |
| 전용 인프라 | ❌ | ❌ | ❌ | ✅ |
| SLA | ❌ | ❌ | ❌ | ✅ |

---

## 문서 구조

```
docs/saas-development/
├── 00-PROJECT-OVERVIEW.md          # 본 문서 (프로젝트 종합 개요)
├── architecture/
│   ├── 01-aws-architecture.md      # AWS 전체 아키텍처
│   ├── 02-microservices.md         # 마이크로서비스 설계
│   ├── 03-data-flow.md             # 데이터 흐름 및 시퀀스
│   └── 04-ia-sitemap.md            # IA 및 Sitemap 설계
├── database/
│   ├── 01-schema-design.md         # DB 스키마 설계
│   └── 02-erd.md                   # ERD 다이어그램
├── api/
│   ├── 01-api-specification.md     # API 명세서
│   └── 02-websocket-events.md      # WebSocket 이벤트 명세
├── infrastructure/
│   ├── 01-terraform-guide.md       # Terraform IaC 가이드
│   ├── 02-eks-setup.md             # EKS 클러스터 설정
│   └── 03-networking.md            # VPC/네트워킹 설정
├── devops/
│   ├── 01-gitops-guide.md          # GitOps 가이드
│   ├── 02-ci-cd-pipeline.md        # CI/CD 파이프라인
│   └── 03-monitoring.md            # 모니터링 설정
├── frontend/
│   ├── 01-storybook-guide.md       # Storybook 도입 가이드
│   └── 02-ui-customization.md      # UI 커스터마이징
├── guides/
│   ├── 01-local-development.md     # 로컬 개발 환경 설정
│   ├── 02-payment-integration.md   # 결제 시스템 연동
│   └── 03-hands-on-tutorial.md     # 신입개발자 핸즈온 가이드
└── diagrams/
    ├── aws-architecture.mmd        # Mermaid 다이어그램
    ├── aws-architecture.drawio     # Draw.io 다이어그램
    └── aws-architecture.svg        # SVG 다이어그램
```

---

## 개발 환경

### 로컬 개발 머신
- **장비**: MacBook Pro M2 Max 96GB
- **OS**: macOS
- **Python**: 3.12
- **Node.js**: 22 LTS
- **Docker Desktop**: 최신 버전

### 클라우드 환경
- **클라우드**: AWS (MSP 계약)
- **접근 방식**: IAM Assume Role + OpenVPN
- **개발자 수**: 현재 2명 (확장 예정)

### 환경 분리 전략

| 환경 | 네임스페이스 | 특징 |
|------|-------------|------|
| **개발 (Dev)** | `pingvas-dev` | 개발/테스트용 |
| **운영 (Prod)** | `pingvas-prod` | 실제 서비스 |

**공유 리소스**:
- Aurora PostgreSQL (스키마로 분리)
- EFS (디렉토리로 분리)

**분리 리소스**:
- Redis: Dev는 Standalone, Prod는 Sentinel

---

## 핵심 설계 원칙

### 1. 비용 최적화
- Karpenter로 GPU 노드 Scale-to-Zero
- Spot 인스턴스 100% 활용 (AI 워커)
- Graviton (ARM64) 인스턴스 활용 (일반 워크로드)

### 2. 성능 보장
- EFS에 모델 Warm Cache 유지
- CloudFront CDN으로 이미지 배포
- 티어별 큐 우선순위 적용

### 3. 보안 강화
- OpenVPN으로 제한된 IP만 접근
- IAM Assume Role 기반 권한 관리
- WAF로 디도스/악성 요청 방어
- Secrets Manager로 민감 정보 관리

### 4. 운영 효율성
- GitOps (ArgoCD)로 선언적 배포
- Terraform으로 인프라 코드화
- 중앙 집중식 로깅/모니터링

---

## 빠른 시작

### 1단계: 로컬 개발 환경 설정
→ `guides/01-local-development.md` 참조

### 2단계: AWS 인프라 구축
→ `infrastructure/01-terraform-guide.md` 참조

### 3단계: 마이크로서비스 배포
→ `devops/01-gitops-guide.md` 참조

### 4단계: 결제 시스템 연동
→ `guides/02-payment-integration.md` 참조

### 5단계: 프론트엔드 커스터마이징
→ `frontend/01-storybook-guide.md` 참조

---

## 담당 및 연락처

| 역할 | 담당 | 비고 |
|------|------|------|
| 프로젝트 총괄 | - | - |
| 백엔드 개발 | - | FastAPI, AI Worker |
| 프론트엔드 개발 | - | React, UI 커스터마이징 |
| 인프라/DevOps | - | Terraform, EKS |

---

## 버전 이력

| 버전 | 날짜 | 변경 내용 |
|------|------|----------|
| 1.0.0 | 2025-11-25 | 최초 작성 |

---

## 다음 단계

1. [AWS 전체 아키텍처](./architecture/01-aws-architecture.md)를 확인합니다.
2. [로컬 개발 환경](./guides/01-local-development.md)을 설정합니다.
3. [신입개발자 핸즈온 가이드](./guides/03-hands-on-tutorial.md)를 따라 시작합니다.
