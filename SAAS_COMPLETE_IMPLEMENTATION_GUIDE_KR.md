# PingvasAI SaaS 완전 구현 가이드

> InvokeAI 기반 크레딧 방식 AI 이미지 생성 SaaS 플랫폼 종합 가이드

## 📚 목차

1. [프로젝트 개요](#프로젝트-개요)
2. [시스템 아키텍처](#시스템-아키텍처)
3. [구현 로드맵 (Phase 0-11)](#구현-로드맵-phase-0-11)
4. [기술 스택](#기술-스택)
5. [빠른 시작 가이드](#빠른-시작-가이드)
6. [배포 체크리스트](#배포-체크리스트)
7. [비용 예측](#비용-예측)
8. [주요 의사결정](#주요-의사결정)
9. [FAQ](#faq)
10. [다음 단계](#다음-단계)

---

## 프로젝트 개요

### 비전
InvokeAI를 기반으로 한 **크레딧 방식의 AI 이미지 생성 SaaS 플랫폼**을 구축하여, 사용자에게 유연하고 투명한 가격 정책과 고품질 이미지 생성 서비스를 제공합니다.

### 핵심 가치 제안
- **크레딧 기반 과금**: GPU 시간 기준 (1초 = 1크레딧)으로 투명하고 공정한 가격
- **다양한 구독 플랜**: Free → Starter ($25) → Pro ($75) → Studio ($150) → Enterprise (맞춤)
- **플랜별 우선순위**: Enterprise 사용자는 최고 우선순위로 작업 처리
- **무제한 Enterprise**: Enterprise 플랜은 크레딧 제한 없음
- **멀티 테넌트**: 완전한 데이터 격리 및 보안

### 타겟 사용자
- **개인 크리에이터**: Starter/Pro 플랜
- **프로 디자이너/에이전시**: Studio 플랜
- **기업 고객**: Enterprise 플랜 (API 우선 접근, 전담 지원)

### 주요 기능
1. ✅ **이미지 생성**: FLUX, Stable Diffusion 등 최신 모델
2. ✅ **사용자 대시보드**: 파일 관리, 폴더, 태그, 검색, 공유
3. ✅ **Admin 대시보드**: 사용자/모델 관리, 통계, 감사 로그
4. ✅ **크레딧 시스템**: 구매, 사용, 환불, 월간 리셋
5. ✅ **이메일 알림**: 가입, 크레딧 부족, 구독 변경
6. ✅ **우선순위 큐**: 플랜별 5단계 우선순위
7. ✅ **Auto Scaling**: Spot 인스턴스 기반 비용 최적화
8. ✅ **모니터링**: Prometheus, Grafana, Loki, Jaeger
9. ✅ **CI/CD**: GitHub Actions + ArgoCD GitOps

---

## 시스템 아키텍처

### 전체 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────────┐
│                         사용자 레이어                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Web Frontend │  │ Mobile App   │  │  API Client  │          │
│  │  (React)     │  │ (React Native│  │  (Python SDK)│          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼──────────────────┼──────────────────┼──────────────────┘
          │                  │                  │
          └──────────────────┴──────────────────┘
                             │
                    ┌────────▼────────┐
                    │   CloudFront    │ (CDN)
                    │   + WAF         │
                    └────────┬────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                      Application Layer                            │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  ALB (Application Load Balancer)                            │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
│                         │                                         │
│  ┌──────────────────────▼──────────────────────────────────────┐ │
│  │  FastAPI (EKS on Fargate)                                   │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐            │ │
│  │  │ API Pod 1  │  │ API Pod 2  │  │ API Pod N  │            │ │
│  │  └────────────┘  └────────────┘  └────────────┘            │ │
│  │  Auto Scaling (3-20 pods, HPA)                              │ │
│  └─────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data & Cache Layer                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ PostgreSQL   │  │ Redis Cluster│  │ S3 + CloudFront         │
│  │ (RDS Aurora) │  │ (ElastiCache)│  │ (Image Storage)│          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Queue & Worker Layer                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Redis (Message Broker) - Celery Queues                     │ │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐  │ │
│  │  │Enterprise │ │  Studio   │ │    Pro    │ │   Starter │  │ │
│  │  │ Priority 10│ │Priority 8│ │Priority 6│ │ Priority 4│  │ │
│  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                         │                                         │
│  ┌──────────────────────▼──────────────────────────────────────┐ │
│  │  GPU Workers (Auto Scaling Group - EC2 Spot)                │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐            │ │
│  │  │ g5.xlarge  │  │ g5.xlarge  │  │ g5.2xlarge │            │ │
│  │  │ (1 GPU)    │  │ (1 GPU)    │  │ (1 GPU)    │            │ │
│  │  └────────────┘  └────────────┘  └────────────┘            │ │
│  │  Min: 0, Max: 10, Spot Instance (70% 비용 절감)             │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Monitoring & Observability                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Prometheus   │  │   Grafana    │  │     Loki     │          │
│  │ (Metrics)    │  │ (Visualization│  │    (Logs)    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐                            │
│  │   Jaeger     │  │ Alertmanager │                            │
│  │  (Tracing)   │  │  (Alerts)    │                            │
│  └──────────────┘  └──────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    External Services                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Lemon Squeezy│  │ Amazon SES   │  │   Stripe     │          │
│  │ (Payment)    │  │  (Email)     │  │  (Backup)    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐                            │
│  │OAuth Providers│ │Elasticsearch │                            │
│  │(Google/Discord│ │  (Search)    │                            │
│  └──────────────┘  └──────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

### 데이터 흐름

#### 1. 이미지 생성 요청 흐름
```
1. 사용자 → FastAPI: POST /api/v1/generate
2. FastAPI: 인증/권한 확인, 크레딧 잔액 확인
3. FastAPI → Redis: Celery 작업 제출 (플랜별 큐)
4. FastAPI → 사용자: 202 Accepted + job_id 반환
5. GPU Worker ← Redis: 작업 가져오기 (우선순위 순)
6. GPU Worker: InvokeAI로 이미지 생성
7. GPU Worker → S3: 이미지 업로드
8. GPU Worker → PostgreSQL: 작업 완료, 크레딧 차감
9. 사용자 → FastAPI: GET /api/v1/jobs/{job_id} (폴링)
10. FastAPI → 사용자: 이미지 URL 반환
```

#### 2. 결제 흐름
```
1. 사용자 → Frontend: 구독 플랜 선택
2. Frontend → Lemon Squeezy: Checkout 페이지 리다이렉트
3. Lemon Squeezy: 결제 처리
4. Lemon Squeezy → FastAPI: Webhook 전송
5. FastAPI: Webhook 서명 검증
6. FastAPI → PostgreSQL: 구독 정보 업데이트, 크레딧 추가
7. FastAPI → SES: 구독 확인 이메일 발송
```

---

## 구현 로드맵 (Phase 0-11)

### Phase 0: 인프라 기초 설정 ⏱️ 1주
**목표**: AWS 인프라 기본 구성

**주요 작업**:
- ✅ AWS 계정 설정, IAM 사용자 생성
- ✅ VPC, Subnet, Security Group 구성
- ✅ RDS Aurora PostgreSQL 15 생성
- ✅ ElastiCache Redis 7 생성
- ✅ S3 버킷 생성 (이미지 저장)
- ✅ CloudFront CDN 설정

**산출물**:
- Terraform 코드
- 인프라 다이어그램

**참고 문서**: (기존 Phase 0 문서)

---

### Phase 1: Kubernetes 클러스터 구축 ⏱️ 1주
**목표**: EKS 클러스터 및 기본 설정

**주요 작업**:
- ✅ EKS 1.28 클러스터 생성
- ✅ Fargate 프로필 설정 (API용)
- ✅ Node Group 설정 (Worker용)
- ✅ ALB Ingress Controller 설치
- ✅ AWS Load Balancer Controller
- ✅ External DNS 설정

**산출물**:
- EKS 클러스터
- kubectl 설정 가이드

**참고 문서**: `SAAS_KUBERNETES_GUIDE_KR.md`

---

### Phase 2: 기본 애플리케이션 구조 ⏱️ 1주
**목표**: FastAPI 프로젝트 뼈대 구성

**주요 작업**:
- ✅ FastAPI 프로젝트 초기화
- ✅ SQLAlchemy ORM 설정
- ✅ Alembic Migration 설정
- ✅ Pydantic 모델 정의
- ✅ 기본 CRUD API
- ✅ 환경 변수 관리 (.env)

**산출물**:
- FastAPI 애플리케이션
- Database 스키마 (초기)

**참고 문서**: `SAAS_FINAL_IMPLEMENTATION_GUIDE_KR.md` (Phase 0-3)

---

### Phase 3: InvokeAI 통합 ⏱️ 2주
**목표**: InvokeAI와 FastAPI 통합

**주요 작업**:
- ✅ InvokeAI 설치 및 설정
- ✅ 모델 다운로드 (FLUX, SD-XL)
- ✅ Python SDK 통합
- ✅ 이미지 생성 API 구현
- ✅ S3 업로드 로직
- ✅ 기본 에러 처리

**산출물**:
- `/api/v1/generate` 엔드포인트
- InvokeAI 통합 가이드

**참고 문서**: (기존 InvokeAI 문서)

---

### Phase 4: 인증 및 Multi-tenancy ⏱️ 1주
**목표**: 사용자 인증 및 데이터 격리

**주요 작업**:
- ✅ OAuth 2.0 (Google, Discord)
- ✅ JWT Access/Refresh Token
- ✅ PostgreSQL Row-Level Security (RLS)
- ✅ 사용자 등록/로그인 API
- ✅ 비밀번호 재설정
- ✅ 이메일 검증

**산출물**:
- 인증 시스템
- RLS 정책

**참고 문서**: `SAAS_PHASE4_AUTHENTICATION_KR.md`

---

### Phase 5: 크레딧 기반 결제 시스템 ⏱️ 2주
**목표**: Lemon Squeezy 통합 및 크레딧 시스템

**주요 작업**:
- ✅ Lemon Squeezy 계정 설정
- ✅ 7개 구독 상품 생성 (Starter/Pro/Studio × Monthly/Yearly + Enterprise)
- ✅ Webhook 처리 (8개 이벤트)
- ✅ 크레딧 시스템 (구매, 사용, 환불, 월간 리셋)
- ✅ 구독 플랜 관리 API
- ✅ 크레딧 사용 추적

**크레딧 규칙**:
- GPU 시간: **1초 = 1크레딧**
- API 호출: **1회 = 20크레딧**
- Enterprise: **무제한**

**구독 플랜**:
| 플랜 | 월간 | 연간 | 월간 크레딧 | 스토리지 | API 한도 |
|------|------|------|-------------|----------|----------|
| Free | $0 | - | 100 | 1GB | - |
| Starter | $25 | $250 (17% 할인) | 2,500 | 10GB | 50/월 |
| Pro | $75 | $750 | 7,500 | 50GB | 500/월 |
| Studio | $150 | $1,500 | 15,000 | 200GB | 2,000/월 |
| Enterprise | 맞춤 | 맞춤 | 무제한 | 무제한 | 무제한 |

**산출물**:
- 결제 시스템
- 크레딧 관리 API

**참고 문서**: `SAAS_PHASE5_PAYMENT_CREDIT_SYSTEM_KR.md`

---

### Phase 6: 사용자 대시보드 ⏱️ 2주
**목표**: 파일 관리 및 사용자 대시보드

**주요 작업**:
- ✅ 폴더 및 태그 시스템
- ✅ S3 + CloudFront 스토리지
- ✅ 파일 CRUD API
- ✅ 공유 기능 (비밀번호, 만료, 조회수 제한)
- ✅ Elasticsearch 검색 (Nori 한국어 분석기)
- ✅ 썸네일 자동 생성 (256px, 512px WEBP)
- ✅ React 프론트엔드 (ImageGrid, SearchBar)

**산출물**:
- 사용자 대시보드 API
- React 컴포넌트

**참고 문서**: `SAAS_PHASE6_USER_DASHBOARD_KR.md`

---

### Phase 7: Admin Dashboard ⏱️ 2주
**목표**: 시스템 관리 대시보드

**주요 작업**:
- ✅ Role-based access control + 2FA (TOTP)
- ✅ 사용자 관리 (플랜 변경, 크레딧 조정, 계정 정지)
- ✅ 모델 관리 (업로드, 활성화, 접근 제어)
- ✅ 시스템 통계 (사용자, 매출, 크레딧, 이미지)
- ✅ 감사 로그 (모든 admin 작업 기록)
- ✅ React Admin UI (Ant Design)

**산출물**:
- Admin API
- Admin 대시보드 UI

**참고 문서**: `SAAS_PHASE7_ADMIN_DASHBOARD_KR.md`

---

### Phase 8: System Mailing ⏱️ 1주
**목표**: 이메일 발송 시스템

**주요 작업**:
- ✅ Amazon SES + SendGrid (백업)
- ✅ MJML 반응형 템플릿
- ✅ 트랜잭션 이메일 (가입, 비밀번호 재설정, 구독 변경, 크레딧 알림)
- ✅ 뉴스레터 (대량 발송)
- ✅ 이메일 추적 (열람률, 클릭률, 반송, 스팸 신고)
- ✅ Celery 비동기 발송

**산출물**:
- 이메일 서비스
- 이메일 템플릿

**참고 문서**: `SAAS_PHASE8_SYSTEM_MAILING_KR.md`

---

### Phase 9: Queue & Worker Optimization ⏱️ 2주
**목표**: 우선순위 큐 및 GPU 워커 최적화

**주요 작업**:
- ✅ 5단계 우선순위 큐 (Enterprise → Free)
- ✅ Celery GPU Worker 설정
- ✅ OOM 방지 (메모리 모니터링, 모델 캐싱, 자동 복구)
- ✅ Auto Scaling (Spot 인스턴스, CloudWatch 메트릭)
- ✅ 작업 타임아웃 및 재시도
- ✅ Dead Letter Queue

**우선순위**:
- Enterprise: Priority 10
- Studio: Priority 8
- Pro: Priority 6
- Starter: Priority 4
- Free: Priority 2

**산출물**:
- 우선순위 큐 시스템
- GPU Auto Scaling

**참고 문서**: `SAAS_PHASE9_QUEUE_WORKER_OPTIMIZATION_KR.md`

---

### Phase 10: Monitoring & Observability ⏱️ 1주
**목표**: 시스템 모니터링 및 관찰성

**주요 작업**:
- ✅ Prometheus (메트릭 수집)
- ✅ Grafana (시각화 대시보드)
- ✅ Loki (로그 수집)
- ✅ Jaeger (분산 추적)
- ✅ Alertmanager (Slack, PagerDuty 알림)
- ✅ SLI/SLO 설정 (99.9% 가용성)
- ✅ 비즈니스 메트릭 (MRR, DAU, MAU)

**산출물**:
- 모니터링 스택
- Grafana 대시보드

**참고 문서**: `SAAS_PHASE10_MONITORING_OBSERVABILITY_KR.md`

---

### Phase 11: CI/CD & Deployment ⏱️ 1주
**목표**: 자동화된 배포 파이프라인

**주요 작업**:
- ✅ GitHub Actions (CI: Lint, Test, Security Scan, Build)
- ✅ Docker 이미지 빌드 및 ECR Push
- ✅ Kubernetes 매니페스트 (Kustomize)
- ✅ ArgoCD GitOps 배포
- ✅ Sealed Secrets (비밀 관리)
- ✅ 배포 전략 (Rolling Update, Blue-Green, Canary)
- ✅ Rollback 및 장애 복구

**산출물**:
- CI/CD 파이프라인
- Kubernetes 매니페스트

**참고 문서**: `SAAS_PHASE11_CICD_DEPLOYMENT_KR.md`

---

## 기술 스택

### Backend
| 카테고리 | 기술 | 버전 | 용도 |
|----------|------|------|------|
| **Framework** | FastAPI | 0.104+ | REST API |
| **Language** | Python | 3.11 | 메인 언어 |
| **ORM** | SQLAlchemy | 2.0+ | Database ORM |
| **Migration** | Alembic | 1.12+ | DB 마이그레이션 |
| **Validation** | Pydantic | 2.0+ | 데이터 검증 |
| **Auth** | PyJWT | 2.8+ | JWT 토큰 |
| **OAuth** | Authlib | 1.2+ | OAuth 2.0 |
| **Task Queue** | Celery | 6.0+ | 비동기 작업 |
| **AI Engine** | InvokeAI | 4.0+ | 이미지 생성 |

### Database & Cache
| 카테고리 | 기술 | 용도 |
|----------|------|------|
| **Primary DB** | PostgreSQL 15 (RDS Aurora) | 메인 데이터베이스 |
| **Cache** | Redis 7 (ElastiCache) | 캐시, Celery 브로커 |
| **Search** | Elasticsearch 8.11 | 전문 검색 |
| **Storage** | Amazon S3 + CloudFront | 이미지 저장 |

### Infrastructure
| 카테고리 | 기술 | 용도 |
|----------|------|------|
| **Container** | Docker | 컨테이너화 |
| **Orchestration** | Kubernetes (EKS 1.28) | 오케스트레이션 |
| **Compute (API)** | EKS Fargate | API 서버 |
| **Compute (Worker)** | EC2 Spot (g5.xlarge) | GPU 워커 |
| **Load Balancer** | AWS ALB | 로드 밸런싱 |
| **CDN** | CloudFront | CDN |
| **IaC** | Terraform | 인프라 코드 |

### Frontend
| 카테고리 | 기술 | 버전 | 용도 |
|----------|------|------|------|
| **Framework** | React | 18+ | UI 프레임워크 |
| **Language** | TypeScript | 5.0+ | 타입 안정성 |
| **State** | Redux Toolkit | 2.0+ | 상태 관리 |
| **Styling** | TailwindCSS | 3.3+ | CSS 프레임워크 |
| **UI Components** | Ant Design | 5.0+ | Admin UI |
| **Charts** | Recharts | 2.8+ | 차트 |

### CI/CD & Monitoring
| 카테고리 | 기술 | 용도 |
|----------|------|------|
| **CI/CD** | GitHub Actions | CI 파이프라인 |
| **GitOps** | ArgoCD | CD 파이프라인 |
| **Container Registry** | Amazon ECR | 이미지 저장소 |
| **Metrics** | Prometheus | 메트릭 수집 |
| **Visualization** | Grafana | 대시보드 |
| **Logs** | Loki + Promtail | 로그 수집 |
| **Tracing** | Jaeger | 분산 추적 |
| **Alerts** | Alertmanager | 알림 |

### External Services
| 카테고리 | 서비스 | 용도 |
|----------|--------|------|
| **Payment** | Lemon Squeezy | 구독 결제 |
| **Email** | Amazon SES + SendGrid | 이메일 발송 |
| **OAuth** | Google, Discord | 소셜 로그인 |
| **Secrets** | AWS Secrets Manager | 비밀 관리 |
| **DNS** | Route 53 | DNS 관리 |
| **Certificate** | ACM | SSL 인증서 |
| **WAF** | AWS WAF | 보안 |

---

## 빠른 시작 가이드

### 사전 요구사항

```bash
# 필수 도구
- Docker 24.0+
- kubectl 1.28+
- Python 3.11+
- Node.js 20+
- Terraform 1.5+
- AWS CLI 2.0+
```

### 로컬 개발 환경 설정

#### 1. 리포지토리 클론
```bash
git clone https://github.com/pingvasai/api.git
cd api
```

#### 2. 환경 변수 설정
```bash
# .env 파일 생성
cp .env.example .env

# 필수 환경 변수 설정
# - DATABASE_URL
# - REDIS_URL
# - AWS_ACCESS_KEY_ID
# - AWS_SECRET_ACCESS_KEY
# - JWT_SECRET_KEY
# - LEMON_SQUEEZY_API_KEY
```

#### 3. Docker Compose로 로컬 실행
```bash
# 서비스 시작
docker-compose up -d

# 데이터베이스 마이그레이션
docker-compose exec api alembic upgrade head

# 로그 확인
docker-compose logs -f api
```

#### 4. API 테스트
```bash
# Health Check
curl http://localhost:8000/health

# API 문서
open http://localhost:8000/docs
```

### Production 배포

#### 1. AWS 인프라 생성 (Terraform)
```bash
cd terraform/

# 초기화
terraform init

# 계획 확인
terraform plan

# 적용
terraform apply
```

#### 2. Kubernetes 클러스터 설정
```bash
# EKS 클러스터 접속 설정
aws eks update-kubeconfig --name pingvasai-production --region us-east-1

# 클러스터 확인
kubectl get nodes
```

#### 3. ArgoCD 설치
```bash
# ArgoCD 설치
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# ArgoCD Application 생성
kubectl apply -f argocd/application.yaml
```

#### 4. 배포 확인
```bash
# ArgoCD UI 접속
kubectl port-forward svc/argocd-server -n argocd 8080:443

# 배포 상태 확인
argocd app get pingvasai-production

# API 접속
curl https://api.pingvasai.com/health
```

---

## 배포 체크리스트

### Pre-Launch 체크리스트

#### 인프라
- [ ] AWS 계정 설정 완료
- [ ] VPC 및 서브넷 구성 완료
- [ ] RDS Aurora PostgreSQL 생성
- [ ] ElastiCache Redis 생성
- [ ] S3 버킷 생성 및 CloudFront 설정
- [ ] EKS 클러스터 생성
- [ ] GPU 워커 Auto Scaling Group 설정
- [ ] Route 53 도메인 설정
- [ ] ACM SSL 인증서 발급

#### 애플리케이션
- [ ] 데이터베이스 마이그레이션 완료
- [ ] 환경 변수 설정 (Sealed Secrets)
- [ ] OAuth 앱 등록 (Google, Discord)
- [ ] Lemon Squeezy 제품 생성
- [ ] Amazon SES 도메인 인증
- [ ] Elasticsearch 인덱스 생성
- [ ] InvokeAI 모델 다운로드

#### 보안
- [ ] JWT Secret 생성 및 저장
- [ ] API Rate Limiting 설정
- [ ] CORS 설정 확인
- [ ] WAF 규칙 설정
- [ ] 2FA 활성화 (Admin)
- [ ] IP 화이트리스트 설정
- [ ] Security Scan 통과

#### 모니터링
- [ ] Prometheus 설정
- [ ] Grafana 대시보드 생성
- [ ] Loki 로그 수집 확인
- [ ] Alertmanager Slack 연동
- [ ] SLO 설정
- [ ] Uptime 모니터링 (UptimeRobot 등)

#### 테스트
- [ ] Unit Tests 통과 (80% 커버리지)
- [ ] Integration Tests 통과
- [ ] E2E Tests 통과
- [ ] Load Test 완료 (k6)
- [ ] Smoke Test 완료

#### 문서
- [ ] API 문서 (Swagger/OpenAPI)
- [ ] 운영 문서 (Runbook)
- [ ] 장애 복구 절차
- [ ] 사용자 가이드
- [ ] 개인정보 처리방침
- [ ] 이용약관

### Launch Day 체크리스트

- [ ] DNS 레코드 업데이트
- [ ] 트래픽 모니터링 시작
- [ ] 실시간 에러 모니터링
- [ ] 고객 지원 준비
- [ ] 백업 확인
- [ ] Rollback 준비

### Post-Launch 체크리스트

- [ ] 첫 24시간 모니터링
- [ ] 성능 메트릭 분석
- [ ] 사용자 피드백 수집
- [ ] 버그 수정 우선순위 결정
- [ ] 비용 분석
- [ ] Capacity Planning

---

## 비용 예측

### 월간 예상 비용 (사용자 1,000명 기준)

| 서비스 | 사양 | 월간 비용 (USD) | 비고 |
|--------|------|-----------------|------|
| **EKS Cluster** | 1개 | $72 | 클러스터 관리 비용 |
| **Fargate (API)** | 5 pods × 0.5vCPU × 1GB | $150 | 24시간 실행 |
| **EC2 Spot (GPU)** | g5.xlarge × 평균 2대 | $400 | Spot 70% 할인 적용 |
| **RDS Aurora PostgreSQL** | db.r6g.large | $200 | HA 구성 |
| **ElastiCache Redis** | cache.r6g.large | $150 | HA 구성 |
| **S3 + CloudFront** | 10TB 저장 + 100TB 전송 | $300 | 이미지 저장 |
| **Load Balancer** | ALB 1개 | $25 | - |
| **Data Transfer** | 출력 100GB | $9 | - |
| **Elasticsearch** | t3.medium 3노드 | $150 | 검색 엔진 |
| **Lemon Squeezy** | 5% 수수료 | 변동 | 결제 처리 |
| **Amazon SES** | 100K 이메일 | $10 | 이메일 발송 |
| **Route 53** | 1 Hosted Zone | $0.50 | DNS |
| **ACM** | SSL 인증서 | $0 | 무료 |
| **CloudWatch** | 로그 + 메트릭 | $50 | 모니터링 |
| **Backup** | S3 + RDS Snapshot | $30 | 백업 |
| **예비** | - | $100 | 버퍼 |
| **총계** | - | **~$1,650/월** | **$19,800/년** |

### 비용 최적화 전략

1. **Spot 인스턴스 사용**: GPU 워커 70% 비용 절감
2. **Auto Scaling**: 유휴 시 워커 0대로 축소
3. **S3 Lifecycle**: 30일 후 Glacier로 이동
4. **CloudFront**: 캐시 히트율 향상
5. **Reserved Instances**: RDS, ElastiCache RI 구매 (1년 약정 시 40% 절감)

### 손익분기점 (BEP)

```
고정 비용: $1,650/월
평균 구독료: $50/월 (Starter + Pro 평균)
손익분기점: 1,650 / 50 = 33명

→ 유료 사용자 33명 이상부터 수익 발생
```

---

## 주요 의사결정

### 1. 왜 크레딧 방식인가?

**이유**:
- **투명성**: 사용자는 정확히 얼마나 사용했는지 알 수 있음
- **유연성**: 사용량에 따라 비용 조정 가능
- **공정성**: GPU 시간 기준으로 공평한 과금
- **예측 가능성**: 월간 크레딧 한도로 예산 관리 용이

**대안 고려**:
- 이미지 수 기준 과금 → 생성 시간이 다르므로 불공평
- 무제한 플랜 → 남용 가능성, 비용 예측 어려움

### 2. 왜 Lemon Squeezy인가?

**이유**:
- **간편한 통합**: Stripe보다 설정 간단
- **세금 자동 처리**: Merchant of Record (MoR)
- **글로벌 결제**: 135개 통화 지원
- **낮은 수수료**: 5% (Stripe 2.9% + $0.30 대비 소규모 거래에 유리)

**단점**:
- Stripe보다 기능 제한적
- 한국 결제 수단 제한적 (Stripe 백업 권장)

### 3. 왜 PostgreSQL Row-Level Security (RLS)인가?

**이유**:
- **데이터베이스 레벨 보안**: 애플리케이션 버그에도 데이터 유출 방지
- **멀티 테넌트**: 완전한 데이터 격리
- **성능**: WHERE 절 자동 추가로 추가 오버헤드 최소

**대안 고려**:
- 애플리케이션 레벨 필터링 → 버그 시 데이터 유출 위험
- 테넌트별 DB 분리 → 관리 복잡도 증가, 비용 증가

### 4. 왜 Spot 인스턴스인가?

**이유**:
- **70% 비용 절감**: On-Demand 대비 엄청난 절감
- **GPU 워커에 적합**: Stateless 작업이므로 중단 가능
- **Auto Scaling**: 작업 없으면 0대로 축소

**위험 관리**:
- Spot 중단 시 자동 재시도 (Celery)
- 다양한 인스턴스 타입 Fallback (g5.xlarge → g5.2xlarge)
- On-Demand 혼합 (Critical 작업용)

### 5. 왜 ArgoCD GitOps인가?

**이유**:
- **선언적 배포**: Git이 Single Source of Truth
- **자동 Sync**: Git 커밋 시 자동 배포
- **Rollback 용이**: Git Revert로 즉시 롤백
- **감사 추적**: 모든 배포 이력 Git에 기록

**대안 고려**:
- Flux CD → ArgoCD가 UI와 커뮤니티 더 성숙
- Jenkins → 레거시, 무거움
- GitHub Actions만 사용 → GitOps 철학과 맞지 않음

---

## FAQ

### Q1. Free 플랜 사용자가 남용하면 어떻게 하나요?

**답변**:
- Free 플랜은 월 100 크레딧으로 제한 (약 100초 GPU 시간)
- 이미지 생성 평균 5초 기준 약 20장
- IP당 Rate Limiting (시간당 10회)
- reCAPTCHA로 봇 방지
- 남용 감지 시 계정 정지

### Q2. Enterprise 무제한 크레딧이 남용되면?

**답변**:
- Enterprise는 계약 기반 (Fair Use Policy)
- 비정상적 사용 패턴 모니터링
- 계약 시 예상 사용량 협의
- 초과 사용 시 추가 청구 조항

### Q3. GPU 워커가 부족하면?

**답변**:
- Auto Scaling으로 자동 증설 (최대 10대)
- CloudWatch Alarm으로 큐 길이 모니터링
- 10대 초과 시 Admin 알림
- 수동으로 Max 증가 또는 더 큰 인스턴스 타입 추가

### Q4. 데이터베이스 장애 시 복구 방법은?

**답변**:
- RDS Aurora 자동 Failover (Multi-AZ)
- 5분 간격 자동 백업
- Point-in-Time Recovery 지원
- 최대 RPO: 5분, RTO: 1분

### Q5. 크레딧 리셋은 언제 되나요?

**답변**:
- 매월 구독 갱신일에 자동 리셋
- Celery Beat 스케줄러가 매일 체크
- 사용한 크레딧은 `credits_used_this_month`로 추적
- 구매한 크레딧은 영구 보관

### Q6. GDPR 준수는?

**답변**:
- 사용자 데이터 삭제 API 제공
- S3, Elasticsearch 포함 완전 삭제
- 개인정보 처리방침 명시
- 데이터 수출 기능 (JSON)
- EU 리전 지원 (향후)

### Q7. 한국어 지원은?

**답변**:
- Elasticsearch Nori 분석기로 한국어 검색
- i18n 적용 (React-i18next)
- 한국어 이메일 템플릿
- 한국 결제 수단 (향후 Stripe 추가)

---

## 다음 단계

### Phase 12: 성능 최적화 (계획)
- Database 쿼리 최적화 (EXPLAIN ANALYZE)
- Redis 캐싱 전략 개선
- CDN 캐시 히트율 향상
- API Response Time 개선 (p95 < 200ms)

### Phase 13: 고급 기능 (계획)
- **LoRA 모델 지원**: 사용자 커스텀 모델 업로드
- **Img2Img**: 이미지 기반 생성
- **Inpainting/Outpainting**: 이미지 편집
- **Video Generation**: 비디오 생성 (Stable Video Diffusion)
- **API SDK**: Python, JavaScript SDK
- **Webhook**: 작업 완료 시 사용자 서버로 알림

### Phase 14: 모바일 앱 (계획)
- React Native 앱 개발
- iOS / Android 배포
- 푸시 알림

### Phase 15: 글로벌 확장 (계획)
- 다국어 지원 (영어, 일본어, 중국어)
- 리전별 배포 (EU, APAC)
- 현지 결제 수단 추가

### Phase 16: AI 기능 강화 (계획)
- **Prompt 자동 완성**: GPT-4 기반 프롬프트 개선
- **스타일 전이**: 특정 스타일 학습 및 적용
- **배치 생성**: 한 번에 여러 이미지 생성
- **고급 편집**: AI 기반 배경 제거, 색상 보정

---

## 문서 구조

```
docs/
├── SAAS_COMPLETE_IMPLEMENTATION_GUIDE_KR.md  ← 이 문서 (통합 가이드)
├── SAAS_ARCHITECTURE_V2_KR.md                 (아키텍처 개요)
├── SAAS_README_KR.md                          (프로젝트 소개)
├── SAAS_KUBERNETES_GUIDE_KR.md                (Kubernetes 가이드)
├── SAAS_QUEUE_WORKER_OPTIMIZATION_KR.md       (Queue 최적화)
│
├── Phase별 상세 가이드/
│   ├── SAAS_FINAL_IMPLEMENTATION_GUIDE_KR.md  (Phase 0-3)
│   ├── SAAS_PHASE4_AUTHENTICATION_KR.md       (Phase 4)
│   ├── SAAS_PHASE5_PAYMENT_CREDIT_SYSTEM_KR.md (Phase 5)
│   ├── SAAS_PHASE6_USER_DASHBOARD_KR.md       (Phase 6)
│   ├── SAAS_PHASE7_ADMIN_DASHBOARD_KR.md      (Phase 7)
│   ├── SAAS_PHASE8_SYSTEM_MAILING_KR.md       (Phase 8)
│   ├── SAAS_PHASE9_QUEUE_WORKER_OPTIMIZATION_KR.md (Phase 9)
│   ├── SAAS_PHASE10_MONITORING_OBSERVABILITY_KR.md (Phase 10)
│   └── SAAS_PHASE11_CICD_DEPLOYMENT_KR.md     (Phase 11)
```

---

## 기여 가이드

### 코드 기여
1. Fork 저장소
2. Feature 브랜치 생성 (`git checkout -b feature/amazing-feature`)
3. 변경사항 커밋 (`git commit -m 'Add amazing feature'`)
4. 브랜치에 Push (`git push origin feature/amazing-feature`)
5. Pull Request 생성

### 코드 스타일
- Python: Black + Flake8 + mypy
- TypeScript: ESLint + Prettier
- Commit: Conventional Commits

### 테스트 필수
- Unit Test 커버리지 80% 이상
- Integration Test 통과
- Lint 오류 없음

---

## 라이선스

MIT License

---

## 연락처

- **Email**: support@pingvasai.com
- **Discord**: https://discord.gg/pingvasai
- **GitHub**: https://github.com/pingvasai/api

---

## 감사의 말

- **InvokeAI 팀**: 훌륭한 AI 이미지 생성 엔진
- **FastAPI 커뮤니티**: 현대적인 Python 웹 프레임워크
- **Kubernetes 커뮤니티**: 강력한 오케스트레이션 플랫폼
- **모든 오픈소스 기여자**: 이 프로젝트를 가능하게 한 모든 분들께 감사드립니다

---

**Last Updated**: 2025-01-19
**Version**: 1.0.0
**Status**: Production Ready ✅
