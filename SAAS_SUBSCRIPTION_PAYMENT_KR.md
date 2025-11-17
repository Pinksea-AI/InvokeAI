# Phase 3: 구독 및 결제 시스템

> Stripe를 사용한 구독 기반 SaaS 비즈니스 모델 구축

## 목차

1. [구독 플랜 설계](#1-구독-플랜-설계)
2. [Stripe 통합](#2-stripe-통합)
3. [Webhook 처리](#3-webhook-처리)
4. [할당량 관리](#4-할당량-관리)
5. [플랜 업그레이드/다운그레이드](#5-플랜-업그레이드다운그레이드)

---

## 1. 구독 플랜 설계

### 1.1 플랜 구조

```
┌──────────────────────────────────────────────────────────┐
│                     FREE 플랜                              │
│  - 월 100장 생성                                           │
│  - 기본 모델만 (SD 1.5)                                     │
│  - 512x512 해상도                                          │
│  - 기본 우선순위 (큐 대기 시간 길 수 있음)                     │
│  - $0/월                                                  │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                     PRO 플랜                               │
│  - 월 1,000장 생성                                         │
│  - 모든 모델 (SDXL, FLUX 포함)                             │
│  - 최대 1024x1024 해상도                                   │
│  - 높은 우선순위 (빠른 처리)                                │
│  - ControlNet, IP Adapter                                │
│  - $29/월                                                 │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                  ENTERPRISE 플랜                           │
│  - 무제한 생성                                             │
│  - 모든 기능                                               │
│  - 최대 2048x2048 해상도                                   │
│  - 최우선 순위                                             │
│  - 전용 GPU (optional)                                     │
│  - API 액세스                                              │
│  - 커스텀 모델 학습 (옵션)                                  │
│  - $199/월 (또는 견적 문의)                                 │
└──────────────────────────────────────────────────────────┘
```

### 1.2 데이터베이스 스키마

```sql
-- 구독 플랜 정의
CREATE TABLE subscription_plans (
    id VARCHAR(50) PRIMARY KEY,  -- 'free', 'pro', 'enterprise'
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price_monthly DECIMAL(10, 2) NOT NULL,  -- 월 가격
    price_yearly DECIMAL(10, 2),  -- 연 가격 (할인)

    -- 할당량
    monthly_image_quota INTEGER,  -- NULL = 무제한
    max_resolution_width INTEGER DEFAULT 512,
    max_resolution_height INTEGER DEFAULT 512,

    -- 기능 제한
    allowed_models TEXT[],  -- ['sd15', 'sdxl', 'flux']
    can_use_controlnet BOOLEAN DEFAULT FALSE,
    can_use_ip_adapter BOOLEAN DEFAULT FALSE,
    can_use_api BOOLEAN DEFAULT FALSE,

    -- 우선순위
    queue_priority INTEGER DEFAULT 0,  -- 높을수록 우선

    -- Stripe 정보
    stripe_price_id_monthly VARCHAR(255),
    stripe_price_id_yearly VARCHAR(255),

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 기본 플랜 데이터
INSERT INTO subscription_plans VALUES
('free', 'Free', 'Get started with AI image generation',
 0, 0, 100, 512, 512,
 ARRAY['sd15'], FALSE, FALSE, FALSE, 0,
 NULL, NULL, NOW(), NOW()),

('pro', 'Pro', 'For serious creators',
 29, 290, 1000, 1024, 1024,
 ARRAY['sd15', 'sdxl', 'flux'], TRUE, TRUE, FALSE, 10,
 'price_xxxx', 'price_yyyy', NOW(), NOW()),

('enterprise', 'Enterprise', 'For teams and businesses',
 199, 1990, NULL, 2048, 2048,
 ARRAY['sd15', 'sdxl', 'flux'], TRUE, TRUE, TRUE, 100,
 'price_zzzz', 'price_wwww', NOW(), NOW());


-- 사용자 구독 정보 (users 테이블에 추가)
ALTER TABLE users ADD COLUMN IF NOT EXISTS
    subscription_plan_id VARCHAR(50) DEFAULT 'free' REFERENCES subscription_plans(id),
    subscription_status VARCHAR(50) DEFAULT 'active',  -- active, canceled, past_due

    -- Stripe
    stripe_customer_id VARCHAR(255) UNIQUE,
    stripe_subscription_id VARCHAR(255) UNIQUE,

    -- 할당량 추적
    current_period_start TIMESTAMP,
    current_period_end TIMESTAMP,
    monthly_image_quota INTEGER DEFAULT 100,
    used_quota_this_month INTEGER DEFAULT 0,

    -- 결제 상태
    last_payment_date TIMESTAMP,
    last_payment_amount DECIMAL(10, 2),
    payment_failure_count INTEGER DEFAULT 0;
```

---

## 2. Stripe 통합

### 2.1 Stripe 설정

**1) Stripe 대시보드에서:**

```
1. Stripe 계정 생성: https://stripe.com
2. API 키 가져오기:
   - 개발: Publishable key, Secret key (test mode)
   - 프로덕션: Publishable key, Secret key (live mode)
3. Products 생성:
   - Pro Plan
   - Enterprise Plan
4. Prices 생성:
   - Pro Monthly: $29
   - Pro Yearly: $290 (월 $24.17)
   - Enterprise Monthly: $199
   - Enterprise Yearly: $1990
5. Webhook 설정 (나중에)
```

**2) 백엔드에 Stripe SDK 추가:**

```bash
pip install stripe
```

```python
# invokeai/app/services/billing/stripe_service.py
import stripe
from typing import Optional, List
from datetime import datetime


class StripeService:
    """Stripe 결제 처리 서비스"""

    def __init__(self, api_key: str):
        stripe.api_key = api_key

    def create_customer(
        self,
        user_id: str,
        email: str,
        name: str,
    ) -> str:
        """
        Stripe 고객 생성

        Returns:
            stripe_customer_id
        """
        customer = stripe.Customer.create(
            email=email,
            name=name,
            metadata={"user_id": user_id},
        )

        return customer.id

    def create_subscription(
        self,
        customer_id: str,
        price_id: str,
        trial_days: int = 0,
    ) -> dict:
        """
        구독 생성

        Args:
            customer_id: Stripe 고객 ID
            price_id: Stripe Price ID (예: price_xxxx)
            trial_days: 무료 체험 일수

        Returns:
            구독 정보
        """
        subscription = stripe.Subscription.create(
            customer=customer_id,
            items=[{"price": price_id}],
            trial_period_days=trial_days if trial_days > 0 else None,

            # 결제 실패 시 재시도
            payment_behavior="default_incomplete",
            payment_settings={"save_default_payment_method": "on_subscription"},

            # 메타데이터
            metadata={
                "plan": "pro",  # 또는 'enterprise'
            },
        )

        return {
            "subscription_id": subscription.id,
            "status": subscription.status,
            "current_period_start": datetime.fromtimestamp(subscription.current_period_start),
            "current_period_end": datetime.fromtimestamp(subscription.current_period_end),
            "client_secret": subscription.latest_invoice.payment_intent.client_secret,
        }

    def cancel_subscription(
        self,
        subscription_id: str,
        cancel_at_period_end: bool = True,
    ):
        """
        구독 취소

        Args:
            subscription_id: Stripe 구독 ID
            cancel_at_period_end: True면 기간 종료 시 취소, False면 즉시 취소
        """
        if cancel_at_period_end:
            # 현재 기간 끝까지 사용 가능
            stripe.Subscription.modify(
                subscription_id,
                cancel_at_period_end=True,
            )
        else:
            # 즉시 취소
            stripe.Subscription.delete(subscription_id)

    def change_plan(
        self,
        subscription_id: str,
        new_price_id: str,
        prorate: bool = True,
    ):
        """
        플랜 변경 (업그레이드/다운그레이드)

        Args:
            subscription_id: Stripe 구독 ID
            new_price_id: 새 플랜의 Price ID
            prorate: 비례 배분 (업그레이드 시 차액 청구)
        """
        # 현재 구독 정보 가져오기
        subscription = stripe.Subscription.retrieve(subscription_id)

        # 플랜 변경
        stripe.Subscription.modify(
            subscription_id,
            cancel_at_period_end=False,
            proration_behavior="create_prorations" if prorate else "none",
            items=[{
                "id": subscription["items"]["data"][0].id,
                "price": new_price_id,
            }],
        )

    def create_checkout_session(
        self,
        customer_id: str,
        price_id: str,
        success_url: str,
        cancel_url: str,
    ) -> dict:
        """
        Stripe Checkout 세션 생성 (결제 페이지)

        Returns:
            checkout_url: 사용자를 리다이렉트할 URL
        """
        checkout_session = stripe.checkout.Session.create(
            customer=customer_id,
            mode="subscription",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=success_url,
            cancel_url=cancel_url,

            # 구독 설정
            subscription_data={
                "trial_period_days": 14,  # 14일 무료 체험
                "metadata": {"source": "web"},
            },
        )

        return {
            "checkout_url": checkout_session.url,
            "checkout_id": checkout_session.id,
        }

    def create_customer_portal_session(
        self,
        customer_id: str,
        return_url: str,
    ) -> str:
        """
        고객 포털 세션 생성 (결제 수단 변경, 구독 취소 등)

        Returns:
            portal_url: 고객 포털 URL
        """
        portal_session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
        )

        return portal_session.url
```

### 2.2 API 엔드포인트

```python
# invokeai/app/api/routers/billing.py
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from invokeai.app.api.dependencies import get_current_user, TokenData
from invokeai.app.services.billing.stripe_service import StripeService


router = APIRouter(prefix="/v1/billing", tags=["billing"])


class CreateCheckoutRequest(BaseModel):
    plan_id: str  # 'pro' or 'enterprise'
    billing_cycle: str = "monthly"  # 'monthly' or 'yearly'


class CreateCheckoutResponse(BaseModel):
    checkout_url: str


@router.post("/checkout", response_model=CreateCheckoutResponse)
async def create_checkout(
    request: CreateCheckoutRequest,
    user: TokenData = Depends(get_current_user),
    stripe_service: StripeService = Depends(lambda: ApiDependencies.stripe_service),
    user_service: UserService = Depends(lambda: ApiDependencies.user_service),
):
    """
    Stripe Checkout 세션 생성

    사용자를 Stripe 결제 페이지로 리다이렉트
    """

    # 1. 사용자 정보 조회
    db_user = user_service.get(user.user_id)

    # 2. Stripe 고객 생성 (아직 없다면)
    if not db_user.stripe_customer_id:
        customer_id = stripe_service.create_customer(
            user_id=user.user_id,
            email=user.email,
            name=user.name,
        )

        # DB 업데이트
        user_service.update(user.user_id, stripe_customer_id=customer_id)
    else:
        customer_id = db_user.stripe_customer_id

    # 3. Price ID 가져오기
    price_id = _get_price_id(request.plan_id, request.billing_cycle)

    # 4. Checkout 세션 생성
    checkout = stripe_service.create_checkout_session(
        customer_id=customer_id,
        price_id=price_id,
        success_url="https://yourdomain.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url="https://yourdomain.com/billing/cancel",
    )

    return CreateCheckoutResponse(checkout_url=checkout["checkout_url"])


@router.post("/portal")
async def create_customer_portal(
    user: TokenData = Depends(get_current_user),
    stripe_service: StripeService = Depends(lambda: ApiDependencies.stripe_service),
    user_service: UserService = Depends(lambda: ApiDependencies.user_service),
):
    """
    고객 포털 세션 생성

    사용자가 결제 수단 변경, 구독 취소 등을 할 수 있는 페이지
    """

    db_user = user_service.get(user.user_id)

    if not db_user.stripe_customer_id:
        raise HTTPException(
            status_code=400,
            detail="No subscription found",
        )

    portal_url = stripe_service.create_customer_portal_session(
        customer_id=db_user.stripe_customer_id,
        return_url="https://yourdomain.com/settings/billing",
    )

    return {"portal_url": portal_url}


@router.get("/status")
async def get_billing_status(
    user: TokenData = Depends(get_current_user),
    user_service: UserService = Depends(lambda: ApiDependencies.user_service),
):
    """현재 구독 상태 조회"""

    db_user = user_service.get(user.user_id)

    return {
        "plan": db_user.subscription_plan_id,
        "status": db_user.subscription_status,
        "current_period_end": db_user.current_period_end,
        "monthly_quota": db_user.monthly_image_quota,
        "used_quota": db_user.used_quota_this_month,
        "remaining_quota": db_user.monthly_image_quota - db_user.used_quota_this_month
            if db_user.monthly_image_quota else None,
    }


def _get_price_id(plan_id: str, billing_cycle: str) -> str:
    """플랜과 주기로 Price ID 조회"""

    # 실제로는 DB나 설정 파일에서 가져옴
    price_map = {
        ("pro", "monthly"): "price_pro_monthly_xxxxx",
        ("pro", "yearly"): "price_pro_yearly_xxxxx",
        ("enterprise", "monthly"): "price_ent_monthly_xxxxx",
        ("enterprise", "yearly"): "price_ent_yearly_xxxxx",
    }

    return price_map.get((plan_id, billing_cycle))
```

### 2.3 프론트엔드 통합

```typescript
// src/features/billing/components/UpgradeButton.tsx
import { useCreateCheckoutMutation } from 'services/api';

export const UpgradeButton = ({ plan }: { plan: 'pro' | 'enterprise' }) => {
  const [createCheckout, { isLoading }] = useCreateCheckoutMutation();

  const handleUpgrade = async () => {
    try {
      // Stripe Checkout URL 생성
      const response = await createCheckout({
        plan_id: plan,
        billing_cycle: 'monthly',
      }).unwrap();

      // Stripe 결제 페이지로 리다이렉트
      window.location.href = response.checkout_url;
    } catch (error) {
      console.error('Failed to create checkout:', error);
      toast({
        title: 'Error',
        description: 'Failed to start checkout process',
        status: 'error',
      });
    }
  };

  return (
    <Button
      onClick={handleUpgrade}
      isLoading={isLoading}
      colorScheme="blue"
      size="lg"
    >
      Upgrade to {plan === 'pro' ? 'Pro' : 'Enterprise'}
    </Button>
  );
};
```

---

## 3. Webhook 처리

### 3.1 왜 Webhook이 필요한가?

**문제:**
- 사용자가 Stripe에서 구독을 취소하면?
- 결제 실패하면?
- 플랜을 변경하면?

→ **Stripe에서 발생한 이벤트를 우리 서버가 알아야 함**

### 3.2 Webhook 엔드포인트

```python
# invokeai/app/api/routers/webhooks.py
import hmac
import hashlib
from fastapi import APIRouter, Request, HTTPException, Header


router = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])


@router.post("/stripe")
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(None),
    stripe_service: StripeService = Depends(lambda: ApiDependencies.stripe_service),
    user_service: UserService = Depends(lambda: ApiDependencies.user_service),
):
    """
    Stripe Webhook 처리

    Stripe에서 이벤트 발생 시 자동으로 호출됨
    """

    # 1. 요청 바디 읽기
    payload = await request.body()

    # 2. 서명 검증 (보안 - 중요!)
    webhook_secret = app_config.stripe_webhook_secret

    try:
        event = stripe.Webhook.construct_event(
            payload,
            stripe_signature,
            webhook_secret,
        )
    except ValueError:
        # 잘못된 payload
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.error.SignatureVerificationError:
        # 잘못된 서명
        raise HTTPException(status_code=400, detail="Invalid signature")

    # 3. 이벤트 타입별 처리
    event_type = event["type"]
    event_data = event["data"]["object"]

    if event_type == "customer.subscription.created":
        # 구독 생성됨
        await _handle_subscription_created(event_data, user_service)

    elif event_type == "customer.subscription.updated":
        # 구독 업데이트됨 (플랜 변경 등)
        await _handle_subscription_updated(event_data, user_service)

    elif event_type == "customer.subscription.deleted":
        # 구독 취소됨
        await _handle_subscription_deleted(event_data, user_service)

    elif event_type == "invoice.payment_succeeded":
        # 결제 성공
        await _handle_payment_succeeded(event_data, user_service)

    elif event_type == "invoice.payment_failed":
        # 결제 실패
        await _handle_payment_failed(event_data, user_service)

    else:
        # 처리하지 않는 이벤트
        logger.info(f"Unhandled event type: {event_type}")

    return {"status": "success"}


async def _handle_subscription_created(
    subscription: dict,
    user_service: UserService,
):
    """구독 생성 처리"""

    customer_id = subscription["customer"]

    # 1. 사용자 찾기
    user = user_service.get_by_stripe_customer(customer_id)
    if not user:
        logger.error(f"User not found for customer {customer_id}")
        return

    # 2. 플랜 정보 추출
    plan_id = subscription["items"]["data"][0]["price"]["metadata"].get("plan_id", "pro")

    # 3. 사용자 정보 업데이트
    user_service.update(
        user.id,
        subscription_plan_id=plan_id,
        subscription_status="active",
        stripe_subscription_id=subscription["id"],
        current_period_start=datetime.fromtimestamp(subscription["current_period_start"]),
        current_period_end=datetime.fromtimestamp(subscription["current_period_end"]),
        monthly_image_quota=_get_quota_for_plan(plan_id),
        used_quota_this_month=0,  # 리셋
    )

    # 4. 이메일 발송 (환영 이메일)
    await send_email(
        to=user.email,
        subject="Welcome to Pro!",
        template="subscription_created",
        data={"user": user, "plan": plan_id},
    )


async def _handle_subscription_updated(
    subscription: dict,
    user_service: UserService,
):
    """구독 업데이트 처리"""

    customer_id = subscription["customer"]
    user = user_service.get_by_stripe_customer(customer_id)

    if not user:
        return

    # 플랜 변경 감지
    new_plan_id = subscription["items"]["data"][0]["price"]["metadata"].get("plan_id")

    if new_plan_id != user.subscription_plan_id:
        logger.info(f"User {user.id} changed plan: {user.subscription_plan_id} -> {new_plan_id}")

    # 업데이트
    user_service.update(
        user.id,
        subscription_plan_id=new_plan_id,
        subscription_status=subscription["status"],
        current_period_end=datetime.fromtimestamp(subscription["current_period_end"]),
        monthly_image_quota=_get_quota_for_plan(new_plan_id),
    )


async def _handle_subscription_deleted(
    subscription: dict,
    user_service: UserService,
):
    """구독 취소 처리"""

    customer_id = subscription["customer"]
    user = user_service.get_by_stripe_customer(customer_id)

    if not user:
        return

    # Free 플랜으로 다운그레이드
    user_service.update(
        user.id,
        subscription_plan_id="free",
        subscription_status="canceled",
        monthly_image_quota=100,
        used_quota_this_month=0,
    )

    # 이메일 발송
    await send_email(
        to=user.email,
        subject="Subscription Canceled",
        template="subscription_canceled",
        data={"user": user},
    )


async def _handle_payment_succeeded(
    invoice: dict,
    user_service: UserService,
):
    """결제 성공 처리"""

    customer_id = invoice["customer"]
    user = user_service.get_by_stripe_customer(customer_id)

    if not user:
        return

    # 결제 정보 기록
    user_service.update(
        user.id,
        last_payment_date=datetime.fromtimestamp(invoice["created"]),
        last_payment_amount=invoice["amount_paid"] / 100,  # cents → dollars
        payment_failure_count=0,  # 리셋
    )

    # 할당량 리셋 (월간 구독 갱신 시)
    if invoice["billing_reason"] == "subscription_cycle":
        user_service.update(
            user.id,
            used_quota_this_month=0,
            current_period_start=datetime.fromtimestamp(invoice["period_start"]),
            current_period_end=datetime.fromtimestamp(invoice["period_end"]),
        )


async def _handle_payment_failed(
    invoice: dict,
    user_service: UserService,
):
    """결제 실패 처리"""

    customer_id = invoice["customer"]
    user = user_service.get_by_stripe_customer(customer_id)

    if not user:
        return

    # 실패 카운트 증가
    failure_count = user.payment_failure_count + 1

    user_service.update(
        user.id,
        subscription_status="past_due",
        payment_failure_count=failure_count,
    )

    # 경고 이메일
    await send_email(
        to=user.email,
        subject="Payment Failed",
        template="payment_failed",
        data={
            "user": user,
            "attempt": failure_count,
        },
    )

    # 3번 실패 시 구독 정지
    if failure_count >= 3:
        user_service.update(
            user.id,
            subscription_plan_id="free",
            subscription_status="suspended",
        )


def _get_quota_for_plan(plan_id: str) -> int:
    """플랜별 월간 할당량 반환"""
    quotas = {
        "free": 100,
        "pro": 1000,
        "enterprise": None,  # 무제한
    }
    return quotas.get(plan_id, 100)
```

### 3.3 Stripe에 Webhook URL 등록

```bash
# 1. Stripe CLI 설치 (로컬 테스트용)
brew install stripe/stripe-cli/stripe

# 2. 로컬 테스트
stripe listen --forward-to localhost:9090/api/v1/webhooks/stripe

# 3. 프로덕션 설정 (Stripe 대시보드)
# Developers → Webhooks → Add endpoint
# URL: https://api.yourdomain.com/api/v1/webhooks/stripe
# Events to send:
#   - customer.subscription.created
#   - customer.subscription.updated
#   - customer.subscription.deleted
#   - invoice.payment_succeeded
#   - invoice.payment_failed
```

---

## 4. 할당량 관리

### 4.1 할당량 체크 미들웨어

```python
# invokeai/app/services/quota/quota_service.py
from datetime import datetime
from typing import Optional


class QuotaExceededError(Exception):
    """할당량 초과 에러"""
    pass


class QuotaService:
    """사용량 할당량 관리"""

    def __init__(self, db: Database):
        self._db = db

    async def check_and_consume(
        self,
        user_id: str,
        amount: int = 1,
    ) -> bool:
        """
        할당량 체크 및 차감

        Args:
            user_id: 사용자 ID
            amount: 소비할 양 (기본 1장)

        Returns:
            성공 여부

        Raises:
            QuotaExceededError: 할당량 초과 시
        """

        # 1. 사용자 정보 조회
        user = await self._db.fetch_one(
            "SELECT * FROM users WHERE id = $1",
            user_id,
        )

        # 2. Enterprise 플랜은 무제한
        if user["monthly_image_quota"] is None:
            return True

        # 3. 기간 확인 (월이 바뀌었으면 리셋)
        now = datetime.now()
        if now > user["current_period_end"]:
            await self._reset_quota(user_id)
            user = await self._db.fetch_one(
                "SELECT * FROM users WHERE id = $1",
                user_id,
            )

        # 4. 할당량 체크
        remaining = user["monthly_image_quota"] - user["used_quota_this_month"]

        if remaining < amount:
            raise QuotaExceededError(
                f"Monthly quota exceeded. "
                f"Used: {user['used_quota_this_month']}/{user['monthly_image_quota']}. "
                f"Resets on {user['current_period_end'].strftime('%Y-%m-%d')}."
            )

        # 5. 사용량 증가
        await self._db.execute(
            "UPDATE users SET used_quota_this_month = used_quota_this_month + $1 "
            "WHERE id = $2",
            amount,
            user_id,
        )

        return True

    async def _reset_quota(self, user_id: str):
        """월간 할당량 리셋"""

        now = datetime.now()

        # 다음 달 같은 날짜로 설정
        next_month = now.replace(day=1)
        if next_month.month == 12:
            next_month = next_month.replace(year=next_month.year + 1, month=1)
        else:
            next_month = next_month.replace(month=next_month.month + 1)

        await self._db.execute(
            "UPDATE users SET "
            "used_quota_this_month = 0, "
            "current_period_start = $1, "
            "current_period_end = $2 "
            "WHERE id = $3",
            now,
            next_month,
            user_id,
        )

    async def get_remaining(self, user_id: str) -> Optional[int]:
        """남은 할당량 조회 (None = 무제한)"""

        user = await self._db.fetch_one(
            "SELECT monthly_image_quota, used_quota_this_month "
            "FROM users WHERE id = $1",
            user_id,
        )

        if user["monthly_image_quota"] is None:
            return None  # 무제한

        return user["monthly_image_quota"] - user["used_quota_this_month"]
```

**API 라우터에 적용:**

```python
# invokeai/app/api/routers/session_queue.py
from invokeai.app.services.quota.quota_service import QuotaService, QuotaExceededError


@router.post("/enqueue_batch")
async def enqueue_batch(
    queue_batch: EnqueueBatchParams,
    user: TokenData = Depends(get_current_user),
    queue: SessionQueueService = Depends(ApiDependencies.queue),
    quota: QuotaService = Depends(ApiDependencies.quota),
):
    """배치를 큐에 추가 (할당량 체크)"""

    # 생성할 이미지 수
    num_images = queue_batch.batch_size

    try:
        # 할당량 체크 및 차감
        await quota.check_and_consume(user.user_id, amount=num_images)
    except QuotaExceededError as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(e),
            headers={
                "X-RateLimit-Limit": str(user.monthly_image_quota),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": str(int(user.current_period_end.timestamp())),
            },
        )

    # 큐에 추가
    enqueue_result = queue.enqueue_batch(queue_batch)
    return enqueue_result
```

### 4.2 사용량 추적 대시보드

```python
# invokeai/app/api/routers/usage.py
@router.get("/usage/stats")
async def get_usage_stats(
    user: TokenData = Depends(get_current_user),
    db: Database = Depends(ApiDependencies.db),
):
    """사용량 통계 조회"""

    # 1. 월간 사용량
    monthly_usage = await db.fetch_one(
        """
        SELECT
            COUNT(*) as images_generated,
            SUM(CASE WHEN width * height > 512*512 THEN 1 ELSE 0 END) as high_res_images
        FROM images
        WHERE user_id = $1
          AND created_at >= $2
        """,
        user.user_id,
        user.current_period_start,
    )

    # 2. 모델별 사용량
    model_usage = await db.fetch_all(
        """
        SELECT
            metadata->>'model' as model,
            COUNT(*) as count
        FROM images
        WHERE user_id = $1
          AND created_at >= $2
        GROUP BY metadata->>'model'
        ORDER BY count DESC
        """,
        user.user_id,
        user.current_period_start,
    )

    return {
        "current_period": {
            "start": user.current_period_start,
            "end": user.current_period_end,
        },
        "quota": {
            "limit": user.monthly_image_quota,
            "used": user.used_quota_this_month,
            "remaining": user.monthly_image_quota - user.used_quota_this_month
                if user.monthly_image_quota else None,
        },
        "monthly_usage": monthly_usage,
        "model_usage": model_usage,
    }
```

---

## 5. 플랜 업그레이드/다운그레이드

### 5.1 즉시 업그레이드

```python
@router.post("/upgrade")
async def upgrade_plan(
    new_plan: str,  # 'pro' or 'enterprise'
    user: TokenData = Depends(get_current_user),
    stripe_service: StripeService = Depends(ApiDependencies.stripe_service),
    user_service: UserService = Depends(ApiDependencies.user_service),
):
    """플랜 업그레이드 (즉시 적용)"""

    db_user = user_service.get(user.user_id)

    if not db_user.stripe_subscription_id:
        raise HTTPException(
            status_code=400,
            detail="No active subscription"
        )

    # Stripe에서 플랜 변경
    new_price_id = _get_price_id(new_plan, "monthly")

    stripe_service.change_plan(
        subscription_id=db_user.stripe_subscription_id,
        new_price_id=new_price_id,
        prorate=True,  # 차액 청구
    )

    # DB 업데이트 (webhook에서도 업데이트되지만, 즉시 반영)
    user_service.update(
        user.user_id,
        subscription_plan_id=new_plan,
        monthly_image_quota=_get_quota_for_plan(new_plan),
    )

    return {"status": "success", "new_plan": new_plan}
```

### 5.2 다운그레이드 (기간 종료 시)

```python
@router.post("/downgrade")
async def downgrade_plan(
    new_plan: str,
    user: TokenData = Depends(get_current_user),
    stripe_service: StripeService = Depends(ApiDependencies.stripe_service),
    user_service: UserService = Depends(ApiDependencies.user_service),
):
    """플랜 다운그레이드 (현재 기간 종료 후 적용)"""

    db_user = user_service.get(user.user_id)

    # Stripe에서 플랜 변경 예약
    new_price_id = _get_price_id(new_plan, "monthly")

    # 현재 기간 종료 시 적용되도록 스케줄링
    stripe_service.schedule_plan_change(
        subscription_id=db_user.stripe_subscription_id,
        new_price_id=new_price_id,
        effective_date=db_user.current_period_end,
    )

    return {
        "status": "scheduled",
        "new_plan": new_plan,
        "effective_date": db_user.current_period_end,
    }
```

---

이제 Phase 4-8을 추가로 작성할까요?
