# PingvasAI SaaS 아키텍처 V2 (크레딧 기반)

> 크레딧 기반 구독 시스템 + 멀티테넌시 + AI 모델 접근 제어

**작성일**: 2025-11-18
**버전**: 2.0 (크레딧 시스템)

---

## 📋 목차

1. [개요](#1-개요)
2. [구독 플랜 체계](#2-구독-플랜-체계)
3. [크레딧 시스템](#3-크레딧-시스템)
4. [주요 기능](#4-주요-기능)
5. [기술 스택](#5-기술-스택)
6. [아키텍처 다이어그램](#6-아키텍처-다이어그램)
7. [구현 Phase 계획](#7-구현-phase-계획)

---

## 1. 개요

### 1.1 핵심 변경사항

기존 **이미지 개수 기반** → **크레딧 기반** 구독 시스템으로 전환

| 항목 | V1 (기존) | V2 (신규) |
|-----|----------|----------|
| **과금 방식** | 월간 이미지 개수 | GPU 시간 + API 호출 크레딧 |
| **플랜 가격** | Free $0, Pro $19, Studio $49 | Starter $25, Pro $75, Studio $150, Enterprise (Custom) |
| **결제 주기** | 월간만 | 월간 + 연간 (할인) |
| **사용량 측정** | 이미지 생성 횟수 | GPU 초당 1크레딧, API 건당 20크레딧 |
| **모델 접근** | 모든 플랜 동일 | 플랜별 모델 접근 제어 |

### 1.2 주요 목표

✅ **크레딧 기반 과금**: GPU 사용 시간과 API 호출에 따른 유연한 과금
✅ **플랜별 차별화**: 모델 접근 권한, Storage, Queue 우선순위 차등 제공
✅ **사용자 대시보드**: 개인 작업물 관리, 공유 파일, 크레딧 사용 내역
✅ **관리자 기능**: 모델 관리, 사용자 관리, 시스템 모니터링
✅ **이메일 시스템**: 인증, 알림, 뉴스레터, 마케팅
✅ **Queue 최적화**: 다중 사용자 환경에서 OOM 방지 및 우선순위 큐

---

## 2. 구독 플랜 체계

### 2.1 플랜 구성

| 플랜 | 월간 | 연간 (할인) | 월간 크레딧 | Storage | Queue 우선순위 | 제공 기능 |
|------|------|------------|-----------|---------|--------------|---------|
| **Free** | $0 | - | 100 | 1GB | 낮음 | 기본 모델만, API 없음 |
| **Starter** | $25 | $250 (17% 할인) | 2,500 | 10GB | 보통 | 중급 모델, API 제한적 |
| **Pro** | $75 | $750 (17% 할인) | 10,000 | 50GB | 높음 | 고급 모델, API 무제한 |
| **Studio** | $150 | $1,500 (17% 할인) | 25,000 | 200GB | 최우선 | 모든 모델, API 무제한, 커스텀 모델 |
| **Enterprise** | Custom | Custom | Custom | Custom | 전용 | 모든 기능 + 전용 인프라 + SLA |

### 2.2 크레딧 사용 정책

**크레딧 소비:**
- **GPU 이미지 생성**: 1초당 1크레딧
  - 예: SDXL 생성 30초 소요 → 30크레딧 차감
  - 예: Flux Dev 생성 45초 소요 → 45크레딧 차감
- **나노바나나 API 호출**: 건당 20크레딧
  - API를 통한 외부 모델 호출 시

**크레딧 관리:**
- 월간 크레딧은 매월 1일 00:00 UTC에 자동 충전
- 사용하지 않은 크레딧은 **이월 불가** (월말 소멸)
- 크레딧 부족 시 추가 구매 가능 (1,000 크레딧 = $10)
- Enterprise는 무제한 또는 협의된 크레딧 제공

### 2.3 플랜별 기능 제한

| 기능 | Free | Starter | Pro | Studio | Enterprise |
|-----|------|---------|-----|--------|-----------|
| **기본 모델** (SD 1.5, SD 2.1) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **중급 모델** (SDXL) | ❌ | ✅ | ✅ | ✅ | ✅ |
| **고급 모델** (Flux, DALL-E 3) | ❌ | ❌ | ✅ | ✅ | ✅ |
| **커스텀 모델** 업로드 | ❌ | ❌ | ❌ | ✅ | ✅ |
| **나노바나나 API** | ❌ | 제한적 (월 50회) | 무제한 | 무제한 | 무제한 |
| **배치 생성** | 1장씩 | 최대 4장 | 최대 10장 | 최대 20장 | 무제한 |
| **동시 작업** | 1개 | 2개 | 5개 | 10개 | 무제한 |
| **파일 공유** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **우선 지원** | ❌ | 이메일 | 우선 이메일 | 우선 이메일 + 채팅 | 24/7 전담 |

---

## 3. 크레딧 시스템

### 3.1 크레딧 충전 로직

```python
# 구독 시작 시
subscription_created:
  - 사용자 플랜 업데이트 (Free → Starter)
  - 월간 크레딧 즉시 충전 (2,500 크레딧)
  - 다음 갱신일 설정 (구독일 + 1개월)

# 구독 갱신 시 (매월)
subscription_renewed:
  - 월간 크레딧 재충전 (2,500 크레딧)
  - 기존 남은 크레딧 소멸
  - 다음 갱신일 갱신 (현재 갱신일 + 1개월)

# 구독 업그레이드 시 (즉시 반영)
subscription_upgraded:
  - 확인 메시지: "지금 업그레이드하면 남은 기간(X일)과 크레딧이 소멸됩니다. 진행하시겠습니까?"
  - 사용자 플랜 업데이트 (Starter → Pro)
  - 기존 크레딧 소멸
  - 새 플랜 크레딧 즉시 충전 (10,000 크레딧)
  - 갱신일 재설정 (업그레이드일 + 1개월)

# 구독 취소 시 (종료일까지 유지)
subscription_cancelled:
  - 자동 갱신 중단
  - 종료일까지 현재 플랜 유지
  - 종료일 00:00 UTC에 Free 플랜으로 강등
  - 남은 크레딧 회수
```

### 3.2 크레딧 소비 추적

```python
# 이미지 생성 시 크레딧 차감
def consume_credits_for_generation(user_id, generation_time_seconds):
    credits_to_consume = generation_time_seconds * 1  # 1초당 1크레딧

    user = get_user(user_id)

    if user.credits_balance < credits_to_consume:
        raise InsufficientCreditsError("크레딧이 부족합니다")

    user.credits_balance -= credits_to_consume
    user.credits_used_this_month += credits_to_consume

    # 사용 내역 로그
    log_credit_usage(
        user_id=user_id,
        amount=credits_to_consume,
        type="gpu_generation",
        metadata={"duration_seconds": generation_time_seconds}
    )

    db.commit()

# API 호출 시 크레딧 차감
def consume_credits_for_api(user_id):
    credits_to_consume = 20  # API 건당 20크레딧

    user = get_user(user_id)

    if user.credits_balance < credits_to_consume:
        raise InsufficientCreditsError("크레딧이 부족합니다")

    user.credits_balance -= credits_to_consume
    user.credits_used_this_month += credits_to_consume

    log_credit_usage(
        user_id=user_id,
        amount=credits_to_consume,
        type="api_call",
        metadata={"api": "nanobanana"}
    )

    db.commit()
```

### 3.3 크레딧 추가 구매

```python
# 크레딧 패키지
CREDIT_PACKAGES = {
    "small": {"credits": 1000, "price": 10.00},    # $10 = 1,000 크레딧
    "medium": {"credits": 5000, "price": 45.00},   # $45 = 5,000 크레딧 (10% 할인)
    "large": {"credits": 10000, "price": 80.00},   # $80 = 10,000 크레딧 (20% 할인)
}

# 추가 구매 시 즉시 충전 (이월 가능)
def purchase_credits(user_id, package_name):
    package = CREDIT_PACKAGES[package_name]

    # Lemon Squeezy 결제 처리
    checkout_url = create_lemon_squeezy_checkout(
        user_id=user_id,
        product_name=f"Credits - {package['credits']}",
        price=package["price"]
    )

    # 결제 완료 Webhook 수신 시
    def on_payment_success():
        user = get_user(user_id)
        user.credits_balance += package["credits"]
        db.commit()
```

---

## 4. 주요 기능

### 4.1 사용자 대시보드

**개인 작업 공간:**
- 내 프로젝트 목록 (폴더 구조)
- 생성한 이미지 갤러리 (필터: 날짜, 모델, 태그)
- 워크플로우 저장 및 재사용
- 크레딧 사용 내역 (일별/월별 차트)
- Storage 사용량 (GB/총 GB)

**공유 기능:**
- 다른 사용자에게 이미지/워크플로우 공유 (읽기 전용)
- 공유 링크 생성 (공개/비공개, 만료 시간)
- 공유받은 리소스 목록
- 협업 초대 (Pro 이상)

**검색:**
- 프롬프트 텍스트 검색 (Elasticsearch)
- 이미지 메타데이터 필터 (모델, 크기, 생성일)
- 태그 기반 검색
- 시맨틱 검색 (유사 이미지 찾기)

### 4.2 관리자 대시보드

**모델 관리:**
- AI 모델 목록 (활성화/비활성화)
- 플랜별 모델 접근 권한 설정
- 모델 사용 통계 (인기 모델, 사용 빈도)
- 커스텀 모델 승인/거부

**사용자 관리:**
- 사용자 목록 (플랜, 크레딧, 가입일)
- 크레딧 수동 조정 (보상/회수)
- 사용자 활동 로그
- 플랜 강제 변경 (어뷰징 대응)

**시스템 모니터링:**
- 실시간 GPU 사용률
- Queue 상태 (대기 중인 작업 수)
- 에러 로그 (Sentry 연동)
- 매출 통계 (일별/월별 MRR, 플랜별 분포)

### 4.3 API Rate Limiting

플랜별 속도 제한:

```python
RATE_LIMITS = {
    "free": {
        "api_calls": "10/hour",       # 시간당 10회
        "gpu_queue": "5/hour",        # 시간당 5회
        "concurrent_jobs": 1,         # 동시 작업 1개
    },
    "starter": {
        "api_calls": "50/hour",
        "gpu_queue": "20/hour",
        "concurrent_jobs": 2,
    },
    "pro": {
        "api_calls": "500/hour",
        "gpu_queue": "100/hour",
        "concurrent_jobs": 5,
    },
    "studio": {
        "api_calls": "unlimited",
        "gpu_queue": "unlimited",
        "concurrent_jobs": 10,
    },
    "enterprise": {
        "api_calls": "unlimited",
        "gpu_queue": "unlimited",
        "concurrent_jobs": "unlimited",
    },
}
```

### 4.4 시스템 메일링

**트랜잭션 이메일 (AWS SES):**
- 회원가입 이메일 인증
- 비밀번호 리셋
- 구독 시작/갱신/취소 알림
- 크레딧 부족 경고 (잔액 < 100 크레딧)
- 결제 실패 알림

**마케팅 이메일:**
- 뉴스레터 (신규 모델 출시, 기능 업데이트)
- 프로모션 (연간 플랜 할인, 추가 크레딧)
- 온보딩 시퀀스 (가입 후 3일/7일/14일)

**이메일 구독 관리:**
- 사용자별 구독 설정 (트랜잭션 필수, 마케팅 선택)
- Unsubscribe 링크 (원클릭 구독 취소)

### 4.5 Queue & Worker 최적화

**우선순위 큐:**
```
Enterprise Queue (최우선) → Studio Queue → Pro Queue → Starter Queue → Free Queue
```

**OOM 방지:**
- GPU 메모리 모니터링 (NVIDIA SMI)
- 작업 시작 전 메모리 체크
- 메모리 부족 시 Queue 대기
- 배치 크기 자동 조정 (플랜별 제한)

**Worker 분산:**
- Celery 기반 분산 작업
- GPU 노드별 Worker Pool
- 플랜별 전용 Worker (Enterprise)
- 자동 스케일링 (Cluster Autoscaler)

---

## 5. 기술 스택

### 5.1 인프라

| 구분 | 기술 | 용도 |
|-----|------|-----|
| **Container Orchestration** | Amazon EKS 1.31 | Kubernetes 클러스터 |
| **Compute** | EC2 g5.xlarge (GPU), t3.medium (일반) | GPU 워크로드 + 웹 서버 |
| **Database** | Aurora PostgreSQL 15 | 사용자, 구독, 크레딧 데이터 |
| **Cache** | ElastiCache Redis 7.0 | 세션, Queue, Rate Limiting |
| **Storage** | S3 (이미지), EFS (AI 모델) | 파일 저장 |
| **Search** | Elasticsearch 8.11 + Nori | 프롬프트 검색 (한글 지원) |
| **Email** | AWS SES + SQS + Lambda | 트랜잭션/마케팅 이메일 |
| **Payment** | Lemon Squeezy | 구독 결제 (MoR) |
| **Monitoring** | Prometheus + Grafana + Loki | 메트릭, 로그, 대시보드 |
| **CDN** | CloudFront | 정적 파일 배포 |
| **CI/CD** | GitHub Actions + ArgoCD | GitOps 배포 |

### 5.2 애플리케이션

| 구분 | 기술 | 용도 |
|-----|------|-----|
| **Backend** | Python 3.12 + FastAPI | RESTful API |
| **Frontend** | React 18 + TypeScript + Redux | SPA |
| **Task Queue** | Celery + Redis | 비동기 작업 (이미지 생성) |
| **ORM** | SQLAlchemy 2.0 + Alembic | 데이터베이스 |
| **Auth** | OAuth 2.0 + JWT | Google/Discord 로그인 |
| **GPU Runtime** | CUDA 12.1 + PyTorch 2.1 | AI 모델 실행 |

---

## 6. 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────────┐
│                         CloudFront CDN                          │
│                    (Static Assets + Images)                     │
└────────────────────┬────────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────────┐
│                      Route 53 (DNS)                             │
│                   pingvasai.com                                 │
└────────────────────┬────────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────────┐
│                 Application Load Balancer                       │
│              (HTTPS, WAF, Shield Standard)                      │
└──────┬─────────────────────────────────────────┬────────────────┘
       │                                         │
       │                                         │
┌──────▼──────────────┐               ┌─────────▼────────────────┐
│   React Frontend    │               │   FastAPI Backend        │
│   (EKS Pods)        │               │   (EKS Pods)             │
│   - Dashboard       │               │   - Auth (JWT)           │
│   - Credit Monitor  │               │   - Subscription API     │
│   - File Manager    │               │   - Credit API           │
│   - Model Selector  │               │   - Image Generation     │
└─────────────────────┘               │   - Admin API            │
                                      └──────┬───────────────────┘
                                             │
                      ┌──────────────────────┼──────────────────────┐
                      │                      │                      │
           ┌──────────▼────────┐  ┌─────────▼────────┐  ┌─────────▼────────┐
           │  Celery Workers   │  │  Aurora PostgreSQL│  │  ElastiCache     │
           │  (GPU Pods)       │  │  - users          │  │  Redis           │
           │  - Priority Queue │  │  - subscriptions  │  │  - Sessions      │
           │  - OOM Monitor    │  │  - credits_log    │  │  - Queue         │
           │  - Model Runner   │  │  - images         │  │  - Rate Limit    │
           └───────────────────┘  └───────────────────┘  └──────────────────┘
                      │
           ┌──────────▼────────┐
           │  GPU Nodes        │
           │  g5.xlarge x3     │
           │  - NVIDIA A10G    │
           │  - 24GB VRAM      │
           └───────────────────┘
                      │
           ┌──────────▼────────┐
           │  S3 + EFS         │
           │  - Images (S3)    │
           │  - Models (EFS)   │
           └───────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     External Services                           │
├─────────────────────┬───────────────────────┬───────────────────┤
│  Lemon Squeezy      │  AWS SES              │  Elasticsearch    │
│  - Subscriptions    │  - Email Sending      │  - Search Index   │
│  - Webhooks         │  - Email Templates    │  - Korean (Nori)  │
└─────────────────────┴───────────────────────┴───────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Monitoring & Logging                         │
├─────────────────────┬───────────────────────┬───────────────────┤
│  Prometheus         │  Grafana              │  Loki             │
│  - Metrics          │  - Dashboards         │  - Log Aggregation│
│  - Alerts           │  - GPU Usage          │  - Error Tracking │
└─────────────────────┴───────────────────────┴───────────────────┘
```

---

## 7. 구현 Phase 계획

### Phase 0-3: 인프라 & 기본 설정 ✅
- VPC, EKS, RDS, ElastiCache 구축
- Docker 이미지 빌드 및 배포

### Phase 4: 인증 & 멀티테넌시 ✅
- OAuth 2.0 (Google, Discord)
- JWT 토큰 시스템
- Row-Level Security (RLS)

### Phase 5: 크레딧 기반 구독 시스템 🔄
- Lemon Squeezy 통합 (7개 플랜)
- 크레딧 충전/소비 로직
- 구독 업그레이드/다운그레이드/취소
- Webhook 이벤트 처리
- 크레딧 추가 구매

### Phase 6: 사용자 대시보드
- 개인 작업물 관리 (폴더, 갤러리)
- 크레딧 사용 내역 차트
- 파일 공유 기능
- Storage 사용량 모니터링

### Phase 7: 관리자 기능
- 모델 관리 (활성화/비활성화, 접근 제어)
- 사용자 관리 (크레딧 조정, 플랜 변경)
- 시스템 모니터링 대시보드
- 매출 통계

### Phase 8: 검색 기능
- Elasticsearch + Nori (한글 형태소 분석)
- 프롬프트 전문 검색
- 이미지 메타데이터 필터링
- 태그 기반 검색

### Phase 9: 이메일 시스템
- AWS SES 설정
- 트랜잭션 이메일 템플릿
- 마케팅 이메일 (뉴스레터)
- 이메일 구독 관리

### Phase 10: Queue & Worker 최적화
- 우선순위 큐 (플랜별)
- OOM 모니터링 및 방지
- Celery Worker 분산
- 자동 스케일링

### Phase 11: 모니터링 & CI/CD
- Prometheus + Grafana
- Loki (로그 수집)
- ArgoCD (GitOps)
- GitHub Actions (CI)

---

## 8. 예상 비용 (월간)

| 항목 | 사양 | 비용 |
|-----|------|------|
| **EKS Cluster** | 컨트롤 플레인 | $73 |
| **EC2 GPU** | g5.xlarge x3 (Spot) | $300 |
| **EC2 일반** | t3.medium x3 (Spot) | $30 |
| **Aurora PostgreSQL** | db.t4g.medium (1 Writer, 1 Reader) | $120 |
| **ElastiCache Redis** | cache.t3.micro | $15 |
| **S3** | 100GB 저장, 1TB 전송 | $12 |
| **EFS** | 50GB (AI 모델) | $15 |
| **Elasticsearch** | t3.small.search x3 | $120 |
| **CloudFront** | 1TB 전송 | $85 |
| **SES** | 10,000 이메일 | $1 |
| **NAT Gateway** | 3개 (HA) | $100 |
| **ALB** | 1개 | $23 |
| **Route 53** | 호스팅 영역 | $1 |
| **기타** | CloudWatch, Secrets Manager | $10 |
| **합계** | | **~$905/월** |

---

**다음 문서**: Phase 5 - 크레딧 기반 구독 시스템 상세 구현 가이드

**작성일**: 2025-11-18
**작성자**: Claude (Anthropic)
