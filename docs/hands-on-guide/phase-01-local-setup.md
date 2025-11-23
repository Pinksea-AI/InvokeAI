# Phase 1: 로컬 개발 환경 구축

이 가이드는 신입 개발자가 로컬 환경에서 InvokeAI SaaS 플랫폼을 개발할 수 있는 환경을 구축하는 과정을 단계별로 설명합니다.

## 목차
1. [사전 요구사항 설치](#사전-요구사항-설치)
2. [Docker Compose 로컬 인프라](#docker-compose-로컬-인프라)
3. [InvokeAI 로컬 실행](#invokeai-로컬-실행)
4. [FastAPI 마이크로서비스 템플릿](#fastapi-마이크로서비스-템플릿)
5. [통합 테스트](#통합-테스트)
6. [자주 발생하는 오류](#자주-발생하는-오류)

---

## 사전 요구사항 설치

### 1. Docker Desktop 설치

**macOS**:
```bash
# Homebrew로 설치
brew install --cask docker

# 설치 후 Docker Desktop 앱 실행
open /Applications/Docker.app
```

**Windows**:
1. [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) 다운로드
2. WSL 2 활성화 (필수)
```powershell
wsl --install
```

**Linux (Ubuntu)**:
```bash
# Docker 설치
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Docker Compose 설치
sudo apt-get update
sudo apt-get install docker-compose-plugin

# 현재 사용자를 docker 그룹에 추가
sudo usermod -aG docker $USER
newgrp docker
```

**확인**:
```bash
docker --version
# Docker version 24.0.7, build afdd53b

docker compose version
# Docker Compose version v2.23.3
```

---

### 2. Python 3.11+ 설치

**uv 패키지 매니저 사용 (권장)**:
```bash
# uv 설치 (크로스 플랫폼)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 또는 pip로 설치
pip install uv

# Python 3.11 설치
uv python install 3.11

# 확인
uv python list
```

**전통적인 방법**:
```bash
# macOS
brew install python@3.11

# Ubuntu
sudo apt-get install python3.11 python3.11-venv

# 확인
python3.11 --version
```

---

### 3. Node.js 18+ 및 pnpm

```bash
# Node.js 설치 (nvm 사용)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc  # 또는 ~/.zshrc

nvm install 18
nvm use 18

# pnpm 설치
npm install -g pnpm

# 확인
node --version
# v18.19.0

pnpm --version
# 8.15.1
```

---

### 4. Git 및 기타 도구

```bash
# macOS
brew install git jq curl wget

# Ubuntu
sudo apt-get install git jq curl wget

# 확인
git --version
```

---

## Docker Compose 로컬 인프라

로컬 개발 환경에서 PostgreSQL, Redis, S3 (LocalStack)를 실행합니다.

### 1. docker-compose.dev.yaml 생성

프로젝트 루트에 `docker-compose.dev.yaml` 파일을 생성하세요:

```yaml
version: '3.8'

services:
  # PostgreSQL 17.4
  postgres:
    image: postgres:17.4
    container_name: invokeai-postgres
    environment:
      POSTGRES_USER: pingvas_admin
      POSTGRES_PASSWORD: dev_password_123
      POSTGRES_DB: pingvas_saas
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-db.sql:/docker-entrypoint-initdb.d/init-db.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pingvas_admin"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis 7.2 (Standalone for dev)
  redis:
    image: redis:7.2-alpine
    container_name: invokeai-redis
    command: redis-server --appendonly yes
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  # LocalStack (S3 Mock)
  localstack:
    image: localstack/localstack:latest
    container_name: invokeai-localstack
    environment:
      SERVICES: s3
      DEFAULT_REGION: us-east-1
      DATA_DIR: /tmp/localstack/data
    ports:
      - "4566:4566"  # LocalStack Gateway
      - "4510-4559:4510-4559"  # External services port range
    volumes:
      - localstack_data:/tmp/localstack
      - ./localstack-init.sh:/etc/localstack/init/ready.d/init.sh
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
      interval: 10s
      timeout: 5s
      retries: 5

  # PostgreSQL Admin (pgAdmin)
  pgadmin:
    image: dpage/pgadmin4:latest
    container_name: invokeai-pgadmin
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@pingvas.studio
      PGADMIN_DEFAULT_PASSWORD: admin123
    ports:
      - "5050:80"
    depends_on:
      - postgres

  # Redis Commander (Redis GUI)
  redis-commander:
    image: rediscommander/redis-commander:latest
    container_name: invokeai-redis-commander
    environment:
      REDIS_HOSTS: local:redis:6379
    ports:
      - "8081:8081"
    depends_on:
      - redis

volumes:
  postgres_data:
  redis_data:
  localstack_data:
```

---

### 2. PostgreSQL 초기화 스크립트

`init-db.sql` 파일을 생성하세요:

```sql
-- Database initialization for local development

-- Create schemas
CREATE SCHEMA IF NOT EXISTS dev_pingvas;
CREATE SCHEMA IF NOT EXISTS prod_pingvas;

-- Set default schema to dev
SET search_path TO dev_pingvas;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    hashed_password VARCHAR(255),
    oauth_provider VARCHAR(50),
    oauth_id VARCHAR(255),
    tier VARCHAR(20) DEFAULT 'free',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    lemon_squeezy_id VARCHAR(255) UNIQUE,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create credit_balances table
CREATE TABLE IF NOT EXISTS credit_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance INTEGER DEFAULT 0,
    monthly_allocation INTEGER DEFAULT 0,
    last_reset_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create credit_transactions table
CREATE TABLE IF NOT EXISTS credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    type VARCHAR(50) NOT NULL,
    job_id UUID,
    description TEXT,
    balance_after INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create generation_jobs table
CREATE TABLE IF NOT EXISTS generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    prompt TEXT NOT NULL,
    negative_prompt TEXT,
    model_name VARCHAR(100),
    width INTEGER DEFAULT 512,
    height INTEGER DEFAULT 512,
    steps INTEGER DEFAULT 30,
    cfg_scale FLOAT DEFAULT 7.5,
    seed BIGINT,
    image_url TEXT,
    duration_seconds INTEGER,
    credits_consumed INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Create images table
CREATE TABLE IF NOT EXISTS images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id UUID REFERENCES generation_jobs(id) ON DELETE SET NULL,
    s3_key VARCHAR(500) NOT NULL,
    thumbnail_s3_key VARCHAR(500),
    width INTEGER,
    height INTEGER,
    file_size_bytes BIGINT,
    metadata JSONB,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create boards table
CREATE TABLE IF NOT EXISTS boards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create board_images junction table
CREATE TABLE IF NOT EXISTS board_images (
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (board_id, image_id)
);

-- Create ai_models table
CREATE TABLE IF NOT EXISTS ai_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255),
    type VARCHAR(50) NOT NULL,
    base_model VARCHAR(50),
    s3_key VARCHAR(500),
    efs_path VARCHAR(500),
    file_size_bytes BIGINT,
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_tier ON users(tier);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_credit_balances_user_id ON credit_balances(user_id);
CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX idx_generation_jobs_user_id ON generation_jobs(user_id);
CREATE INDEX idx_generation_jobs_status ON generation_jobs(status);
CREATE INDEX idx_images_user_id ON images(user_id);
CREATE INDEX idx_boards_user_id ON boards(user_id);

-- Insert test user
INSERT INTO users (email, tier, oauth_provider)
VALUES ('dev@pingvas.studio', 'pro', 'google')
ON CONFLICT (email) DO NOTHING;

-- Get test user ID and insert credit balance
INSERT INTO credit_balances (user_id, balance, monthly_allocation)
SELECT id, 5000, 5000 FROM users WHERE email = 'dev@pingvas.studio'
ON CONFLICT (user_id) DO NOTHING;

COMMENT ON DATABASE pingvas_saas IS 'InvokeAI SaaS Platform - Local Development';
```

---

### 3. LocalStack 초기화 스크립트

`localstack-init.sh` 파일을 생성하세요:

```bash
#!/bin/bash

# Wait for LocalStack to be ready
echo "Waiting for LocalStack..."
sleep 5

# Create S3 buckets
awslocal s3 mb s3://pingvas-images-dev
awslocal s3 mb s3://pingvas-models-dev
awslocal s3 mb s3://pingvas-logs-dev

# Set bucket policies (public read for images)
awslocal s3api put-bucket-policy --bucket pingvas-images-dev --policy '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::pingvas-images-dev/*"
    }
  ]
}'

echo "LocalStack initialization complete!"
```

실행 권한 부여:
```bash
chmod +x localstack-init.sh
```

---

### 4. Docker Compose 실행

```bash
# 모든 서비스 시작
docker compose -f docker-compose.dev.yaml up -d

# 로그 확인
docker compose -f docker-compose.dev.yaml logs -f

# 상태 확인
docker compose -f docker-compose.dev.yaml ps
```

**확인 URL**:
- PostgreSQL: `localhost:5432`
- pgAdmin: http://localhost:5050 (admin@pingvas.studio / admin123)
- Redis: `localhost:6379`
- Redis Commander: http://localhost:8081
- LocalStack S3: `http://localhost:4566`

---

### 5. 서비스 연결 테스트

**PostgreSQL 테스트**:
```bash
# psql CLI로 접속
docker exec -it invokeai-postgres psql -U pingvas_admin -d pingvas_saas

# 테이블 확인
\dt dev_pingvas.*

# 테스트 쿼리
SELECT * FROM dev_pingvas.users;

# 종료
\q
```

**Redis 테스트**:
```bash
# redis-cli로 접속
docker exec -it invokeai-redis redis-cli

# 테스트
PING
# PONG

SET test_key "Hello InvokeAI"
GET test_key

# 종료
exit
```

**S3 (LocalStack) 테스트**:
```bash
# AWS CLI 설치 (없는 경우)
pip install awscli awscli-local

# 버킷 확인
awslocal s3 ls

# 테스트 파일 업로드
echo "test" > test.txt
awslocal s3 cp test.txt s3://pingvas-images-dev/test.txt

# 확인
awslocal s3 ls s3://pingvas-images-dev/
```

---

## InvokeAI 로컬 실행

원본 InvokeAI를 로컬에서 실행하여 동작을 이해합니다.

### 1. InvokeAI 설치

```bash
# 프로젝트 루트에서
cd /home/user/InvokeAI

# Python 가상 환경 생성 (uv 사용)
uv venv --python 3.11
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 의존성 설치
uv pip install -e ".[test]"

# 또는 전통적인 방법
pip install -e ".[test]"
```

---

### 2. InvokeAI 설정

```bash
# 설정 초기화
invokeai-configure --yes

# 설정 파일 확인
cat ~/.invokeai/invokeai.yaml
```

**수동 설정** (선택사항):

`~/.invokeai/invokeai.yaml` 편집:
```yaml
InvokeAI:
  host: 0.0.0.0
  port: 9090
  allow_origins: []
  allow_credentials: true
  allow_methods:
    - '*'
  allow_headers:
    - '*'

  # 로컬 DB 연결
  db_url: postgresql://pingvas_admin:dev_password_123@localhost:5432/pingvas_saas

  # 로그 레벨
  log_level: info

  # 모델 경로
  models_dir: ~/.invokeai/models
```

---

### 3. 기본 모델 다운로드

```bash
# Stable Diffusion 1.5 모델 다운로드
invokeai-model-install --add runwayml/stable-diffusion-v1-5

# 또는 대화형 설치
invokeai-model-install
```

**수동 다운로드** (HuggingFace Token 필요):
```bash
# HuggingFace CLI 설치
pip install huggingface-hub

# 로그인
huggingface-cli login

# 모델 다운로드
huggingface-cli download runwayml/stable-diffusion-v1-5 \
  --local-dir ~/.invokeai/models/sd-1/main/stable-diffusion-v1-5
```

---

### 4. InvokeAI 실행

```bash
# API 서버 실행
invokeai-web

# 또는 개발 모드 (hot reload)
uvicorn invokeai.app.api_app:app --host 0.0.0.0 --port 9090 --reload
```

**확인**:
- API 문서: http://localhost:9090/docs
- UI: http://localhost:9090

---

### 5. 이미지 생성 테스트

**API로 테스트**:
```bash
curl -X POST "http://localhost:9090/api/v1/images/text-to-image" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A beautiful sunset over mountains",
    "model": "stable-diffusion-v1-5",
    "width": 512,
    "height": 512,
    "steps": 30
  }'
```

**Python 스크립트로 테스트**:

`test_generation.py`:
```python
import requests
import json

API_URL = "http://localhost:9090"

def test_generation():
    payload = {
        "prompt": "A serene lake with mountains in the background",
        "negative_prompt": "ugly, blurry",
        "model": "stable-diffusion-v1-5",
        "width": 512,
        "height": 512,
        "steps": 30,
        "cfg_scale": 7.5,
        "seed": 42
    }

    response = requests.post(
        f"{API_URL}/api/v1/images/text-to-image",
        json=payload
    )

    if response.status_code == 200:
        result = response.json()
        print(f"✅ Generation successful!")
        print(f"Image ID: {result.get('image_id')}")
        print(f"Image URL: {result.get('image_url')}")
    else:
        print(f"❌ Generation failed: {response.text}")

if __name__ == "__main__":
    test_generation()
```

실행:
```bash
python test_generation.py
```

---

## FastAPI 마이크로서비스 템플릿

기본 FastAPI 서비스 템플릿을 생성합니다.

### 1. 디렉토리 구조 생성

```bash
# 프로젝트 루트에서
mkdir -p services/user-service
cd services/user-service

# 디렉토리 구조
mkdir -p app/{api,models,schemas,utils,db}
touch app/__init__.py
touch app/main.py
```

---

### 2. pyproject.toml

`services/user-service/pyproject.toml`:
```toml
[project]
name = "user-service"
version = "0.1.0"
description = "User authentication and management service"
requires-python = ">=3.11"

dependencies = [
    "fastapi>=0.109.0",
    "uvicorn[standard]>=0.27.0",
    "sqlalchemy>=2.0.25",
    "psycopg2-binary>=2.9.9",
    "pydantic>=2.5.3",
    "pydantic-settings>=2.1.0",
    "python-jose[cryptography]>=3.3.0",
    "passlib[bcrypt]>=1.7.4",
    "python-multipart>=0.0.6",
    "redis>=5.0.1",
    "httpx>=0.26.0",
]

[tool.uv]
dev-dependencies = [
    "pytest>=7.4.4",
    "pytest-asyncio>=0.23.3",
    "pytest-cov>=4.1.0",
]
```

---

### 3. 환경 변수 설정

`services/user-service/.env`:
```bash
# Service
SERVICE_NAME=user-service
HOST=0.0.0.0
PORT=8001

# Database
DATABASE_URL=postgresql://pingvas_admin:dev_password_123@localhost:5432/pingvas_saas
DB_SCHEMA=dev_pingvas

# Redis
REDIS_URL=redis://localhost:6379/0

# JWT
JWT_SECRET_KEY=dev_secret_key_change_in_production_12345
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30

# OAuth (개발용 더미 값)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
```

---

### 4. 설정 파일

`services/user-service/app/config.py`:
```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # Service
    service_name: str = "user-service"
    host: str = "0.0.0.0"
    port: int = 8001

    # Database
    database_url: str
    db_schema: str = "dev_pingvas"

    # Redis
    redis_url: str

    # JWT
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30

    # OAuth
    google_client_id: str = ""
    google_client_secret: str = ""
    discord_client_id: str = ""
    discord_client_secret: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False
    )

settings = Settings()
```

---

### 5. 데이터베이스 모델

`services/user-service/app/models/user.py`:
```python
from sqlalchemy import Column, String, Boolean, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid

from app.db.base import Base

class User(Base):
    __tablename__ = "users"
    __table_args__ = {"schema": "dev_pingvas"}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=True)
    oauth_provider = Column(String(50), nullable=True)
    oauth_id = Column(String(255), nullable=True)
    tier = Column(String(20), default="free")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
```

---

### 6. Pydantic 스키마

`services/user-service/app/schemas/user.py`:
```python
from pydantic import BaseModel, EmailStr, Field
from datetime import datetime
from uuid import UUID
from typing import Optional

class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8)

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    id: UUID
    email: str
    tier: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
```

---

### 7. 데이터베이스 연결

`services/user-service/app/db/base.py`:
```python
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from app.config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
```

---

### 8. 인증 유틸리티

`services/user-service/app/utils/auth.py`:
```python
from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.db.base import get_db
from app.models.user import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes)

    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return encoded_jwt

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise credentials_exception

    return user
```

---

### 9. API 라우터

`services/user-service/app/api/auth.py`:
```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.base import get_db
from app.models.user import User
from app.schemas.user import UserCreate, UserLogin, UserResponse, Token
from app.utils.auth import hash_password, verify_password, create_access_token

router = APIRouter(prefix="/api/v1/auth", tags=["Authentication"])

@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
async def register(user_data: UserCreate, db: Session = Depends(get_db)):
    """
    신규 사용자 등록
    """
    # 이메일 중복 체크
    existing_user = db.query(User).filter(User.email == user_data.email).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )

    # 사용자 생성
    new_user = User(
        email=user_data.email,
        hashed_password=hash_password(user_data.password),
        tier="free"
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # JWT 토큰 생성
    access_token = create_access_token(data={"sub": str(new_user.id)})

    return Token(
        access_token=access_token,
        user=UserResponse.model_validate(new_user)
    )

@router.post("/login", response_model=Token)
async def login(credentials: UserLogin, db: Session = Depends(get_db)):
    """
    사용자 로그인
    """
    # 사용자 조회
    user = db.query(User).filter(User.email == credentials.email).first()

    if not user or not verify_password(credentials.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password"
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is inactive"
        )

    # JWT 토큰 생성
    access_token = create_access_token(data={"sub": str(user.id)})

    return Token(
        access_token=access_token,
        user=UserResponse.model_validate(user)
    )

@router.get("/me", response_model=UserResponse)
async def get_current_user_info(user: User = Depends(get_current_user)):
    """
    현재 로그인한 사용자 정보 조회
    """
    return UserResponse.model_validate(user)
```

---

### 10. Main 애플리케이션

`services/user-service/app/main.py`:
```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from app.config import settings
from app.api import auth

app = FastAPI(
    title=settings.service_name,
    version="0.1.0",
    description="User authentication and management service"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 개발 환경
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 라우터 등록
app.include_router(auth.router)

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": settings.service_name}

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True
    )
```

---

### 11. 서비스 실행

```bash
# 의존성 설치
cd services/user-service
uv venv
source .venv/bin/activate
uv pip install -e .

# 서비스 실행
python -m app.main

# 또는
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

**확인**:
- API 문서: http://localhost:8001/docs
- Health Check: http://localhost:8001/health

---

## 통합 테스트

### 1. 사용자 등록 테스트

```bash
curl -X POST "http://localhost:8001/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "securepassword123"
  }'
```

**예상 응답**:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "user": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "email": "test@example.com",
    "tier": "free",
    "is_active": true,
    "created_at": "2025-01-20T10:30:00Z"
  }
}
```

---

### 2. 로그인 테스트

```bash
curl -X POST "http://localhost:8001/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "securepassword123"
  }'
```

---

### 3. 인증된 요청 테스트

```bash
# 토큰 저장
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# /me 엔드포인트 호출
curl -X GET "http://localhost:8001/api/v1/auth/me" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 4. 통합 테스트 스크립트

`test_integration.py`:
```python
import requests
import time

BASE_URL = "http://localhost:8001"

def test_full_flow():
    # 1. 사용자 등록
    print("1. Testing user registration...")
    register_data = {
        "email": f"test_{int(time.time())}@example.com",
        "password": "testpassword123"
    }

    response = requests.post(f"{BASE_URL}/api/v1/auth/register", json=register_data)
    assert response.status_code == 201
    token = response.json()["access_token"]
    print(f"✅ Registration successful. Token: {token[:20]}...")

    # 2. 로그인
    print("\n2. Testing login...")
    login_data = {
        "email": register_data["email"],
        "password": register_data["password"]
    }

    response = requests.post(f"{BASE_URL}/api/v1/auth/login", json=login_data)
    assert response.status_code == 200
    print("✅ Login successful")

    # 3. 인증된 요청
    print("\n3. Testing authenticated request...")
    headers = {"Authorization": f"Bearer {token}"}
    response = requests.get(f"{BASE_URL}/api/v1/auth/me", headers=headers)
    assert response.status_code == 200
    user = response.json()
    print(f"✅ User info retrieved: {user['email']}")

    print("\n🎉 All tests passed!")

if __name__ == "__main__":
    test_full_flow()
```

실행:
```bash
python test_integration.py
```

---

## 자주 발생하는 오류

### 1. Docker 서비스 실행 오류

**문제**: `ERROR: port is already allocated`

**해결**:
```bash
# 포트 사용 중인 프로세스 확인
lsof -i :5432
# 또는
netstat -an | grep 5432

# 프로세스 종료
kill -9 <PID>

# 또는 docker-compose.dev.yaml의 포트 변경
ports:
  - "15432:5432"  # 호스트 포트 변경
```

---

### 2. PostgreSQL 연결 오류

**문제**: `psycopg2.OperationalError: could not connect to server`

**해결**:
```bash
# Docker 컨테이너 상태 확인
docker ps | grep postgres

# 로그 확인
docker logs invokeai-postgres

# 헬스체크
docker inspect invokeai-postgres | grep Health -A 10

# 재시작
docker restart invokeai-postgres
```

---

### 3. Python 의존성 설치 오류

**문제**: `ERROR: Could not build wheels for psycopg2`

**해결**:
```bash
# macOS
brew install postgresql

# Ubuntu
sudo apt-get install libpq-dev python3-dev

# 또는 psycopg2-binary 사용 (개발 환경)
uv pip install psycopg2-binary
```

---

### 4. InvokeAI 모델 다운로드 오류

**문제**: `HTTPError 401: Unauthorized`

**해결**:
```bash
# HuggingFace 토큰 생성 (https://huggingface.co/settings/tokens)
# Read 권한 필요

# 토큰 설정
export HUGGING_FACE_HUB_TOKEN="hf_..."

# 또는 로그인
huggingface-cli login
```

---

### 5. FastAPI 서비스 임포트 오류

**문제**: `ModuleNotFoundError: No module named 'app'`

**해결**:
```bash
# PYTHONPATH 설정
export PYTHONPATH="${PYTHONPATH}:/home/user/InvokeAI/services/user-service"

# 또는 개발 모드로 설치
pip install -e .

# 또는 절대 경로로 실행
cd services/user-service
python -m app.main
```

---

## 다음 단계

로컬 환경 구축이 완료되었습니다! 이제 마이크로서비스 개발로 넘어갑니다:

**👉 [Phase 2 - 마이크로서비스 개발](./phase-02-microservices.md)**

---

## 체크리스트

완료한 항목을 체크하세요:

- [ ] Docker Desktop 설치 및 실행
- [ ] Python 3.11+ 설치
- [ ] Node.js 18+ 및 pnpm 설치
- [ ] docker-compose.dev.yaml 생성
- [ ] PostgreSQL, Redis, LocalStack 실행
- [ ] 데이터베이스 연결 테스트
- [ ] InvokeAI 로컬 실행
- [ ] 기본 모델 다운로드
- [ ] 이미지 생성 테스트 성공
- [ ] FastAPI 템플릿 서비스 생성
- [ ] User Service 실행
- [ ] 통합 테스트 통과

**모두 완료되었다면 Phase 2로 이동하세요!** 🚀
