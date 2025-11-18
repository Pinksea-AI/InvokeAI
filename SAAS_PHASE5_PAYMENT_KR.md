# Phase 5: 구독 및 결제 시스템 구현

> Lemon Squeezy 기반 SaaS 구독 결제 완벽 가이드

**소요 시간**: Week 9-10 (2주, 60-80시간)
**난이도**: ⭐⭐⭐⭐ (중상)
**예상 비용**: Lemon Squeezy 수수료 5% + $0.50/transaction

---

## 📋 목차

1. [개요](#1-개요)
2. [Lemon Squeezy 설정](#2-lemon-squeezy-설정)
3. [제품 및 플랜 구성](#3-제품-및-플랜-구성)
4. [Webhook 구현](#4-webhook-구현)
5. [결제 플로우 구현](#5-결제-플로우-구현)
6. [구독 관리](#6-구독-관리)
7. [할당량 시스템](#7-할당량-시스템)
8. [프론트엔드 UI](#8-프론트엔드-ui)
9. [테스트 및 검증](#9-테스트-및-검증)
10. [운영 및 모니터링](#10-운영-및-모니터링)

---

## 1. 개요

### 1.1 목표

이 Phase에서 구현할 핵심 기능:

✅ **결제 시스템**
- Lemon Squeezy 통합 (Merchant of Record)
- 정기 구독 결제 (월간)
- 플랜 업그레이드/다운그레이드
- 환불 및 취소 처리

✅ **구독 플랜**
- **Free**: $0/월, 100 images/month
- **Pro**: $19/월, 1,000 images/month
- **Studio**: $49/월, 5,000 images/month
- **Enterprise**: Custom pricing

✅ **할당량 관리**
- 월간 이미지 생성 제한
- 할당량 초과 시 차단
- 매월 1일 자동 리셋

### 1.2 Lemon Squeezy를 선택한 이유

| 항목 | Lemon Squeezy | Stripe |
|-----|--------------|--------|
| **수수료** | 5% + $0.50 | 2.9% + $0.30 |
| **VAT/Tax 처리** | 자동 (MoR) | 수동 (개발자 책임) |
| **글로벌 결제** | 135+ 국가 | 135+ 국가 |
| **설정 복잡도** | 낮음 | 중간 |
| **매출 한도** | 제한 없음 | 제한 없음 |

**결론**: Lemon Squeezy는 MoR로서 세금 처리를 자동화하므로 초기 스타트업에 적합합니다.

### 1.3 결제 플로우

```
┌─────────────┐
│   사용자     │
│  (Free 플랜) │
└──────┬──────┘
       │ 1. "Pro로 업그레이드" 클릭
       ↓
┌─────────────────────────────────┐
│  FastAPI Backend                │
│  POST /api/v1/subscriptions/    │
│       checkout                  │
│  - Create Lemon Squeezy         │
│    Checkout URL                 │
└──────┬──────────────────────────┘
       │ 2. Checkout URL 반환
       ↓
┌─────────────────────────────────┐
│  Lemon Squeezy Checkout         │
│  (외부 결제 페이지)               │
│  - 카드 정보 입력                │
│  - 결제 완료                     │
└──────┬──────────────────────────┘
       │ 3. Webhook (subscription_created)
       ↓
┌─────────────────────────────────┐
│  FastAPI Webhook Handler        │
│  POST /api/v1/webhooks/lemon    │
│  - 구독 정보 DB 저장             │
│  - 사용자 플랜 업데이트           │
└──────┬──────────────────────────┘
       │ 4. 성공 페이지로 리다이렉트
       ↓
┌─────────────────────────────────┐
│  프론트엔드 Success 페이지        │
│  - "Pro 플랜 활성화 완료!"        │
└─────────────────────────────────┘
```

---

## 2. Lemon Squeezy 설정

### 2.1 계정 생성

1. https://lemonsqueezy.com 접속
2. "Start Selling" → 계정 생성
3. 스토어 이름: "PingvasAI"
4. 카테고리: "Software" 선택

### 2.2 스토어 설정

```bash
# 1. 스토어 정보 입력
Store Name: PingvasAI
Store URL: pingvasai (lemonsqueezy.com/pingvasai)
Currency: USD
Time Zone: Asia/Seoul (UTC+9)

# 2. 결제 수단 설정
Settings → Payments → Payment Methods
✅ Credit Card (Stripe)
✅ PayPal
✅ Google Pay
✅ Apple Pay

# 3. 세금 설정 (자동)
Settings → Tax
✅ Automatic tax collection (MoR)
```

### 2.3 API 키 발급

```bash
# 1. API 키 생성
Settings → API → Create API Key

Name: PingvasAI Production
Permissions: Read & Write

# API 키 복사 (안전하게 보관)
LEMON_SQUEEZY_API_KEY=eyJ0eXAiOiJKV1QiLCJhbGc...

# 2. 스토어 ID 확인
Settings → Store → Store ID
LEMON_SQUEEZY_STORE_ID=12345
```

### 2.4 Webhook 설정

```bash
# 1. Webhook 생성
Settings → Webhooks → Create Webhook

URL: https://api.pingvasai.com/api/v1/webhooks/lemon
Secret: <랜덤 생성된 Signing Secret 복사>

# 2. 이벤트 선택
✅ subscription_created
✅ subscription_updated
✅ subscription_cancelled
✅ subscription_resumed
✅ subscription_expired
✅ subscription_payment_success
✅ subscription_payment_failed

# Signing Secret 저장
LEMON_SQUEEZY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxx
```

---

## 3. 제품 및 플랜 구성

### 3.1 제품 생성 (Products)

Lemon Squeezy Dashboard에서 제품 생성:

```bash
# 1. Products → Create Product

Product Name: PingvasAI Subscription
Description: AI-powered image generation platform
Type: Subscription
```

### 3.2 Variants (플랜) 생성

각 플랜을 Variant로 생성:

#### Pro 플랜

```yaml
Name: Pro Plan
Price: $19.00 USD
Billing Cycle: Monthly
Trial Period: 7 days (옵션)
Description: |
  - 1,000 images per month
  - Priority queue
  - Advanced AI models
  - Email support
```

#### Studio 플랜

```yaml
Name: Studio Plan
Price: $49.00 USD
Billing Cycle: Monthly
Trial Period: 7 days (옵션)
Description: |
  - 5,000 images per month
  - Fastest queue
  - All AI models
  - Priority email support
  - Custom models (beta)
```

#### Enterprise 플랜

```yaml
Name: Enterprise Plan
Price: Custom (Contact Sales)
Type: Custom (Manual billing)
Description: |
  - Unlimited images
  - Dedicated infrastructure
  - SLA guarantee
  - 24/7 phone support
  - Custom integrations
```

### 3.3 Variant ID 확인

각 플랜의 Variant ID를 메모:

```bash
# Products → PingvasAI Subscription → Variants

Pro Plan:        variant_id_123456
Studio Plan:     variant_id_789012
Enterprise Plan: (Custom, Variant 없음)
```

---

## 4. Webhook 구현

### 4.1 Webhook 모델 정의

```python
# backend/invokeai/app/models/subscription.py

"""
구독 관련 모델
"""

from sqlalchemy import Column, String, Integer, TIMESTAMP, Boolean, Enum
from sqlalchemy.dialects.postgresql import UUID
import enum

from invokeai.app.services.database import Base


class SubscriptionStatus(str, enum.Enum):
    """구독 상태"""
    ACTIVE = "active"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    PAST_DUE = "past_due"
    PAUSED = "paused"


class Subscription(Base):
    """
    Lemon Squeezy 구독 정보
    """
    __tablename__ = "subscriptions"
    __table_args__ = {"schema": "prod"}  # 또는 "dev"

    subscription_id = Column(UUID(as_uuid=True), primary_key=True)
    user_id = Column(UUID(as_uuid=True), nullable=False, index=True)

    # Lemon Squeezy 정보
    lemon_squeezy_id = Column(String(255), unique=True, nullable=False)
    lemon_squeezy_customer_id = Column(String(255))
    lemon_squeezy_variant_id = Column(String(255), nullable=False)
    lemon_squeezy_product_id = Column(String(255))

    # 구독 정보
    status = Column(Enum(SubscriptionStatus), default=SubscriptionStatus.ACTIVE)
    plan_name = Column(String(50))  # "pro", "studio", "enterprise"

    # 결제 정보
    amount = Column(Integer)  # Cents (e.g., 1900 = $19.00)
    currency = Column(String(3), default="USD")
    billing_cycle = Column(String(20), default="monthly")

    # 날짜 정보
    trial_ends_at = Column(TIMESTAMP, nullable=True)
    renews_at = Column(TIMESTAMP)
    ends_at = Column(TIMESTAMP, nullable=True)
    created_at = Column(TIMESTAMP, nullable=False)
    updated_at = Column(TIMESTAMP)

    # 상태
    is_active = Column(Boolean, default=True)
```

### 4.2 Webhook 서명 검증

```python
# backend/invokeai/app/services/lemon_squeezy/webhook.py

"""
Lemon Squeezy Webhook 서명 검증
"""

import hmac
import hashlib
from fastapi import HTTPException, status


def verify_webhook_signature(payload: bytes, signature: str, secret: str) -> bool:
    """
    Webhook 서명 검증

    Args:
        payload: 요청 본문 (raw bytes)
        signature: X-Signature 헤더 값
        secret: Webhook Signing Secret

    Returns:
        bool: 서명이 유효하면 True

    Raises:
        HTTPException: 서명이 유효하지 않을 때
    """
    # HMAC-SHA256 해시 계산
    expected_signature = hmac.new(
        secret.encode('utf-8'),
        payload,
        hashlib.sha256
    ).hexdigest()

    # 서명 비교 (Timing Attack 방지)
    if not hmac.compare_digest(signature, expected_signature):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook signature",
        )

    return True
```

### 4.3 Webhook 핸들러

```python
# backend/invokeai/app/api/routers/webhooks.py

"""
Lemon Squeezy Webhook 엔드포인트
"""

from fastapi import APIRouter, Request, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from typing import Optional
import logging

from invokeai.app.services.database import get_db
from invokeai.app.services.lemon_squeezy.webhook import verify_webhook_signature
from invokeai.app.models.user import User
from invokeai.app.models.subscription import Subscription, SubscriptionStatus
from invokeai.app.core.config import settings


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["Webhooks"])


@router.post("/lemon")
async def lemon_squeezy_webhook(
    request: Request,
    x_signature: str = Header(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Lemon Squeezy Webhook 핸들러

    Args:
        request: FastAPI Request
        x_signature: Webhook 서명 (헤더)
        db: Database session

    Returns:
        dict: 성공 메시지
    """
    # 1. 요청 본문 읽기
    payload = await request.body()

    # 2. 서명 검증
    verify_webhook_signature(
        payload,
        x_signature,
        settings.LEMON_SQUEEZY_WEBHOOK_SECRET
    )

    # 3. JSON 파싱
    data = await request.json()
    event_name = data.get("meta", {}).get("event_name")
    attributes = data.get("data", {}).get("attributes", {})

    logger.info(f"Received Lemon Squeezy webhook: {event_name}")

    # 4. 이벤트 처리
    if event_name == "subscription_created":
        await handle_subscription_created(db, attributes)
    elif event_name == "subscription_updated":
        await handle_subscription_updated(db, attributes)
    elif event_name == "subscription_cancelled":
        await handle_subscription_cancelled(db, attributes)
    elif event_name == "subscription_expired":
        await handle_subscription_expired(db, attributes)
    elif event_name == "subscription_payment_success":
        await handle_payment_success(db, attributes)
    elif event_name == "subscription_payment_failed":
        await handle_payment_failed(db, attributes)
    else:
        logger.warning(f"Unknown webhook event: {event_name}")

    return {"status": "success"}


async def handle_subscription_created(db: AsyncSession, attributes: dict):
    """
    구독 생성 이벤트 처리

    Args:
        db: Database session
        attributes: Webhook payload attributes
    """
    from datetime import datetime

    # Lemon Squeezy ID
    lemon_id = str(attributes.get("id"))
    customer_id = str(attributes.get("customer_id"))
    variant_id = str(attributes.get("variant_id"))
    product_id = str(attributes.get("product_id"))

    # 사용자 조회 (customer_id로)
    stmt = select(User).where(User.lemon_squeezy_customer_id == customer_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        logger.error(f"User not found for customer_id: {customer_id}")
        return

    # 플랜 이름 매핑
    plan_name = get_plan_name_from_variant(variant_id)

    # 구독 생성
    subscription = Subscription(
        user_id=user.user_id,
        lemon_squeezy_id=lemon_id,
        lemon_squeezy_customer_id=customer_id,
        lemon_squeezy_variant_id=variant_id,
        lemon_squeezy_product_id=product_id,
        status=SubscriptionStatus.ACTIVE,
        plan_name=plan_name,
        amount=attributes.get("first_subscription_item", {}).get("price"),
        renews_at=datetime.fromisoformat(attributes.get("renews_at")),
        created_at=datetime.fromisoformat(attributes.get("created_at")),
    )

    db.add(subscription)

    # 사용자 플랜 업데이트
    user.subscription_plan = plan_name
    user.subscription_status = "active"
    user.lemon_squeezy_subscription_id = lemon_id
    user.monthly_image_quota = get_quota_for_plan(plan_name)

    await db.commit()

    logger.info(f"Subscription created for user {user.user_id}: {plan_name}")


async def handle_subscription_updated(db: AsyncSession, attributes: dict):
    """구독 업데이트 이벤트 처리"""
    from datetime import datetime

    lemon_id = str(attributes.get("id"))

    # 구독 조회
    stmt = select(Subscription).where(Subscription.lemon_squeezy_id == lemon_id)
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        logger.warning(f"Subscription not found: {lemon_id}")
        return

    # 구독 업데이트
    subscription.status = SubscriptionStatus(attributes.get("status"))
    subscription.renews_at = datetime.fromisoformat(attributes.get("renews_at"))
    subscription.updated_at = datetime.utcnow()

    # 사용자 플랜 동기화
    stmt = select(User).where(User.user_id == subscription.user_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if user:
        user.subscription_status = subscription.status.value

    await db.commit()

    logger.info(f"Subscription updated: {lemon_id} → {subscription.status}")


async def handle_subscription_cancelled(db: AsyncSession, attributes: dict):
    """구독 취소 이벤트 처리"""
    from datetime import datetime

    lemon_id = str(attributes.get("id"))

    # 구독 업데이트
    stmt = update(Subscription).where(
        Subscription.lemon_squeezy_id == lemon_id
    ).values(
        status=SubscriptionStatus.CANCELLED,
        ends_at=datetime.fromisoformat(attributes.get("ends_at")),
        updated_at=datetime.utcnow(),
    )

    await db.execute(stmt)
    await db.commit()

    logger.info(f"Subscription cancelled: {lemon_id}")


async def handle_subscription_expired(db: AsyncSession, attributes: dict):
    """구독 만료 이벤트 처리"""
    from datetime import datetime

    lemon_id = str(attributes.get("id"))

    # 구독 만료 처리
    stmt = select(Subscription).where(Subscription.lemon_squeezy_id == lemon_id)
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if subscription:
        subscription.status = SubscriptionStatus.EXPIRED
        subscription.is_active = False

        # 사용자 플랜 다운그레이드 (Free로)
        stmt = select(User).where(User.user_id == subscription.user_id)
        result = await db.execute(stmt)
        user = result.scalar_one_or_none()

        if user:
            user.subscription_plan = "free"
            user.subscription_status = "expired"
            user.monthly_image_quota = 100  # Free 플랜 할당량

        await db.commit()

        logger.info(f"Subscription expired: {lemon_id}")


async def handle_payment_success(db: AsyncSession, attributes: dict):
    """결제 성공 이벤트 처리"""
    lemon_id = str(attributes.get("subscription_id"))

    # 구독 갱신 날짜 업데이트
    stmt = select(Subscription).where(Subscription.lemon_squeezy_id == lemon_id)
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if subscription:
        from datetime import datetime
        subscription.renews_at = datetime.fromisoformat(attributes.get("renews_at"))
        await db.commit()

        logger.info(f"Payment successful for subscription: {lemon_id}")


async def handle_payment_failed(db: AsyncSession, attributes: dict):
    """결제 실패 이벤트 처리"""
    lemon_id = str(attributes.get("subscription_id"))

    # 구독 상태 변경
    stmt = update(Subscription).where(
        Subscription.lemon_squeezy_id == lemon_id
    ).values(
        status=SubscriptionStatus.PAST_DUE,
    )

    await db.execute(stmt)
    await db.commit()

    logger.warning(f"Payment failed for subscription: {lemon_id}")


def get_plan_name_from_variant(variant_id: str) -> str:
    """
    Variant ID로 플랜 이름 조회

    Args:
        variant_id: Lemon Squeezy Variant ID

    Returns:
        str: "pro", "studio", 또는 "free"
    """
    # 환경 변수에서 Variant ID 매핑
    variant_mapping = {
        settings.LEMON_SQUEEZY_PRO_VARIANT_ID: "pro",
        settings.LEMON_SQUEEZY_STUDIO_VARIANT_ID: "studio",
    }

    return variant_mapping.get(variant_id, "free")


def get_quota_for_plan(plan_name: str) -> int:
    """
    플랜별 할당량 반환

    Args:
        plan_name: "free", "pro", "studio", "enterprise"

    Returns:
        int: 월간 이미지 생성 할당량
    """
    quota_mapping = {
        "free": 100,
        "pro": 1000,
        "studio": 5000,
        "enterprise": 999999,  # Unlimited
    }

    return quota_mapping.get(plan_name, 100)
```

---

## 5. 결제 플로우 구현

### 5.1 Checkout URL 생성

```python
# backend/invokeai/app/services/lemon_squeezy/client.py

"""
Lemon Squeezy API 클라이언트
"""

import httpx
from typing import Dict, Optional
from fastapi import HTTPException, status

from invokeai.app.core.config import settings


class LemonSqueezyClient:
    """Lemon Squeezy API 클라이언트"""

    BASE_URL = "https://api.lemonsqueezy.com/v1"

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/vnd.api+json",
            "Accept": "application/vnd.api+json",
        }

    async def create_checkout(
        self,
        store_id: str,
        variant_id: str,
        user_email: str,
        user_id: str,
        custom_data: Optional[Dict] = None,
    ) -> Dict:
        """
        Checkout 세션 생성

        Args:
            store_id: Lemon Squeezy Store ID
            variant_id: Product Variant ID
            user_email: 사용자 이메일
            user_id: 사용자 UUID
            custom_data: 커스텀 데이터 (옵션)

        Returns:
            Dict: Checkout URL 및 정보

        Raises:
            HTTPException: API 호출 실패 시
        """
        checkout_data = {
            "data": {
                "type": "checkouts",
                "attributes": {
                    "checkout_data": {
                        "email": user_email,
                        "custom": custom_data or {"user_id": user_id},
                    }
                },
                "relationships": {
                    "store": {
                        "data": {
                            "type": "stores",
                            "id": store_id,
                        }
                    },
                    "variant": {
                        "data": {
                            "type": "variants",
                            "id": variant_id,
                        }
                    },
                },
            }
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.BASE_URL}/checkouts",
                headers=self.headers,
                json=checkout_data,
                timeout=30.0,
            )

            if response.status_code != 201:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Failed to create checkout: {response.text}",
                )

            data = response.json()
            checkout_url = data["data"]["attributes"]["url"]

            return {
                "checkout_url": checkout_url,
                "checkout_id": data["data"]["id"],
            }

    async def get_subscription(self, subscription_id: str) -> Dict:
        """
        구독 정보 조회

        Args:
            subscription_id: Lemon Squeezy Subscription ID

        Returns:
            Dict: 구독 정보
        """
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.BASE_URL}/subscriptions/{subscription_id}",
                headers=self.headers,
                timeout=30.0,
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Subscription not found",
                )

            return response.json()

    async def cancel_subscription(self, subscription_id: str) -> Dict:
        """
        구독 취소

        Args:
            subscription_id: Lemon Squeezy Subscription ID

        Returns:
            Dict: 취소된 구독 정보
        """
        cancel_data = {
            "data": {
                "type": "subscriptions",
                "id": subscription_id,
                "attributes": {
                    "cancelled": True
                }
            }
        }

        async with httpx.AsyncClient() as client:
            response = await client.patch(
                f"{self.BASE_URL}/subscriptions/{subscription_id}",
                headers=self.headers,
                json=cancel_data,
                timeout=30.0,
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to cancel subscription",
                )

            return response.json()
```

### 5.2 구독 API 엔드포인트

```python
# backend/invokeai/app/api/routers/subscriptions.py

"""
구독 관리 API
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

from invokeai.app.services.database import get_db
from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.services.lemon_squeezy.client import LemonSqueezyClient
from invokeai.app.models.user import User
from invokeai.app.models.subscription import Subscription
from invokeai.app.core.config import settings


router = APIRouter(prefix="/subscriptions", tags=["Subscriptions"])

# Lemon Squeezy 클라이언트
lemon_client = LemonSqueezyClient(api_key=settings.LEMON_SQUEEZY_API_KEY)


class CheckoutRequest(BaseModel):
    """Checkout 요청"""
    plan: str  # "pro" or "studio"


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
        request: Checkout 요청 (플랜)
        current_user: 현재 사용자
        db: Database session

    Returns:
        CheckoutResponse: Checkout URL
    """
    # 이미 구독 중인지 확인
    if current_user.subscription_plan in ["pro", "studio", "enterprise"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You already have an active subscription. Please cancel it first.",
        )

    # Variant ID 선택
    variant_id = None
    if request.plan == "pro":
        variant_id = settings.LEMON_SQUEEZY_PRO_VARIANT_ID
    elif request.plan == "studio":
        variant_id = settings.LEMON_SQUEEZY_STUDIO_VARIANT_ID
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid plan. Choose 'pro' or 'studio'.",
        )

    # Checkout 세션 생성
    checkout_data = await lemon_client.create_checkout(
        store_id=settings.LEMON_SQUEEZY_STORE_ID,
        variant_id=variant_id,
        user_email=current_user.email,
        user_id=str(current_user.user_id),
    )

    return CheckoutResponse(checkout_url=checkout_data["checkout_url"])


@router.get("/current")
async def get_current_subscription(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    현재 사용자의 구독 정보 조회

    Args:
        current_user: 현재 사용자
        db: Database session

    Returns:
        Dict: 구독 정보
    """
    stmt = select(Subscription).where(
        Subscription.user_id == current_user.user_id,
        Subscription.is_active == True,
    )
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        return {
            "plan": "free",
            "status": "active",
            "quota": 100,
        }

    return {
        "plan": subscription.plan_name,
        "status": subscription.status.value,
        "amount": subscription.amount / 100,  # Cents to Dollars
        "renews_at": subscription.renews_at.isoformat(),
        "quota": current_user.monthly_image_quota,
    }


@router.post("/cancel")
async def cancel_subscription(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    구독 취소

    Args:
        current_user: 현재 사용자
        db: Database session

    Returns:
        Dict: 성공 메시지
    """
    # 활성 구독 조회
    stmt = select(Subscription).where(
        Subscription.user_id == current_user.user_id,
        Subscription.is_active == True,
    )
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active subscription found",
        )

    # Lemon Squeezy에서 취소
    await lemon_client.cancel_subscription(subscription.lemon_squeezy_id)

    return {
        "message": "Subscription cancelled successfully",
        "ends_at": subscription.renews_at.isoformat(),
    }
```


@router.get("/portal")
async def get_customer_portal(
    current_user: User = Depends(get_current_active_user),
):
    """
    Lemon Squeezy 고객 포털 URL 생성

    Args:
        current_user: 현재 사용자

    Returns:
        Dict: 포털 URL
    """
    if not current_user.lemon_squeezy_customer_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No subscription found",
        )

    # Lemon Squeezy 고객 포털 URL
    portal_url = f"https://app.lemonsqueezy.com/my-orders/{current_user.lemon_squeezy_customer_id}"

    return {"portal_url": portal_url}
```

---

## 6. 구독 관리

### 6.1 플랜 변경 (업그레이드/다운그레이드)

```python
# backend/invokeai/app/api/routers/subscriptions.py (추가)

@router.post("/change-plan")
async def change_subscription_plan(
    new_plan: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    구독 플랜 변경

    Args:
        new_plan: 새 플랜 ("pro" or "studio")
        current_user: 현재 사용자
        db: Database session

    Returns:
        Dict: 변경된 구독 정보
    """
    # 활성 구독 조회
    stmt = select(Subscription).where(
        Subscription.user_id == current_user.user_id,
        Subscription.is_active == True,
    )
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active subscription found",
        )

    # 같은 플랜이면 에러
    if subscription.plan_name == new_plan:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You are already on this plan",
        )

    # 새 Variant ID
    new_variant_id = None
    if new_plan == "pro":
        new_variant_id = settings.LEMON_SQUEEZY_PRO_VARIANT_ID
    elif new_plan == "studio":
        new_variant_id = settings.LEMON_SQUEEZY_STUDIO_VARIANT_ID
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid plan",
        )

    # Lemon Squeezy에서 플랜 변경
    update_data = {
        "data": {
            "type": "subscriptions",
            "id": subscription.lemon_squeezy_id,
            "attributes": {
                "variant_id": int(new_variant_id)
            }
        }
    }

    async with httpx.AsyncClient() as client:
        response = await client.patch(
            f"{lemon_client.BASE_URL}/subscriptions/{subscription.lemon_squeezy_id}",
            headers=lemon_client.headers,
            json=update_data,
            timeout=30.0,
        )

        if response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to change plan",
            )

    # DB 업데이트 (Webhook에서도 업데이트되지만 즉시 반영)
    subscription.plan_name = new_plan
    subscription.lemon_squeezy_variant_id = new_variant_id
    current_user.subscription_plan = new_plan
    current_user.monthly_image_quota = get_quota_for_plan(new_plan)

    await db.commit()

    return {
        "message": "Plan changed successfully",
        "new_plan": new_plan,
        "new_quota": current_user.monthly_image_quota,
    }
```

### 6.2 구독 일시 정지

```python
@router.post("/pause")
async def pause_subscription(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    구독 일시 정지 (Lemon Squeezy Pro 기능)

    Args:
        current_user: 현재 사용자
        db: Database session

    Returns:
        Dict: 성공 메시지
    """
    stmt = select(Subscription).where(
        Subscription.user_id == current_user.user_id,
        Subscription.is_active == True,
    )
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()

    if not subscription:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active subscription found",
        )

    # Lemon Squeezy에서 일시 정지
    pause_data = {
        "data": {
            "type": "subscriptions",
            "id": subscription.lemon_squeezy_id,
            "attributes": {
                "pause": {
                    "mode": "void"  # 또는 "free" (무료 모드로 전환)
                }
            }
        }
    }

    async with httpx.AsyncClient() as client:
        response = await client.patch(
            f"{lemon_client.BASE_URL}/subscriptions/{subscription.lemon_squeezy_id}",
            headers=lemon_client.headers,
            json=pause_data,
            timeout=30.0,
        )

        if response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to pause subscription",
            )

    # DB 업데이트
    subscription.status = SubscriptionStatus.PAUSED
    current_user.subscription_status = "paused"

    await db.commit()

    return {"message": "Subscription paused successfully"}
```

### 6.3 환불 처리

```python
@router.post("/refund")
async def request_refund(
    reason: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    환불 요청 (관리자 승인 필요)

    Args:
        reason: 환불 사유
        current_user: 현재 사용자
        db: Database session

    Returns:
        Dict: 성공 메시지
    """
    # 환불 요청 로그 저장
    from invokeai.app.models.refund_request import RefundRequest

    refund_request = RefundRequest(
        user_id=current_user.user_id,
        subscription_id=current_user.lemon_squeezy_subscription_id,
        reason=reason,
        status="pending",
    )

    db.add(refund_request)
    await db.commit()

    # TODO: 관리자에게 이메일 알림 전송

    return {
        "message": "Refund request submitted. Our team will review it within 3 business days.",
        "request_id": refund_request.request_id,
    }
```

---

## 7. 할당량 시스템

### 7.1 할당량 확인 미들웨어

```python
# backend/invokeai/app/api/dependencies/quota.py

"""
할당량 검증 Dependency
"""

from fastapi import Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from invokeai.app.services.database import get_db
from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.models.user import User


async def check_quota(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    사용자 할당량 확인

    Args:
        current_user: 현재 사용자
        db: Database session

    Returns:
        User: 할당량이 남은 사용자

    Raises:
        HTTPException: 할당량 초과 시
    """
    # 할당량 확인
    if current_user.monthly_images_generated >= current_user.monthly_image_quota:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "message": "Monthly quota exceeded",
                "quota": current_user.monthly_image_quota,
                "used": current_user.monthly_images_generated,
                "plan": current_user.subscription_plan,
                "upgrade_url": "/pricing",
            },
        )

    return current_user
```

### 7.2 할당량 소비

```python
# backend/invokeai/app/api/routers/images.py (수정)

from invokeai.app.api.dependencies.quota import check_quota


@router.post("/generate")
async def generate_image(
    prompt: str,
    current_user: User = Depends(check_quota),  # 할당량 확인
    db: AsyncSession = Depends(get_db),
):
    """
    이미지 생성 (할당량 차감)

    Args:
        prompt: 생성 프롬프트
        current_user: 할당량이 확인된 사용자
        db: Database session

    Returns:
        Dict: 생성된 이미지 정보
    """
    # 이미지 생성 로직
    # ... (생략)

    # 할당량 차감
    current_user.monthly_images_generated += 1
    await db.commit()

    return {
        "image_url": "s3://...",
        "quota_remaining": current_user.monthly_image_quota - current_user.monthly_images_generated,
    }
```

### 7.3 할당량 리셋 (Cron Job)

```python
# backend/invokeai/app/tasks/quota_reset.py

"""
월간 할당량 리셋 (매월 1일 00:00 UTC 실행)
"""

import asyncio
from sqlalchemy import update
from datetime import datetime, timedelta

from invokeai.app.services.database import AsyncSessionLocal


async def reset_monthly_quotas():
    """
    모든 사용자의 월간 할당량 리셋

    Returns:
        int: 리셋된 사용자 수
    """
    async with AsyncSessionLocal() as db:
        # 모든 사용자의 할당량 리셋
        stmt = update(User).values(
            monthly_images_generated=0,
            quota_reset_date=datetime.utcnow(),
        )

        result = await db.execute(stmt)
        await db.commit()

        reset_count = result.rowcount
        print(f"Reset quota for {reset_count} users")

        return reset_count


if __name__ == "__main__":
    # Cron으로 실행
    asyncio.run(reset_monthly_quotas())
```

**Kubernetes CronJob 설정:**

```yaml
# kubernetes/prod/cronjob-quota-reset.yaml

apiVersion: batch/v1
kind: CronJob
metadata:
  name: quota-reset
  namespace: prod
spec:
  schedule: "0 0 1 * *"  # 매월 1일 00:00 UTC
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: quota-reset
            image: <ECR_REPO>/pingvasai-api:latest
            command: ["python", "-m", "invokeai.app.tasks.quota_reset"]
            env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: auth-secrets
                  key: DATABASE_URL
          restartPolicy: OnFailure
```

---

## 8. 프론트엔드 UI

### 8.1 Pricing 페이지

```typescript
// frontend/src/pages/Pricing.tsx

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

const Pricing: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const [loading, setLoading] = React.useState<string | null>(null);

  const plans = [
    {
      name: 'Free',
      price: 0,
      period: 'forever',
      quota: 100,
      features: [
        '100 images per month',
        'Basic AI models',
        'Standard queue',
        'Community support',
      ],
      cta: 'Current Plan',
      planKey: 'free',
    },
    {
      name: 'Pro',
      price: 19,
      period: 'month',
      quota: 1000,
      features: [
        '1,000 images per month',
        'Advanced AI models',
        'Priority queue',
        'Email support',
        '7-day free trial',
      ],
      cta: 'Upgrade to Pro',
      planKey: 'pro',
      popular: true,
    },
    {
      name: 'Studio',
      price: 49,
      period: 'month',
      quota: 5000,
      features: [
        '5,000 images per month',
        'All AI models',
        'Fastest queue',
        'Priority email support',
        'Custom models (beta)',
        '7-day free trial',
      ],
      cta: 'Upgrade to Studio',
      planKey: 'studio',
    },
  ];

  const handleSubscribe = async (planKey: string) => {
    if (!isAuthenticated) {
      navigate('/login?redirect=/pricing');
      return;
    }

    if (planKey === 'free') {
      return;
    }

    setLoading(planKey);

    try {
      // Checkout 세션 생성
      const response = await api.post('/subscriptions/checkout', {
        plan: planKey,
      });

      // Lemon Squeezy Checkout 페이지로 리다이렉트
      window.location.href = response.data.checkout_url;
    } catch (error: any) {
      console.error('Checkout failed:', error);
      alert(error.response?.data?.detail || 'Failed to create checkout session');
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Simple, Transparent Pricing
          </h1>
          <p className="text-xl text-gray-600">
            Choose the plan that fits your creative needs
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {plans.map((plan) => {
            const isCurrentPlan = user?.subscription_plan === plan.planKey;

            return (
              <div
                key={plan.planKey}
                className={`bg-white rounded-lg shadow-lg p-8 relative ${
                  plan.popular ? 'border-2 border-blue-500' : ''
                }`}
              >
                {plan.popular && (
                  <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
                    <span className="bg-blue-500 text-white px-4 py-1 rounded-full text-sm font-semibold">
                      Most Popular
                    </span>
                  </div>
                )}

                <div className="text-center mb-6">
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">
                    {plan.name}
                  </h2>
                  <div className="mb-4">
                    <span className="text-5xl font-bold text-gray-900">
                      ${plan.price}
                    </span>
                    <span className="text-gray-600">/{plan.period}</span>
                  </div>
                  <p className="text-gray-600">
                    {plan.quota.toLocaleString()} images/month
                  </p>
                </div>

                <ul className="space-y-3 mb-8">
                  {plan.features.map((feature, index) => (
                    <li key={index} className="flex items-center text-gray-700">
                      <svg
                        className="w-5 h-5 text-green-500 mr-2"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleSubscribe(plan.planKey)}
                  disabled={isCurrentPlan || loading === plan.planKey}
                  className={`w-full py-3 px-6 rounded-lg font-semibold transition ${
                    isCurrentPlan
                      ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                      : plan.popular
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-gray-800 text-white hover:bg-gray-900'
                  }`}
                >
                  {loading === plan.planKey
                    ? 'Loading...'
                    : isCurrentPlan
                    ? 'Current Plan'
                    : plan.cta}
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-12 text-center text-gray-600">
          <p>
            All plans include a <strong>7-day free trial</strong>. Cancel anytime.
          </p>
          <p className="mt-2">
            Need more? <a href="/enterprise" className="text-blue-600 hover:underline">
              Contact us for Enterprise pricing
            </a>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Pricing;
```

### 8.2 할당량 표시 컴포넌트

```typescript
// frontend/src/components/QuotaDisplay.tsx

import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

interface QuotaInfo {
  used: number;
  total: number;
  plan: string;
}

const QuotaDisplay: React.FC = () => {
  const { user } = useAuth();
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  useEffect(() => {
    if (user) {
      setQuota({
        used: user.monthly_images_generated,
        total: user.monthly_image_quota,
        plan: user.subscription_plan,
      });
    }
  }, [user]);

  if (!quota) return null;

  const percentage = (quota.used / quota.total) * 100;
  const remaining = quota.total - quota.used;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">
          Monthly Quota ({quota.plan.toUpperCase()})
        </span>
        <span className="text-sm text-gray-600">
          {remaining.toLocaleString()} remaining
        </span>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-gray-200 rounded-full h-2.5 mb-2">
        <div
          className={`h-2.5 rounded-full ${
            percentage > 90
              ? 'bg-red-600'
              : percentage > 70
              ? 'bg-yellow-500'
              : 'bg-green-600'
          }`}
          style={{ width: `${percentage}%` }}
        ></div>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {quota.used.toLocaleString()} / {quota.total.toLocaleString()} used
        </span>
        {percentage > 90 && (
          <a href="/pricing" className="text-blue-600 hover:underline">
            Upgrade
          </a>
        )}
      </div>
    </div>
  );
};

export default QuotaDisplay;
```

### 8.3 구독 관리 페이지

```typescript
// frontend/src/pages/SubscriptionSettings.tsx

import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

interface SubscriptionInfo {
  plan: string;
  status: string;
  amount?: number;
  renews_at?: string;
  quota: number;
}

const SubscriptionSettings: React.FC = () => {
  const { user } = useAuth();
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSubscription();
  }, []);

  const loadSubscription = async () => {
    try {
      const response = await api.get('/subscriptions/current');
      setSubscription(response.data);
    } catch (error) {
      console.error('Failed to load subscription:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel your subscription?')) {
      return;
    }

    try {
      await api.post('/subscriptions/cancel');
      alert('Subscription cancelled successfully');
      loadSubscription();
    } catch (error: any) {
      alert(error.response?.data?.detail || 'Failed to cancel subscription');
    }
  };

  const handlePortal = async () => {
    try {
      const response = await api.get('/subscriptions/portal');
      window.open(response.data.portal_url, '_blank');
    } catch (error: any) {
      alert(error.response?.data?.detail || 'Failed to open portal');
    }
  };

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  if (!subscription) {
    return <div className="text-center py-12">No subscription found</div>;
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">
        Subscription Settings
      </h1>

      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">
          Current Plan
        </h2>

        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <p className="text-sm text-gray-600 mb-1">Plan</p>
            <p className="text-2xl font-bold text-gray-900 capitalize">
              {subscription.plan}
            </p>
          </div>

          <div>
            <p className="text-sm text-gray-600 mb-1">Status</p>
            <p className="text-lg font-semibold text-green-600 capitalize">
              {subscription.status}
            </p>
          </div>

          {subscription.amount && (
            <div>
              <p className="text-sm text-gray-600 mb-1">Price</p>
              <p className="text-lg font-semibold text-gray-900">
                ${subscription.amount.toFixed(2)}/month
              </p>
            </div>
          )}

          {subscription.renews_at && (
            <div>
              <p className="text-sm text-gray-600 mb-1">Renews On</p>
              <p className="text-lg font-semibold text-gray-900">
                {new Date(subscription.renews_at).toLocaleDateString()}
              </p>
            </div>
          )}

          <div>
            <p className="text-sm text-gray-600 mb-1">Monthly Quota</p>
            <p className="text-lg font-semibold text-gray-900">
              {subscription.quota.toLocaleString()} images
            </p>
          </div>
        </div>
      </div>

      {subscription.plan !== 'free' && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            Manage Subscription
          </h2>

          <div className="space-y-4">
            <button
              onClick={handlePortal}
              className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700 transition"
            >
              Manage Billing & Invoices
            </button>

            <button
              onClick={handleCancel}
              className="w-full bg-red-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-red-700 transition"
            >
              Cancel Subscription
            </button>
          </div>

          <p className="text-sm text-gray-600 mt-4">
            After cancellation, you'll retain access until the end of your billing period.
          </p>
        </div>
      )}

      {subscription.plan === 'free' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
          <p className="text-gray-700 mb-4">
            Upgrade to unlock more features and higher quotas
          </p>
          <a
            href="/pricing"
            className="inline-block bg-blue-600 text-white py-3 px-8 rounded-lg font-semibold hover:bg-blue-700 transition"
          >
            View Plans
          </a>
        </div>
      )}
    </div>
  );
};

export default SubscriptionSettings;
```

---

## 9. 테스트 및 검증

### 9.1 Lemon Squeezy 테스트 모드

```bash
# 1. 테스트 API 키 사용
Settings → API → Create Test API Key

# 2. 환경 변수 설정 (dev)
export LEMON_SQUEEZY_API_KEY=test_xxxxxxxxxxxxx
export LEMON_SQUEEZY_TEST_MODE=true

# 3. 테스트 카드 번호
Card Number: 4242 4242 4242 4242
Expiry: 12/34
CVC: 123
ZIP: 12345
```

### 9.2 Webhook 테스트

```bash
# 로컬에서 Webhook 테스트 (ngrok 사용)

# 1. ngrok 설치
brew install ngrok

# 2. ngrok 실행
ngrok http 9090

# 3. ngrok URL을 Lemon Squeezy Webhook에 등록
https://xxxx-xxxx-xxxx.ngrok.io/api/v1/webhooks/lemon

# 4. 테스트 결제 진행 → 로컬에서 Webhook 수신 확인
```

### 9.3 단위 테스트

```python
# backend/tests/test_subscriptions.py

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock

from invokeai.app.run_app import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.mark.asyncio
async def test_create_checkout(client, mock_user):
    """Checkout 세션 생성 테스트"""

    with patch('invokeai.app.services.lemon_squeezy.client.LemonSqueezyClient.create_checkout') as mock_checkout:
        mock_checkout.return_value = {
            "checkout_url": "https://lemonsqueezy.com/checkout/xxxxx",
            "checkout_id": "12345",
        }

        response = client.post(
            "/api/v1/subscriptions/checkout",
            json={"plan": "pro"},
            headers={"Authorization": f"Bearer {mock_user.access_token}"}
        )

        assert response.status_code == 200
        assert "checkout_url" in response.json()


@pytest.mark.asyncio
async def test_webhook_signature_verification(client):
    """Webhook 서명 검증 테스트"""
    import hmac
    import hashlib

    payload = b'{"data": "test"}'
    secret = "test_secret"

    # 올바른 서명 생성
    signature = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()

    response = client.post(
        "/api/v1/webhooks/lemon",
        data=payload,
        headers={"X-Signature": signature}
    )

    # 서명이 올바르면 200
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_quota_exceeded(client, mock_user):
    """할당량 초과 테스트"""

    # 사용자 할당량 모두 소진
    mock_user.monthly_images_generated = mock_user.monthly_image_quota

    response = client.post(
        "/api/v1/images/generate",
        json={"prompt": "test"},
        headers={"Authorization": f"Bearer {mock_user.access_token}"}
    )

    assert response.status_code == 429  # Too Many Requests
    assert "quota exceeded" in response.json()["detail"]["message"].lower()
```

---

## 10. 운영 및 모니터링

### 10.1 구독 통계 대시보드

```python
# backend/invokeai/app/api/routers/admin/subscriptions.py

"""
관리자용 구독 통계 API
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from invokeai.app.services.database import get_db
from invokeai.app.api.dependencies.auth import get_current_superuser
from invokeai.app.models.subscription import Subscription, SubscriptionStatus


router = APIRouter(prefix="/admin/subscriptions", tags=["Admin - Subscriptions"])


@router.get("/stats")
async def get_subscription_stats(
    current_user = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """
    구독 통계 조회 (Superuser만)

    Returns:
        Dict: 구독 통계
    """
    # 플랜별 구독 수
    stmt = select(
        Subscription.plan_name,
        func.count(Subscription.subscription_id).label("count")
    ).where(
        Subscription.is_active == True
    ).group_by(Subscription.plan_name)

    result = await db.execute(stmt)
    plan_counts = {row.plan_name: row.count for row in result}

    # 월간 반복 수익 (MRR)
    stmt = select(
        func.sum(Subscription.amount).label("total_mrr")
    ).where(
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.is_active == True,
    )

    result = await db.execute(stmt)
    total_mrr = result.scalar() or 0

    # 상태별 구독 수
    stmt = select(
        Subscription.status,
        func.count(Subscription.subscription_id).label("count")
    ).group_by(Subscription.status)

    result = await db.execute(stmt)
    status_counts = {row.status.value: row.count for row in result}

    return {
        "plan_distribution": plan_counts,
        "total_mrr": total_mrr / 100,  # Cents to Dollars
        "status_distribution": status_counts,
    }
```

### 10.2 결제 실패 알림

```python
# backend/invokeai/app/services/email/payment_failed.py

"""
결제 실패 이메일 알림
"""

async def send_payment_failed_email(user_email: str, subscription_id: str):
    """
    결제 실패 이메일 전송

    Args:
        user_email: 사용자 이메일
        subscription_id: 구독 ID
    """
    # TODO: AWS SES 연동 (Phase 6에서 구현)
    subject = "Payment Failed - Action Required"
    body = f"""
    Hello,

    We were unable to process your payment for your PingvasAI subscription.

    Please update your payment method to continue using your plan.

    Update Payment Method:
    https://app.lemonsqueezy.com/my-orders/{subscription_id}

    If you have any questions, please contact support.

    Best regards,
    PingvasAI Team
    """

    # 이메일 전송 로직
    print(f"Sending email to {user_email}: {subject}")
```

### 10.3 Prometheus 메트릭

```python
# backend/invokeai/app/metrics/subscriptions.py

"""
구독 관련 Prometheus 메트릭
"""

from prometheus_client import Counter, Gauge

# 신규 구독 수
new_subscriptions = Counter(
    'subscriptions_new_total',
    'Total number of new subscriptions',
    ['plan']
)

# 취소된 구독 수
cancelled_subscriptions = Counter(
    'subscriptions_cancelled_total',
    'Total number of cancelled subscriptions',
    ['plan']
)

# 활성 구독 수
active_subscriptions = Gauge(
    'subscriptions_active',
    'Number of active subscriptions',
    ['plan']
)

# 월간 반복 수익 (MRR)
monthly_recurring_revenue = Gauge(
    'subscriptions_mrr_dollars',
    'Monthly Recurring Revenue in dollars'
)
```

---

## 11. 다음 단계

Phase 5 완료 후:

✅ **완료된 작업:**
- Lemon Squeezy 구독 결제 시스템
- 플랜별 할당량 관리
- Webhook 이벤트 처리
- 프론트엔드 결제 UI

📋 **다음 Phase:**
- **Phase 6**: 이메일 서비스 (AWS SES + Lambda)
- **Phase 7**: 검색 기능 (Elasticsearch + Nori)
- **Phase 8**: 모니터링 & CI/CD (Prometheus, ArgoCD)

---

**Phase 5 완료! 💰**

이제 사용자는 Pro/Studio 플랜으로 업그레이드하고, 할당량에 따라 이미지를 생성할 수 있습니다.

**예상 소요 시간**: 2주 (60-80시간)
**작성일**: 2025-11-18
**작성자**: Claude (Anthropic)