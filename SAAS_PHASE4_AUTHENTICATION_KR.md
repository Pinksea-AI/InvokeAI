# Phase 4: 멀티테넌시 & 인증 시스템 구현

> OAuth 2.0 + JWT 기반 인증 및 사용자별 데이터 격리 완벽 가이드

**소요 시간**: Week 7-8 (2주, 80-100시간)
**난이도**: ⭐⭐⭐⭐ (중상)
**예상 비용**: 추가 비용 없음 (기존 인프라 활용)

---

## 📋 목차

1. [개요](#1-개요)
2. [데이터베이스 스키마 설계](#2-데이터베이스-스키마-설계)
3. [OAuth 2.0 통합](#3-oauth-20-통합)
4. [JWT 토큰 시스템](#4-jwt-토큰-시스템)
5. [멀티테넌시 구현](#5-멀티테넌시-구현)
6. [프론트엔드 인증](#6-프론트엔드-인증)
7. [테스트 및 검증](#7-테스트-및-검증)
8. [보안 강화](#8-보안-강화)

---

## 1. 개요

### 1.1 목표

이 Phase에서 구현할 핵심 기능:

✅ **인증 시스템**
- Google OAuth 2.0 로그인
- Discord OAuth 2.0 로그인
- 이메일/비밀번호 로그인 (자체)
- JWT 액세스 토큰 + 리프레시 토큰

✅ **멀티테넌시**
- 사용자별 데이터 완전 격리
- Aurora PostgreSQL 스키마 분리 (dev/prod)
- Row-Level Security (RLS)

✅ **권한 관리**
- Role-Based Access Control (RBAC)
- 플랜별 권한 (Free, Pro, Studio, Enterprise)

### 1.2 아키텍처 흐름

```
┌─────────────┐
│   Browser   │
│  (React)    │
└──────┬──────┘
       │ 1. Login Request
       ↓
┌─────────────────────────────────┐
│  Google/Discord OAuth 2.0       │
└──────┬──────────────────────────┘
       │ 2. Authorization Code
       ↓
┌─────────────────────────────────┐
│  FastAPI Backend                │
│  ┌──────────────────────────┐   │
│  │ OAuth Token Exchange     │   │
│  │ JWT Token Generation     │   │
│  │ User Creation/Update     │   │
│  └──────────────────────────┘   │
└──────┬──────────────────────────┘
       │ 3. JWT Token
       ↓
┌─────────────────────────────────┐
│  Aurora PostgreSQL              │
│  ┌──────────────────────────┐   │
│  │ users (user_id, email)   │   │
│  │ images (user_id FK)      │   │
│  │ models (user_id FK)      │   │
│  └──────────────────────────┘   │
└─────────────────────────────────┘
```

### 1.3 보안 요구사항

| 항목 | 요구사항 | 구현 방법 |
|-----|---------|----------|
| **비밀번호 저장** | Hashing (bcrypt) | bcrypt.hashpw() |
| **토큰 암호화** | JWT HS256 | python-jose |
| **HTTPS** | TLS 1.2+ | ALB SSL Termination |
| **CORS** | Origin 제한 | FastAPI CORS Middleware |
| **Rate Limiting** | 100 req/min per IP | slowapi |
| **SQL Injection** | Parameterized Query | SQLAlchemy ORM |

---

## 2. 데이터베이스 스키마 설계

### 2.1 스키마 분리 (dev/prod)

Aurora PostgreSQL에서 dev와 prod를 스키마로 분리:

```sql
-- 관리자로 접속
psql -h pingvasai-aurora.cluster-xxxxx.ap-northeast-2.rds.amazonaws.com \
  -U postgres -d pingvasai

-- 스키마 생성
CREATE SCHEMA IF NOT EXISTS dev;
CREATE SCHEMA IF NOT EXISTS prod;

-- 사용자 생성
CREATE USER pingvasai_dev WITH PASSWORD 'DevPassword123!';
CREATE USER pingvasai_prod WITH PASSWORD 'ProdPassword456!';

-- 권한 부여
GRANT ALL PRIVILEGES ON SCHEMA dev TO pingvasai_dev;
GRANT ALL PRIVILEGES ON SCHEMA prod TO pingvasai_prod;

-- 기본 스키마 설정
ALTER USER pingvasai_dev SET search_path TO dev, public;
ALTER USER pingvasai_prod SET search_path TO prod, public;

-- 테이블 소유권 이전
ALTER SCHEMA dev OWNER TO pingvasai_dev;
ALTER SCHEMA prod OWNER TO pingvasai_prod;
```

### 2.2 Users 테이블

```sql
-- prod 스키마에서 실행 (dev도 동일)
SET search_path TO prod, public;

-- Users 테이블
CREATE TABLE users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 기본 정보
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) UNIQUE,
    full_name VARCHAR(255),

    -- 인증 정보
    password_hash VARCHAR(255),  -- 자체 로그인용 (NULL 가능)
    email_verified BOOLEAN DEFAULT FALSE,

    -- OAuth 정보
    oauth_provider VARCHAR(50),  -- 'google', 'discord', 'email'
    oauth_id VARCHAR(255),       -- OAuth Provider User ID
    oauth_access_token TEXT,     -- OAuth Access Token (암호화 저장)
    oauth_refresh_token TEXT,    -- OAuth Refresh Token (암호화 저장)

    -- 프로필 정보
    avatar_url TEXT,
    bio TEXT,
    locale VARCHAR(10) DEFAULT 'en',
    timezone VARCHAR(50) DEFAULT 'UTC',

    -- 구독 정보
    subscription_plan VARCHAR(50) DEFAULT 'free',  -- 'free', 'pro', 'studio', 'enterprise'
    subscription_status VARCHAR(50) DEFAULT 'active',  -- 'active', 'cancelled', 'expired'
    subscription_start_date TIMESTAMP,
    subscription_end_date TIMESTAMP,
    lemon_squeezy_customer_id VARCHAR(255),
    lemon_squeezy_subscription_id VARCHAR(255),

    -- 할당량 정보
    monthly_image_quota INTEGER DEFAULT 100,  -- Free: 100, Pro: 1000, Studio: 5000
    monthly_images_generated INTEGER DEFAULT 0,
    quota_reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- 메타데이터
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    is_staff BOOLEAN DEFAULT FALSE,
    is_superuser BOOLEAN DEFAULT FALSE,

    -- 인덱스
    CONSTRAINT users_email_check CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$')
);

-- 인덱스 생성
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_oauth_provider ON users(oauth_provider);
CREATE INDEX idx_users_oauth_id ON users(oauth_id);
CREATE INDEX idx_users_subscription_plan ON users(subscription_plan);
CREATE INDEX idx_users_created_at ON users(created_at DESC);

-- updated_at 자동 업데이트 트리거
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### 2.3 User Sessions 테이블 (JWT 관리)

```sql
-- 세션 테이블 (리프레시 토큰 관리)
CREATE TABLE user_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- 토큰 정보
    refresh_token TEXT NOT NULL UNIQUE,
    access_token_jti VARCHAR(255),  -- JWT ID (revocation용)

    -- 세션 정보
    device_name VARCHAR(255),
    ip_address INET,
    user_agent TEXT,

    -- 만료 정보
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- 상태
    is_active BOOLEAN DEFAULT TRUE
);

-- 인덱스
CREATE INDEX idx_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_sessions_refresh_token ON user_sessions(refresh_token);
CREATE INDEX idx_sessions_expires_at ON user_sessions(expires_at);

-- 만료된 세션 자동 삭제 (Cron Job)
CREATE INDEX idx_sessions_active_expired ON user_sessions(is_active, expires_at)
    WHERE is_active = TRUE;
```

### 2.4 기존 테이블에 user_id 추가

```sql
-- Images 테이블 수정
ALTER TABLE images ADD COLUMN user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;
CREATE INDEX idx_images_user_id ON images(user_id);

-- Boards 테이블 수정
ALTER TABLE boards ADD COLUMN user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;
CREATE INDEX idx_boards_user_id ON boards(user_id);

-- Models 테이블 수정 (커스텀 모델)
ALTER TABLE models ADD COLUMN user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;
CREATE INDEX idx_models_user_id ON models(user_id);

-- Workflows 테이블 수정
ALTER TABLE workflows ADD COLUMN user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;
CREATE INDEX idx_workflows_user_id ON workflows(user_id);
```

### 2.5 Row-Level Security (RLS)

```sql
-- RLS 활성화
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE models ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;

-- 정책 생성: 사용자는 자신의 데이터만 조회/수정/삭제
CREATE POLICY images_isolation_policy ON images
    USING (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY boards_isolation_policy ON boards
    USING (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY models_isolation_policy ON models
    USING (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY workflows_isolation_policy ON workflows
    USING (user_id = current_setting('app.current_user_id')::UUID);

-- Superuser는 모든 데이터 접근 가능
CREATE POLICY images_superuser_policy ON images
    USING (current_setting('app.is_superuser')::BOOLEAN = TRUE);

CREATE POLICY boards_superuser_policy ON boards
    USING (current_setting('app.is_superuser')::BOOLEAN = TRUE);
```

### 2.6 Alembic 마이그레이션

```bash
# Alembic 마이그레이션 생성
cd ~/pingvasai-saas/backend
alembic revision -m "add_authentication_and_multitenancy"
```

```python
# migrations/versions/xxxx_add_authentication_and_multitenancy.py

"""Add authentication and multitenancy

Revision ID: xxxx
Revises: yyyy
Create Date: 2025-11-18

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

def upgrade() -> None:
    # Users 테이블 생성
    op.create_table(
        'users',
        sa.Column('user_id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('email', sa.String(255), nullable=False, unique=True),
        sa.Column('username', sa.String(100), unique=True),
        sa.Column('full_name', sa.String(255)),
        sa.Column('password_hash', sa.String(255)),
        sa.Column('email_verified', sa.Boolean(), default=False),
        sa.Column('oauth_provider', sa.String(50)),
        sa.Column('oauth_id', sa.String(255)),
        sa.Column('oauth_access_token', sa.Text()),
        sa.Column('oauth_refresh_token', sa.Text()),
        sa.Column('avatar_url', sa.Text()),
        sa.Column('bio', sa.Text()),
        sa.Column('locale', sa.String(10), default='en'),
        sa.Column('timezone', sa.String(50), default='UTC'),
        sa.Column('subscription_plan', sa.String(50), default='free'),
        sa.Column('subscription_status', sa.String(50), default='active'),
        sa.Column('subscription_start_date', sa.TIMESTAMP()),
        sa.Column('subscription_end_date', sa.TIMESTAMP()),
        sa.Column('lemon_squeezy_customer_id', sa.String(255)),
        sa.Column('lemon_squeezy_subscription_id', sa.String(255)),
        sa.Column('monthly_image_quota', sa.Integer(), default=100),
        sa.Column('monthly_images_generated', sa.Integer(), default=0),
        sa.Column('quota_reset_date', sa.TIMESTAMP(), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('created_at', sa.TIMESTAMP(), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('updated_at', sa.TIMESTAMP(), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('last_login_at', sa.TIMESTAMP()),
        sa.Column('is_active', sa.Boolean(), default=True),
        sa.Column('is_staff', sa.Boolean(), default=False),
        sa.Column('is_superuser', sa.Boolean(), default=False),
    )

    # 인덱스 생성
    op.create_index('idx_users_email', 'users', ['email'])
    op.create_index('idx_users_oauth_provider', 'users', ['oauth_provider'])
    op.create_index('idx_users_oauth_id', 'users', ['oauth_id'])
    op.create_index('idx_users_subscription_plan', 'users', ['subscription_plan'])

    # User Sessions 테이블
    op.create_table(
        'user_sessions',
        sa.Column('session_id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.user_id', ondelete='CASCADE'), nullable=False),
        sa.Column('refresh_token', sa.Text(), nullable=False, unique=True),
        sa.Column('access_token_jti', sa.String(255)),
        sa.Column('device_name', sa.String(255)),
        sa.Column('ip_address', postgresql.INET()),
        sa.Column('user_agent', sa.Text()),
        sa.Column('expires_at', sa.TIMESTAMP(), nullable=False),
        sa.Column('created_at', sa.TIMESTAMP(), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('last_used_at', sa.TIMESTAMP(), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('is_active', sa.Boolean(), default=True),
    )

    op.create_index('idx_sessions_user_id', 'user_sessions', ['user_id'])
    op.create_index('idx_sessions_refresh_token', 'user_sessions', ['refresh_token'])

    # 기존 테이블에 user_id 추가
    op.add_column('images', sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.user_id', ondelete='CASCADE')))
    op.create_index('idx_images_user_id', 'images', ['user_id'])

    op.add_column('boards', sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.user_id', ondelete='CASCADE')))
    op.create_index('idx_boards_user_id', 'boards', ['user_id'])


def downgrade() -> None:
    # 롤백
    op.drop_index('idx_images_user_id', 'images')
    op.drop_column('images', 'user_id')

    op.drop_index('idx_boards_user_id', 'boards')
    op.drop_column('boards', 'user_id')

    op.drop_table('user_sessions')
    op.drop_table('users')
```

```bash
# 마이그레이션 적용 (dev)
export DB_USER=pingvasai_dev
export DB_PASSWORD=DevPassword123!
export DB_HOST=pingvasai-aurora.cluster-xxxxx.ap-northeast-2.rds.amazonaws.com
export DB_NAME=pingvasai
export DB_SCHEMA=dev

alembic upgrade head

# 마이그레이션 적용 (prod)
export DB_SCHEMA=prod
export DB_USER=pingvasai_prod
export DB_PASSWORD=ProdPassword456!

alembic upgrade head
```

---

## 3. OAuth 2.0 통합

### 3.1 Google OAuth 설정

**Google Cloud Console 설정:**

1. https://console.cloud.google.com 접속
2. 프로젝트 생성: "PingvasAI"
3. API 및 서비스 → OAuth 동의 화면
   - User Type: External
   - App name: PingvasAI
   - User support email: support@pingvasai.com
   - Authorized domains: pingvasai.com
   - Developer contact: dev@pingvasai.com
4. API 및 서비스 → 사용자 인증 정보 → OAuth 2.0 클라이언트 ID
   - Application type: Web application
   - Name: PingvasAI Web Client
   - Authorized redirect URIs:
     - https://api.pingvasai.com/api/v1/auth/google/callback
     - http://localhost:3000/auth/google/callback (개발용)
5. 클라이언트 ID와 시크릿 저장

**환경 변수 설정:**

```bash
# Kubernetes Secret 생성
kubectl create secret generic oauth-credentials \
  --from-literal=GOOGLE_CLIENT_ID='xxxxx.apps.googleusercontent.com' \
  --from-literal=GOOGLE_CLIENT_SECRET='yyyyy' \
  --from-literal=DISCORD_CLIENT_ID='zzzzz' \
  --from-literal=DISCORD_CLIENT_SECRET='wwwww' \
  -n prod
```

### 3.2 Discord OAuth 설정

**Discord Developer Portal 설정:**

1. https://discord.com/developers/applications 접속
2. New Application: "PingvasAI"
3. OAuth2 → General
   - Redirects:
     - https://api.pingvasai.com/api/v1/auth/discord/callback
     - http://localhost:3000/auth/discord/callback
4. Client ID와 Secret 저장

### 3.3 FastAPI OAuth 구현

```python
# backend/invokeai/app/services/auth/oauth.py

"""
OAuth 2.0 통합 서비스
- Google OAuth
- Discord OAuth
"""

from typing import Optional, Dict
import httpx
from fastapi import HTTPException, status
from pydantic import BaseModel, EmailStr


class OAuthUserInfo(BaseModel):
    """OAuth 사용자 정보"""
    email: EmailStr
    full_name: Optional[str] = None
    avatar_url: Optional[str] = None
    oauth_provider: str
    oauth_id: str
    locale: Optional[str] = "en"


class GoogleOAuthService:
    """Google OAuth 2.0 서비스"""

    AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
    TOKEN_URL = "https://oauth2.googleapis.com/token"
    USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri

    def get_authorization_url(self, state: str) -> str:
        """
        Google 로그인 URL 생성

        Args:
            state: CSRF 방지용 랜덤 문자열

        Returns:
            str: Authorization URL
        """
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "access_type": "offline",  # Refresh Token 받기
            "prompt": "consent",
        }

        from urllib.parse import urlencode
        return f"{self.AUTHORIZATION_URL}?{urlencode(params)}"

    async def exchange_code_for_token(self, code: str) -> Dict[str, str]:
        """
        Authorization Code를 Access Token으로 교환

        Args:
            code: Authorization Code

        Returns:
            Dict: Access Token, Refresh Token 등
        """
        async with httpx.AsyncClient() as client:
            response = await client.post(
                self.TOKEN_URL,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "code": code,
                    "redirect_uri": self.redirect_uri,
                    "grant_type": "authorization_code",
                },
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Failed to exchange authorization code",
                )

            return response.json()

    async def get_user_info(self, access_token: str) -> OAuthUserInfo:
        """
        Access Token으로 사용자 정보 조회

        Args:
            access_token: Access Token

        Returns:
            OAuthUserInfo: 사용자 정보
        """
        async with httpx.AsyncClient() as client:
            response = await client.get(
                self.USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Failed to get user info from Google",
                )

            data = response.json()

            return OAuthUserInfo(
                email=data["email"],
                full_name=data.get("name"),
                avatar_url=data.get("picture"),
                oauth_provider="google",
                oauth_id=data["id"],
                locale=data.get("locale", "en"),
            )


class DiscordOAuthService:
    """Discord OAuth 2.0 서비스"""

    AUTHORIZATION_URL = "https://discord.com/api/oauth2/authorize"
    TOKEN_URL = "https://discord.com/api/oauth2/token"
    USERINFO_URL = "https://discord.com/api/users/@me"

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri

    def get_authorization_url(self, state: str) -> str:
        """Discord 로그인 URL 생성"""
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": "identify email",
            "state": state,
        }

        from urllib.parse import urlencode
        return f"{self.AUTHORIZATION_URL}?{urlencode(params)}"

    async def exchange_code_for_token(self, code: str) -> Dict[str, str]:
        """Authorization Code를 Access Token으로 교환"""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                self.TOKEN_URL,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "code": code,
                    "redirect_uri": self.redirect_uri,
                    "grant_type": "authorization_code",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Failed to exchange authorization code",
                )

            return response.json()

    async def get_user_info(self, access_token: str) -> OAuthUserInfo:
        """Access Token으로 사용자 정보 조회"""
        async with httpx.AsyncClient() as client:
            response = await client.get(
                self.USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Failed to get user info from Discord",
                )

            data = response.json()

            # Discord 아바타 URL 생성
            avatar_url = None
            if data.get("avatar"):
                avatar_url = f"https://cdn.discordapp.com/avatars/{data['id']}/{data['avatar']}.png"

            return OAuthUserInfo(
                email=data["email"],
                full_name=data.get("username"),
                avatar_url=avatar_url,
                oauth_provider="discord",
                oauth_id=data["id"],
                locale=data.get("locale", "en"),
            )
```

### 3.4 OAuth 라우터

```python
# backend/invokeai/app/api/routers/auth.py

"""
인증 관련 API 라우터
- OAuth 로그인
- 이메일/비밀번호 로그인
- 토큰 갱신
"""

from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
import secrets

from invokeai.app.services.auth.oauth import GoogleOAuthService, DiscordOAuthService, OAuthUserInfo
from invokeai.app.services.auth.jwt import create_access_token, create_refresh_token
from invokeai.app.services.database import get_db
from invokeai.app.models.user import User, UserSession
from invokeai.app.core.config import settings


router = APIRouter(prefix="/auth", tags=["Authentication"])


# OAuth 서비스 인스턴스
google_oauth = GoogleOAuthService(
    client_id=settings.GOOGLE_CLIENT_ID,
    client_secret=settings.GOOGLE_CLIENT_SECRET,
    redirect_uri=f"{settings.API_BASE_URL}/api/v1/auth/google/callback",
)

discord_oauth = DiscordOAuthService(
    client_id=settings.DISCORD_CLIENT_ID,
    client_secret=settings.DISCORD_CLIENT_SECRET,
    redirect_uri=f"{settings.API_BASE_URL}/api/v1/auth/discord/callback",
)


@router.get("/google")
async def google_login(request: Request):
    """
    Google OAuth 로그인 시작

    Returns:
        RedirectResponse: Google 로그인 페이지로 리다이렉트
    """
    # CSRF 방지용 state 생성
    state = secrets.token_urlsafe(32)

    # 세션에 state 저장 (검증용)
    request.session["oauth_state"] = state

    # Google 로그인 URL로 리다이렉트
    auth_url = google_oauth.get_authorization_url(state)
    return RedirectResponse(auth_url)


@router.get("/google/callback")
async def google_callback(
    request: Request,
    code: str,
    state: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Google OAuth 콜백 처리

    Args:
        code: Authorization Code
        state: CSRF 방지용 state

    Returns:
        Dict: Access Token, Refresh Token
    """
    # State 검증 (CSRF 방지)
    stored_state = request.session.get("oauth_state")
    if not stored_state or stored_state != state:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid state parameter",
        )

    # Authorization Code를 Access Token으로 교환
    token_data = await google_oauth.exchange_code_for_token(code)

    # 사용자 정보 조회
    user_info = await google_oauth.get_user_info(token_data["access_token"])

    # 사용자 생성 또는 업데이트
    user = await get_or_create_user(db, user_info, token_data)

    # JWT 토큰 생성
    access_token = create_access_token(user.user_id, user.email)
    refresh_token = create_refresh_token(user.user_id)

    # 세션 저장
    await create_user_session(
        db,
        user.user_id,
        refresh_token,
        request.client.host,
        request.headers.get("User-Agent"),
    )

    # 프론트엔드로 리다이렉트 (토큰 포함)
    frontend_url = f"{settings.FRONTEND_URL}/auth/callback?access_token={access_token}&refresh_token={refresh_token}"
    return RedirectResponse(frontend_url)


@router.get("/discord")
async def discord_login(request: Request):
    """Discord OAuth 로그인 시작"""
    state = secrets.token_urlsafe(32)
    request.session["oauth_state"] = state
    auth_url = discord_oauth.get_authorization_url(state)
    return RedirectResponse(auth_url)


@router.get("/discord/callback")
async def discord_callback(
    request: Request,
    code: str,
    state: str,
    db: AsyncSession = Depends(get_db),
):
    """Discord OAuth 콜백 처리"""
    # State 검증
    stored_state = request.session.get("oauth_state")
    if not stored_state or stored_state != state:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid state parameter",
        )

    # Token 교환
    token_data = await discord_oauth.exchange_code_for_token(code)

    # 사용자 정보 조회
    user_info = await discord_oauth.get_user_info(token_data["access_token"])

    # 사용자 생성/업데이트
    user = await get_or_create_user(db, user_info, token_data)

    # JWT 토큰 생성
    access_token = create_access_token(user.user_id, user.email)
    refresh_token = create_refresh_token(user.user_id)

    # 세션 저장
    await create_user_session(
        db,
        user.user_id,
        refresh_token,
        request.client.host,
        request.headers.get("User-Agent"),
    )

    # 리다이렉트
    frontend_url = f"{settings.FRONTEND_URL}/auth/callback?access_token={access_token}&refresh_token={refresh_token}"
    return RedirectResponse(frontend_url)


async def get_or_create_user(
    db: AsyncSession,
    user_info: OAuthUserInfo,
    token_data: dict,
) -> User:
    """
    OAuth 사용자 정보로 User 생성 또는 업데이트

    Args:
        db: Database session
        user_info: OAuth 사용자 정보
        token_data: OAuth 토큰 데이터

    Returns:
        User: 사용자 객체
    """
    from sqlalchemy import select
    from datetime import datetime

    # 기존 사용자 조회 (이메일 or OAuth ID)
    stmt = select(User).where(
        (User.email == user_info.email) |
        ((User.oauth_provider == user_info.oauth_provider) & (User.oauth_id == user_info.oauth_id))
    )
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if user:
        # 기존 사용자 업데이트
        user.oauth_access_token = token_data.get("access_token")
        user.oauth_refresh_token = token_data.get("refresh_token")
        user.avatar_url = user_info.avatar_url
        user.last_login_at = datetime.utcnow()
    else:
        # 새 사용자 생성
        user = User(
            email=user_info.email,
            full_name=user_info.full_name,
            avatar_url=user_info.avatar_url,
            oauth_provider=user_info.oauth_provider,
            oauth_id=user_info.oauth_id,
            oauth_access_token=token_data.get("access_token"),
            oauth_refresh_token=token_data.get("refresh_token"),
            email_verified=True,  # OAuth는 이미 검증됨
            locale=user_info.locale,
            last_login_at=datetime.utcnow(),
        )
        db.add(user)

    await db.commit()
    await db.refresh(user)

    return user


async def create_user_session(
    db: AsyncSession,
    user_id: str,
    refresh_token: str,
    ip_address: str,
    user_agent: str,
) -> UserSession:
    """
    사용자 세션 생성

    Args:
        db: Database session
        user_id: 사용자 ID
        refresh_token: Refresh Token
        ip_address: IP 주소
        user_agent: User Agent

    Returns:
        UserSession: 세션 객체
    """
    from datetime import datetime, timedelta

    session = UserSession(
        user_id=user_id,
        refresh_token=refresh_token,
        ip_address=ip_address,
        user_agent=user_agent,
        expires_at=datetime.utcnow() + timedelta(days=30),  # 30일
    )

    db.add(session)
    await db.commit()
    await db.refresh(session)

    return session
```

---

## 4. JWT 토큰 시스템

### 4.1 JWT 토큰 구조

PingvasAI는 **Access Token + Refresh Token** 이중 토큰 시스템을 사용합니다:

| 토큰 종류 | 만료 시간 | 저장 위치 | 용도 |
|----------|---------|---------|-----|
| **Access Token** | 15분 | LocalStorage | API 인증 |
| **Refresh Token** | 30일 | HttpOnly Cookie | Access Token 갱신 |

**JWT Payload 구조:**

```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",  // user_id
  "email": "user@example.com",
  "type": "access",  // "access" or "refresh"
  "exp": 1700000000,  // 만료 시간
  "iat": 1699999000,  // 발행 시간
  "jti": "unique-token-id"  // JWT ID (revocation용)
}
```

### 4.2 JWT 서비스 구현

```python
# backend/invokeai/app/services/auth/jwt.py

"""
JWT 토큰 생성 및 검증
- Access Token: 15분
- Refresh Token: 30일
"""

from datetime import datetime, timedelta
from typing import Optional, Dict
from jose import JWTError, jwt
from fastapi import HTTPException, status
import uuid

from invokeai.app.core.config import settings


# JWT 설정
SECRET_KEY = settings.JWT_SECRET_KEY
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 30


def create_access_token(user_id: str, email: str, additional_claims: Optional[Dict] = None) -> str:
    """
    Access Token 생성

    Args:
        user_id: 사용자 UUID
        email: 사용자 이메일
        additional_claims: 추가 클레임 (옵션)

    Returns:
        str: JWT Access Token
    """
    now = datetime.utcnow()
    expire = now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)

    payload = {
        "sub": str(user_id),
        "email": email,
        "type": "access",
        "exp": expire,
        "iat": now,
        "jti": str(uuid.uuid4()),  # JWT ID
    }

    if additional_claims:
        payload.update(additional_claims)

    token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
    return token


def create_refresh_token(user_id: str) -> str:
    """
    Refresh Token 생성

    Args:
        user_id: 사용자 UUID

    Returns:
        str: JWT Refresh Token
    """
    now = datetime.utcnow()
    expire = now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)

    payload = {
        "sub": str(user_id),
        "type": "refresh",
        "exp": expire,
        "iat": now,
        "jti": str(uuid.uuid4()),
    }

    token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
    return token


def verify_token(token: str, token_type: str = "access") -> Dict:
    """
    JWT 토큰 검증

    Args:
        token: JWT 토큰
        token_type: "access" or "refresh"

    Returns:
        Dict: Decoded payload

    Raises:
        HTTPException: 토큰이 유효하지 않을 때
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

        # 토큰 타입 확인
        if payload.get("type") != token_type:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid token type. Expected {token_type}",
            )

        return payload

    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Could not validate credentials: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )


def decode_token_without_verification(token: str) -> Optional[Dict]:
    """
    토큰 검증 없이 디코드 (만료된 토큰도 읽기 가능)

    Args:
        token: JWT 토큰

    Returns:
        Dict or None: Decoded payload
    """
    try:
        payload = jwt.decode(
            token,
            SECRET_KEY,
            algorithms=[ALGORITHM],
            options={"verify_exp": False}  # 만료 검증 비활성화
        )
        return payload
    except JWTError:
        return None
```

### 4.3 토큰 갱신 API

```python
# backend/invokeai/app/api/routers/auth.py (추가)

from fastapi import Cookie

@router.post("/refresh")
async def refresh_access_token(
    refresh_token: str = Cookie(None),
    db: AsyncSession = Depends(get_db),
):
    """
    Refresh Token으로 새 Access Token 발급

    Args:
        refresh_token: Refresh Token (Cookie)

    Returns:
        Dict: 새로운 Access Token
    """
    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token is missing",
        )

    # Refresh Token 검증
    payload = verify_token(refresh_token, token_type="refresh")
    user_id = payload.get("sub")

    # 세션 확인 (Refresh Token이 DB에 존재하는지)
    from sqlalchemy import select
    stmt = select(UserSession).where(
        UserSession.refresh_token == refresh_token,
        UserSession.is_active == True,
        UserSession.expires_at > datetime.utcnow(),
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    # 사용자 조회
    stmt = select(User).where(User.user_id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )

    # 새 Access Token 생성
    new_access_token = create_access_token(user.user_id, user.email)

    # 세션 last_used_at 업데이트
    session.last_used_at = datetime.utcnow()
    await db.commit()

    return {
        "access_token": new_access_token,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }


@router.post("/logout")
async def logout(
    refresh_token: str = Cookie(None),
    db: AsyncSession = Depends(get_db),
):
    """
    로그아웃 (세션 무효화)

    Args:
        refresh_token: Refresh Token (Cookie)

    Returns:
        Dict: 성공 메시지
    """
    if refresh_token:
        # 세션 비활성화
        from sqlalchemy import update
        stmt = update(UserSession).where(
            UserSession.refresh_token == refresh_token
        ).values(is_active=False)

        await db.execute(stmt)
        await db.commit()

    return {"message": "Logged out successfully"}
```

### 4.4 인증 미들웨어

```python
# backend/invokeai/app/api/dependencies/auth.py

"""
인증 Dependency
- get_current_user: 현재 로그인한 사용자 조회
- get_current_active_user: 활성 사용자만 허용
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from invokeai.app.services.auth.jwt import verify_token
from invokeai.app.services.database import get_db
from invokeai.app.models.user import User


security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Access Token으로 현재 사용자 조회

    Args:
        credentials: Bearer Token
        db: Database session

    Returns:
        User: 현재 사용자

    Raises:
        HTTPException: 인증 실패 시
    """
    token = credentials.credentials

    # JWT 검증
    payload = verify_token(token, token_type="access")
    user_id = payload.get("sub")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )

    # 사용자 조회
    from sqlalchemy import select
    stmt = select(User).where(User.user_id == user_id)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    return user


async def get_current_active_user(
    current_user: User = Depends(get_current_user),
) -> User:
    """
    활성 사용자만 허용

    Args:
        current_user: 현재 사용자

    Returns:
        User: 활성 사용자

    Raises:
        HTTPException: 비활성 사용자일 때
    """
    if not current_user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Inactive user",
        )

    return current_user


async def get_current_superuser(
    current_user: User = Depends(get_current_active_user),
) -> User:
    """
    Superuser만 허용

    Args:
        current_user: 현재 사용자

    Returns:
        User: Superuser

    Raises:
        HTTPException: Superuser가 아닐 때
    """
    if not current_user.is_superuser:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not enough permissions",
        )

    return current_user
```

### 4.5 API 엔드포인트 보호

```python
# backend/invokeai/app/api/routers/images.py

"""
이미지 생성 API (인증 필요)
"""

from fastapi import APIRouter, Depends
from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.models.user import User


router = APIRouter(prefix="/images", tags=["Images"])


@router.post("/generate")
async def generate_image(
    prompt: str,
    current_user: User = Depends(get_current_active_user),  # 인증 필요
    db: AsyncSession = Depends(get_db),
):
    """
    이미지 생성 (인증된 사용자만)

    Args:
        prompt: 생성 프롬프트
        current_user: 현재 로그인한 사용자

    Returns:
        Dict: 생성된 이미지 정보
    """
    # 할당량 확인
    if current_user.monthly_images_generated >= current_user.monthly_image_quota:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Monthly quota exceeded. Upgrade to Pro plan for more generations.",
        )

    # 이미지 생성 로직...
    # (생략)

    # 할당량 증가
    current_user.monthly_images_generated += 1
    await db.commit()

    return {"message": "Image generated", "user_id": current_user.user_id}
```

---

## 5. 멀티테넌시 구현

### 5.1 Row-Level Security (RLS) 활성화

PostgreSQL의 RLS를 사용하여 사용자별 데이터 격리를 보장합니다.

```python
# backend/invokeai/app/services/database.py

"""
Database 연결 및 RLS 설정
"""

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from invokeai.app.core.config import settings


# SQLAlchemy 엔진
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

Base = declarative_base()


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Database session dependency

    Yields:
        AsyncSession: Database session
    """
    async with AsyncSessionLocal() as session:
        yield session


@asynccontextmanager
async def get_db_with_user_context(user_id: str, is_superuser: bool = False):
    """
    RLS 설정과 함께 Database session 생성

    Args:
        user_id: 사용자 UUID
        is_superuser: Superuser 여부

    Yields:
        AsyncSession: RLS가 설정된 Database session
    """
    async with AsyncSessionLocal() as session:
        # PostgreSQL RLS 설정
        await session.execute(
            f"SET LOCAL app.current_user_id = '{user_id}'"
        )
        await session.execute(
            f"SET LOCAL app.is_superuser = {is_superuser}"
        )

        try:
            yield session
        finally:
            # RLS 설정 해제
            await session.execute("RESET app.current_user_id")
            await session.execute("RESET app.is_superuser")
```

### 5.2 사용자 컨텍스트 Dependency

```python
# backend/invokeai/app/api/dependencies/auth.py (추가)

from invokeai.app.services.database import get_db_with_user_context


async def get_db_for_current_user(
    current_user: User = Depends(get_current_active_user),
) -> AsyncGenerator[AsyncSession, None]:
    """
    현재 사용자의 RLS가 설정된 Database session

    Args:
        current_user: 현재 사용자

    Yields:
        AsyncSession: RLS가 설정된 Database session
    """
    async with get_db_with_user_context(
        user_id=current_user.user_id,
        is_superuser=current_user.is_superuser,
    ) as session:
        yield session
```

### 5.3 멀티테넌트 쿼리 예제

```python
# backend/invokeai/app/api/routers/images.py (수정)

@router.get("/my-images")
async def get_my_images(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_for_current_user),  # RLS 적용
):
    """
    내 이미지 목록 조회

    Args:
        current_user: 현재 사용자
        db: RLS가 설정된 Database session

    Returns:
        List[Image]: 사용자의 이미지 목록
    """
    from sqlalchemy import select
    from invokeai.app.models.image import Image

    # RLS 덕분에 자동으로 user_id 필터링됨
    stmt = select(Image).order_by(Image.created_at.desc()).limit(100)
    result = await db.execute(stmt)
    images = result.scalars().all()

    return images


@router.delete("/images/{image_id}")
async def delete_image(
    image_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db_for_current_user),  # RLS 적용
):
    """
    이미지 삭제 (본인 이미지만 가능)

    Args:
        image_id: 이미지 UUID
        current_user: 현재 사용자
        db: RLS가 설정된 Database session

    Returns:
        Dict: 성공 메시지
    """
    from sqlalchemy import select, delete
    from invokeai.app.models.image import Image

    # RLS 덕분에 다른 사용자의 이미지는 조회되지 않음
    stmt = select(Image).where(Image.image_id == image_id)
    result = await db.execute(stmt)
    image = result.scalar_one_or_none()

    if not image:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found or you don't have permission",
        )

    # 삭제
    await db.delete(image)
    await db.commit()

    return {"message": "Image deleted successfully"}
```

### 5.4 스키마 분리 테스트

```bash
# dev 스키마 접속
export DB_USER=pingvasai_dev
export DB_PASSWORD=DevPassword123!
export DB_SCHEMA=dev

psql -h pingvasai-aurora.cluster-xxxxx.ap-northeast-2.rds.amazonaws.com \
  -U pingvasai_dev -d pingvasai

# 현재 스키마 확인
SHOW search_path;
-- 출력: dev, public

# 테이블 조회
\dt
-- dev 스키마의 테이블만 표시됨

# prod 스키마는 접근 불가
SELECT * FROM prod.users;
-- ERROR: permission denied for schema prod
```

---

## 6. 프론트엔드 인증

### 6.1 React 인증 Context

```typescript
// frontend/src/contexts/AuthContext.tsx

import React, { createContext, useState, useContext, useEffect } from 'react';
import axios from 'axios';

interface User {
  user_id: string;
  email: string;
  full_name?: string;
  avatar_url?: string;
  subscription_plan: 'free' | 'pro' | 'studio' | 'enterprise';
  monthly_image_quota: number;
  monthly_images_generated: number;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (provider: 'google' | 'discord') => void;
  logout: () => Promise<void>;
  refreshToken: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Access Token을 LocalStorage에서 가져오기
  const getAccessToken = () => localStorage.getItem('access_token');
  const setAccessToken = (token: string) => localStorage.setItem('access_token', token);
  const removeAccessToken = () => localStorage.removeItem('access_token');

  // 사용자 정보 로드
  const loadUser = async () => {
    const token = getAccessToken();
    if (!token) {
      setIsLoading(false);
      return;
    }

    try {
      const response = await axios.get('/api/v1/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUser(response.data);
    } catch (error) {
      console.error('Failed to load user:', error);
      removeAccessToken();
    } finally {
      setIsLoading(false);
    }
  };

  // OAuth 로그인
  const login = (provider: 'google' | 'discord') => {
    window.location.href = `/api/v1/auth/${provider}`;
  };

  // 로그아웃
  const logout = async () => {
    try {
      await axios.post('/api/v1/auth/logout', {}, { withCredentials: true });
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      removeAccessToken();
      setUser(null);
    }
  };

  // Refresh Token으로 Access Token 갱신
  const refreshToken = async () => {
    try {
      const response = await axios.post(
        '/api/v1/auth/refresh',
        {},
        { withCredentials: true }  // Refresh Token은 Cookie
      );
      setAccessToken(response.data.access_token);
    } catch (error) {
      console.error('Token refresh failed:', error);
      removeAccessToken();
      setUser(null);
    }
  };

  // 초기 로드
  useEffect(() => {
    loadUser();
  }, []);

  // Access Token 자동 갱신 (14분마다)
  useEffect(() => {
    if (!user) return;

    const interval = setInterval(() => {
      refreshToken();
    }, 14 * 60 * 1000);  // 14분 (15분 만료 전에 갱신)

    return () => clearInterval(interval);
  }, [user]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        logout,
        refreshToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
```

### 6.2 Axios Interceptor (자동 토큰 갱신)

```typescript
// frontend/src/services/api.ts

import axios from 'axios';

const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,  // Refresh Token Cookie 전송
});

// Request Interceptor: Access Token 자동 추가
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('access_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response Interceptor: 401 시 자동 토큰 갱신
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // 401 Unauthorized && 아직 재시도 안 함
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        // Refresh Token으로 새 Access Token 받기
        const response = await axios.post('/api/v1/auth/refresh', {}, { withCredentials: true });
        const newAccessToken = response.data.access_token;

        // LocalStorage 업데이트
        localStorage.setItem('access_token', newAccessToken);

        // 원래 요청 재시도
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh Token도 만료됨 → 로그아웃
        localStorage.removeItem('access_token');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
```

### 6.3 OAuth Callback 페이지

```typescript
// frontend/src/pages/AuthCallback.tsx

import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const AuthCallback: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refreshToken } = useAuth();

  useEffect(() => {
    const accessToken = searchParams.get('access_token');
    const refreshTokenParam = searchParams.get('refresh_token');

    if (accessToken && refreshTokenParam) {
      // Access Token 저장
      localStorage.setItem('access_token', accessToken);

      // Refresh Token은 Cookie로 이미 설정됨 (백엔드에서)

      // 사용자 정보 로드 후 리다이렉트
      refreshToken().then(() => {
        navigate('/dashboard');
      });
    } else {
      // 실패
      navigate('/login?error=auth_failed');
    }
  }, [searchParams, navigate, refreshToken]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <div className="spinner mb-4"></div>
        <p className="text-gray-600">로그인 처리 중...</p>
      </div>
    </div>
  );
};

export default AuthCallback;
```

### 6.4 로그인 페이지

```typescript
// frontend/src/pages/Login.tsx

import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { FaGoogle, FaDiscord } from 'react-icons/fa';

const Login: React.FC = () => {
  const { login } = useAuth();

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full">
        <h1 className="text-3xl font-bold text-center mb-8">
          PingvasAI에 로그인
        </h1>

        <div className="space-y-4">
          {/* Google 로그인 */}
          <button
            onClick={() => login('google')}
            className="w-full flex items-center justify-center gap-3 bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-700 font-semibold py-3 px-4 rounded-lg transition"
          >
            <FaGoogle className="text-xl text-red-500" />
            Google로 로그인
          </button>

          {/* Discord 로그인 */}
          <button
            onClick={() => login('discord')}
            className="w-full flex items-center justify-center gap-3 bg-[#5865F2] hover:bg-[#4752C4] text-white font-semibold py-3 px-4 rounded-lg transition"
          >
            <FaDiscord className="text-xl" />
            Discord로 로그인
          </button>
        </div>

        <p className="text-center text-gray-500 text-sm mt-6">
          로그인하면 <a href="/terms" className="text-blue-600 hover:underline">이용약관</a> 및{' '}
          <a href="/privacy" className="text-blue-600 hover:underline">개인정보 처리방침</a>에 동의하는 것으로 간주됩니다.
        </p>
      </div>
    </div>
  );
};

export default Login;
```

### 6.5 Protected Route

```typescript
// frontend/src/components/ProtectedRoute.tsx

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredPlan?: 'free' | 'pro' | 'studio' | 'enterprise';
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, requiredPlan }) => {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // 플랜 확인 (옵션)
  if (requiredPlan && user) {
    const planHierarchy = { free: 0, pro: 1, studio: 2, enterprise: 3 };
    if (planHierarchy[user.subscription_plan] < planHierarchy[requiredPlan]) {
      return <Navigate to="/upgrade" replace />;
    }
  }

  return <>{children}</>;
};

