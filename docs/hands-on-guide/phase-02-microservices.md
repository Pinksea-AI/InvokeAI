# Phase 2: 마이크로서비스 개발

이 가이드는 InvokeAI를 5개의 마이크로서비스로 분리하고 각 서비스를 구현하는 과정을 다룹니다.

## 목차
1. [아키텍처 개요](#아키텍처-개요)
2. [User Service](#user-service)
3. [Payment Service](#payment-service)
4. [Generation Service](#generation-service)
5. [Gallery Service](#gallery-service)
6. [Model Service](#model-service)
7. [서비스 간 통신](#서비스-간-통신)
8. [API Gateway 설정](#api-gateway-설정)
9. [통합 테스트](#통합-테스트)

---

## 아키텍처 개요

### 마이크로서비스 구성

```
services/
├── user-service/          # 인증, 사용자 관리
├── payment-service/       # 구독, 결제, 크레딧
├── generation-service/    # 이미지 생성 요청 관리
├── gallery-service/       # 이미지 메타데이터, 보드
├── model-service/         # AI 모델 관리
└── api-gateway/           # Nginx 또는 Kong
```

### 서비스별 책임

| 서비스 | 포트 | 주요 기능 |
|--------|------|-----------|
| User Service | 8001 | 회원가입/로그인, OAuth, JWT 발급 |
| Payment Service | 8002 | Lemon Squeezy 연동, 크레딧 관리 |
| Generation Service | 8003 | 이미지 생성 요청, 큐 관리 |
| Gallery Service | 8004 | 이미지 조회, 보드 관리 |
| Model Service | 8005 | 모델 다운로드, 메타데이터 |

---

## User Service

**Phase 1에서 이미 생성한 User Service를 확장합니다.**

### 1. OAuth 통합 (Google)

`services/user-service/app/api/oauth.py`:
```python
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
import httpx

from app.config import settings
from app.db.base import get_db
from app.models.user import User
from app.schemas.user import Token, UserResponse
from app.utils.auth import create_access_token

router = APIRouter(prefix="/api/v1/oauth", tags=["OAuth"])

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

@router.get("/google/login")
async def google_login():
    """
    Google OAuth 로그인 시작
    """
    redirect_uri = "http://localhost:8001/api/v1/oauth/google/callback"
    scope = "openid email profile"

    auth_url = (
        f"{GOOGLE_AUTH_URL}?"
        f"client_id={settings.google_client_id}&"
        f"redirect_uri={redirect_uri}&"
        f"response_type=code&"
        f"scope={scope}"
    )

    return RedirectResponse(url=auth_url)

@router.get("/google/callback")
async def google_callback(code: str, db: Session = Depends(get_db)):
    """
    Google OAuth 콜백
    """
    # 1. Access Token 교환
    token_data = {
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": "http://localhost:8001/api/v1/oauth/google/callback",
        "grant_type": "authorization_code"
    }

    async with httpx.AsyncClient() as client:
        token_response = await client.post(GOOGLE_TOKEN_URL, data=token_data)

        if token_response.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to get access token")

        access_token = token_response.json()["access_token"]

        # 2. 사용자 정보 가져오기
        userinfo_response = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"}
        )

        if userinfo_response.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to get user info")

        user_info = userinfo_response.json()

    # 3. 사용자 생성 또는 조회
    user = db.query(User).filter(
        User.oauth_provider == "google",
        User.oauth_id == user_info["id"]
    ).first()

    if not user:
        # 신규 사용자 생성
        user = User(
            email=user_info["email"],
            oauth_provider="google",
            oauth_id=user_info["id"],
            tier="free"
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    # 4. JWT 토큰 발급
    jwt_token = create_access_token(data={"sub": str(user.id)})

    # 프론트엔드로 리다이렉트 (토큰 전달)
    return RedirectResponse(
        url=f"http://localhost:3000/auth/callback?token={jwt_token}"
    )
```

**main.py에 라우터 추가**:
```python
from app.api import auth, oauth

app.include_router(auth.router)
app.include_router(oauth.router)
```

---

### 2. 티어 관리 API

`services/user-service/app/api/users.py`:
```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.base import get_db
from app.models.user import User
from app.utils.auth import get_current_user
from app.schemas.user import UserResponse

router = APIRouter(prefix="/api/v1/users", tags=["Users"])

@router.get("/me/tier", response_model=dict)
async def get_my_tier(current_user: User = Depends(get_current_user)):
    """
    현재 사용자의 구독 티어 조회
    """
    tier_features = {
        "free": {
            "max_concurrent_jobs": 0,
            "max_queue_size": 3,
            "priority": 10,
            "features": ["basic_generation"]
        },
        "starter": {
            "max_concurrent_jobs": 1,
            "max_queue_size": 10,
            "priority": 25,
            "monthly_credits": 2500,
            "features": ["basic_generation", "advanced_settings"]
        },
        "pro": {
            "max_concurrent_jobs": 1,
            "max_queue_size": 50,
            "priority": 50,
            "monthly_credits": 10000,
            "features": ["basic_generation", "advanced_settings", "controlnet", "ip_adapter"]
        },
        "studio": {
            "max_concurrent_jobs": 3,
            "max_queue_size": 200,
            "priority": 75,
            "monthly_credits": 50000,
            "features": ["all", "external_api", "workflow"]
        },
        "enterprise": {
            "max_concurrent_jobs": None,
            "max_queue_size": None,
            "priority": 100,
            "monthly_credits": None,
            "features": ["all", "external_api", "workflow", "dedicated_gpu"]
        }
    }

    return {
        "tier": current_user.tier,
        "features": tier_features.get(current_user.tier, tier_features["free"])
    }

@router.patch("/me/tier", response_model=UserResponse)
async def update_tier(
    new_tier: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    사용자 티어 업데이트 (관리자 또는 Payment Service에서 호출)
    """
    valid_tiers = ["free", "starter", "pro", "studio", "enterprise"]

    if new_tier not in valid_tiers:
        raise HTTPException(status_code=400, detail=f"Invalid tier. Must be one of {valid_tiers}")

    current_user.tier = new_tier
    db.commit()
    db.refresh(current_user)

    return UserResponse.model_validate(current_user)
```

---

## Payment Service

### 1. 프로젝트 구조

```bash
mkdir -p services/payment-service/app/{api,models,schemas,utils,db}
cd services/payment-service
```

---

### 2. 크레딧 잔액 모델

`services/payment-service/app/models/credit.py`:
```python
from sqlalchemy import Column, Integer, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid

from app.db.base import Base

class CreditBalance(Base):
    __tablename__ = "credit_balances"
    __table_args__ = {"schema": "dev_pingvas"}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("dev_pingvas.users.id"), unique=True, nullable=False)
    balance = Column(Integer, default=0)
    monthly_allocation = Column(Integer, default=0)
    last_reset_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class CreditTransaction(Base):
    __tablename__ = "credit_transactions"
    __table_args__ = {"schema": "dev_pingvas"}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("dev_pingvas.users.id"), nullable=False)
    amount = Column(Integer, nullable=False)
    type = Column(String(50), nullable=False)
    job_id = Column(UUID(as_uuid=True), nullable=True)
    description = Column(Text)
    balance_after = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
```

---

### 3. Lemon Squeezy Webhook Handler

`services/payment-service/app/api/webhooks.py`:
```python
from fastapi import APIRouter, Request, HTTPException, Depends
from sqlalchemy.orm import Session
import hmac
import hashlib
import json

from app.config import settings
from app.db.base import get_db
from app.models.subscription import Subscription
from app.models.credit import CreditBalance

router = APIRouter(prefix="/api/v1/webhooks", tags=["Webhooks"])

def verify_webhook_signature(payload: bytes, signature: str) -> bool:
    """
    Lemon Squeezy 웹훅 서명 검증
    """
    expected_signature = hmac.new(
        settings.lemon_squeezy_webhook_secret.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(expected_signature, signature)

@router.post("/lemon-squeezy")
async def lemon_squeezy_webhook(request: Request, db: Session = Depends(get_db)):
    """
    Lemon Squeezy 웹훅 수신
    """
    # 서명 검증
    signature = request.headers.get("X-Signature")
    payload = await request.body()

    if not verify_webhook_signature(payload, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # 페이로드 파싱
    event = json.loads(payload)
    event_name = event["meta"]["event_name"]
    data = event["data"]

    # 이벤트 처리
    if event_name == "subscription_created":
        await handle_subscription_created(data, db)
    elif event_name == "subscription_updated":
        await handle_subscription_updated(data, db)
    elif event_name == "subscription_cancelled":
        await handle_subscription_cancelled(data, db)
    elif event_name == "subscription_payment_success":
        await handle_payment_success(data, db)

    return {"status": "ok"}

async def handle_subscription_created(data: dict, db: Session):
    """
    구독 생성 이벤트
    """
    user_id = data["attributes"]["user_id"]
    tier = data["attributes"]["variant_name"].lower()  # "Starter", "Pro", etc.

    # 크레딧 할당
    credit_allocations = {
        "starter": 2500,
        "pro": 10000,
        "studio": 50000,
        "enterprise": 100000
    }

    credits = credit_allocations.get(tier, 0)

    # 크레딧 잔액 업데이트
    credit_balance = db.query(CreditBalance).filter(
        CreditBalance.user_id == user_id
    ).first()

    if credit_balance:
        credit_balance.balance += credits
        credit_balance.monthly_allocation = credits
    else:
        credit_balance = CreditBalance(
            user_id=user_id,
            balance=credits,
            monthly_allocation=credits
        )
        db.add(credit_balance)

    db.commit()

    # User Service에 티어 업데이트 요청
    await update_user_tier(user_id, tier)

async def update_user_tier(user_id: str, tier: str):
    """
    User Service에 티어 업데이트 요청
    """
    import httpx

    async with httpx.AsyncClient() as client:
        response = await client.patch(
            f"http://user-service:8001/api/v1/users/{user_id}/tier",
            json={"tier": tier},
            headers={"X-Internal-Service": "payment-service"}
        )

        if response.status_code != 200:
            print(f"Failed to update user tier: {response.text}")
```

---

### 4. 크레딧 차감 API

`services/payment-service/app/api/credits.py`:
```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.db.base import get_db
from app.models.credit import CreditBalance, CreditTransaction

router = APIRouter(prefix="/api/v1/credits", tags=["Credits"])

@router.post("/deduct")
async def deduct_credits(
    user_id: str,
    amount: int,
    job_id: str = None,
    description: str = None,
    db: Session = Depends(get_db)
):
    """
    원자적 크레딧 차감
    """
    # SELECT FOR UPDATE로 행 잠금
    result = db.execute(
        text("""
            SELECT balance FROM dev_pingvas.credit_balances
            WHERE user_id = :user_id
            FOR UPDATE
        """),
        {"user_id": user_id}
    ).fetchone()

    if not result:
        raise HTTPException(status_code=404, detail="Credit balance not found")

    current_balance = result[0]

    if current_balance < amount:
        raise HTTPException(
            status_code=402,
            detail=f"Insufficient credits. Required: {amount}, Available: {current_balance}"
        )

    # 차감 실행
    new_balance = current_balance - amount

    db.execute(
        text("""
            UPDATE dev_pingvas.credit_balances
            SET balance = :new_balance, updated_at = NOW()
            WHERE user_id = :user_id
        """),
        {"user_id": user_id, "new_balance": new_balance}
    )

    # 트랜잭션 기록
    db.execute(
        text("""
            INSERT INTO dev_pingvas.credit_transactions
            (id, user_id, amount, type, job_id, description, balance_after, created_at)
            VALUES (gen_random_uuid(), :user_id, :amount, 'deduction', :job_id, :description, :balance_after, NOW())
        """),
        {
            "user_id": user_id,
            "amount": -amount,
            "job_id": job_id,
            "description": description,
            "balance_after": new_balance
        }
    )

    db.commit()

    return {"success": True, "balance": new_balance}

@router.get("/balance/{user_id}")
async def get_credit_balance(user_id: str, db: Session = Depends(get_db)):
    """
    크레딧 잔액 조회
    """
    balance = db.query(CreditBalance).filter(CreditBalance.user_id == user_id).first()

    if not balance:
        return {"balance": 0, "monthly_allocation": 0}

    return {
        "balance": balance.balance,
        "monthly_allocation": balance.monthly_allocation,
        "last_reset_at": balance.last_reset_at
    }
```

---

## Generation Service

### 1. 생성 작업 모델

`services/generation-service/app/models/job.py`:
```python
from sqlalchemy import Column, String, Integer, Float, Text, BigInteger, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid

from app.db.base import Base

class GenerationJob(Base):
    __tablename__ = "generation_jobs"
    __table_args__ = {"schema": "dev_pingvas"}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("dev_pingvas.users.id"), nullable=False)
    status = Column(String(20), default="pending")
    prompt = Column(Text, nullable=False)
    negative_prompt = Column(Text)
    model_name = Column(String(100))
    width = Column(Integer, default=512)
    height = Column(Integer, default=512)
    steps = Column(Integer, default=30)
    cfg_scale = Column(Float, default=7.5)
    seed = Column(BigInteger)
    image_url = Column(Text)
    duration_seconds = Column(Integer)
    credits_consumed = Column(Integer)
    error_message = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
```

---

### 2. 생성 요청 API

`services/generation-service/app/api/generate.py`:
```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import httpx
import redis

from app.db.base import get_db
from app.models.job import GenerationJob
from app.schemas.generation import GenerationRequest, GenerationResponse
from app.config import settings

router = APIRouter(prefix="/api/v1/generation", tags=["Generation"])

redis_client = redis.from_url(settings.redis_url)

@router.post("/create", response_model=GenerationResponse)
async def create_generation(
    request: GenerationRequest,
    user_id: str,  # From JWT token
    db: Session = Depends(get_db)
):
    """
    이미지 생성 작업 생성
    """
    # 1. 사용자 티어 조회
    tier_info = await get_user_tier(user_id)
    tier = tier_info["tier"]

    # 2. 크레딧 확인
    estimated_credits = estimate_credits(request)

    credit_balance = await get_credit_balance(user_id)

    if credit_balance < estimated_credits:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "Insufficient credits",
                "required": estimated_credits,
                "available": credit_balance
            }
        )

    # 3. 작업 생성
    job = GenerationJob(
        user_id=user_id,
        status="pending",
        prompt=request.prompt,
        negative_prompt=request.negative_prompt,
        model_name=request.model,
        width=request.width,
        height=request.height,
        steps=request.steps,
        cfg_scale=request.cfg_scale,
        seed=request.seed
    )

    db.add(job)
    db.commit()
    db.refresh(job)

    # 4. Redis 우선순위 큐에 추가
    priority = get_tier_priority(tier)
    enqueue_job(str(job.id), tier, priority, user_id)

    return GenerationResponse(
        job_id=str(job.id),
        status="pending",
        estimated_wait_seconds=estimate_wait_time(tier),
        estimated_credits=estimated_credits
    )

def enqueue_job(job_id: str, tier: str, priority: int, user_id: str):
    """
    Redis Sorted Set에 작업 추가
    """
    import json
    import time

    queue_key = f"queue:{tier}"
    timestamp = int(time.time() * 1000)
    score = -(priority * 1000000) + timestamp

    job_data = json.dumps({
        "job_id": job_id,
        "user_id": user_id,
        "tier": tier,
        "priority": priority,
        "enqueued_at": timestamp
    })

    redis_client.zadd(queue_key, {job_data: score})

def estimate_credits(request: GenerationRequest) -> int:
    """
    예상 크레딧 계산
    """
    base_time = request.steps * 0.5
    resolution_factor = (request.width * request.height) / (512 * 512)

    model_factors = {
        "sd15": 1.0,
        "sdxl": 1.5,
        "flux": 2.0
    }
    model_factor = model_factors.get(request.model, 1.0)

    estimated_seconds = int(base_time * resolution_factor * model_factor)

    return max(estimated_seconds, 10)

async def get_user_tier(user_id: str) -> dict:
    """
    User Service에서 티어 조회
    """
    async with httpx.AsyncClient() as client:
        response = await client.get(f"http://user-service:8001/api/v1/users/{user_id}/tier")
        return response.json()

async def get_credit_balance(user_id: str) -> int:
    """
    Payment Service에서 크레딧 잔액 조회
    """
    async with httpx.AsyncClient() as client:
        response = await client.get(f"http://payment-service:8002/api/v1/credits/balance/{user_id}")
        data = response.json()
        return data["balance"]
```

---

### 3. 작업 상태 조회 API

`services/generation-service/app/api/jobs.py`:
```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.base import get_db
from app.models.job import GenerationJob

router = APIRouter(prefix="/api/v1/jobs", tags=["Jobs"])

@router.get("/{job_id}")
async def get_job_status(job_id: str, db: Session = Depends(get_db)):
    """
    작업 상태 조회
    """
    job = db.query(GenerationJob).filter(GenerationJob.id == job_id).first()

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    return {
        "job_id": str(job.id),
        "status": job.status,
        "prompt": job.prompt,
        "image_url": job.image_url,
        "duration_seconds": job.duration_seconds,
        "credits_consumed": job.credits_consumed,
        "error_message": job.error_message,
        "created_at": job.created_at,
        "completed_at": job.completed_at
    }

@router.get("/user/{user_id}")
async def get_user_jobs(
    user_id: str,
    status: str = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db)
):
    """
    사용자의 작업 목록 조회
    """
    query = db.query(GenerationJob).filter(GenerationJob.user_id == user_id)

    if status:
        query = query.filter(GenerationJob.status == status)

    total = query.count()
    jobs = query.order_by(GenerationJob.created_at.desc()).offset(offset).limit(limit).all()

    return {
        "total": total,
        "items": [
            {
                "job_id": str(job.id),
                "status": job.status,
                "prompt": job.prompt[:100],
                "created_at": job.created_at,
                "completed_at": job.completed_at
            }
            for job in jobs
        ]
    }
```

---

## Gallery Service

### 1. 이미지 모델

`services/gallery-service/app/models/image.py`:
```python
from sqlalchemy import Column, String, Integer, BigInteger, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func
import uuid

from app.db.base import Base

class Image(Base):
    __tablename__ = "images"
    __table_args__ = {"schema": "dev_pingvas"}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("dev_pingvas.users.id"), nullable=False)
    job_id = Column(UUID(as_uuid=True), ForeignKey("dev_pingvas.generation_jobs.id"))
    s3_key = Column(String(500), nullable=False)
    thumbnail_s3_key = Column(String(500))
    width = Column(Integer)
    height = Column(Integer)
    file_size_bytes = Column(BigInteger)
    metadata = Column(JSONB)
    is_public = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Board(Base):
    __tablename__ = "boards"
    __table_args__ = {"schema": "dev_pingvas"}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("dev_pingvas.users.id"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    is_public = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
```

---

### 2. 이미지 조회 API

`services/gallery-service/app/api/images.py`:
```python
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import List

from app.db.base import get_db
from app.models.image import Image

router = APIRouter(prefix="/api/v1/images", tags=["Images"])

@router.get("/")
async def list_images(
    user_id: str,
    limit: int = Query(50, le=100),
    offset: int = 0,
    db: Session = Depends(get_db)
):
    """
    사용자 이미지 목록 조회
    """
    query = db.query(Image).filter(Image.user_id == user_id)
    total = query.count()

    images = query.order_by(Image.created_at.desc()).offset(offset).limit(limit).all()

    return {
        "total": total,
        "items": [
            {
                "id": str(img.id),
                "s3_key": img.s3_key,
                "thumbnail_url": f"https://cdn.pingvas.studio/{img.thumbnail_s3_key}",
                "width": img.width,
                "height": img.height,
                "created_at": img.created_at
            }
            for img in images
        ]
    }

@router.get("/{image_id}")
async def get_image(image_id: str, db: Session = Depends(get_db)):
    """
    이미지 상세 조회
    """
    image = db.query(Image).filter(Image.id == image_id).first()

    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    return {
        "id": str(image.id),
        "user_id": str(image.user_id),
        "s3_key": image.s3_key,
        "url": f"https://cdn.pingvas.studio/{image.s3_key}",
        "width": image.width,
        "height": image.height,
        "metadata": image.metadata,
        "created_at": image.created_at
    }
```

---

## Model Service

### 1. 모델 관리 API

`services/model-service/app/api/models.py`:
```python
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import List

from app.db.base import get_db
from app.models.model import AIModel

router = APIRouter(prefix="/api/v1/models", tags=["Models"])

@router.get("/")
async def list_models(db: Session = Depends(get_db)):
    """
    사용 가능한 AI 모델 목록
    """
    models = db.query(AIModel).filter(AIModel.is_active == True).all()

    return {
        "items": [
            {
                "id": str(model.id),
                "name": model.name,
                "display_name": model.display_name,
                "type": model.type,
                "base_model": model.base_model
            }
            for model in models
        ]
    }

@router.get("/{model_id}")
async def get_model(model_id: str, db: Session = Depends(get_db)):
    """
    모델 상세 정보
    """
    model = db.query(AIModel).filter(AIModel.id == model_id).first()

    if not model:
        raise HTTPException(status_code=404, detail="Model not found")

    return {
        "id": str(model.id),
        "name": model.name,
        "display_name": model.display_name,
        "type": model.type,
        "base_model": model.base_model,
        "efs_path": model.efs_path,
        "metadata": model.metadata
    }
```

---

## 서비스 간 통신

### 1. 서비스 간 인증 (Internal API Key)

각 서비스의 `app/middleware/internal_auth.py`:
```python
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware

class InternalServiceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Internal API 경로 확인
        if request.url.path.startswith("/internal/"):
            internal_key = request.headers.get("X-Internal-Service-Key")

            if internal_key != "dev_internal_secret_key_123":
                raise HTTPException(status_code=403, detail="Forbidden")

        response = await call_next(request)
        return response
```

**Main 앱에 추가**:
```python
from app.middleware.internal_auth import InternalServiceMiddleware

app.add_middleware(InternalServiceMiddleware)
```

---

### 2. 서비스 디스커버리 (Docker Compose)

`docker-compose.services.yaml`:
```yaml
version: '3.8'

services:
  user-service:
    build: ./services/user-service
    container_name: user-service
    ports:
      - "8001:8001"
    environment:
      DATABASE_URL: postgresql://pingvas_admin:dev_password_123@postgres:5432/pingvas_saas
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - postgres
      - redis

  payment-service:
    build: ./services/payment-service
    container_name: payment-service
    ports:
      - "8002:8002"
    environment:
      DATABASE_URL: postgresql://pingvas_admin:dev_password_123@postgres:5432/pingvas_saas
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - postgres
      - redis

  generation-service:
    build: ./services/generation-service
    container_name: generation-service
    ports:
      - "8003:8003"
    environment:
      DATABASE_URL: postgresql://pingvas_admin:dev_password_123@postgres:5432/pingvas_saas
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - postgres
      - redis

  gallery-service:
    build: ./services/gallery-service
    container_name: gallery-service
    ports:
      - "8004:8004"
    environment:
      DATABASE_URL: postgresql://pingvas_admin:dev_password_123@postgres:5432/pingvas_saas
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - postgres
      - redis

  model-service:
    build: ./services/model-service
    container_name: model-service
    ports:
      - "8005:8005"
    environment:
      DATABASE_URL: postgresql://pingvas_admin:dev_password_123@postgres:5432/pingvas_saas
    depends_on:
      - postgres
```

---

## API Gateway 설정

### Nginx 리버스 프록시

`nginx/nginx.conf`:
```nginx
http {
    upstream user_service {
        server user-service:8001;
    }

    upstream payment_service {
        server payment-service:8002;
    }

    upstream generation_service {
        server generation-service:8003;
    }

    upstream gallery_service {
        server gallery-service:8004;
    }

    upstream model_service {
        server model-service:8005;
    }

    server {
        listen 80;
        server_name localhost;

        # User Service
        location /api/v1/auth/ {
            proxy_pass http://user_service;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        location /api/v1/users/ {
            proxy_pass http://user_service;
            proxy_set_header Host $host;
        }

        # Payment Service
        location /api/v1/credits/ {
            proxy_pass http://payment_service;
        }

        location /api/v1/webhooks/ {
            proxy_pass http://payment_service;
        }

        # Generation Service
        location /api/v1/generation/ {
            proxy_pass http://generation_service;
        }

        location /api/v1/jobs/ {
            proxy_pass http://generation_service;
        }

        # Gallery Service
        location /api/v1/images/ {
            proxy_pass http://gallery_service;
        }

        location /api/v1/boards/ {
            proxy_pass http://gallery_service;
        }

        # Model Service
        location /api/v1/models/ {
            proxy_pass http://model_service;
        }
    }
}
```

---

## 통합 테스트

### 전체 플로우 테스트

`test_full_flow.py`:
```python
import requests
import time

BASE_URL = "http://localhost"  # API Gateway

def test_complete_flow():
    # 1. 사용자 등록
    print("1. User Registration...")
    register_response = requests.post(
        f"{BASE_URL}/api/v1/auth/register",
        json={"email": f"test_{int(time.time())}@example.com", "password": "test123456"}
    )
    assert register_response.status_code == 201
    token = register_response.json()["access_token"]
    user_id = register_response.json()["user"]["id"]
    print(f"✅ User registered: {user_id}")

    headers = {"Authorization": f"Bearer {token}"}

    # 2. 크레딧 확인
    print("\n2. Check Credit Balance...")
    credit_response = requests.get(
        f"{BASE_URL}/api/v1/credits/balance/{user_id}",
        headers=headers
    )
    print(f"✅ Credits: {credit_response.json()['balance']}")

    # 3. 이미지 생성 요청
    print("\n3. Create Generation Job...")
    gen_response = requests.post(
        f"{BASE_URL}/api/v1/generation/create",
        headers=headers,
        json={
            "prompt": "A beautiful mountain landscape",
            "model": "sd15",
            "width": 512,
            "height": 512,
            "steps": 20
        }
    )
    assert gen_response.status_code == 200
    job_id = gen_response.json()["job_id"]
    print(f"✅ Job created: {job_id}")

    # 4. 작업 상태 폴링
    print("\n4. Polling Job Status...")
    for i in range(30):
        status_response = requests.get(
            f"{BASE_URL}/api/v1/jobs/{job_id}",
            headers=headers
        )
        status = status_response.json()["status"]
        print(f"  Status: {status}")

        if status == "completed":
            break

        time.sleep(2)

    print("\n🎉 Complete flow test passed!")

if __name__ == "__main__":
    test_complete_flow()
```

---

## 다음 단계

마이크로서비스 개발이 완료되었습니다! 이제 AWS 인프라 구축으로 넘어갑니다:

**👉 [Phase 3 - AWS 인프라 구축](./phase-03-aws-infra.md)**

---

## 체크리스트

- [ ] User Service OAuth 통합
- [ ] Payment Service Lemon Squeezy 연동
- [ ] Generation Service 작업 관리
- [ ] Gallery Service 이미지 관리
- [ ] Model Service 모델 관리
- [ ] 서비스 간 통신 구현
- [ ] API Gateway 설정
- [ ] 전체 플로우 테스트 통과
