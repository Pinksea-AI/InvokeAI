# Lemon Squeezy 결제 시스템 연동 가이드

## 개요

이 문서는 Pingvas Studio의 결제 시스템을 Lemon Squeezy와 연동하는 방법을 안내합니다.

---

## 1단계: Lemon Squeezy 설정

### 1.1 상점 및 상품 등록

1. [Lemon Squeezy](https://lemonsqueezy.com) 가입
2. 상점(Store) 생성
3. 구독 상품 생성:

| 상품명 | Variant ID | 가격 | 결제 주기 |
|--------|-----------|------|----------|
| Starter Monthly | (자동 생성) | $25 | monthly |
| Starter Yearly | (자동 생성) | $250 | yearly |
| Pro Monthly | (자동 생성) | $75 | monthly |
| Pro Yearly | (자동 생성) | $750 | yearly |
| Studio Monthly | (자동 생성) | $150 | monthly |
| Studio Yearly | (자동 생성) | $1,500 | yearly |

### 1.2 API 키 발급

1. Settings → API → Create API Key
2. 권한 설정: `read`, `write`
3. API 키 안전하게 저장

### 1.3 Webhook 설정

1. Settings → Webhooks → Add Webhook
2. URL: `https://api.studio.pingvas.com/api/v1/webhooks/lemon-squeezy`
3. 이벤트 선택:
   - `subscription_created`
   - `subscription_updated`
   - `subscription_cancelled`
   - `subscription_resumed`
   - `subscription_expired`
   - `subscription_payment_success`
   - `subscription_payment_failed`
   - `order_created`
4. Signing Secret 저장

---

## 2단계: 백엔드 구현

### 2.1 환경 변수

```bash
# .env
LEMON_SQUEEZY_API_KEY=your_api_key
LEMON_SQUEEZY_WEBHOOK_SECRET=your_webhook_secret
LEMON_SQUEEZY_STORE_ID=your_store_id

# 상품 Variant IDs
LEMON_SQUEEZY_STARTER_MONTHLY_ID=123456
LEMON_SQUEEZY_STARTER_YEARLY_ID=123457
LEMON_SQUEEZY_PRO_MONTHLY_ID=123458
LEMON_SQUEEZY_PRO_YEARLY_ID=123459
LEMON_SQUEEZY_STUDIO_MONTHLY_ID=123460
LEMON_SQUEEZY_STUDIO_YEARLY_ID=123461
```

### 2.2 설정 모듈

```python
# services/payment-service/app/config.py

from pydantic_settings import BaseSettings
from functools import lru_cache

class Settings(BaseSettings):
    # Lemon Squeezy
    lemon_squeezy_api_key: str
    lemon_squeezy_webhook_secret: str
    lemon_squeezy_store_id: str

    # Variant IDs
    lemon_squeezy_starter_monthly_id: str
    lemon_squeezy_starter_yearly_id: str
    lemon_squeezy_pro_monthly_id: str
    lemon_squeezy_pro_yearly_id: str
    lemon_squeezy_studio_monthly_id: str
    lemon_squeezy_studio_yearly_id: str

    # Database
    database_url: str

    class Config:
        env_file = ".env"

@lru_cache()
def get_settings() -> Settings:
    return Settings()

# Variant ID 매핑
VARIANT_TO_PLAN = {
    settings.lemon_squeezy_starter_monthly_id: ("starter", "monthly"),
    settings.lemon_squeezy_starter_yearly_id: ("starter", "yearly"),
    settings.lemon_squeezy_pro_monthly_id: ("pro", "monthly"),
    settings.lemon_squeezy_pro_yearly_id: ("pro", "yearly"),
    settings.lemon_squeezy_studio_monthly_id: ("studio", "monthly"),
    settings.lemon_squeezy_studio_yearly_id: ("studio", "yearly"),
}

settings = get_settings()
```

### 2.3 Lemon Squeezy 클라이언트

```python
# services/payment-service/app/services/lemon_squeezy.py

import httpx
from typing import Optional, Dict, Any
from app.config import settings

class LemonSqueezyClient:
    BASE_URL = "https://api.lemonsqueezy.com/v1"

    def __init__(self):
        self.api_key = settings.lemon_squeezy_api_key
        self.store_id = settings.lemon_squeezy_store_id

    def _get_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
        }

    async def create_checkout(
        self,
        variant_id: str,
        user_id: str,
        user_email: str,
        user_name: str,
        success_url: str,
        cancel_url: str,
    ) -> Dict[str, Any]:
        """체크아웃 세션 생성"""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.BASE_URL}/checkouts",
                headers=self._get_headers(),
                json={
                    "data": {
                        "type": "checkouts",
                        "attributes": {
                            "checkout_data": {
                                "email": user_email,
                                "name": user_name,
                                "custom": {
                                    "user_id": user_id,
                                },
                            },
                            "product_options": {
                                "redirect_url": success_url,
                            },
                        },
                        "relationships": {
                            "store": {
                                "data": {
                                    "type": "stores",
                                    "id": self.store_id,
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
                },
            )
            response.raise_for_status()
            return response.json()

    async def get_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """구독 정보 조회"""
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.BASE_URL}/subscriptions/{subscription_id}",
                headers=self._get_headers(),
            )
            response.raise_for_status()
            return response.json()

    async def cancel_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """구독 취소"""
        async with httpx.AsyncClient() as client:
            response = await client.delete(
                f"{self.BASE_URL}/subscriptions/{subscription_id}",
                headers=self._get_headers(),
            )
            response.raise_for_status()
            return response.json()

    async def update_subscription(
        self,
        subscription_id: str,
        variant_id: str,
    ) -> Dict[str, Any]:
        """구독 변경 (업그레이드/다운그레이드)"""
        async with httpx.AsyncClient() as client:
            response = await client.patch(
                f"{self.BASE_URL}/subscriptions/{subscription_id}",
                headers=self._get_headers(),
                json={
                    "data": {
                        "type": "subscriptions",
                        "id": subscription_id,
                        "attributes": {
                            "variant_id": int(variant_id),
                            "invoice_immediately": True,
                        },
                    }
                },
            )
            response.raise_for_status()
            return response.json()


lemon_squeezy_client = LemonSqueezyClient()
```

### 2.4 웹훅 처리

```python
# services/payment-service/app/api/routes/webhooks.py

import hmac
import hashlib
from fastapi import APIRouter, Request, HTTPException, Depends
from sqlalchemy.orm import Session
from app.config import settings
from app.database import get_db
from app.services.subscription import SubscriptionService
from app.services.credit import CreditService

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

def verify_webhook_signature(payload: bytes, signature: str) -> bool:
    """웹훅 시그니처 검증"""
    expected = hmac.new(
        settings.lemon_squeezy_webhook_secret.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


@router.post("/lemon-squeezy")
async def lemon_squeezy_webhook(
    request: Request,
    db: Session = Depends(get_db),
):
    """Lemon Squeezy 웹훅 수신 처리"""

    # 시그니처 검증
    signature = request.headers.get("X-Signature", "")
    payload = await request.body()

    if not verify_webhook_signature(payload, signature):
        raise HTTPException(status_code=401, detail="Invalid signature")

    # 이벤트 파싱
    data = await request.json()
    event_name = data.get("meta", {}).get("event_name")
    custom_data = data.get("meta", {}).get("custom_data", {})
    user_id = custom_data.get("user_id")

    subscription_data = data.get("data", {}).get("attributes", {})

    # 이벤트 로깅
    await log_webhook_event(db, "lemon_squeezy", event_name, data)

    # 이벤트별 처리
    handlers = {
        "subscription_created": handle_subscription_created,
        "subscription_updated": handle_subscription_updated,
        "subscription_cancelled": handle_subscription_cancelled,
        "subscription_resumed": handle_subscription_resumed,
        "subscription_expired": handle_subscription_expired,
        "subscription_payment_success": handle_payment_success,
        "subscription_payment_failed": handle_payment_failed,
        "order_created": handle_order_created,
    }

    handler = handlers.get(event_name)
    if handler:
        await handler(db, user_id, subscription_data, data)

    return {"success": True}


async def handle_subscription_created(
    db: Session,
    user_id: str,
    subscription_data: dict,
    raw_data: dict,
):
    """신규 구독 처리"""
    subscription_service = SubscriptionService(db)
    credit_service = CreditService(db)

    variant_id = str(subscription_data.get("variant_id"))
    plan_name, billing_cycle = VARIANT_TO_PLAN.get(variant_id, (None, None))

    if not plan_name:
        raise ValueError(f"Unknown variant: {variant_id}")

    # 1. 구독 정보 저장
    subscription = await subscription_service.create_subscription(
        user_id=user_id,
        plan_name=plan_name,
        billing_cycle=billing_cycle,
        lemon_squeezy_subscription_id=str(subscription_data.get("id")),
        lemon_squeezy_customer_id=str(subscription_data.get("customer_id")),
        current_period_start=subscription_data.get("created_at"),
        current_period_end=subscription_data.get("renews_at"),
        trial_ends_at=subscription_data.get("trial_ends_at"),
    )

    # 2. 사용자 티어 업데이트
    await subscription_service.update_user_tier(user_id, plan_name)

    # 3. 크레딧 충전
    plan = await subscription_service.get_plan(plan_name)
    await credit_service.add_credits(
        user_id=user_id,
        amount=plan.credits,
        type="subscription_grant",
        description=f"{plan.display_name} 플랜 크레딧",
        reference_id=subscription.id,
        reference_type="subscription",
    )

    # 4. 스토리지 할당량 업데이트
    await subscription_service.update_storage_quota(user_id, plan.storage_bytes)

    # 5. 구독 이력 기록
    await subscription_service.log_history(
        subscription_id=subscription.id,
        change_type="created",
        to_plan_id=plan.id,
    )


async def handle_subscription_updated(
    db: Session,
    user_id: str,
    subscription_data: dict,
    raw_data: dict,
):
    """구독 변경 (업그레이드/다운그레이드) 처리"""
    subscription_service = SubscriptionService(db)
    credit_service = CreditService(db)

    variant_id = str(subscription_data.get("variant_id"))
    new_plan_name, billing_cycle = VARIANT_TO_PLAN.get(variant_id, (None, None))

    # 현재 구독 조회
    subscription = await subscription_service.get_by_lemon_squeezy_id(
        subscription_data.get("id")
    )
    old_plan = await subscription_service.get_plan_by_id(subscription.plan_id)
    new_plan = await subscription_service.get_plan(new_plan_name)

    # 업그레이드 여부 확인
    is_upgrade = new_plan.tier_level > old_plan.tier_level

    # 1. 구독 정보 업데이트
    await subscription_service.update_subscription(
        subscription_id=subscription.id,
        plan_name=new_plan_name,
        billing_cycle=billing_cycle,
        current_period_end=subscription_data.get("renews_at"),
    )

    # 2. 사용자 티어 업데이트
    await subscription_service.update_user_tier(user_id, new_plan_name)

    # 3. 크레딧 갱신 (업그레이드 시 즉시 갱신)
    if is_upgrade:
        await credit_service.reset_credits(
            user_id=user_id,
            amount=new_plan.credits,
            type="subscription_upgrade",
            description=f"{new_plan.display_name} 플랜 업그레이드 크레딧",
        )

    # 4. 스토리지 할당량 업데이트
    await subscription_service.update_storage_quota(user_id, new_plan.storage_bytes)

    # 5. 구독 이력 기록
    await subscription_service.log_history(
        subscription_id=subscription.id,
        change_type="upgraded" if is_upgrade else "downgraded",
        from_plan_id=old_plan.id,
        to_plan_id=new_plan.id,
    )


async def handle_subscription_cancelled(
    db: Session,
    user_id: str,
    subscription_data: dict,
    raw_data: dict,
):
    """구독 취소 처리 (종료일까지 서비스 유지)"""
    subscription_service = SubscriptionService(db)

    subscription = await subscription_service.get_by_lemon_squeezy_id(
        subscription_data.get("id")
    )

    # 취소 예정 상태로 변경 (종료일까지 서비스 유지)
    await subscription_service.mark_cancelling(
        subscription_id=subscription.id,
        ends_at=subscription_data.get("ends_at"),
        cancel_reason=subscription_data.get("cancellation_reason"),
    )

    # 구독 이력 기록
    await subscription_service.log_history(
        subscription_id=subscription.id,
        change_type="cancelled",
    )


async def handle_subscription_expired(
    db: Session,
    user_id: str,
    subscription_data: dict,
    raw_data: dict,
):
    """구독 만료 처리"""
    subscription_service = SubscriptionService(db)
    credit_service = CreditService(db)

    subscription = await subscription_service.get_by_lemon_squeezy_id(
        subscription_data.get("id")
    )

    # 1. 티어 다운그레이드
    await subscription_service.update_user_tier(user_id, "free")

    # 2. 잔여 크레딧 회수
    current_credits = await credit_service.get_balance(user_id)
    if current_credits > 0:
        await credit_service.revoke_credits(
            user_id=user_id,
            amount=current_credits,
            type="subscription_expired",
            description="구독 만료로 인한 크레딧 회수",
        )

    # 3. 스토리지 할당량 제거 (초과 시 경고 이메일)
    await subscription_service.update_storage_quota(user_id, 0)
    await subscription_service.check_storage_overage(user_id)

    # 4. 구독 상태 업데이트
    await subscription_service.update_subscription(
        subscription_id=subscription.id,
        status="expired",
    )

    # 5. 구독 이력 기록
    await subscription_service.log_history(
        subscription_id=subscription.id,
        change_type="expired",
    )


async def handle_payment_success(
    db: Session,
    user_id: str,
    subscription_data: dict,
    raw_data: dict,
):
    """결제 성공 처리 (월간 갱신 시)"""
    subscription_service = SubscriptionService(db)
    credit_service = CreditService(db)

    subscription = await subscription_service.get_by_lemon_squeezy_id(
        subscription_data.get("id")
    )
    plan = await subscription_service.get_plan_by_id(subscription.plan_id)

    # 크레딧 갱신
    await credit_service.reset_credits(
        user_id=user_id,
        amount=plan.credits,
        type="subscription_renew",
        description=f"{plan.display_name} 플랜 월간 크레딧 갱신",
    )

    # 구독 이력 기록
    await subscription_service.log_history(
        subscription_id=subscription.id,
        change_type="renewed",
    )


async def handle_payment_failed(
    db: Session,
    user_id: str,
    subscription_data: dict,
    raw_data: dict,
):
    """결제 실패 처리"""
    subscription_service = SubscriptionService(db)

    subscription = await subscription_service.get_by_lemon_squeezy_id(
        subscription_data.get("id")
    )

    # 구독 상태 업데이트
    await subscription_service.update_subscription(
        subscription_id=subscription.id,
        status="past_due",
    )

    # 결제 실패 알림 이메일 발송
    await send_payment_failed_email(user_id)


async def handle_order_created(
    db: Session,
    user_id: str,
    subscription_data: dict,
    raw_data: dict,
):
    """주문 생성 처리 (추가 크레딧 구매 등)"""
    # 일회성 구매 처리 로직
    pass
```

### 2.5 API 엔드포인트

```python
# services/payment-service/app/api/routes/subscriptions.py

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user
from app.services.lemon_squeezy import lemon_squeezy_client
from app.schemas.subscription import CheckoutRequest, UpgradeRequest

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])

PLAN_VARIANTS = {
    ("starter", "monthly"): settings.lemon_squeezy_starter_monthly_id,
    ("starter", "yearly"): settings.lemon_squeezy_starter_yearly_id,
    ("pro", "monthly"): settings.lemon_squeezy_pro_monthly_id,
    ("pro", "yearly"): settings.lemon_squeezy_pro_yearly_id,
    ("studio", "monthly"): settings.lemon_squeezy_studio_monthly_id,
    ("studio", "yearly"): settings.lemon_squeezy_studio_yearly_id,
}


@router.post("/checkout")
async def create_checkout(
    request: CheckoutRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """체크아웃 세션 생성"""
    variant_id = PLAN_VARIANTS.get((request.plan, request.billing_cycle))

    if not variant_id:
        raise HTTPException(status_code=400, detail="Invalid plan")

    result = await lemon_squeezy_client.create_checkout(
        variant_id=variant_id,
        user_id=str(current_user.id),
        user_email=current_user.email,
        user_name=current_user.name,
        success_url=f"{settings.frontend_url}/subscription/success",
        cancel_url=f"{settings.frontend_url}/subscription/cancel",
    )

    checkout_url = result["data"]["attributes"]["url"]

    return {
        "success": True,
        "data": {
            "checkout_url": checkout_url,
        }
    }


@router.post("/upgrade")
async def upgrade_subscription(
    request: UpgradeRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """구독 업그레이드"""
    subscription_service = SubscriptionService(db)

    # 현재 구독 확인
    subscription = await subscription_service.get_active_subscription(current_user.id)
    if not subscription:
        raise HTTPException(status_code=400, detail="No active subscription")

    current_plan = await subscription_service.get_plan_by_id(subscription.plan_id)
    target_plan = await subscription_service.get_plan(request.target_plan)

    # 업그레이드만 허용
    if target_plan.tier_level <= current_plan.tier_level:
        raise HTTPException(
            status_code=400,
            detail="Only upgrades are allowed through this endpoint"
        )

    # Lemon Squeezy에서 구독 변경
    variant_id = PLAN_VARIANTS.get((request.target_plan, subscription.billing_cycle))

    await lemon_squeezy_client.update_subscription(
        subscription_id=subscription.lemon_squeezy_subscription_id,
        variant_id=variant_id,
    )

    return {
        "success": True,
        "data": {
            "message": f"{target_plan.display_name} 플랜으로 업그레이드되었습니다.",
            "previous_plan": current_plan.name,
            "new_plan": target_plan.name,
        }
    }


@router.post("/cancel")
async def cancel_subscription(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """구독 취소"""
    subscription_service = SubscriptionService(db)

    subscription = await subscription_service.get_active_subscription(current_user.id)
    if not subscription:
        raise HTTPException(status_code=400, detail="No active subscription")

    # Lemon Squeezy에서 구독 취소
    result = await lemon_squeezy_client.cancel_subscription(
        subscription_id=subscription.lemon_squeezy_subscription_id,
    )

    ends_at = result["data"]["attributes"]["ends_at"]

    return {
        "success": True,
        "data": {
            "status": "cancelling",
            "ends_at": ends_at,
            "message": f"구독이 {ends_at}에 종료됩니다.",
        }
    }
```

---

## 3단계: 프론트엔드 구현

### 3.1 결제 페이지 컴포넌트

```typescript
// src/features/subscription/components/PricingPage.tsx

import { useState } from 'react';
import { Box, Flex, Switch, Text, VStack } from '@invoke-ai/ui-library';
import { PricingCard } from './PricingCard';
import { useGetPlansQuery, useCreateCheckoutMutation } from '@/services/api/endpoints/subscription';

export const PricingPage = () => {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const { data: plans, isLoading } = useGetPlansQuery();
  const [createCheckout, { isLoading: isCheckoutLoading }] = useCreateCheckoutMutation();

  const handleSelectPlan = async (planId: string) => {
    try {
      const result = await createCheckout({
        plan: planId,
        billing_cycle: billingCycle,
      }).unwrap();

      // Lemon Squeezy 체크아웃 페이지로 이동
      window.location.href = result.data.checkout_url;
    } catch (error) {
      console.error('Checkout failed:', error);
    }
  };

  return (
    <Box p={8}>
      <VStack spacing={8}>
        {/* 결제 주기 선택 */}
        <Flex align="center" gap={4}>
          <Text color={billingCycle === 'monthly' ? 'white' : 'whiteAlpha.600'}>
            월간
          </Text>
          <Switch
            isChecked={billingCycle === 'yearly'}
            onChange={(e) => setBillingCycle(e.target.checked ? 'yearly' : 'monthly')}
            colorScheme="invokeBlue"
          />
          <Text color={billingCycle === 'yearly' ? 'white' : 'whiteAlpha.600'}>
            연간
            <Text as="span" color="invokeGreen.400" fontSize="sm" ml={2}>
              (2개월 무료)
            </Text>
          </Text>
        </Flex>

        {/* 플랜 카드 */}
        <Flex gap={6} wrap="wrap" justify="center">
          {plans?.data.map((plan) => (
            <PricingCard
              key={plan.id}
              plan={plan}
              billingCycle={billingCycle}
              onSelect={handleSelectPlan}
              isLoading={isCheckoutLoading}
            />
          ))}
        </Flex>
      </VStack>
    </Box>
  );
};
```

### 3.2 업그레이드 확인 모달

```typescript
// src/features/subscription/components/UpgradeModal.tsx

import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Text,
  VStack,
} from '@invoke-ai/ui-library';
import { useUpgradeSubscriptionMutation } from '@/services/api/endpoints/subscription';

interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlan: string;
  targetPlan: string;
  daysRemaining: number;
  newCredits: number;
}

export const UpgradeModal = ({
  isOpen,
  onClose,
  currentPlan,
  targetPlan,
  daysRemaining,
  newCredits,
}: UpgradeModalProps) => {
  const [upgrade, { isLoading }] = useUpgradeSubscriptionMutation();

  const handleUpgrade = async () => {
    try {
      await upgrade({ target_plan: targetPlan }).unwrap();
      onClose();
      // 성공 알림 표시
    } catch (error) {
      // 에러 처리
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalOverlay />
      <ModalContent bg="gray.800">
        <ModalHeader>플랜 업그레이드 확인</ModalHeader>
        <ModalBody>
          <VStack spacing={4} align="start">
            <Text>
              <strong>{currentPlan}</strong>에서{' '}
              <strong>{targetPlan}</strong>으로 업그레이드하시겠습니까?
            </Text>

            <Text color="yellow.400">
              ⚠️ 갱신 기간이 {daysRemaining}일 남았습니다.
            </Text>

            <Text>
              업그레이드하면:
            </Text>
            <VStack spacing={2} align="start" pl={4}>
              <Text>• 즉시 새 플랜이 적용됩니다</Text>
              <Text>• 크레딧이 {newCredits.toLocaleString()}으로 새로 갱신됩니다</Text>
              <Text>• 새 기능에 바로 접근할 수 있습니다</Text>
            </VStack>
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" mr={3} onClick={onClose}>
            취소
          </Button>
          <Button
            colorScheme="invokeBlue"
            onClick={handleUpgrade}
            isLoading={isLoading}
          >
            업그레이드
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
```

---

## 4단계: 스케줄러 작업

### 4.1 만료 구독 처리

```python
# services/payment-service/app/tasks/subscription_tasks.py

from celery import Celery
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.services.subscription import SubscriptionService
from app.services.credit import CreditService

celery = Celery('payment-service')

@celery.task
def process_expired_subscriptions():
    """
    매일 00:00 UTC에 실행
    만료된 구독 처리
    """
    db = SessionLocal()
    try:
        subscription_service = SubscriptionService(db)
        credit_service = CreditService(db)

        # 만료된 구독 조회
        expired = subscription_service.get_expired_subscriptions(
            as_of=datetime.now(timezone.utc)
        )

        for subscription in expired:
            user_id = subscription.user_id

            # 1. 티어 다운그레이드
            subscription_service.update_user_tier(user_id, "free")

            # 2. 잔여 크레딧 회수
            current_credits = credit_service.get_balance(user_id)
            if current_credits > 0:
                credit_service.revoke_credits(
                    user_id=user_id,
                    amount=current_credits,
                    type="subscription_expired",
                    description="구독 만료로 인한 크레딧 회수",
                )

            # 3. 스토리지 초과 확인 및 경고
            subscription_service.update_storage_quota(user_id, 0)
            subscription_service.check_storage_overage(user_id)

            # 4. 구독 상태 업데이트
            subscription_service.update_subscription(
                subscription_id=subscription.id,
                status="expired",
            )

            # 5. 이력 기록
            subscription_service.log_history(
                subscription_id=subscription.id,
                change_type="expired",
            )

    finally:
        db.close()
```

### 4.2 Celery Beat 스케줄

```python
# services/payment-service/app/celery_config.py

from celery.schedules import crontab

beat_schedule = {
    'process-expired-subscriptions': {
        'task': 'app.tasks.subscription_tasks.process_expired_subscriptions',
        'schedule': crontab(hour=0, minute=0),  # 매일 00:00 UTC
    },
}
```

---

## 테스트

### 웹훅 테스트

```bash
# 로컬에서 웹훅 테스트
curl -X POST http://localhost:8002/api/v1/webhooks/lemon-squeezy \
  -H "Content-Type: application/json" \
  -H "X-Signature: test_signature" \
  -d '{
    "meta": {
      "event_name": "subscription_created",
      "custom_data": {
        "user_id": "test-user-id"
      }
    },
    "data": {
      "type": "subscriptions",
      "id": "123",
      "attributes": {
        "variant_id": 123456,
        "status": "active",
        "created_at": "2025-11-25T00:00:00Z",
        "renews_at": "2025-12-25T00:00:00Z"
      }
    }
  }'
```

---

## 체크리스트

- [ ] Lemon Squeezy 상점 설정됨
- [ ] 구독 상품 6개 등록됨
- [ ] API 키 발급됨
- [ ] 웹훅 설정됨
- [ ] 백엔드 웹훅 핸들러 구현됨
- [ ] 체크아웃 API 구현됨
- [ ] 프론트엔드 결제 페이지 구현됨
- [ ] 업그레이드 확인 모달 구현됨
- [ ] 스케줄러 작업 설정됨
- [ ] 테스트 완료됨

---

## 다음 단계

1. [GitOps 가이드](../devops/01-gitops-guide.md)에서 배포 설정을 확인합니다.
2. [API 명세서](../api/01-api-specification.md)에서 전체 API를 확인합니다.