export default ProtectedRoute;
```

### 6.6 라우터 설정

```typescript
// frontend/src/App.tsx

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import Dashboard from './pages/Dashboard';
import ImageGeneration from './pages/ImageGeneration';

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />

          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />

          <Route
            path="/generate"
            element={
              <ProtectedRoute requiredPlan="pro">
                <ImageGeneration />
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
```

---

## 7. 테스트 및 검증

### 7.1 단위 테스트 (Backend)

```python
# backend/tests/test_auth.py

"""
인증 시스템 테스트
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from invokeai.app.run_app import app
from invokeai.app.services.auth.jwt import create_access_token, verify_token
from invokeai.app.models.user import User


# 테스트용 Database
TEST_DATABASE_URL = "postgresql+asyncpg://test:test@localhost/pingvasai_test"

engine = create_async_engine(TEST_DATABASE_URL, echo=True)
TestingSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture
async def db_session():
    """테스트용 Database session"""
    async with TestingSessionLocal() as session:
        yield session
        await session.rollback()


@pytest.fixture
def client():
    """테스트용 FastAPI client"""
    return TestClient(app)


def test_create_access_token():
    """Access Token 생성 테스트"""
    user_id = "550e8400-e29b-41d4-a716-446655440000"
    email = "test@example.com"

    token = create_access_token(user_id, email)

    # 검증
    payload = verify_token(token, token_type="access")
    assert payload["sub"] == user_id
    assert payload["email"] == email
    assert payload["type"] == "access"


def test_verify_invalid_token():
    """잘못된 토큰 검증 테스트"""
    invalid_token = "invalid.jwt.token"

    with pytest.raises(HTTPException) as exc:
        verify_token(invalid_token)

    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_google_oauth_callback(client, db_session):
    """Google OAuth Callback 테스트"""
    # Mock OAuth code
    code = "mock_authorization_code"
    state = "random_state_string"

    # Callback 요청
    response = client.get(f"/api/v1/auth/google/callback?code={code}&state={state}")

    # 프론트엔드로 리다이렉트 확인
    assert response.status_code == 307  # Redirect
    assert "access_token" in response.headers["location"]


@pytest.mark.asyncio
async def test_protected_endpoint_without_token(client):
    """인증 없이 보호된 엔드포인트 접근 테스트"""
    response = client.get("/api/v1/images/my-images")

    assert response.status_code == 401
    assert "Not authenticated" in response.json()["detail"]


@pytest.mark.asyncio
async def test_protected_endpoint_with_token(client, db_session):
    """인증과 함께 보호된 엔드포인트 접근 테스트"""
    # 테스트 사용자 생성
    user = User(
        email="test@example.com",
        oauth_provider="google",
        oauth_id="12345",
        email_verified=True,
    )
    db_session.add(user)
    await db_session.commit()

    # Access Token 생성
    token = create_access_token(user.user_id, user.email)

    # 보호된 엔드포인트 접근
    response = client.get(
        "/api/v1/images/my-images",
        headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200
```

### 7.2 통합 테스트

```bash
# Pytest 실행
cd ~/pingvasai-saas/backend
pytest tests/ -v

# 커버리지 확인
pytest --cov=invokeai.app.services.auth --cov-report=html
```

### 7.3 수동 테스트 체크리스트

| 테스트 항목 | 테스트 방법 | 예상 결과 |
|-----------|----------|---------|
| **Google 로그인** | 프론트엔드에서 "Google로 로그인" 클릭 | Google 로그인 페이지로 리다이렉트 |
| **OAuth Callback** | Google 로그인 완료 | 대시보드로 리다이렉트 + Access Token 발급 |
| **토큰 갱신** | 14분 대기 | 자동으로 Access Token 갱신 |
| **로그아웃** | "로그아웃" 버튼 클릭 | 로그인 페이지로 리다이렉트 + 토큰 삭제 |
| **보호된 페이지 접근** | 로그아웃 후 `/dashboard` 접근 | `/login`으로 리다이렉트 |
| **할당량 초과** | Free 플랜으로 100장 이상 생성 시도 | 429 에러 + "Quota exceeded" 메시지 |
| **RLS 검증** | 사용자 A로 로그인 → 사용자 B의 이미지 조회 시도 | 404 Not Found |

### 7.4 RLS 검증 테스트

```sql
-- 테스트 사용자 생성
INSERT INTO prod.users (user_id, email, oauth_provider, oauth_id)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'alice@example.com', 'google', '1'),
  ('00000000-0000-0000-0000-000000000002', 'bob@example.com', 'google', '2');

-- 테스트 이미지 생성
INSERT INTO prod.images (image_id, user_id, image_name, image_url)
VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'Alice Image', 's3://...'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000002', 'Bob Image', 's3://...');

-- RLS 설정
SET LOCAL app.current_user_id = '00000000-0000-0000-0000-000000000001';
SET LOCAL app.is_superuser = FALSE;

-- Alice로 조회 (Alice의 이미지만 보여야 함)
SELECT * FROM prod.images;
-- 결과: Alice Image만 표시

-- Bob의 이미지 조회 시도 (실패해야 함)
SELECT * FROM prod.images WHERE user_id = '00000000-0000-0000-0000-000000000002';
-- 결과: 0 rows (RLS에 의해 차단됨)

-- Superuser로 변경
SET LOCAL app.is_superuser = TRUE;

-- 모든 이미지 조회 (성공)
SELECT * FROM prod.images;
-- 결과: Alice Image, Bob Image 모두 표시
```

---

## 8. 보안 강화

### 8.1 환경 변수 보안

```yaml
# kubernetes/prod/secrets.yaml

apiVersion: v1
kind: Secret
metadata:
  name: auth-secrets
  namespace: prod
type: Opaque
stringData:
  JWT_SECRET_KEY: "your-super-secret-jwt-key-min-32-characters"
  GOOGLE_CLIENT_ID: "xxxxx.apps.googleusercontent.com"
  GOOGLE_CLIENT_SECRET: "yyyyy"
  DISCORD_CLIENT_ID: "zzzzz"
  DISCORD_CLIENT_SECRET: "wwwww"
  DATABASE_URL: "postgresql+asyncpg://pingvasai_prod:password@aurora-endpoint:5432/pingvasai"
```

```bash
# Secret 생성
kubectl apply -f kubernetes/prod/secrets.yaml

# Deployment에서 Secret 사용
```

```yaml
# kubernetes/prod/deployment-api.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-deployment
  namespace: prod
spec:
  template:
    spec:
      containers:
      - name: api
        image: <ECR_REPO>/pingvasai-api:latest
        env:
        - name: JWT_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: auth-secrets
              key: JWT_SECRET_KEY
        - name: GOOGLE_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: auth-secrets
              key: GOOGLE_CLIENT_ID
        # ... 나머지 환경 변수
```

### 8.2 Rate Limiting

```python
# backend/invokeai/app/middleware/rate_limit.py

"""
Rate Limiting Middleware
- slowapi를 사용한 속도 제한
"""

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from fastapi import FastAPI, Request


limiter = Limiter(key_func=get_remote_address)


def setup_rate_limiting(app: FastAPI):
    """
    Rate Limiting 설정

    Args:
        app: FastAPI 앱
    """
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# 사용 예시
# backend/invokeai/app/api/routers/auth.py

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)


@router.post("/login")
@limiter.limit("5/minute")  # 1분에 5번까지
async def login(request: Request, email: str, password: str):
    """로그인 (Rate Limited)"""
    # ...
```

### 8.3 CORS 설정

```python
# backend/invokeai/app/run_app.py

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://pingvasai.com",
        "https://www.pingvasai.com",
        "http://localhost:3000",  # 개발용
    ],
    allow_credentials=True,  # Cookie 허용
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
)
```

### 8.4 HTTPS 강제 (ALB)

```hcl
# terraform/modules/alb/main.tf

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # HTTP → HTTPS 리다이렉트
  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = aws_acm_certificate.cert.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
```

### 8.5 비밀번호 해싱 (이메일/비밀번호 로그인용)

```python
# backend/invokeai/app/services/auth/password.py

"""
비밀번호 해싱 (bcrypt)
"""

import bcrypt


def hash_password(password: str) -> str:
    """
    비밀번호 해싱

    Args:
        password: 평문 비밀번호

    Returns:
        str: 해싱된 비밀번호
    """
    salt = bcrypt.gensalt(rounds=12)
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')


def verify_password(password: str, hashed_password: str) -> bool:
    """
    비밀번호 검증

    Args:
        password: 평문 비밀번호
        hashed_password: 해싱된 비밀번호

    Returns:
        bool: 검증 결과
    """
    return bcrypt.checkpw(password.encode('utf-8'), hashed_password.encode('utf-8'))
```

### 8.6 SQL Injection 방지

```python
# ❌ 나쁜 예 (SQL Injection 취약)
user_id = request.query_params.get("user_id")
query = f"SELECT * FROM users WHERE user_id = '{user_id}'"  # 위험!
result = await db.execute(query)

# ✅ 좋은 예 (SQLAlchemy ORM)
stmt = select(User).where(User.user_id == user_id)  # 안전 (Parameterized Query)
result = await db.execute(stmt)
```

### 8.7 보안 체크리스트

| 항목 | 구현 상태 | 비고 |
|-----|---------|-----|
| **HTTPS 강제** | ✅ | ALB에서 HTTP → HTTPS 리다이렉트 |
| **JWT Secret Key** | ✅ | 32자 이상, Kubernetes Secret |
| **비밀번호 해싱** | ✅ | bcrypt (rounds=12) |
| **Rate Limiting** | ✅ | slowapi (5 req/min for login) |
| **CORS 설정** | ✅ | 허용된 도메인만 |
| **SQL Injection 방지** | ✅ | SQLAlchemy ORM |
| **XSS 방지** | ✅ | React (자동 이스케이프) |
| **CSRF 방지** | ✅ | OAuth state 파라미터 |
| **Row-Level Security** | ✅ | PostgreSQL RLS |
| **Secrets 관리** | ✅ | Kubernetes Secrets |
| **토큰 만료** | ✅ | Access: 15분, Refresh: 30일 |
| **세션 무효화** | ✅ | 로그아웃 시 세션 비활성화 |

---

## 9. 배포 및 실행

### 9.1 로컬 개발 환경

```bash
# 1. PostgreSQL 시작 (Docker)
docker run -d \
  --name postgres-dev \
  -e POSTGRES_USER=pingvasai_dev \
  -e POSTGRES_PASSWORD=DevPassword123! \
  -e POSTGRES_DB=pingvasai \
  -p 5432:5432 \
  postgres:15

# 2. 스키마 생성
psql -h localhost -U pingvasai_dev -d pingvasai -c "CREATE SCHEMA IF NOT EXISTS dev;"

# 3. 마이그레이션
cd ~/pingvasai-saas/backend
export DATABASE_URL="postgresql+asyncpg://pingvasai_dev:DevPassword123!@localhost:5432/pingvasai"
alembic upgrade head

# 4. 백엔드 실행
export GOOGLE_CLIENT_ID="your-client-id"
export GOOGLE_CLIENT_SECRET="your-client-secret"
export JWT_SECRET_KEY="your-super-secret-jwt-key-min-32-characters"

uvicorn invokeai.app.run_app:app --reload --port 9090

# 5. 프론트엔드 실행
cd ~/pingvasai-saas/frontend
npm install
npm run dev
```

### 9.2 Kubernetes 배포

```bash
# 1. Secrets 생성
kubectl apply -f kubernetes/prod/secrets.yaml

# 2. Deployment 배포
kubectl apply -f kubernetes/prod/deployment-api.yaml
kubectl apply -f kubernetes/prod/service-api.yaml

# 3. 상태 확인
kubectl get pods -n prod
kubectl logs -f deployment/api-deployment -n prod

# 4. 서비스 확인
kubectl get svc -n prod
```

### 9.3 마이그레이션 Job (Kubernetes)

```yaml
# kubernetes/prod/job-migration.yaml

apiVersion: batch/v1
kind: Job
metadata:
  name: alembic-migration
  namespace: prod
spec:
  template:
    spec:
      containers:
      - name: migration
        image: <ECR_REPO>/pingvasai-api:latest
        command: ["alembic", "upgrade", "head"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: auth-secrets
              key: DATABASE_URL
      restartPolicy: OnFailure
```

```bash
# 마이그레이션 실행
kubectl apply -f kubernetes/prod/job-migration.yaml

# 로그 확인
kubectl logs job/alembic-migration -n prod
```

---

## 10. 문제 해결 (Troubleshooting)

### 10.1 일반적인 문제

| 문제 | 원인 | 해결 방법 |
|-----|------|---------|
| **401 Unauthorized** | Access Token 만료 | Refresh Token으로 갱신 |
| **403 Forbidden** | 권한 부족 (비활성 사용자 or 플랜 제한) | 사용자 상태 확인 or 플랜 업그레이드 |
| **OAuth Redirect 실패** | Redirect URI 불일치 | Google/Discord 콘솔에서 URI 확인 |
| **RLS 정책 미작동** | `app.current_user_id` 미설정 | `get_db_with_user_context` 사용 |
| **Database Connection 실패** | 잘못된 자격증명 or 네트워크 | Aurora Security Group 확인 |

### 10.2 디버깅 팁

```bash
# 1. JWT 토큰 디코드 (jwt.io 또는 CLI)
echo "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." | base64 -d

# 2. PostgreSQL RLS 정책 확인
psql -h aurora-endpoint -U pingvasai_prod -d pingvasai
\d+ prod.images  -- RLS 정책 확인

# 3. Kubernetes Logs
kubectl logs -f deployment/api-deployment -n prod --tail=100

# 4. Database 연결 테스트
psql -h aurora-endpoint -U pingvasai_prod -d pingvasai -c "SELECT version();"
```

---

## 11. 다음 단계

Phase 4 완료 후:

✅ **완료된 작업:**
- OAuth 2.0 로그인 (Google, Discord)
- JWT 인증 시스템
- 멀티테넌시 (RLS)
- 프론트엔드 인증 UI

📋 **다음 Phase:**
- **Phase 5**: 구독 및 결제 (Lemon Squeezy 통합)
- **Phase 6**: 이메일 서비스 (AWS SES)
- **Phase 7**: 검색 기능 (Elasticsearch + Nori)
- **Phase 8**: 모니터링 & CI/CD (Prometheus, ArgoCD)

---

**Phase 4 완료! 🎉**

이제 사용자는 Google/Discord로 로그인하고, JWT 토큰으로 인증되며, 자신의 데이터만 접근할 수 있습니다.

**예상 소요 시간**: 2주 (80-100시간)
**작성일**: 2025-11-18
**작성자**: Claude (Anthropic)