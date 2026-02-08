# InvokeAI SaaS 전환 핸즈온 가이드

## 목차
1. [전환 전략 개요](#1-전환-전략-개요)
2. [Phase 1: 인증/인가 시스템 구축](#2-phase-1-인증인가-시스템-구축)
3. [Phase 2: 데이터베이스 마이그레이션 (SQLite -> PostgreSQL)](#3-phase-2-데이터베이스-마이그레이션)
4. [Phase 3: 멀티테넌시 적용](#4-phase-3-멀티테넌시-적용)
5. [Phase 4: 스토리지 전환 (로컬 -> S3)](#5-phase-4-스토리지-전환)
6. [Phase 5: GPU 워커 분리 아키텍처](#6-phase-5-gpu-워커-분리-아키텍처)
7. [Phase 6: 큐 시스템 전환 (SQLite -> SQS/Redis)](#7-phase-6-큐-시스템-전환)
8. [Phase 7: 프론트엔드 SaaS 기능 추가](#8-phase-7-프론트엔드-saas-기능-추가)
9. [Phase 8: 동기→비동기 처리 전환](#9-phase-8-동기비동기-처리-전환)
10. [커스터마이징 핵심 원칙](#10-커스터마이징-핵심-원칙)
11. [개선이 필요한 불안정 요소](#11-개선이-필요한-불안정-요소)

---

## 1. 전환 전략 개요

### 1.1 핵심 원칙

InvokeAI의 코어 기능(노드 기반 이미지 생성 파이프라인, 모델 관리, 캔버스 시스템)은 **그대로 보존**하고, 온라인 SaaS 구조에 맞는 계층을 **감싸는(wrapping) 방식**으로 커스터마이징합니다.

```
[변경하지 않는 것]
- invokeai/app/invocations/* (노드 시스템)
- invokeai/backend/* (AI 추론 엔진)
- invokeai/frontend/web/src/features/controlLayers/* (캔버스)
- invokeai/frontend/web/src/features/nodes/* (노드 에디터)
- invokeai/frontend/web/src/features/parameters/* (생성 파라미터)

[교체하는 것]
- SQLite -> PostgreSQL
- 로컬 파일 스토리지 -> S3
- 단일 프로세스 큐 -> SQS + 분산 GPU 워커
- WebSocket (단일) -> Redis-backed Socket.IO

[추가하는 것]
- 인증/인가 (Cognito + JWT)
- 구독/결제 (Stripe)
- 크레딧 시스템
- 관리자 패널
- 모니터링/로깅
```

### 1.2 전환 단계별 로드맵

```mermaid
gantt
    title SaaS 전환 로드맵
    dateFormat YYYY-MM-DD
    axisFormat %m/%d

    section Phase 1 - 인증
    Cognito 설정              :p1a, 2025-01-01, 5d
    JWT 미들웨어 추가          :p1b, after p1a, 5d
    프론트엔드 로그인 UI       :p1c, after p1a, 7d

    section Phase 2 - DB 전환
    PostgreSQL 스키마 설계     :p2a, after p1b, 5d
    ORM 전환 코드 작성        :p2b, after p2a, 10d
    데이터 마이그레이션        :p2c, after p2b, 5d

    section Phase 3 - 멀티테넌시
    user_id 필드 추가          :p3a, after p2c, 7d
    데이터 격리 적용           :p3b, after p3a, 5d

    section Phase 4 - 스토리지
    S3 스토리지 서비스 구현    :p4a, after p3b, 7d
    이미지 서비스 교체          :p4b, after p4a, 5d

    section Phase 5 - GPU 분리
    GPU 워커 서비스 구현       :p5a, after p4b, 10d
    SQS 큐 연동               :p5b, after p5a, 7d

    section Phase 6 - 구독/결제
    Stripe 연동                :p6a, after p5b, 7d
    크레딧 시스템 구현          :p6b, after p6a, 7d

    section Phase 7 - 프론트엔드
    SaaS UI 추가               :p7a, after p6b, 14d
    관리자 패널                 :p7b, after p7a, 10d

    section Phase 8 - 동기→비동기 전환
    DB 서비스 비동기화          :p8a, after p5b, 7d
    파일 I/O 비동기화           :p8b, after p8a, 5d
    CPU 바운드 래핑             :p8c, after p8b, 3d
```

---

## 2. Phase 1: 인증/인가 시스템 구축

### 2.1 AWS Cognito 설정

InvokeAI는 현재 인증이 전혀 없습니다. AWS Cognito를 사용하여 사용자 인증을 추가합니다.

**Step 1: Cognito User Pool 생성**

```bash
# AWS CLI로 User Pool 생성
aws cognito-idp create-user-pool \
  --pool-name "invokeai-saas-users" \
  --policies '{
    "PasswordPolicy": {
      "MinimumLength": 8,
      "RequireUppercase": true,
      "RequireLowercase": true,
      "RequireNumbers": true,
      "RequireSymbols": false
    }
  }' \
  --auto-verified-attributes email \
  --username-attributes email \
  --schema '[
    {"Name": "email", "Required": true, "Mutable": true},
    {"Name": "name", "Required": true, "Mutable": true}
  ]'
```

**Step 2: App Client 생성**

```bash
aws cognito-idp create-user-pool-client \
  --user-pool-id <YOUR_POOL_ID> \
  --client-name "invokeai-web-app" \
  --no-generate-secret \
  --explicit-auth-flows \
    ALLOW_USER_PASSWORD_AUTH \
    ALLOW_REFRESH_TOKEN_AUTH \
    ALLOW_USER_SRP_AUTH \
  --supported-identity-providers COGNITO \
  --callback-urls '["https://your-domain.com/auth/callback"]' \
  --logout-urls '["https://your-domain.com/auth/logout"]'
```

**Step 3: 백엔드 JWT 미들웨어 추가**

새로운 파일 `invokeai/app/api/middleware/auth.py` 생성:

```python
# invokeai/app/api/middleware/auth.py
"""
JWT 인증 미들웨어
- Cognito에서 발급한 JWT 토큰을 검증
- 모든 /api/* 엔드포인트에 적용 (일부 공개 경로 제외)
"""
import json
import time
from typing import Optional

import jwt
import requests
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# 설정값 (환경변수에서 로드)
COGNITO_REGION = "ap-northeast-2"  # 서울 리전
COGNITO_USER_POOL_ID = "your-pool-id"
COGNITO_APP_CLIENT_ID = "your-client-id"
COGNITO_ISSUER = f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}"
JWKS_URL = f"{COGNITO_ISSUER}/.well-known/jwks.json"

# JWKS 키 캐시
_jwks_cache: dict = {}
_jwks_cache_time: float = 0
JWKS_CACHE_TTL = 3600  # 1시간

security = HTTPBearer(auto_error=False)


def get_jwks() -> dict:
    """Cognito JWKS 키를 가져옴 (캐싱)"""
    global _jwks_cache, _jwks_cache_time
    if time.time() - _jwks_cache_time > JWKS_CACHE_TTL:
        response = requests.get(JWKS_URL)
        _jwks_cache = response.json()
        _jwks_cache_time = time.time()
    return _jwks_cache


def verify_token(token: str) -> dict:
    """JWT 토큰 검증 및 클레임 반환"""
    jwks = get_jwks()
    headers = jwt.get_unverified_header(token)
    kid = headers.get("kid")

    # 키 찾기
    key = None
    for k in jwks.get("keys", []):
        if k["kid"] == kid:
            key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(k))
            break

    if key is None:
        raise HTTPException(status_code=401, detail="Invalid token key")

    try:
        payload = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=COGNITO_APP_CLIENT_ID,
            issuer=COGNITO_ISSUER,
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {str(e)}")


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    """현재 인증된 사용자 정보 반환"""
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = verify_token(credentials.credentials)
    return {
        "cognito_sub": payload["sub"],
        "email": payload.get("email"),
        "name": payload.get("name"),
    }


async def get_optional_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Optional[dict]:
    """선택적 인증 (공개 엔드포인트용)"""
    if credentials is None:
        return None
    try:
        return await get_current_user(credentials)
    except HTTPException:
        return None
```

**Step 4: 라우터에 인증 적용**

`invokeai/app/api_app.py` 수정 - 인증 미들웨어를 추가합니다:

```python
# api_app.py 에 추가할 코드 패턴
from invokeai.app.api.middleware.auth import get_current_user

# 인증이 필요한 라우터에 dependency 추가
# 예: images 라우터 수정
@images_router.post("/upload", dependencies=[Depends(get_current_user)])
async def upload_image(...):
    ...
```

**Step 5: 프론트엔드 인증 설정**

`invokeai/frontend/web/src/services/auth/` 디렉토리 생성:

```typescript
// src/services/auth/authService.ts
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from 'amazon-cognito-identity-js';

const userPool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  ClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
});

export const authService = {
  signUp: (email: string, password: string, name: string) => {
    return new Promise((resolve, reject) => {
      userPool.signUp(
        email,
        password,
        [{ Name: 'name', Value: name }],
        [],
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
    });
  },

  signIn: (email: string, password: string) => {
    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });
    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: userPool,
    });
    return new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => resolve(session),
        onFailure: (err) => reject(err),
      });
    });
  },

  getAccessToken: (): string | null => {
    const currentUser = userPool.getCurrentUser();
    if (!currentUser) return null;

    let token: string | null = null;
    currentUser.getSession((err: Error | null, session: any) => {
      if (!err && session.isValid()) {
        token = session.getAccessToken().getJwtToken();
      }
    });
    return token;
  },

  signOut: () => {
    const currentUser = userPool.getCurrentUser();
    currentUser?.signOut();
  },
};
```

---

## 3. Phase 2: 데이터베이스 마이그레이션

### 3.1 PostgreSQL 스키마 생성

InvokeAI는 자체 SQLite 마이그레이션 시스템(v0~v25)을 사용하고 있습니다. SaaS 전환 시 **SQLAlchemy + Alembic** 기반으로 전환합니다.

**Step 1: 의존성 추가**

`pyproject.toml`에 추가:

```toml
dependencies = [
  # 기존 의존성...
  "sqlalchemy[asyncio]>=2.0",
  "asyncpg",           # PostgreSQL async 드라이버
  "alembic>=1.13",     # DB 마이그레이션
  "psycopg[binary]>=3.1",  # PostgreSQL 동기 드라이버
]
```

**Step 2: SQLAlchemy 모델 정의**

새 파일 `invokeai/app/services/shared/postgres/models.py`:

```python
# invokeai/app/services/shared/postgres/models.py
"""
PostgreSQL용 SQLAlchemy 모델 정의
기존 SQLite 스키마를 PostgreSQL에 맞게 변환
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Integer,
    String, Text, UniqueConstraint, func
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    cognito_sub: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    avatar_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="user", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    last_login_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    subscriptions = relationship("UserSubscription", back_populates="user")
    credits = relationship("Credit", back_populates="user")
    images = relationship("ImageRecord", back_populates="user")


class ImageRecord(Base):
    """기존 images 테이블 + user_id + S3 지원"""
    __tablename__ = "images"

    image_name: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    image_origin: Mapped[str] = mapped_column(String(50), nullable=False)
    image_category: Mapped[str] = mapped_column(String(50), nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    node_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    metadata_json: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    is_intermediate: Mapped[bool] = mapped_column(Boolean, default=False)
    starred: Mapped[bool] = mapped_column(Boolean, default=False)
    has_workflow: Mapped[bool] = mapped_column(Boolean, default=False)
    workflow_json: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    graph_json: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    s3_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    s3_thumbnail_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    file_size_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    user = relationship("User", back_populates="images")


class SubscriptionPlan(Base):
    __tablename__ = "subscription_plans"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    slug: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    monthly_price: Mapped[float] = mapped_column(Float, nullable=False)
    annual_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    monthly_credits: Mapped[int] = mapped_column(Integer, nullable=False)
    gpu_tier: Mapped[str] = mapped_column(String(20), nullable=False)
    max_resolution: Mapped[int] = mapped_column(Integer, nullable=False)
    max_batch_size: Mapped[int] = mapped_column(Integer, nullable=False)
    max_concurrent_jobs: Mapped[int] = mapped_column(Integer, nullable=False)
    max_storage_gb: Mapped[int] = mapped_column(Integer, nullable=False)
    node_editor_access: Mapped[bool] = mapped_column(Boolean, default=False)
    api_access: Mapped[bool] = mapped_column(Boolean, default=False)
    priority_queue: Mapped[bool] = mapped_column(Boolean, default=False)
    features: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Credit(Base):
    __tablename__ = "credits"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    total_credits: Mapped[int] = mapped_column(Integer, nullable=False)
    used_credits: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(30), nullable=False)
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    valid_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    user = relationship("User", back_populates="credits")
```

**Step 3: 기존 서비스 인터페이스 유지하면서 구현만 교체**

InvokeAI의 서비스 아키텍처는 이미 **추상 기반 클래스 + 구현 클래스** 패턴을 사용하므로, 구현 클래스만 교체하면 됩니다.

예시: `ImageRecordStorage` 인터페이스를 유지하면서 PostgreSQL 구현 추가:

```python
# invokeai/app/services/image_records/image_records_postgres.py
"""
PostgreSQL 기반 이미지 레코드 스토리지
기존 SqliteImageRecordStorage와 동일한 인터페이스
"""
from sqlalchemy.ext.asyncio import AsyncSession

from invokeai.app.services.image_records.image_records_base import ImageRecordStorageBase


class PostgresImageRecordStorage(ImageRecordStorageBase):
    def __init__(self, session_factory):
        self._session_factory = session_factory

    # ... 기존 메서드 시그니처를 그대로 유지하면서 PostgreSQL 구현
```

### 3.2 Alembic 설정

```bash
# Alembic 초기화
cd invokeai
alembic init alembic

# alembic.ini 수정
# sqlalchemy.url = postgresql+asyncpg://user:pass@host:5432/invokeai
```

---

## 4. Phase 3: 멀티테넌시 적용

### 4.1 핵심 변경: 모든 데이터에 user_id 추가

```python
# 핵심 패턴: 모든 서비스 메서드에 user_id 파라미터 추가
# 기존:
def get_many(self, offset, limit, ...):
    # 모든 이미지 반환

# SaaS 전환 후:
def get_many(self, user_id: UUID, offset, limit, ...):
    # user_id에 해당하는 이미지만 반환
```

### 4.2 데이터 격리 전략

```mermaid
flowchart LR
    subgraph "Row-Level Security"
        REQ["API Request"] --> AUTH["JWT 인증"]
        AUTH --> UID["user_id 추출"]
        UID --> QUERY["DB 쿼리<br/>WHERE user_id = ?"]
        QUERY --> RESULT["격리된 데이터"]
    end
```

**PostgreSQL RLS (Row Level Security) 활용:**

```sql
-- 모든 SaaS 테이블에 RLS 적용
ALTER TABLE images ENABLE ROW LEVEL SECURITY;

CREATE POLICY images_isolation ON images
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

---

## 5. Phase 4: 스토리지 전환

### 5.1 S3 이미지 스토리지 구현

현재 InvokeAI는 `DiskImageFileStorage`를 사용합니다. 이를 S3로 교체합니다.

```python
# invokeai/app/services/image_files/image_files_s3.py
"""
S3 기반 이미지 파일 스토리지
기존 DiskImageFileStorage와 동일한 인터페이스
"""
import io
from pathlib import Path

import boto3
from PIL import Image

from invokeai.app.services.image_files.image_files_base import ImageFileStorageBase


class S3ImageFileStorage(ImageFileStorageBase):
    def __init__(self, bucket_name: str, prefix: str = "images"):
        self._s3 = boto3.client("s3")
        self._bucket = bucket_name
        self._prefix = prefix

    def get(self, image_name: str) -> Image.Image:
        """S3에서 이미지 가져오기"""
        key = f"{self._prefix}/{image_name}"
        response = self._s3.get_object(Bucket=self._bucket, Key=key)
        return Image.open(io.BytesIO(response["Body"].read()))

    def save(
        self,
        image: Image.Image,
        image_name: str,
        metadata: dict | None = None,
        workflow: str | None = None,
        graph: str | None = None,
    ) -> None:
        """S3에 이미지 저장"""
        # 원본 저장
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        buffer.seek(0)

        key = f"{self._prefix}/{image_name}"
        self._s3.put_object(
            Bucket=self._bucket,
            Key=key,
            Body=buffer.getvalue(),
            ContentType="image/png",
        )

        # 썸네일 생성 및 저장
        thumbnail = image.copy()
        thumbnail.thumbnail((256, 256))
        thumb_buffer = io.BytesIO()
        thumbnail.save(thumb_buffer, format="WEBP")
        thumb_buffer.seek(0)

        thumb_key = f"{self._prefix}/thumbnails/{image_name}.webp"
        self._s3.put_object(
            Bucket=self._bucket,
            Key=thumb_key,
            Body=thumb_buffer.getvalue(),
            ContentType="image/webp",
        )

    def delete(self, image_name: str) -> None:
        """S3에서 이미지 삭제"""
        self._s3.delete_object(
            Bucket=self._bucket,
            Key=f"{self._prefix}/{image_name}",
        )
        self._s3.delete_object(
            Bucket=self._bucket,
            Key=f"{self._prefix}/thumbnails/{image_name}.webp",
        )

    def get_url(self, image_name: str, thumbnail: bool = False) -> str:
        """Pre-signed URL 생성"""
        if thumbnail:
            key = f"{self._prefix}/thumbnails/{image_name}.webp"
        else:
            key = f"{self._prefix}/{image_name}"

        return self._s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=3600,
        )
```

### 5.2 dependencies.py에서 스토리지 교체

```python
# ApiDependencies.initialize() 에서 변경
# 기존:
image_files = DiskImageFileStorage(f"{output_folder}/images")

# SaaS 전환 후:
if config.use_s3_storage:
    image_files = S3ImageFileStorage(
        bucket_name=config.s3_bucket_name,
        prefix=f"users/{user_id}/images",
    )
else:
    image_files = DiskImageFileStorage(f"{output_folder}/images")
```

---

## 6. Phase 5: GPU 워커 분리 아키텍처

### 6.1 아키텍처 변경

현재 InvokeAI는 API 서버와 GPU 추론이 **같은 프로세스**에서 실행됩니다. SaaS에서는 이를 분리해야 합니다.

```mermaid
sequenceDiagram
    participant Client
    participant API as API Server (ECS Fargate)
    participant SQS as Amazon SQS
    participant Worker as GPU Worker (ECS GPU)
    participant S3 as Amazon S3
    participant Redis as Redis

    Client->>API: POST /enqueue_batch
    API->>SQS: Send message (job)
    API->>Redis: Set job status = queued
    API-->>Client: 202 Accepted

    Worker->>SQS: Receive message
    Worker->>Redis: Set job status = processing
    Worker->>Worker: Load model + Run inference
    Worker->>S3: Upload result image
    Worker->>Redis: Set job status = completed
    Worker->>Redis: PUBLISH completion event

    Redis-->>API: Subscription notification
    API-->>Client: WebSocket: job completed
```

### 6.2 GPU 워커 구현

```python
# invokeai/worker/gpu_worker.py
"""
독립 GPU 워커 프로세스
SQS에서 작업을 가져와 GPU에서 실행
"""
import json
import time

import boto3
import redis

from invokeai.app.services.shared.graph import Graph
from invokeai.backend.util.devices import TorchDevice


class GPUWorker:
    def __init__(self, config):
        self.sqs = boto3.client("sqs", region_name=config.aws_region)
        self.s3 = boto3.client("s3")
        self.redis = redis.Redis(host=config.redis_host, port=6379)
        self.queue_url = config.sqs_queue_url
        self.device = TorchDevice.choose_torch_device()

    def run(self):
        """메인 이벤트 루프"""
        while True:
            response = self.sqs.receive_message(
                QueueUrl=self.queue_url,
                MaxNumberOfMessages=1,
                WaitTimeSeconds=20,  # Long polling
            )

            messages = response.get("Messages", [])
            if not messages:
                continue

            for message in messages:
                self.process_job(message)
                self.sqs.delete_message(
                    QueueUrl=self.queue_url,
                    ReceiptHandle=message["ReceiptHandle"],
                )

    def process_job(self, message):
        """작업 처리"""
        job = json.loads(message["Body"])
        job_id = job["job_id"]
        user_id = job["user_id"]

        try:
            # 상태 업데이트
            self.redis.set(f"job:{job_id}:status", "processing")
            self.redis.publish("job_updates", json.dumps({
                "job_id": job_id,
                "user_id": user_id,
                "status": "processing",
            }))

            # 그래프 실행 (기존 InvokeAI 코어 활용)
            graph = Graph.model_validate(job["graph"])
            # ... 노드 실행 로직 (기존 SessionRunner 로직 재사용)

            # 결과 S3 업로드
            # ... 이미지 업로드

            self.redis.set(f"job:{job_id}:status", "completed")
            self.redis.publish("job_updates", json.dumps({
                "job_id": job_id,
                "user_id": user_id,
                "status": "completed",
                "result": {"image_name": "..."},
            }))

        except Exception as e:
            self.redis.set(f"job:{job_id}:status", "failed")
            self.redis.publish("job_updates", json.dumps({
                "job_id": job_id,
                "user_id": user_id,
                "status": "failed",
                "error": str(e),
            }))
```

---

## 7. Phase 6: 큐 시스템 전환

### 7.1 SQS 기반 세션 큐

기존 `SqliteSessionQueue`를 SQS + Redis로 교체합니다.

```python
# invokeai/app/services/session_queue/session_queue_sqs.py
"""
Amazon SQS 기반 세션 큐
기존 SqliteSessionQueue 인터페이스 유지
"""
import json
import uuid
from typing import Optional

import boto3
import redis

from invokeai.app.services.session_queue.session_queue_base import SessionQueueBase
from invokeai.app.services.session_queue.session_queue_common import (
    Batch, EnqueueBatchResult, SessionQueueItem, SessionQueueStatus,
)


class SQSSessionQueue(SessionQueueBase):
    def __init__(self, sqs_url: str, redis_client: redis.Redis):
        self._sqs = boto3.client("sqs")
        self._sqs_url = sqs_url
        self._redis = redis_client

    async def enqueue_batch(
        self, queue_id: str, batch: Batch, prepend: bool = False
    ) -> EnqueueBatchResult:
        """배치를 SQS에 전송"""
        batch_id = str(uuid.uuid4())
        enqueued = 0

        for graph in batch.graph.generate_graphs(batch):
            session_id = str(uuid.uuid4())
            message = {
                "queue_id": queue_id,
                "batch_id": batch_id,
                "session_id": session_id,
                "graph": graph.model_dump_json(),
                "user_id": batch.user_id,  # SaaS 추가 필드
                "gpu_tier": batch.gpu_tier,  # SaaS 추가 필드
            }

            self._sqs.send_message(
                QueueUrl=self._sqs_url,
                MessageBody=json.dumps(message),
                MessageGroupId=queue_id,
            )

            # Redis에 상태 저장
            self._redis.hset(f"queue_item:{session_id}", mapping={
                "status": "pending",
                "queue_id": queue_id,
                "batch_id": batch_id,
            })
            enqueued += 1

        return EnqueueBatchResult(
            batch=batch,
            enqueued=enqueued,
            requested=enqueued,
            priority=0,
        )
```

---

## 8. Phase 7: 프론트엔드 SaaS 기능 추가

### 8.1 새로운 페이지/컴포넌트 구조

```
src/
├── features/
│   ├── auth/                    # ★ 새로 추가
│   │   ├── components/
│   │   │   ├── LoginPage.tsx
│   │   │   ├── SignUpPage.tsx
│   │   │   ├── ForgotPasswordPage.tsx
│   │   │   └── AuthGuard.tsx
│   │   ├── store/
│   │   │   └── authSlice.ts
│   │   └── hooks/
│   │       └── useAuth.ts
│   │
│   ├── subscription/            # ★ 새로 추가
│   │   ├── components/
│   │   │   ├── PricingPage.tsx
│   │   │   ├── PlanCard.tsx
│   │   │   ├── SubscriptionStatus.tsx
│   │   │   └── UpgradeModal.tsx
│   │   └── store/
│   │       └── subscriptionSlice.ts
│   │
│   ├── credits/                 # ★ 새로 추가
│   │   ├── components/
│   │   │   ├── CreditBalance.tsx
│   │   │   ├── CreditHistory.tsx
│   │   │   ├── PurchaseCreditsModal.tsx
│   │   │   └── UsageChart.tsx
│   │   └── store/
│   │       └── creditsSlice.ts
│   │
│   ├── dashboard/               # ★ 새로 추가
│   │   ├── components/
│   │   │   ├── DashboardPage.tsx
│   │   │   ├── UsageStats.tsx
│   │   │   └── RecentGenerations.tsx
│   │   └── store/
│   │       └── dashboardSlice.ts
│   │
│   ├── admin/                   # ★ 새로 추가
│   │   ├── components/
│   │   │   ├── AdminLayout.tsx
│   │   │   ├── UserManagement.tsx
│   │   │   ├── PlanManagement.tsx
│   │   │   ├── TestPlanGrant.tsx
│   │   │   ├── GPUMonitor.tsx
│   │   │   └── RevenueDashboard.tsx
│   │   └── store/
│   │       └── adminSlice.ts
│   │
│   └── landing/                 # ★ 새로 추가
│       ├── LandingPage.tsx
│       ├── HeroSection.tsx
│       ├── FeaturesSection.tsx
│       └── PricingSection.tsx
```

### 8.2 라우팅 추가

```typescript
// src/app/routes.tsx
import { createBrowserRouter } from 'react-router-dom';

export const router = createBrowserRouter([
  // 공개 페이지
  { path: '/', element: <LandingPage /> },
  { path: '/pricing', element: <PricingPage /> },  // Starter($25)/Pro($75)/Studio($150)/Enterprise(Custom)/Trial(7일)
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignUpPage /> },

  // 인증 필요 페이지
  {
    element: <AuthGuard />,
    children: [
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/studio', element: <StudioPage /> },       // 기존 InvokeAI UI
      { path: '/gallery', element: <GalleryPage /> },
      { path: '/workflows', element: <WorkflowsPage /> },
      { path: '/models', element: <ModelsPage /> },
      { path: '/account', element: <AccountPage /> },
      { path: '/account/subscription', element: <SubscriptionPage /> },
      { path: '/account/billing', element: <BillingPage /> },
    ],
  },

  // 관리자 전용
  {
    element: <AdminGuard />,
    children: [
      { path: '/admin', element: <AdminDashboard /> },
      { path: '/admin/users', element: <UserManagement /> },
      { path: '/admin/plans', element: <PlanManagement /> },
      { path: '/admin/test-plans', element: <TestPlanGrant /> },
      { path: '/admin/gpu', element: <GPUMonitor /> },
    ],
  },
]);
```

### 8.3 크레딧 차감 미들웨어 (프론트엔드)

```typescript
// src/features/credits/hooks/useCreditCheck.ts
export const useCreditCheck = () => {
  const { data: balance } = useGetCreditBalanceQuery();
  const dispatch = useAppDispatch();

  const checkAndDeduct = async (estimatedCredits: number): Promise<boolean> => {
    if (!balance || balance.remaining < estimatedCredits) {
      dispatch(openUpgradeModal());
      return false;
    }
    return true;
  };

  return { checkAndDeduct, balance };
};
```

---

## 9. Phase 8: 동기→비동기 처리 전환

InvokeAI의 현재 아키텍처는 **동기 처리 중심**입니다. SaaS 전환 시 API 서버의 동시 처리 성능을 극대화하기 위해, 서비스 계층의 동기 호출을 비동기로 전환하는 작업이 필요합니다.

### 9.1 현재 동기 처리 문제점과 전환 전략

```mermaid
flowchart TB
    subgraph "현재 문제 (동기 블로킹)"
        direction TB
        P1["async 핸들러에서<br/>동기 서비스 호출"]
        P2["이벤트 루프 블로킹<br/>스레드풀 고갈"]
        P3["단일 SQLite 락<br/>쓰기 직렬화"]
        P4["동기 파일 I/O<br/>요청 처리 지연"]

        P1 --> P2
        P3 --> P2
        P4 --> P2
    end

    subgraph "전환 전략"
        direction TB
        S1["PostgreSQL + asyncpg<br/>(비동기 DB)"]
        S2["S3 + aioboto3<br/>(비동기 스토리지)"]
        S3["asyncio.to_thread()<br/>(CPU 바운드 래핑)"]
        S4["GPU 워커 분리<br/>(동기 유지 + 프로세스 격리)"]
    end

    P2 -->|"해결"| S1
    P2 -->|"해결"| S2
    P2 -->|"해결"| S3
    P2 -->|"해결"| S4

    style P2 fill:#ff4757,color:#fff
    style S1 fill:#7bed9f,color:#000
    style S2 fill:#7bed9f,color:#000
    style S3 fill:#7bed9f,color:#000
    style S4 fill:#ffa502,color:#fff
```

### 9.2 서비스 계층 비동기 전환 (Step-by-Step)

**Step 1: 비동기 데이터베이스 서비스 계층 추가**

기존 동기 인터페이스를 유지하면서, 비동기 구현을 추가합니다.

```python
# invokeai/app/services/image_records/image_records_postgres_async.py
"""
비동기 PostgreSQL 기반 이미지 레코드 스토리지
기존 동기 인터페이스를 비동기로 확장
"""
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from invokeai.app.services.image_records.image_records_base import ImageRecordStorageBase


class AsyncPostgresImageRecordStorage:
    """비동기 전용 구현 - 기존 동기 인터페이스와 별도"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]):
        self._session_factory = session_factory

    async def get(self, image_name: str) -> ImageRecord:
        """비동기 이미지 레코드 조회"""
        async with self._session_factory() as session:
            result = await session.execute(
                select(ImageRecordModel).where(
                    ImageRecordModel.image_name == image_name
                )
            )
            record = result.scalar_one_or_none()
            if record is None:
                raise ImageRecordNotFoundException
            return record.to_domain()

    async def save(self, image_record: ImageRecord) -> None:
        """비동기 이미지 레코드 저장"""
        async with self._session_factory() as session:
            model = ImageRecordModel.from_domain(image_record)
            session.add(model)
            await session.commit()

    async def get_many(
        self,
        user_id: str,
        offset: int = 0,
        limit: int = 10,
        **filters,
    ) -> OffsetPaginatedResults[ImageRecord]:
        """비동기 이미지 목록 조회 (사용자별 격리)"""
        async with self._session_factory() as session:
            query = (
                select(ImageRecordModel)
                .where(ImageRecordModel.user_id == user_id)
                .offset(offset)
                .limit(limit)
                .order_by(ImageRecordModel.created_at.desc())
            )
            result = await session.execute(query)
            records = result.scalars().all()

            count_result = await session.execute(
                select(func.count()).where(ImageRecordModel.user_id == user_id)
            )
            total = count_result.scalar()

            return OffsetPaginatedResults(
                items=[r.to_domain() for r in records],
                offset=offset,
                limit=limit,
                total=total,
            )
```

**Step 2: API 라우터에서 비동기 서비스 호출**

```python
# 기존 (동기 블로킹):
@images_router.get("/{image_name}")
async def get_image(image_name: str):
    result = ApiDependencies.invoker.services.images.get_dto(image_name)  # 동기!
    return result

# SaaS 전환 후 (비동기):
@images_router.get("/{image_name}")
async def get_image(image_name: str, user: dict = Depends(get_current_user)):
    result = await async_image_service.get_dto(image_name, user["id"])  # 비동기!
    return result
```

**Step 3: 파일 I/O 비동기 전환**

```python
# invokeai/app/services/image_files/image_files_s3_async.py
"""
비동기 S3 이미지 파일 스토리지
"""
import aioboto3
from PIL import Image


class AsyncS3ImageFileStorage:
    def __init__(self, bucket_name: str, prefix: str = "images"):
        self._session = aioboto3.Session()
        self._bucket = bucket_name
        self._prefix = prefix

    async def get(self, image_name: str) -> Image.Image:
        """비동기 S3에서 이미지 가져오기"""
        async with self._session.client("s3") as s3:
            response = await s3.get_object(
                Bucket=self._bucket,
                Key=f"{self._prefix}/{image_name}",
            )
            data = await response["Body"].read()
            # PIL Image.open은 CPU 바운드이므로 to_thread 사용
            return await asyncio.to_thread(Image.open, io.BytesIO(data))

    async def save(self, image: Image.Image, image_name: str, **kwargs) -> None:
        """비동기 S3에 이미지 저장"""
        # PIL 인코딩은 CPU 바운드 → to_thread
        buffer = await asyncio.to_thread(self._encode_image, image)

        async with self._session.client("s3") as s3:
            await s3.put_object(
                Bucket=self._bucket,
                Key=f"{self._prefix}/{image_name}",
                Body=buffer,
                ContentType="image/png",
            )

    @staticmethod
    def _encode_image(image: Image.Image) -> bytes:
        """동기 이미지 인코딩 (CPU 바운드)"""
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()
```

**Step 4: CPU 바운드 작업 asyncio.to_thread() 래핑**

```python
# 이미지 디코딩, 해시 계산 등 CPU 바운드 작업
async def upload_image(file: UploadFile):
    contents = await file.read()  # 비동기 ✓

    # CPU 바운드 작업은 to_thread로 래핑
    pil_image = await asyncio.to_thread(Image.open, io.BytesIO(contents))
    resized = await asyncio.to_thread(heuristic_resize_fast, pil_image)

    # 비동기 서비스 호출
    result = await async_image_service.create(
        image=resized,
        user_id=current_user["id"],
    )
    return result
```

### 9.3 전환 대상 분류 (동기 유지 vs 비동기 전환)

| 컴포넌트 | 전환 방식 | 이유 |
|----------|----------|------|
| **DB 쿼리 (SQLite→PostgreSQL)** | ✅ 비동기 전환 | asyncpg 사용, 연결 풀링 |
| **파일 I/O (디스크→S3)** | ✅ 비동기 전환 | aioboto3 사용 |
| **이미지 인코딩/디코딩 (PIL)** | 🔶 to_thread 래핑 | CPU 바운드, 완전 비동기 불가 |
| **모델 로딩** | ❌ 동기 유지 | GPU 워커에서 격리 실행 |
| **GPU 연산 (PyTorch)** | ❌ 동기 유지 | PyTorch 특성상 불가 |
| **디노이징 루프** | ❌ 동기 유지 | GPU 워커에서 격리 실행 |
| **이벤트 시스템** | ✅ 이미 비동기 | 변경 불필요 |
| **WebSocket 브로드캐스트** | ✅ 이미 비동기 | Redis adapter 추가만 |

### 9.4 동기/비동기 분리 아키텍처 (최종)

```mermaid
flowchart TB
    subgraph "API 서버 (전부 비동기)"
        direction TB
        REQ["HTTP 요청"] --> AUTH["JWT 인증<br/>(async)"]
        AUTH --> HANDLER["API 핸들러<br/>(async def)"]
        HANDLER --> ASYNC_DB["asyncpg<br/>(await query)"]
        HANDLER --> ASYNC_S3["aioboto3<br/>(await upload/download)"]
        HANDLER --> THREAD["asyncio.to_thread()<br/>(CPU 바운드 래핑)"]
        HANDLER --> SQS_SEND["SQS 메시지 전송<br/>(await send)"]
    end

    subgraph "GPU 워커 (전부 동기)"
        direction TB
        SQS_RECV["SQS 메시지 수신<br/>(동기 long polling)"]
        NODE["node.invoke()<br/>(동기 실행)"]
        GPU_OP["GPU 연산<br/>(동기 PyTorch)"]
        MODEL["모델 캐시<br/>(동기 + 프로세스 독립)"]
        S3_SYNC["S3 결과 업로드<br/>(동기 boto3)"]
        REDIS_PUB["Redis 상태 발행<br/>(동기)"]

        SQS_RECV --> NODE
        NODE --> GPU_OP
        NODE --> MODEL
        NODE --> S3_SYNC
        NODE --> REDIS_PUB
    end

    SQS_SEND -->|"비동기→동기 경계"| SQS_RECV

    style REQ fill:#4ecdc4,color:#fff
    style ASYNC_DB fill:#4ecdc4,color:#fff
    style ASYNC_S3 fill:#4ecdc4,color:#fff
    style GPU_OP fill:#ff6b6b,color:#fff
    style MODEL fill:#ff6b6b,color:#fff
    style SQS_SEND fill:#ffa502,color:#fff
    style SQS_RECV fill:#ffa502,color:#fff
```

### 9.5 마이그레이션 전/후 성능 비교 (예상)

| 메트릭 | 현재 (동기) | SaaS (비동기 API + 동기 GPU) |
|--------|-----------|---------------------------|
| **동시 API 요청 처리** | ~10-20 (스레드풀 한계) | ~1,000+ (async 이벤트루프) |
| **DB 쿼리 동시성** | 1 (SQLite RLock) | ~100 (asyncpg 커넥션풀) |
| **이미지 업로드 처리** | 직렬 (디스크 I/O 블로킹) | 병렬 (aioboto3 비동기 S3) |
| **GPU 작업 처리** | 인스턴스당 1개 | 워커당 1개 × N 워커 |
| **모델 로딩 대기** | 전체 시스템 블로킹 | 해당 워커만 블로킹 |
| **이벤트 브로드캐스트** | 단일 프로세스 | Redis Pub/Sub 멀티 인스턴스 |

---

## 10. 커스터마이징 핵심 원칙

### 10.1 서비스 인터페이스 보존

InvokeAI의 서비스 아키텍처는 **추상 기반 클래스** 패턴을 일관되게 사용합니다:

```
*_base.py  → 인터페이스 (변경하지 않음)
*_sqlite.py → SQLite 구현 (PostgreSQL 구현으로 대체)
*_disk.py   → 디스크 구현 (S3 구현으로 대체)
*_default.py → 비즈니스 로직 (user_id 파라미터 추가)
```

이 패턴을 활용하면, **기존 코드를 건드리지 않고** 새로운 구현을 추가할 수 있습니다.

### 10.2 dependencies.py가 핵심 주입 포인트

`ApiDependencies.initialize()` 메서드가 모든 서비스 인스턴스를 생성합니다. 여기에서 환경 설정에 따라 로컬 구현과 SaaS 구현을 **스위칭**할 수 있습니다:

```python
# 환경에 따른 서비스 구현 선택
if config.deployment_mode == "saas":
    image_files = S3ImageFileStorage(...)
    image_records = PostgresImageRecordStorage(...)
    session_queue = SQSSessionQueue(...)
else:
    image_files = DiskImageFileStorage(...)
    image_records = SqliteImageRecordStorage(...)
    session_queue = SqliteSessionQueue(...)
```

### 10.3 프론트엔드 RTK Query 확장

프론트엔드 API는 `openapi-typescript`로 OpenAPI 스키마에서 자동 생성됩니다. 새 API를 백엔드에 추가하면:

```bash
# 1. 백엔드에서 OpenAPI 스키마 추출
python -c "from invokeai.app.api_app import app; import json; print(json.dumps(app.openapi()))" > openapi.json

# 2. 프론트엔드 타입 재생성
cd invokeai/frontend/web
pnpm run typegen
```

이 과정으로 프론트엔드 RTK Query 훅이 자동으로 새 API 엔드포인트를 지원합니다.

---

## 11. 개선이 필요한 불안정 요소

### 11.1 현재 시스템의 불안정/미흡 사항

| # | 항목 | 문제점 | 심각도 | SaaS 대응 방안 |
|---|------|--------|--------|---------------|
| 1 | **Generic Exception 캐치** | 라우터에서 `except Exception`으로 모든 에러를 잡아 500 반환 | 중 | 구체적 예외 타입 분리, 에러 로깅 강화 |
| 2 | **CORS 설정** | `allow_methods=["*"]`, `allow_headers=["*"]` | 중 | 운영 환경에서 구체적 도메인/메서드 제한 |
| 3 | **SQLite 동시성** | `threading.RLock()` 기반 잠금 → 단일 쓰기 | 높 | PostgreSQL로 전환 |
| 4 | **모델 캐시 메모리** | 전체 모델을 RAM에 유지 → 메모리 부족 가능 | 중 | K8s 리소스 제한 + 모델 캐시 풀 공유 |
| 5 | **에러 복구** | SessionProcessor 에러 시 재시작 로직 미약 | 중 | 헬스체크 + 자동 재시작 (ECS/K8s) |
| 6 | **로깅 구조** | 로컬 파일/콘솔 로깅만 → 중앙 로깅 미지원 | 중 | CloudWatch Logs + 구조화된 JSON 로깅 |
| 7 | **설정 하드코딩** | 일부 설정이 코드에 하드코딩 (포트 9090 등) | 저 | 환경변수/AWS Secrets Manager 전환 |
| 8 | **이미지 URL 체계** | 로컬 경로 기반 → 외부 접근 불가 | 높 | S3 Pre-signed URL 또는 CloudFront |
| 9 | **WebSocket 확장성** | 단일 프로세스 Socket.IO → 멀티 인스턴스 불가 | 높 | Redis adapter로 Socket.IO 확장 |
| 10 | **테스트 커버리지** | 목표 85%이나 실제 커버리지 미달 가능 | 중 | SaaS 기능 추가 시 테스트 코드 필수 동반 |

### 11.2 보안 강화 필요사항

| # | 항목 | 현재 상태 | 필요 조치 |
|---|------|----------|----------|
| 1 | 인증 | 없음 | JWT + Cognito 필수 |
| 2 | 인가 | 없음 | RBAC (user/admin/super_admin) |
| 3 | Rate Limiting | 없음 | API Gateway 레벨 + 앱 레벨 이중 적용 |
| 4 | 입력 검증 | Pydantic 기본 | 추가 sanitization 필요 |
| 5 | 파일 업로드 | 기본 검증만 | 파일 크기/타입 엄격 제한 |
| 6 | SQL Injection | SQLite 파라미터 바인딩 사용 (안전) | PostgreSQL에서도 ORM/파라미터 바인딩 유지 |
| 7 | XSS | React 기본 방어 | CSP 헤더 추가 |
| 8 | 모델 보안 | picklescan 옵션 | SaaS에서는 사전 검증된 모델만 허용 |
| 9 | 데이터 암호화 | 없음 | RDS 암호화 + S3 SSE-S3/KMS |
| 10 | 감사 로그 | 없음 | 모든 관리 작업 감사 로그 기록 |
