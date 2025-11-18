# Phase 5: 크레딧 기반 구독 & 결제 시스템

> Lemon Squeezy + 크레딧 시스템 + 모델 접근 제어

**소요 시간**: Week 9-11 (3주, 100-120시간)
**난이도**: ⭐⭐⭐⭐⭐ (최상)
**예상 비용**: Lemon Squeezy 수수료 5% + $0.50/transaction

---

## 📋 목차

1. [개요](#1-개요)
2. [Lemon Squeezy 설정](#2-lemon-squeezy-설정)
3. [크레딧 시스템 설계](#3-크레딧-시스템-설계)
4. [구독 플랜 구성](#4-구독-플랜-구성)
5. [Webhook 구현](#5-webhook-구현)
6. [크레딧 관리](#6-크레딧-관리)
7. [모델 접근 제어](#7-모델-접근-제어)
8. [프론트엔드 UI](#8-프론트엔드-ui)
9. [테스트 및 검증](#9-테스트-및-검증)

---

## 1. 개요

### 1.1 목표

이 Phase에서 구현할 핵심 기능:

✅ **크레딧 기반 과금**
- GPU 사용 시간: 1초당 1크레딧
- 나노바나나 API: 건당 20크레딧
- 월간 크레딧 자동 충전/소멸

✅ **구독 플랜** (7개 상품)
- **Free**: $0/월, 100 크레딧
- **Starter**: $25/월 or $250/년 (17% 할인), 2,500 크레딧
- **Pro**: $75/월 or $750/년, 10,000 크레딧
- **Studio**: $150/월 or $1,500/년, 25,000 크레딧
- **Enterprise**: Custom (계약 기반)

✅ **구독 정책**
- 구독 시작: 즉시 크레딧 충전
- 구독 갱신: 매월 1일 크레딧 재충전 (기존 소멸)
- 업그레이드: 즉시 반영 + 확인 메시지
- 취소: 종료일까지 유지 후 Free 강등

✅ **모델 접근 제어**
- 플랜별 AI 모델 사용 권한
- 나노바나나 API 접근 제한

### 1.2 아키텍처 흐름

```
┌─────────────┐
│   사용자     │
│  (Free)     │
└──────┬──────┘
       │ 1. "Starter 플랜 구독" 클릭
       ↓
┌─────────────────────────────────┐
│  FastAPI Backend                │
│  POST /api/v1/subscriptions/    │
│       checkout                  │
│  - Lemon Squeezy Checkout URL 생성│
└──────┬──────────────────────────┘
       │ 2. Checkout URL 반환
       ↓
┌─────────────────────────────────┐
│  Lemon Squeezy Checkout         │
│  - 카드 정보 입력                │
│  - Trial 시작 (7일)              │
│  - 결제 완료                     │
└──────┬──────────────────────────┘
       │ 3. Webhook: subscription_created
       ↓
┌─────────────────────────────────┐
│  FastAPI Webhook Handler        │
│  POST /api/v1/webhooks/lemon    │
│  - 플랜: Free → Starter         │
│  - 크레딧: 0 → 2,500            │
│  - 갱신일: 현재 + 1개월          │
└──────┬──────────────────────────┘
       │ 4. 성공 페이지로 리다이렉트
       ↓
┌─────────────────────────────────┐
│  Dashboard (React)              │
│  - "Starter 플랜 활성화!"        │
│  - 크레딧: 2,500 표시            │
└─────────────────────────────────┘
```

---

## 2. Lemon Squeezy 설정

### 2.1 계정 생성

1. https://lemonsqueezy.com 접속
2. "Start Selling" → 계정 생성
3. 스토어 이름: "PingvasAI"
4. 카테고리: "Software" 선택

### 2.2 제품 생성

**제품 1개 생성 (PingvasAI Subscription):**

```yaml
Product Name: PingvasAI Subscription
Description: AI-powered image generation platform with credit-based billing
Type: Subscription
```

### 2.3 Variants (플랜) 생성

총 7개 Variant 생성:

#### 1. Starter - Monthly

```yaml
Name: Starter (Monthly)
Price: $25.00 USD
Billing Cycle: Monthly
Trial Period: 7 days
Description: |
  - 2,500 credits per month
  - 10GB storage
  - Medium-tier models (SDXL)
  - Limited API access (50 calls/month)
```

#### 2. Starter - Yearly

```yaml
Name: Starter (Yearly)
Price: $250.00 USD ($20.83/month, 17% off)
Billing Cycle: Yearly
Trial Period: 7 days
Description: |
  - 2,500 credits per month
  - 10GB storage
  - Medium-tier models (SDXL)
  - Limited API access (50 calls/month)
  - Save 17% with annual billing
```

#### 3. Pro - Monthly

```yaml
Name: Pro (Monthly)
Price: $75.00 USD
Billing Cycle: Monthly
Trial Period: 7 days
Description: |
  - 10,000 credits per month
  - 50GB storage
  - Premium models (Flux, DALL-E 3)
  - Unlimited API access
  - Priority queue
```

#### 4. Pro - Yearly

```yaml
Name: Pro (Yearly)
Price: $750.00 USD ($62.50/month, 17% off)
Billing Cycle: Yearly
Trial Period: 7 days
```

#### 5. Studio - Monthly

```yaml
Name: Studio (Monthly)
Price: $150.00 USD
Billing Cycle: Monthly
Trial Period: 7 days
Description: |
  - 25,000 credits per month
  - 200GB storage
  - All models + Custom model upload
  - Unlimited API access
  - Highest priority queue
```

#### 6. Studio - Yearly

```yaml
Name: Studio (Yearly)
Price: $1,500.00 USD ($125/month, 17% off)
Billing Cycle: Yearly
Trial Period: 7 days
```

#### 7. Enterprise (Manual)

```yaml
Name: Enterprise
Type: Custom (수동 관리)
Description: |
  - Unlimited credits
  - Unlimited storage
  - Dedicated infrastructure
  - 24/7 support
  - SLA guarantee

# Enterprise는 Lemon Squeezy가 아닌 직접 계약 관리
```

### 2.4 Variant ID 확인 및 환경 변수 설정

```bash
# Lemon Squeezy Dashboard → Products → Variants에서 ID 확인

# Kubernetes Secret에 추가
kubectl create secret generic lemon-squeezy-secrets \
  --from-literal=API_KEY='lmsq_xxxxx' \
  --from-literal=STORE_ID='12345' \
  --from-literal=WEBHOOK_SECRET='whsec_xxxxx' \
  --from-literal=STARTER_MONTHLY_VARIANT_ID='123456' \
  --from-literal=STARTER_YEARLY_VARIANT_ID='123457' \
  --from-literal=PRO_MONTHLY_VARIANT_ID='123458' \
  --from-literal=PRO_YEARLY_VARIANT_ID='123459' \
  --from-literal=STUDIO_MONTHLY_VARIANT_ID='123460' \
  --from-literal=STUDIO_YEARLY_VARIANT_ID='123461' \
  -n prod
```

### 2.5 Webhook 설정

```bash
# Lemon Squeezy → Settings → Webhooks → Create

URL: https://api.pingvasai.com/api/v1/webhooks/lemon
Signing Secret: <자동 생성된 Secret 복사>

# 이벤트 선택:
✅ subscription_created
✅ subscription_updated
✅ subscription_cancelled
✅ subscription_resumed
✅ subscription_expired
✅ subscription_payment_success
✅ subscription_payment_failed
✅ order_created (크레딧 추가 구매용)
```

---

## 3. 크레딧 시스템 설계

### 3.1 데이터베이스 스키마

```sql
-- Users 테이블에 크레딧 컬럼 추가
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_balance INTEGER DEFAULT 100;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_used_this_month INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_purchased INTEGER DEFAULT 0;  -- 추가 구매한 크레딧

-- Subscriptions 테이블 수정
CREATE TABLE subscriptions (
    subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- Lemon Squeezy 정보
    lemon_squeezy_id VARCHAR(255) UNIQUE NOT NULL,
    lemon_squeezy_customer_id VARCHAR(255),
    lemon_squeezy_variant_id VARCHAR(255) NOT NULL,
    lemon_squeezy_product_id VARCHAR(255),

    -- 구독 정보
    status VARCHAR(50) DEFAULT 'active',  -- active, cancelled, expired, past_due, paused
    plan_name VARCHAR(50) NOT NULL,       -- starter, pro, studio, enterprise
    billing_cycle VARCHAR(20),            -- monthly, yearly

    -- 크레딧 정보
    monthly_credits INTEGER NOT NULL,     -- 월간 제공 크레딧

    -- 결제 정보
    amount INTEGER NOT NULL,              -- Cents (2500 = $25.00)
    currency VARCHAR(3) DEFAULT 'USD',

    -- 날짜 정보
    trial_ends_at TIMESTAMP,
    current_period_start TIMESTAMP NOT NULL,
    current_period_end TIMESTAMP NOT NULL,
    renews_at TIMESTAMP,
    ends_at TIMESTAMP,                    -- 취소 시 종료일
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP,

    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_lemon_id ON subscriptions(lemon_squeezy_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- 크레딧 사용 로그
CREATE TABLE credit_usage_log (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- 사용 정보
    credits_consumed INTEGER NOT NULL,
    usage_type VARCHAR(50) NOT NULL,     -- gpu_generation, api_call, refund
    description TEXT,

    -- 메타데이터 (JSON)
    metadata JSONB,                       -- {duration_seconds: 30, model: "flux-dev"}

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_credit_log_user_id ON credit_usage_log(user_id);
CREATE INDEX idx_credit_log_created_at ON credit_usage_log(created_at DESC);
CREATE INDEX idx_credit_log_type ON credit_usage_log(usage_type);

-- 크레딧 구매 내역
CREATE TABLE credit_purchases (
    purchase_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- 구매 정보
    credits_amount INTEGER NOT NULL,
    price_paid INTEGER NOT NULL,          -- Cents
    lemon_squeezy_order_id VARCHAR(255),

    -- 상태
    status VARCHAR(50) DEFAULT 'completed',  -- pending, completed, refunded

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_credit_purchases_user_id ON credit_purchases(user_id);
```

### 3.2 플랜별 크레딧 매핑

```python
# backend/invokeai/app/core/plans.py

"""
구독 플랜 정의
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class Plan:
    name: str
    display_name: str
    monthly_price: int          # Cents
    yearly_price: Optional[int] # Cents
    monthly_credits: int
    storage_gb: int
    concurrent_jobs: int
    queue_priority: int         # 1 (최저) ~ 5 (최고)
    features: dict


# 플랜 정의
PLANS = {
    "free": Plan(
        name="free",
        display_name="Free",
        monthly_price=0,
        yearly_price=None,
        monthly_credits=100,
        storage_gb=1,
        concurrent_jobs=1,
        queue_priority=1,
        features={
            "basic_models": True,
            "medium_models": False,
            "premium_models": False,
            "custom_models": False,
            "api_access": False,
            "api_monthly_limit": 0,
            "batch_size": 1,
            "file_sharing": False,
            "priority_support": False,
        }
    ),

    "starter": Plan(
        name="starter",
        display_name="Starter",
        monthly_price=2500,  # $25.00
        yearly_price=25000,  # $250.00 (17% off)
        monthly_credits=2500,
        storage_gb=10,
        concurrent_jobs=2,
        queue_priority=2,
        features={
            "basic_models": True,
            "medium_models": True,   # SDXL
            "premium_models": False,
            "custom_models": False,
            "api_access": True,
            "api_monthly_limit": 50,
            "batch_size": 4,
            "file_sharing": True,
            "priority_support": False,
        }
    ),

    "pro": Plan(
        name="pro",
        display_name="Pro",
        monthly_price=7500,  # $75.00
        yearly_price=75000,  # $750.00
        monthly_credits=10000,
        storage_gb=50,
        concurrent_jobs=5,
        queue_priority=4,
        features={
            "basic_models": True,
            "medium_models": True,
            "premium_models": True,  # Flux, DALL-E 3
            "custom_models": False,
            "api_access": True,
            "api_monthly_limit": -1,  # Unlimited
            "batch_size": 10,
            "file_sharing": True,
            "priority_support": True,
        }
    ),

    "studio": Plan(
        name="studio",
        display_name="Studio",
        monthly_price=15000,  # $150.00
        yearly_price=150000,  # $1,500.00
        monthly_credits=25000,
        storage_gb=200,
        concurrent_jobs=10,
        queue_priority=5,
        features={
            "basic_models": True,
            "medium_models": True,
            "premium_models": True,
            "custom_models": True,   # 커스텀 모델 업로드
            "api_access": True,
            "api_monthly_limit": -1,
            "batch_size": 20,
            "file_sharing": True,
            "priority_support": True,
        }
    ),

    "enterprise": Plan(
        name="enterprise",
        display_name="Enterprise",
        monthly_price=None,  # Custom
        yearly_price=None,
        monthly_credits=-1,  # Unlimited
        storage_gb=-1,       # Unlimited
        concurrent_jobs=-1,  # Unlimited
        queue_priority=6,    # 최우선
        features={
            "basic_models": True,
            "medium_models": True,
            "premium_models": True,
            "custom_models": True,
            "api_access": True,
            "api_monthly_limit": -1,
            "batch_size": -1,  # Unlimited
            "file_sharing": True,
            "priority_support": True,
            "dedicated_infrastructure": True,
            "sla": True,
        }
    ),
}


def get_plan(plan_name: str) -> Plan:
    """플랜 정보 조회"""
    return PLANS.get(plan_name, PLANS["free"])


def get_variant_id_for_plan(plan_name: str, billing_cycle: str) -> str:
    """플랜과 결제 주기에 맞는 Variant ID 반환"""
    from invokeai.app.core.config import settings

    mapping = {
        ("starter", "monthly"): settings.LEMON_SQUEEZY_STARTER_MONTHLY_VARIANT_ID,
        ("starter", "yearly"): settings.LEMON_SQUEEZY_STARTER_YEARLY_VARIANT_ID,
        ("pro", "monthly"): settings.LEMON_SQUEEZY_PRO_MONTHLY_VARIANT_ID,
        ("pro", "yearly"): settings.LEMON_SQUEEZY_PRO_YEARLY_VARIANT_ID,
        ("studio", "monthly"): settings.LEMON_SQUEEZY_STUDIO_MONTHLY_VARIANT_ID,
        ("studio", "yearly"): settings.LEMON_SQUEEZY_STUDIO_YEARLY_VARIANT_ID,
    }

    return mapping.get((plan_name, billing_cycle))


def get_plan_from_variant_id(variant_id: str) -> tuple[str, str]:
    """Variant ID로 플랜명과 결제 주기 조회"""
    from invokeai.app.core.config import settings

    reverse_mapping = {
        settings.LEMON_SQUEEZY_STARTER_MONTHLY_VARIANT_ID: ("starter", "monthly"),
        settings.LEMON_SQUEEZY_STARTER_YEARLY_VARIANT_ID: ("starter", "yearly"),
        settings.LEMON_SQUEEZY_PRO_MONTHLY_VARIANT_ID: ("pro", "monthly"),
        settings.LEMON_SQUEEZY_PRO_YEARLY_VARIANT_ID: ("pro", "yearly"),
        settings.LEMON_SQUEEZY_STUDIO_MONTHLY_VARIANT_ID: ("studio", "monthly"),
        settings.LEMON_SQUEEZY_STUDIO_YEARLY_VARIANT_ID: ("studio", "yearly"),
    }

    return reverse_mapping.get(variant_id, ("free", "monthly"))
```

---

## 4. 구독 플랜 구성

### 4.1 Checkout API

```python
# backend/invokeai/app/api/routers/subscriptions.py

"""
구독 관리 API
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Literal

from invokeai.app.services.database import get_db
from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.services.lemon_squeezy.client import LemonSqueezyClient
from invokeai.app.models.user import User
from invokeai.app.models.subscription import Subscription
from invokeai.app.core.config import settings
from invokeai.app.core.plans import get_variant_id_for_plan, PLANS


router = APIRouter(prefix="/subscriptions", tags=["Subscriptions"])

# Lemon Squeezy 클라이언트
lemon_client = LemonSqueezyClient(api_key=settings.LEMON_SQUEEZY_API_KEY)


class CheckoutRequest(BaseModel):
    """Checkout 요청"""
    plan: Literal["starter", "pro", "studio"]
    billing_cycle: Literal["monthly", "yearly"]


class CheckoutResponse(BaseModel):
    """Checkout 응답"""
    checkout_url: str


@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout_session(
    request: CheckoutRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    결제 Checkout 세션 생성

    Args:
        request: Checkout 요청 (플랜 + 결제 주기)
        current_user: 현재 사용자
        db: Database session

    Returns:
        CheckoutResponse: Checkout URL
    """
    # 이미 유료 플랜 구독 중인지 확인
    if current_user.subscription_plan in ["starter", "pro", "studio", "enterprise"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You already have an active subscription. Please cancel it first or use upgrade/downgrade.",
        )

    # Variant ID 조회
    variant_id = get_variant_id_for_plan(request.plan, request.billing_cycle)
    if not variant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid plan or billing cycle",
        )

    # Checkout 세션 생성
    checkout_data = await lemon_client.create_checkout(
        store_id=settings.LEMON_SQUEEZY_STORE_ID,
        variant_id=variant_id,
        user_email=current_user.email,
        user_id=str(current_user.user_id),
        custom_data={
            "user_id": str(current_user.user_id),
            "plan": request.plan,
            "billing_cycle": request.billing_cycle,
        }
    )

    return CheckoutResponse(checkout_url=checkout_data["checkout_url"])


@router.get("/current")
async def get_current_subscription(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    현재 사용자의 구독 정보 조회

    Returns:
        Dict: 구독 및 크레딧 정보
    """
    stmt = select(Subscription).where(
        Subscription.user_id == current_user.user_id,
        Subscription.is_active == True,
    )
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    # Free 플랜
    if not subscription:
        return {
            "plan": "free",
            "billing_cycle": "monthly",
            "status": "active",
            "credits_balance": current_user.credits_balance,
            "credits_used_this_month": current_user.credits_used_this_month,
            "credits_monthly_quota": 100,
            "storage_used_gb": 0,  # TODO: 실제 계산
            "storage_quota_gb": 1,
        }

    # 유료 플랜
    plan_info = PLANS[subscription.plan_name]

    return {
        "plan": subscription.plan_name,
        "billing_cycle": subscription.billing_cycle,
        "status": subscription.status,
        "amount": subscription.amount / 100,  # Cents to Dollars
        "current_period_start": subscription.current_period_start.isoformat(),
        "current_period_end": subscription.current_period_end.isoformat(),
        "renews_at": subscription.renews_at.isoformat() if subscription.renews_at else None,
        "ends_at": subscription.ends_at.isoformat() if subscription.ends_at else None,
        "credits_balance": current_user.credits_balance,
        "credits_used_this_month": current_user.credits_used_this_month,
        "credits_monthly_quota": plan_info.monthly_credits,
        "credits_purchased": current_user.credits_purchased,  # 추가 구매 크레딧
        "storage_used_gb": 0,  # TODO
        "storage_quota_gb": plan_info.storage_gb,
    }
```


### 4.2 업그레이드 API

```python
class UpgradeRequest(BaseModel):
    """업그레이드 요청"""
    target_plan: Literal["starter", "pro", "studio"]
    billing_cycle: Literal["monthly", "yearly"]


@router.post("/upgrade")
async def upgrade_subscription(
    request: UpgradeRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    구독 플랜 업그레이드

    정책:
    - 즉시 업그레이드 반영
    - 기존 크레딧 소멸, 새 플랜 크레딧으로 교체
    - 프론트엔드에서 확인 메시지 표시 필요

    Args:
        request: 업그레이드할 플랜 정보
        current_user: 현재 사용자
        db: Database session

    Returns:
        Dict: 업그레이드된 구독 정보
    """
    # 현재 구독 조회
    stmt = select(Subscription).where(
        Subscription.user_id == current_user.user_id,
        Subscription.is_active == True,
    )
    result = await db.execute(stmt)
    current_subscription = result.scalar_one_or_none()

    if not current_subscription:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active subscription found. Please use /checkout instead.",
        )

    # 업그레이드 가능 여부 확인
    plan_hierarchy = {"free": 0, "starter": 1, "pro": 2, "studio": 3}
    current_tier = plan_hierarchy.get(current_subscription.plan_name, 0)
    target_tier = plan_hierarchy.get(request.target_plan, 0)

    if target_tier <= current_tier:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Target plan must be higher than current plan. Use /downgrade for downgrades.",
        )

    # Lemon Squeezy API로 구독 변경
    variant_id = get_variant_id_for_plan(request.target_plan, request.billing_cycle)

    try:
        updated_subscription = await lemon_client.update_subscription(
            subscription_id=current_subscription.lemon_squeezy_id,
            variant_id=variant_id,
            proration_enabled=True,  # 일할 계산
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to upgrade subscription: {str(e)}",
        )

    # NOTE: Webhook이 실제 DB 업데이트를 처리함
    # 이 API는 Lemon Squeezy에 변경 요청만 전송

    return {
        "message": "Upgrade request sent successfully. Your subscription will be updated shortly.",
        "target_plan": request.target_plan,
        "billing_cycle": request.billing_cycle,
    }


@router.post("/cancel")
async def cancel_subscription(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    구독 취소

    정책:
    - 즉시 자동 갱신 중지
    - 현재 기간 종료일까지 서비스 유지
    - 종료일 00:00에 Free 플랜으로 강등
    - 크레딧은 종료일까지 사용 가능

    Args:
        current_user: 현재 사용자
        db: Database session

    Returns:
        Dict: 취소 정보
    """
    # 현재 구독 조회
    stmt = select(Subscription).where(
        Subscription.user_id == current_user.user_id,
        Subscription.is_active == True,
    )
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active subscription found.",
        )

    # Lemon Squeezy API로 취소 요청
    try:
        cancelled_subscription = await lemon_client.cancel_subscription(
            subscription_id=subscription.lemon_squeezy_id,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to cancel subscription: {str(e)}",
        )

    # NOTE: Webhook이 실제 DB 업데이트 처리

    return {
        "message": "Subscription cancelled successfully.",
        "access_until": subscription.current_period_end.isoformat(),
        "downgrade_to": "free",
    }
```

---

## 5. Webhook 구현

### 5.1 Webhook 핸들러 구조

```python
# backend/invokeai/app/api/routers/webhooks.py

"""
Lemon Squeezy Webhook 핸들러
"""

from fastapi import APIRouter, Request, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from datetime import datetime, timedelta
import hashlib
import hmac

from invokeai.app.services.database import get_db
from invokeai.app.models.user import User
from invokeai.app.models.subscription import Subscription
from invokeai.app.models.credit_usage_log import CreditUsageLog
from invokeai.app.core.config import settings
from invokeai.app.core.plans import get_plan_from_variant_id, PLANS


router = APIRouter(prefix="/webhooks", tags=["Webhooks"])


def verify_webhook_signature(payload: bytes, signature: str) -> bool:
    """
    Webhook 서명 검증

    Args:
        payload: 원본 JSON 바이트
        signature: X-Signature 헤더 값

    Returns:
        bool: 검증 성공 여부
    """
    expected_signature = hmac.new(
        settings.LEMON_SQUEEZY_WEBHOOK_SECRET.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(expected_signature, signature)


@router.post("/lemon")
async def handle_lemon_webhook(request: Request):
    """
    Lemon Squeezy Webhook 수신

    이벤트:
    - subscription_created: 새 구독 생성
    - subscription_updated: 구독 변경 (업그레이드/다운그레이드)
    - subscription_cancelled: 구독 취소
    - subscription_resumed: 구독 재개
    - subscription_expired: 구독 만료
    - subscription_payment_success: 결제 성공 (갱신)
    - subscription_payment_failed: 결제 실패
    - order_created: 일회성 구매 (크레딧 추가 구매)
    """
    # 1. 서명 검증
    signature = request.headers.get("X-Signature")
    if not signature:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing signature",
        )

    payload = await request.body()

    if not verify_webhook_signature(payload, signature):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid signature",
        )

    # 2. JSON 파싱
    data = await request.json()
    event_name = data["meta"]["event_name"]

    # 3. 이벤트 처리
    async with get_db() as db:
        if event_name == "subscription_created":
            await handle_subscription_created(data, db)
        elif event_name == "subscription_updated":
            await handle_subscription_updated(data, db)
        elif event_name == "subscription_cancelled":
            await handle_subscription_cancelled(data, db)
        elif event_name == "subscription_resumed":
            await handle_subscription_resumed(data, db)
        elif event_name == "subscription_expired":
            await handle_subscription_expired(data, db)
        elif event_name == "subscription_payment_success":
            await handle_subscription_payment_success(data, db)
        elif event_name == "subscription_payment_failed":
            await handle_subscription_payment_failed(data, db)
        elif event_name == "order_created":
            await handle_order_created(data, db)
        else:
            print(f"Unknown event: {event_name}")

    return {"status": "ok"}
```

### 5.2 subscription_created 핸들러

```python
async def handle_subscription_created(data: dict, db: AsyncSession):
    """
    새 구독 생성 처리

    동작:
    1. Subscription 레코드 생성
    2. User 플랜 업데이트
    3. 크레딧 즉시 충전
    """
    attributes = data["data"]["attributes"]

    # 사용자 ID 추출
    user_id = attributes["first_subscription_item"]["meta"]["custom_data"]["user_id"]

    # 플랜 정보 추출
    variant_id = attributes["variant_id"]
    plan_name, billing_cycle = get_plan_from_variant_id(str(variant_id))
    plan_info = PLANS[plan_name]

    # 구독 생성
    subscription = Subscription(
        user_id=user_id,
        lemon_squeezy_id=str(attributes["id"]),
        lemon_squeezy_customer_id=str(attributes["customer_id"]),
        lemon_squeezy_variant_id=str(variant_id),
        lemon_squeezy_product_id=str(attributes["product_id"]),
        status=attributes["status"],
        plan_name=plan_name,
        billing_cycle=billing_cycle,
        monthly_credits=plan_info.monthly_credits,
        amount=int(attributes["renews_at_formatted"]),  # TODO: 정확한 금액 파싱
        currency="USD",
        trial_ends_at=datetime.fromisoformat(attributes["trial_ends_at"]) if attributes.get("trial_ends_at") else None,
        current_period_start=datetime.fromisoformat(attributes["current_period_start"]),
        current_period_end=datetime.fromisoformat(attributes["current_period_end"]),
        renews_at=datetime.fromisoformat(attributes["renews_at"]) if attributes.get("renews_at") else None,
        is_active=True,
    )

    db.add(subscription)

    # User 업데이트
    stmt = (
        update(User)
        .where(User.user_id == user_id)
        .values(
            subscription_plan=plan_name,
            subscription_status="active",
            credits_balance=plan_info.monthly_credits,  # 즉시 크레딧 충전
            credits_used_this_month=0,
        )
    )
    await db.execute(stmt)

    # 크레딧 로그 기록
    credit_log = CreditUsageLog(
        user_id=user_id,
        credits_consumed=-plan_info.monthly_credits,  # 음수 = 충전
        usage_type="subscription_created",
        description=f"Initial credit charge for {plan_name} plan",
        metadata={
            "subscription_id": str(subscription.subscription_id),
            "plan": plan_name,
            "billing_cycle": billing_cycle,
        }
    )
    db.add(credit_log)

    await db.commit()

    print(f"✅ Subscription created: User {user_id} → {plan_name} ({plan_info.monthly_credits} credits)")


async def handle_subscription_updated(data: dict, db: AsyncSession):
    """
    구독 변경 처리 (업그레이드/다운그레이드)

    동작:
    1. Subscription 레코드 업데이트
    2. User 플랜 업데이트
    3. 크레딧 재충전 (업그레이드 시 기존 크레딧 소멸)
    """
    attributes = data["data"]["attributes"]
    lemon_id = str(attributes["id"])

    # 기존 구독 조회
    stmt = select(Subscription).where(Subscription.lemon_squeezy_id == lemon_id)
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        print(f"⚠️ Subscription not found: {lemon_id}")
        return

    # 플랜 정보
    variant_id = attributes["variant_id"]
    new_plan_name, new_billing_cycle = get_plan_from_variant_id(str(variant_id))
    new_plan_info = PLANS[new_plan_name]

    old_plan = subscription.plan_name

    # 구독 업데이트
    subscription.plan_name = new_plan_name
    subscription.billing_cycle = new_billing_cycle
    subscription.monthly_credits = new_plan_info.monthly_credits
    subscription.status = attributes["status"]
    subscription.current_period_end = datetime.fromisoformat(attributes["current_period_end"])
    subscription.renews_at = datetime.fromisoformat(attributes["renews_at"]) if attributes.get("renews_at") else None
    subscription.updated_at = datetime.utcnow()

    # User 업데이트 + 크레딧 재충전
    stmt = (
        update(User)
        .where(User.user_id == subscription.user_id)
        .values(
            subscription_plan=new_plan_name,
            credits_balance=new_plan_info.monthly_credits,  # 기존 크레딧 소멸, 새 크레딧으로 교체
            credits_used_this_month=0,
        )
    )
    await db.execute(stmt)

    # 크레딧 로그
    credit_log = CreditUsageLog(
        user_id=subscription.user_id,
        credits_consumed=-new_plan_info.monthly_credits,
        usage_type="subscription_updated",
        description=f"Subscription changed: {old_plan} → {new_plan_name}",
        metadata={
            "old_plan": old_plan,
            "new_plan": new_plan_name,
            "billing_cycle": new_billing_cycle,
        }
    )
    db.add(credit_log)

    await db.commit()

    print(f"✅ Subscription updated: User {subscription.user_id} → {old_plan} to {new_plan_name}")


async def handle_subscription_cancelled(data: dict, db: AsyncSession):
    """
    구독 취소 처리

    정책:
    - 즉시 자동 갱신 중지
    - ends_at 설정 (현재 기간 종료일)
    - 종료일까지 서비스 유지
    - 크레딧 유지 (종료일까지 사용 가능)
    """
    attributes = data["data"]["attributes"]
    lemon_id = str(attributes["id"])

    stmt = select(Subscription).where(Subscription.lemon_squeezy_id == lemon_id)
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        return

    # 구독 상태 업데이트
    subscription.status = "cancelled"
    subscription.ends_at = subscription.current_period_end  # 종료일 설정
    subscription.renews_at = None  # 갱신 중지

    # User 상태 업데이트 (아직 플랜 유지)
    stmt = (
        update(User)
        .where(User.user_id == subscription.user_id)
        .values(subscription_status="cancelled")
    )
    await db.execute(stmt)

    await db.commit()

    print(f"✅ Subscription cancelled: User {subscription.user_id}, ends at {subscription.ends_at}")


async def handle_subscription_expired(data: dict, db: AsyncSession):
    """
    구독 만료 처리

    동작:
    - Free 플랜으로 강등
    - 크레딧을 100으로 리셋
    - 구독 레코드 비활성화
    """
    attributes = data["data"]["attributes"]
    lemon_id = str(attributes["id"])

    stmt = select(Subscription).where(Subscription.lemon_squeezy_id == lemon_id)
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        return

    # 구독 비활성화
    subscription.status = "expired"
    subscription.is_active = False

    # User를 Free 플랜으로 강등
    stmt = (
        update(User)
        .where(User.user_id == subscription.user_id)
        .values(
            subscription_plan="free",
            subscription_status="active",
            credits_balance=100,  # Free 플랜 크레딧
            credits_used_this_month=0,
        )
    )
    await db.execute(stmt)

    # 로그
    credit_log = CreditUsageLog(
        user_id=subscription.user_id,
        credits_consumed=0,
        usage_type="subscription_expired",
        description="Subscription expired, downgraded to Free plan",
        metadata={"old_plan": subscription.plan_name}
    )
    db.add(credit_log)

    await db.commit()

    print(f"✅ Subscription expired: User {subscription.user_id} → downgraded to Free")


async def handle_subscription_payment_success(data: dict, db: AsyncSession):
    """
    구독 갱신 성공 처리

    동작:
    - 크레딧 월간 재충전
    - 기존 크레딧 소멸 (추가 구매 크레딧 제외)
    - 갱신일 업데이트
    """
    attributes = data["data"]["attributes"]
    lemon_id = str(attributes["id"])

    stmt = select(Subscription).where(Subscription.lemon_squeezy_id == lemon_id)
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        return

    plan_info = PLANS[subscription.plan_name]

    # 갱신일 업데이트
    subscription.current_period_start = datetime.fromisoformat(attributes["current_period_start"])
    subscription.current_period_end = datetime.fromisoformat(attributes["current_period_end"])
    subscription.renews_at = datetime.fromisoformat(attributes["renews_at"])
    subscription.status = "active"

    # 크레딧 재충전 (기존 크레딧 소멸)
    stmt = select(User).where(User.user_id == subscription.user_id)
    result = await db.execute(stmt)
    user = result.scalar_one()

    # 추가 구매 크레딧은 유지
    purchased_credits = user.credits_purchased

    stmt = (
        update(User)
        .where(User.user_id == subscription.user_id)
        .values(
            subscription_status="active",
            credits_balance=plan_info.monthly_credits + purchased_credits,  # 월간 크레딧 + 구매 크레딧
            credits_used_this_month=0,
        )
    )
    await db.execute(stmt)

    # 로그
    credit_log = CreditUsageLog(
        user_id=subscription.user_id,
        credits_consumed=-plan_info.monthly_credits,
        usage_type="subscription_renewed",
        description=f"Monthly credit reset for {subscription.plan_name} plan",
        metadata={
            "plan": subscription.plan_name,
            "billing_cycle": subscription.billing_cycle,
            "purchased_credits_retained": purchased_credits,
        }
    )
    db.add(credit_log)

    await db.commit()

    print(f"✅ Subscription renewed: User {subscription.user_id} → {plan_info.monthly_credits} credits recharged")


async def handle_subscription_payment_failed(data: dict, db: AsyncSession):
    """
    구독 결제 실패 처리

    동작:
    - 상태를 past_due로 변경
    - 3회 실패 시 자동 취소 (Lemon Squeezy 기본 정책)
    """
    attributes = data["data"]["attributes"]
    lemon_id = str(attributes["id"])

    stmt = select(Subscription).where(Subscription.lemon_squeezy_id == lemon_id)
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        return

    subscription.status = "past_due"

    stmt = (
        update(User)
        .where(User.user_id == subscription.user_id)
        .values(subscription_status="past_due")
    )
    await db.execute(stmt)

    await db.commit()

    print(f"⚠️ Payment failed: User {subscription.user_id}")


async def handle_order_created(data: dict, db: AsyncSession):
    """
    일회성 주문 처리 (크레딧 추가 구매)

    동작:
    - 추가 크레딧 충전
    - 이 크레딧은 월간 리셋에서 소멸되지 않음
    """
    attributes = data["data"]["attributes"]

    # 사용자 ID
    user_id = attributes["meta"]["custom_data"]["user_id"]
    credits_amount = int(attributes["meta"]["custom_data"]["credits"])
    price_paid = int(attributes["total"])  # Cents

    # User 업데이트
    stmt = (
        update(User)
        .where(User.user_id == user_id)
        .values(
            credits_balance=User.credits_balance + credits_amount,
            credits_purchased=User.credits_purchased + credits_amount,
        )
    )
    await db.execute(stmt)

    # 구매 내역 기록
    from invokeai.app.models.credit_purchase import CreditPurchase

    purchase = CreditPurchase(
        user_id=user_id,
        credits_amount=credits_amount,
        price_paid=price_paid,
        lemon_squeezy_order_id=str(attributes["id"]),
        status="completed",
    )
    db.add(purchase)

    # 로그
    credit_log = CreditUsageLog(
        user_id=user_id,
        credits_consumed=-credits_amount,
        usage_type="credit_purchase",
        description=f"Purchased {credits_amount} credits for ${price_paid / 100}",
        metadata={
            "order_id": str(attributes["id"]),
            "price_paid": price_paid,
        }
    )
    db.add(credit_log)

    await db.commit()

    print(f"✅ Credits purchased: User {user_id} → +{credits_amount} credits")
```

---

## 6. 크레딧 관리

### 6.1 크레딧 차감 함수

```python
# backend/invokeai/app/services/credits/manager.py

"""
크레딧 관리 서비스
"""

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from datetime import datetime

from invokeai.app.models.user import User
from invokeai.app.models.credit_usage_log import CreditUsageLog
from invokeai.app.core.plans import PLANS


class InsufficientCreditsError(Exception):
    """크레딧 부족 에러"""
    pass


async def consume_credits(
    user_id: str,
    credits: int,
    usage_type: str,
    description: str,
    metadata: dict,
    db: AsyncSession,
):
    """
    크레딧 차감

    Args:
        user_id: 사용자 ID
        credits: 차감할 크레딧
        usage_type: 사용 타입 (gpu_generation, api_call)
        description: 설명
        metadata: 메타데이터 (JSON)
        db: Database session

    Raises:
        InsufficientCreditsError: 크레딧 부족
    """
    # 사용자 조회
    stmt = select(User).where(User.user_id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one()

    # Enterprise는 무제한
    if user.subscription_plan == "enterprise":
        # 로그만 기록
        credit_log = CreditUsageLog(
            user_id=user_id,
            credits_consumed=credits,
            usage_type=usage_type,
            description=description,
            metadata=metadata,
        )
        db.add(credit_log)
        await db.commit()
        return

    # 크레딧 확인
    if user.credits_balance < credits:
        raise InsufficientCreditsError(
            f"Insufficient credits. Required: {credits}, Available: {user.credits_balance}"
        )

    # 크레딧 차감
    stmt = (
        update(User)
        .where(User.user_id == user_id)
        .values(
            credits_balance=User.credits_balance - credits,
            credits_used_this_month=User.credits_used_this_month + credits,
        )
    )
    await db.execute(stmt)

    # 로그 기록
    credit_log = CreditUsageLog(
        user_id=user_id,
        credits_consumed=credits,
        usage_type=usage_type,
        description=description,
        metadata=metadata,
    )
    db.add(credit_log)

    await db.commit()


async def check_credits(user_id: str, required_credits: int, db: AsyncSession) -> bool:
    """
    크레딧 확인

    Args:
        user_id: 사용자 ID
        required_credits: 필요한 크레딧
        db: Database session

    Returns:
        bool: 충분한 크레딧 보유 여부
    """
    stmt = select(User).where(User.user_id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one()

    # Enterprise는 항상 true
    if user.subscription_plan == "enterprise":
        return True

    return user.credits_balance >= required_credits


async def refund_credits(
    user_id: str,
    credits: int,
    reason: str,
    metadata: dict,
    db: AsyncSession,
):
    """
    크레딧 환불

    Args:
        user_id: 사용자 ID
        credits: 환불할 크레딧
        reason: 환불 이유
        metadata: 메타데이터
        db: Database session
    """
    stmt = (
        update(User)
        .where(User.user_id == user_id)
        .values(
            credits_balance=User.credits_balance + credits,
            credits_used_this_month=User.credits_used_this_month - credits,
        )
    )
    await db.execute(stmt)

    # 로그
    credit_log = CreditUsageLog(
        user_id=user_id,
        credits_consumed=-credits,  # 음수 = 환불
        usage_type="refund",
        description=reason,
        metadata=metadata,
    )
    db.add(credit_log)

    await db.commit()
```

### 6.2 이미지 생성 시 크레딧 차감

```python
# backend/invokeai/app/api/routers/images.py

from invokeai.app.services.credits.manager import consume_credits, check_credits, InsufficientCreditsError

@router.post("/generate")
async def generate_image(
    request: ImageGenerationRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    이미지 생성 API

    크레딧 계산:
    - GPU 사용 시간 1초 = 1크레딧
    - 예상 소요 시간으로 사전 크레딧 차감
    - 실제 소요 시간과 차이나면 환불/추가 차감
    """
    # 1. 예상 크레딧 계산
    estimated_duration = estimate_generation_time(
        model=request.model,
        width=request.width,
        height=request.height,
        steps=request.steps,
    )
    estimated_credits = int(estimated_duration)  # 1초 = 1크레딧

    # 2. 크레딧 확인
    has_enough = await check_credits(current_user.user_id, estimated_credits, db)
    if not has_enough:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Insufficient credits. Required: {estimated_credits}, Available: {current_user.credits_balance}",
        )

    # 3. 사전 크레딧 차감
    try:
        await consume_credits(
            user_id=current_user.user_id,
            credits=estimated_credits,
            usage_type="gpu_generation_precharge",
            description=f"Pre-charge for image generation ({request.model})",
            metadata={
                "model": request.model,
                "width": request.width,
                "height": request.height,
                "steps": request.steps,
                "estimated_duration": estimated_duration,
            },
            db=db,
        )
    except InsufficientCreditsError as e:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=str(e),
        )

    # 4. 이미지 생성 (Celery 큐에 전송)
    start_time = datetime.utcnow()

    task = generate_image_task.delay(
        user_id=str(current_user.user_id),
        model=request.model,
        prompt=request.prompt,
        negative_prompt=request.negative_prompt,
        width=request.width,
        height=request.height,
        steps=request.steps,
        cfg_scale=request.cfg_scale,
    )

    # 5. 태스크 결과 대기
    result = task.get(timeout=300)  # 5분 타임아웃

    actual_duration = (datetime.utcnow() - start_time).total_seconds()
    actual_credits = int(actual_duration)

    # 6. 크레딧 정산
    credit_diff = actual_credits - estimated_credits

    if credit_diff > 0:
        # 추가 차감
        await consume_credits(
            user_id=current_user.user_id,
            credits=credit_diff,
            usage_type="gpu_generation_adjustment",
            description=f"Additional charge for longer generation time",
            metadata={
                "task_id": str(task.id),
                "estimated_duration": estimated_duration,
                "actual_duration": actual_duration,
                "credit_diff": credit_diff,
            },
            db=db,
        )
    elif credit_diff < 0:
        # 환불
        await refund_credits(
            user_id=current_user.user_id,
            credits=abs(credit_diff),
            reason="Faster generation than estimated",
            metadata={
                "task_id": str(task.id),
                "estimated_duration": estimated_duration,
                "actual_duration": actual_duration,
                "credit_diff": credit_diff,
            },
            db=db,
        )

    return {
        "image_id": result["image_id"],
        "image_url": result["image_url"],
        "credits_charged": actual_credits,
        "generation_time": actual_duration,
    }


def estimate_generation_time(model: str, width: int, height: int, steps: int) -> float:
    """
    이미지 생성 예상 시간 계산

    Args:
        model: 모델명
        width: 가로 크기
        height: 세로 크기
        steps: 스텝 수

    Returns:
        float: 예상 소요 시간 (초)
    """
    # 모델별 기본 시간 (초)
    base_times = {
        "sd-1.5": 5,
        "sdxl": 15,
        "flux-dev": 30,
        "flux-schnell": 10,
    }

    base_time = base_times.get(model, 10)

    # 해상도 보정
    resolution_factor = (width * height) / (512 * 512)

    # 스텝 보정
    step_factor = steps / 20

    estimated_time = base_time * resolution_factor * step_factor

    return max(1.0, estimated_time)  # 최소 1초
```

### 6.3 나노바나나 API 크레딧 차감

```python
# backend/invokeai/app/api/routers/nanobanana.py

@router.post("/generate")
async def call_nanobanana_api(
    request: NanobananaRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    나노바나나 API 호출

    크레딧 계산:
    - API 호출 1건 = 20크레딧
    """
    NANOBANANA_COST = 20

    # 1. API 접근 권한 확인
    plan = PLANS[current_user.subscription_plan]

    if not plan.features["api_access"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your plan does not include API access. Please upgrade.",
        )

    # 2. 월간 API 호출 제한 확인 (Enterprise 제외)
    if current_user.subscription_plan != "enterprise":
        api_limit = plan.features["api_monthly_limit"]

        if api_limit > 0:  # -1 = unlimited
            # TODO: 이번 달 API 호출 횟수 조회
            api_calls_this_month = await get_api_calls_this_month(current_user.user_id, db)

            if api_calls_this_month >= api_limit:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"Monthly API limit reached ({api_limit} calls/month).",
                )

    # 3. 크레딧 확인
    has_enough = await check_credits(current_user.user_id, NANOBANANA_COST, db)
    if not has_enough:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Insufficient credits. Required: {NANOBANANA_COST}, Available: {current_user.credits_balance}",
        )

    # 4. 크레딧 차감
    await consume_credits(
        user_id=current_user.user_id,
        credits=NANOBANANA_COST,
        usage_type="api_call",
        description="Nanobanana API call",
        metadata={
            "endpoint": request.endpoint,
            "model": request.model,
        },
        db=db,
    )

    # 5. API 호출
    response = await call_nanobanana_external_api(request)

    return response
```

### 6.4 크레딧 추가 구매 API

```python
# backend/invokeai/app/api/routers/subscriptions.py

class CreditPurchaseRequest(BaseModel):
    """크레딧 구매 요청"""
    amount: Literal[1000, 5000, 10000]  # 1,000 / 5,000 / 10,000 크레딧


@router.post("/buy-credits")
async def buy_additional_credits(
    request: CreditPurchaseRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    추가 크레딧 구매

    가격:
    - 1,000 크레딧 = $10
    - 5,000 크레딧 = $45 (10% 할인)
    - 10,000 크레딧 = $80 (20% 할인)

    정책:
    - 추가 구매 크레딧은 월간 리셋에서 소멸되지 않음
    - 만료 기한 없음
    """
    # 가격 매핑
    pricing = {
        1000: 1000,   # $10.00
        5000: 4500,   # $45.00
        10000: 8000,  # $80.00
    }

    price = pricing[request.amount]

    # Lemon Squeezy 일회성 주문 생성
    checkout_data = await lemon_client.create_checkout(
        store_id=settings.LEMON_SQUEEZY_STORE_ID,
        variant_id=settings.LEMON_SQUEEZY_CREDIT_ADDON_VARIANT_ID,
        user_email=current_user.email,
        user_id=str(current_user.user_id),
        custom_data={
            "user_id": str(current_user.user_id),
            "credits": request.amount,
            "price": price,
        },
        checkout_options={
            "embed": False,
            "media": False,
            "logo": True,
            "desc": True,
            "discount": True,
            "button_color": "#7C3AED",
        }
    )

    return {"checkout_url": checkout_data["checkout_url"]}
```

### 6.5 월간 크레딧 리셋 Cron Job

```python
# backend/invokeai/app/services/cron/credit_reset.py

"""
월간 크레딧 리셋 Cron Job

매월 1일 00:00 UTC에 실행
"""

from sqlalchemy import select, update
from datetime import datetime

from invokeai.app.services.database import get_db
from invokeai.app.models.user import User
from invokeai.app.models.subscription import Subscription
from invokeai.app.models.credit_usage_log import CreditUsageLog
from invokeai.app.core.plans import PLANS


async def reset_monthly_credits():
    """
    모든 유료 플랜 사용자의 월간 크레딧 리셋

    정책:
    - 구독 크레딧: 새로 충전, 기존 소멸
    - 추가 구매 크레딧: 유지
    """
    print(f"🔄 Starting monthly credit reset at {datetime.utcnow()}")

    async with get_db() as db:
        # 활성 구독 조회
        stmt = select(Subscription).where(
            Subscription.is_active == True,
            Subscription.status == "active",
        )
        result = await db.execute(stmt)
        subscriptions = result.scalars().all()

        reset_count = 0

        for subscription in subscriptions:
            plan_info = PLANS[subscription.plan_name]

            # User 조회
            stmt = select(User).where(User.user_id == subscription.user_id)
            result = await db.execute(stmt)
            user = result.scalar_one()

            # 추가 구매 크레딧 유지
            purchased_credits = user.credits_purchased

            # 크레딧 리셋
            stmt = (
                update(User)
                .where(User.user_id == user.user_id)
                .values(
                    credits_balance=plan_info.monthly_credits + purchased_credits,
                    credits_used_this_month=0,
                )
            )
            await db.execute(stmt)

            # 로그
            credit_log = CreditUsageLog(
                user_id=user.user_id,
                credits_consumed=-plan_info.monthly_credits,
                usage_type="monthly_reset",
                description=f"Monthly credit reset for {subscription.plan_name} plan",
                metadata={
                    "plan": subscription.plan_name,
                    "monthly_credits": plan_info.monthly_credits,
                    "purchased_credits_retained": purchased_credits,
                }
            )
            db.add(credit_log)

            reset_count += 1

        await db.commit()

        print(f"✅ Monthly credit reset completed: {reset_count} users reset")


# Kubernetes CronJob 설정
"""
apiVersion: batch/v1
kind: CronJob
metadata:
  name: credit-reset-cron
  namespace: prod
spec:
  schedule: "0 0 1 * *"  # 매월 1일 00:00 UTC
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: credit-reset
            image: pingvasai/backend:latest
            command:
            - python
            - -m
            - invokeai.app.services.cron.credit_reset
          restartPolicy: OnFailure
"""
```

---

## 7. 모델 접근 제어

### 7.1 모델 권한 체크 미들웨어

```python
# backend/invokeai/app/api/dependencies/model_access.py

"""
모델 접근 제어 미들웨어
"""

from fastapi import Depends, HTTPException, status

from invokeai.app.models.user import User
from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.core.plans import PLANS


# 모델 티어 정의
MODEL_TIERS = {
    # Basic 모델 (Free+)
    "sd-1.5": "basic",
    "sd-2.1": "basic",
    "openjourney": "basic",

    # Medium 모델 (Starter+)
    "sdxl-base-1.0": "medium",
    "sdxl-turbo": "medium",
    "juggernaut-xl": "medium",

    # Premium 모델 (Pro+)
    "flux-dev": "premium",
    "flux-schnell": "premium",
    "dall-e-3": "premium",
    "midjourney-v6": "premium",

    # Custom 모델 (Studio+)
    "user-uploaded-model": "custom",
}


def check_model_access(model_name: str, current_user: User = Depends(get_current_active_user)):
    """
    모델 접근 권한 확인

    Args:
        model_name: 모델명
        current_user: 현재 사용자

    Raises:
        HTTPException: 권한 없음
    """
    # 모델 티어 확인
    model_tier = MODEL_TIERS.get(model_name)

    if not model_tier:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Model '{model_name}' not found",
        )

    # 사용자 플랜 확인
    plan = PLANS[current_user.subscription_plan]
    features = plan.features

    # 권한 체크
    if model_tier == "basic" and features["basic_models"]:
        return True
    elif model_tier == "medium" and features["medium_models"]:
        return True
    elif model_tier == "premium" and features["premium_models"]:
        return True
    elif model_tier == "custom" and features["custom_models"]:
        return True

    # 권한 없음
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"Your plan ({current_user.subscription_plan}) does not have access to {model_tier} tier models. Please upgrade.",
    )
```

### 7.2 이미지 생성 API에 적용

```python
# backend/invokeai/app/api/routers/images.py

from invokeai.app.api.dependencies.model_access import check_model_access

@router.post("/generate")
async def generate_image(
    request: ImageGenerationRequest,
    current_user: User = Depends(get_current_active_user),
    model_access: bool = Depends(lambda: check_model_access(request.model, current_user)),  # ✅ 모델 권한 체크
    db: AsyncSession = Depends(get_db),
):
    """
    이미지 생성 API
    """
    # ... (이전 코드)
```

### 7.3 사용 가능한 모델 목록 API

```python
# backend/invokeai/app/api/routers/models.py

"""
모델 관리 API
"""

from fastapi import APIRouter, Depends

from invokeai.app.models.user import User
from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.core.plans import PLANS
from invokeai.app.api.dependencies.model_access import MODEL_TIERS


router = APIRouter(prefix="/models", tags=["Models"])


@router.get("/available")
async def get_available_models(
    current_user: User = Depends(get_current_active_user),
):
    """
    사용자 플랜에서 사용 가능한 모델 목록 조회

    Returns:
        List[Dict]: 모델 목록
    """
    plan = PLANS[current_user.subscription_plan]
    features = plan.features

    available_models = []

    for model_name, tier in MODEL_TIERS.items():
        has_access = False

        if tier == "basic" and features["basic_models"]:
            has_access = True
        elif tier == "medium" and features["medium_models"]:
            has_access = True
        elif tier == "premium" and features["premium_models"]:
            has_access = True
        elif tier == "custom" and features["custom_models"]:
            has_access = True

        if has_access:
            available_models.append({
                "name": model_name,
                "tier": tier,
                "display_name": model_name.replace("-", " ").title(),
            })

    return {
        "plan": current_user.subscription_plan,
        "models": available_models,
    }
```

---

## 8. 프론트엔드 UI

### 8.1 가격 페이지 (Pricing Page)

```tsx
// frontend/src/pages/PricingPage.tsx

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

interface Plan {
  name: string;
  displayName: string;
  monthlyPrice: number;
  yearlyPrice: number;
  credits: number;
  features: string[];
  recommended?: boolean;
}

const plans: Plan[] = [
  {
    name: 'free',
    displayName: 'Free',
    monthlyPrice: 0,
    yearlyPrice: 0,
    credits: 100,
    features: [
      '100 credits/month',
      '1GB storage',
      'Basic models (SD 1.5, SD 2.1)',
      '1 concurrent job',
      'Community support',
    ],
  },
  {
    name: 'starter',
    displayName: 'Starter',
    monthlyPrice: 25,
    yearlyPrice: 250,
    credits: 2500,
    features: [
      '2,500 credits/month',
      '10GB storage',
      'Medium models (SDXL)',
      '2 concurrent jobs',
      'Limited API access (50 calls/month)',
      'Priority queue',
    ],
  },
  {
    name: 'pro',
    displayName: 'Pro',
    monthlyPrice: 75,
    yearlyPrice: 750,
    credits: 10000,
    features: [
      '10,000 credits/month',
      '50GB storage',
      'Premium models (Flux, DALL-E 3)',
      '5 concurrent jobs',
      'Unlimited API access',
      'High priority queue',
      'Priority support',
    ],
    recommended: true,
  },
  {
    name: 'studio',
    displayName: 'Studio',
    monthlyPrice: 150,
    yearlyPrice: 1500,
    credits: 25000,
    features: [
      '25,000 credits/month',
      '200GB storage',
      'All models + Custom uploads',
      '10 concurrent jobs',
      'Unlimited API access',
      'Highest priority queue',
      '24/7 priority support',
    ],
  },
];

export const PricingPage: React.FC = () => {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const navigate = useNavigate();

  const handleSubscribe = async (planName: string) => {
    if (planName === 'free') {
      return;
    }

    try {
      const response = await axios.post('/api/v1/subscriptions/checkout', {
        plan: planName,
        billing_cycle: billingCycle,
      });

      // Lemon Squeezy Checkout으로 리다이렉트
      window.location.href = response.data.checkout_url;
    } catch (error: any) {
      console.error('Checkout error:', error);
      alert(error.response?.data?.detail || 'Failed to create checkout session');
    }
  };

  const getPrice = (plan: Plan) => {
    return billingCycle === 'monthly' ? plan.monthlyPrice : plan.yearlyPrice / 12;
  };

  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-7xl mx-auto px-4">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Choose Your Plan
          </h1>
          <p className="text-xl text-gray-600">
            Credit-based pricing. Pay for what you use.
          </p>

          {/* Billing Cycle Toggle */}
          <div className="mt-8 flex items-center justify-center gap-4">
            <button
              onClick={() => setBillingCycle('monthly')}
              className={`px-6 py-2 rounded-lg font-medium ${
                billingCycle === 'monthly'
                  ? 'bg-purple-600 text-white'
                  : 'bg-white text-gray-700'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBillingCycle('yearly')}
              className={`px-6 py-2 rounded-lg font-medium ${
                billingCycle === 'yearly'
                  ? 'bg-purple-600 text-white'
                  : 'bg-white text-gray-700'
              }`}
            >
              Yearly
              <span className="ml-2 text-sm text-green-500">Save 17%</span>
            </button>
          </div>
        </div>

        {/* Plans Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`bg-white rounded-lg shadow-lg p-8 relative ${
                plan.recommended ? 'ring-2 ring-purple-600' : ''
              }`}
            >
              {plan.recommended && (
                <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
                  <span className="bg-purple-600 text-white px-4 py-1 rounded-full text-sm font-medium">
                    Recommended
                  </span>
                </div>
              )}

              <div className="text-center mb-6">
                <h3 className="text-2xl font-bold text-gray-900 mb-2">
                  {plan.displayName}
                </h3>
                <div className="text-4xl font-bold text-gray-900">
                  ${getPrice(plan)}
                  <span className="text-lg font-normal text-gray-600">/mo</span>
                </div>
                {billingCycle === 'yearly' && plan.monthlyPrice > 0 && (
                  <div className="text-sm text-gray-500 mt-1">
                    ${plan.yearlyPrice}/year
                  </div>
                )}
              </div>

              <div className="mb-6">
                <div className="text-lg font-semibold text-purple-600 mb-4">
                  {plan.credits.toLocaleString()} credits/month
                </div>
                <ul className="space-y-3">
                  {plan.features.map((feature, index) => (
                    <li key={index} className="flex items-start">
                      <svg
                        className="w-5 h-5 text-green-500 mr-2 mt-0.5"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span className="text-gray-600">{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <button
                onClick={() => handleSubscribe(plan.name)}
                disabled={plan.name === 'free'}
                className={`w-full py-3 rounded-lg font-medium ${
                  plan.name === 'free'
                    ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                    : plan.recommended
                    ? 'bg-purple-600 text-white hover:bg-purple-700'
                    : 'bg-gray-900 text-white hover:bg-gray-800'
                }`}
              >
                {plan.name === 'free' ? 'Current Plan' : 'Subscribe'}
              </button>
            </div>
          ))}
        </div>

        {/* Credit Info */}
        <div className="mt-16 bg-white rounded-lg shadow-lg p-8">
          <h3 className="text-2xl font-bold text-gray-900 mb-4">
            How Credits Work
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-semibold text-lg mb-2">GPU Image Generation</h4>
              <p className="text-gray-600">
                1 credit per second of GPU usage
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Example: 30-second generation = 30 credits
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-lg mb-2">Nanobanana API</h4>
              <p className="text-gray-600">
                20 credits per API call
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Available for Starter plan and above
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
```

### 8.2 크레딧 대시보드

```tsx
// frontend/src/components/CreditDashboard.tsx

import React, { useEffect, useState } from 'react';
import axios from 'axios';

interface SubscriptionInfo {
  plan: string;
  billing_cycle: string;
  status: string;
  credits_balance: number;
  credits_used_this_month: number;
  credits_monthly_quota: number;
  credits_purchased: number;
  current_period_end?: string;
}

export const CreditDashboard: React.FC = () => {
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSubscription();
  }, []);

  const fetchSubscription = async () => {
    try {
      const response = await axios.get('/api/v1/subscriptions/current');
      setSubscription(response.data);
    } catch (error) {
      console.error('Failed to fetch subscription:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  if (!subscription) {
    return <div>No subscription found</div>;
  }

  const creditPercentage = (subscription.credits_balance / subscription.credits_monthly_quota) * 100;

  return (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <h2 className="text-2xl font-bold mb-6">Credits & Usage</h2>

      {/* Credit Balance */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-gray-600">Available Credits</span>
          <span className="text-2xl font-bold text-purple-600">
            {subscription.credits_balance.toLocaleString()}
          </span>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-gray-200 rounded-full h-4">
          <div
            className="bg-purple-600 h-4 rounded-full transition-all"
            style={{ width: `${Math.min(creditPercentage, 100)}%` }}
          />
        </div>

        <div className="flex justify-between text-sm text-gray-500 mt-1">
          <span>Used: {subscription.credits_used_this_month.toLocaleString()}</span>
          <span>Quota: {subscription.credits_monthly_quota.toLocaleString()}</span>
        </div>
      </div>

      {/* Purchased Credits */}
      {subscription.credits_purchased > 0 && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <span className="text-gray-700">Purchased Credits (No Expiry)</span>
            <span className="text-lg font-semibold text-green-600">
              +{subscription.credits_purchased.toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {/* Plan Info */}
      <div className="border-t pt-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-gray-600">Current Plan</span>
          <span className="font-semibold capitalize">{subscription.plan}</span>
        </div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-gray-600">Billing Cycle</span>
          <span className="capitalize">{subscription.billing_cycle}</span>
        </div>
        {subscription.current_period_end && (
          <div className="flex justify-between items-center">
            <span className="text-gray-600">Renews On</span>
            <span>{new Date(subscription.current_period_end).toLocaleDateString()}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-6 flex gap-4">
        <button
          onClick={() => window.location.href = '/pricing'}
          className="flex-1 bg-purple-600 text-white py-2 rounded-lg hover:bg-purple-700"
        >
          Upgrade Plan
        </button>
        <button
          onClick={() => window.location.href = '/buy-credits'}
          className="flex-1 bg-gray-200 text-gray-700 py-2 rounded-lg hover:bg-gray-300"
        >
          Buy More Credits
        </button>
      </div>
    </div>
  );
};
```

### 8.3 업그레이드 확인 다이얼로그

```tsx
// frontend/src/components/UpgradeConfirmDialog.tsx

import React from 'react';

interface Props {
  currentPlan: string;
  targetPlan: string;
  billingCycle: 'monthly' | 'yearly';
  daysRemaining: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export const UpgradeConfirmDialog: React.FC<Props> = ({
  currentPlan,
  targetPlan,
  billingCycle,
  daysRemaining,
  onConfirm,
  onCancel,
}) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-8 max-w-md w-full">
        <h3 className="text-2xl font-bold mb-4">Confirm Upgrade</h3>

        <div className="mb-6">
          <p className="text-gray-700 mb-4">
            You are about to upgrade from{' '}
            <span className="font-semibold capitalize">{currentPlan}</span> to{' '}
            <span className="font-semibold capitalize">{targetPlan}</span>.
          </p>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-yellow-800 text-sm">
              ⚠️ <strong>Important:</strong>
            </p>
            <ul className="text-yellow-700 text-sm mt-2 space-y-1">
              <li>• Your subscription will upgrade immediately</li>
              <li>
                • You have <strong>{daysRemaining} days</strong> remaining in your current period
              </li>
              <li>• Your current credits will be replaced with the new plan's credits</li>
              <li>• Unused credits from your current plan will expire</li>
            </ul>
          </div>
        </div>

        <div className="flex gap-4">
          <button
            onClick={onCancel}
            className="flex-1 bg-gray-200 text-gray-700 py-3 rounded-lg hover:bg-gray-300"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-purple-600 text-white py-3 rounded-lg hover:bg-purple-700"
          >
            Confirm Upgrade
          </button>
        </div>
      </div>
    </div>
  );
};
```

---

## 9. 테스트 및 검증

### 9.1 구독 시나리오 테스트

```python
# backend/tests/test_subscriptions.py

"""
구독 시스템 테스트
"""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_checkout_flow(client: AsyncClient, auth_headers):
    """Checkout 플로우 테스트"""
    # 1. Checkout 세션 생성
    response = await client.post(
        "/api/v1/subscriptions/checkout",
        json={"plan": "starter", "billing_cycle": "monthly"},
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert "checkout_url" in response.json()


@pytest.mark.asyncio
async def test_subscription_created_webhook(client: AsyncClient, db_session):
    """subscription_created Webhook 테스트"""
    # Webhook 페이로드
    payload = {
        "meta": {"event_name": "subscription_created"},
        "data": {
            "attributes": {
                "id": "123456",
                "customer_id": "789",
                "variant_id": "starter_monthly_variant_id",
                "product_id": "product_123",
                "status": "active",
                "current_period_start": "2025-01-15T00:00:00Z",
                "current_period_end": "2025-02-15T00:00:00Z",
                "renews_at": "2025-02-15T00:00:00Z",
                "first_subscription_item": {
                    "meta": {
                        "custom_data": {
                            "user_id": "test-user-id"
                        }
                    }
                }
            }
        }
    }

    # TODO: 서명 생성

    response = await client.post(
        "/api/v1/webhooks/lemon",
        json=payload,
        headers={"X-Signature": "valid_signature"}
    )

    assert response.status_code == 200

    # DB 확인
    # TODO: User와 Subscription이 올바르게 생성되었는지 확인


@pytest.mark.asyncio
async def test_credit_consumption(client: AsyncClient, db_session, auth_headers):
    """크레딧 차감 테스트"""
    from invokeai.app.services.credits.manager import consume_credits

    # 초기 크레딧 확인
    response = await client.get("/api/v1/subscriptions/current", headers=auth_headers)
    initial_balance = response.json()["credits_balance"]

    # 크레딧 차감
    await consume_credits(
        user_id="test-user-id",
        credits=50,
        usage_type="test",
        description="Test consumption",
        metadata={},
        db=db_session,
    )

    # 크레딧 확인
    response = await client.get("/api/v1/subscriptions/current", headers=auth_headers)
    new_balance = response.json()["credits_balance"]

    assert new_balance == initial_balance - 50


@pytest.mark.asyncio
async def test_insufficient_credits(client: AsyncClient, auth_headers):
    """크레딧 부족 시 에러 테스트"""
    # Free 플랜 (100 크레딧)에서 고비용 모델 생성 시도
    response = await client.post(
        "/api/v1/images/generate",
        json={
            "model": "flux-dev",  # 약 30초 = 30 크레딧
            "prompt": "test",
            "width": 1024,
            "height": 1024,
            "steps": 50,  # 높은 스텝 → 예상 시간 증가
        },
        headers=auth_headers,
    )

    # 크레딧 부족으로 402 에러 예상
    assert response.status_code == 402


@pytest.mark.asyncio
async def test_model_access_control(client: AsyncClient, auth_headers):
    """모델 접근 제어 테스트"""
    # Free 플랜에서 Premium 모델 접근 시도
    response = await client.post(
        "/api/v1/images/generate",
        json={
            "model": "flux-dev",  # Premium 모델
            "prompt": "test",
        },
        headers=auth_headers,
    )

    # 403 Forbidden 예상
    assert response.status_code == 403
    assert "does not have access" in response.json()["detail"]
```

### 9.2 수동 테스트 체크리스트

#### ✅ 구독 플로우
- [ ] Free → Starter 구독 (Monthly)
- [ ] Free → Pro 구독 (Yearly)
- [ ] Starter → Pro 업그레이드 (확인 메시지 표시)
- [ ] Pro → Starter 다운그레이드
- [ ] 구독 취소 (종료일까지 유지 확인)
- [ ] 구독 만료 시 Free 강등 확인

#### ✅ 크레딧 시스템
- [ ] 구독 시작 시 크레딧 즉시 충전
- [ ] 이미지 생성 시 크레딧 차감 (GPU 시간 기준)
- [ ] 나노바나나 API 호출 시 20크레딧 차감
- [ ] 크레딧 부족 시 402 에러
- [ ] 월간 크레딧 리셋 (매월 1일)
- [ ] 추가 구매 크레딧 유지 (리셋에서 제외)

#### ✅ 모델 접근 제어
- [ ] Free: Basic 모델만 접근 가능
- [ ] Starter: Medium 모델 접근 가능
- [ ] Pro: Premium 모델 접근 가능
- [ ] Studio: Custom 모델 업로드 가능
- [ ] 권한 없는 모델 접근 시 403 에러

#### ✅ Webhook 처리
- [ ] subscription_created → User 업데이트 + 크레딧 충전
- [ ] subscription_updated → 플랜 변경 + 크레딧 재충전
- [ ] subscription_cancelled → 상태 변경 + ends_at 설정
- [ ] subscription_expired → Free 강등 + 크레딧 100으로 리셋
- [ ] subscription_payment_success → 크레딧 재충전
- [ ] order_created → 추가 크레딧 충전

#### ✅ 프론트엔드
- [ ] Pricing 페이지 렌더링
- [ ] Monthly/Yearly 토글
- [ ] Checkout 버튼 → Lemon Squeezy 리다이렉트
- [ ] Credit Dashboard 표시
- [ ] 업그레이드 확인 다이얼로그
- [ ] 크레딧 부족 시 알림

### 9.3 성능 테스트

```python
# backend/tests/test_performance.py

"""
성능 테스트
"""

import pytest
import asyncio
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_concurrent_credit_consumption(db_session):
    """동시 크레딧 차감 테스트 (Race Condition 확인)"""
    from invokeai.app.services.credits.manager import consume_credits

    # 100명의 사용자가 동시에 10크레딧씩 차감
    tasks = [
        consume_credits(
            user_id="test-user-id",
            credits=10,
            usage_type="concurrent_test",
            description=f"Test {i}",
            metadata={},
            db=db_session,
        )
        for i in range(100)
    ]

    # 동시 실행
    await asyncio.gather(*tasks, return_exceptions=True)

    # TODO: 최종 크레딧이 정확히 1000 차감되었는지 확인


@pytest.mark.asyncio
async def test_webhook_processing_time(client: AsyncClient):
    """Webhook 처리 시간 측정"""
    import time

    payload = {
        "meta": {"event_name": "subscription_created"},
        "data": { ... }
    }

    start = time.time()

    response = await client.post(
        "/api/v1/webhooks/lemon",
        json=payload,
        headers={"X-Signature": "valid_signature"}
    )

    elapsed = time.time() - start

    assert response.status_code == 200
    assert elapsed < 1.0  # 1초 이내 처리
```

---

## 🎉 Phase 5 완료!

이제 다음이 구현되었습니다:

✅ **크레딧 기반 과금 시스템**
- GPU 시간: 1초 = 1크레딧
- 나노바나나 API: 1건 = 20크레딧

✅ **7개 구독 플랜**
- Free / Starter / Pro / Studio (Monthly/Yearly) / Enterprise

✅ **Lemon Squeezy 통합**
- Checkout, Webhook, 구독 관리

✅ **모델 접근 제어**
- 플랜별 AI 모델 사용 권한

✅ **프론트엔드 UI**
- Pricing 페이지, Credit Dashboard, 확인 다이얼로그

### 다음 단계

**Phase 6**: User Dashboard (개인 파일, 공유, 검색)
**Phase 7**: Admin Dashboard (모델 관리, 사용자 관리)
**Phase 8**: System Mailing (이메일 인증, 뉴스레터)

---

## 📚 참고 자료

- **Lemon Squeezy API**: https://docs.lemonsqueezy.com/api
- **Webhook 이벤트**: https://docs.lemonsqueezy.com/api/webhooks
- **PostgreSQL RLS**: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- **FastAPI Background Tasks**: https://fastapi.tiangolo.com/tutorial/background-tasks/
- **React Context API**: https://react.dev/reference/react/useContext
