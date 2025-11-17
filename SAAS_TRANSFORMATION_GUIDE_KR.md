# InvokeAI를 구독형 SaaS로 전환하기 - 완전 가이드

> AWS 기반 멀티테넌트 AI 이미지 생성 SaaS 구축 핸즈온

## 📋 목차

1. [현재 vs 목표 아키텍처](#1-현재-vs-목표-아키텍처)
2. [전체 로드맵](#2-전체-로드맵)
3. [Phase 1: 사용자 인증 및 멀티테넌시](#phase-1-사용자-인증-및-멀티테넌시)
4. [Phase 2: AWS 인프라 설계](#phase-2-aws-인프라-설계)
5. [Phase 3: 구독 및 결제 시스템](#phase-3-구독-및-결제-시스템)
6. [Phase 4: 리소스 격리 및 할당량](#phase-4-리소스-격리-및-할당량)
7. [Phase 5: 스케일링 전략](#phase-5-스케일링-전략)
8. [Phase 6: 배포 및 CI/CD](#phase-6-배포-및-cicd)
9. [Phase 7: 모니터링 및 운영](#phase-7-모니터링-및-운영)
10. [Phase 8: 보안 강화](#phase-8-보안-강화)

---

## 1. 현재 vs 목표 아키텍처

### 1.1 현재 아키텍처 (로컬 실행)

```
┌─────────────────────────────────────────┐
│         사용자의 컴퓨터                     │
│                                         │
│  ┌────────────────────────────────┐   │
│  │    브라우저 (localhost:9090)     │   │
│  └────────────┬───────────────────┘   │
│               │                        │
│  ┌────────────▼───────────────────┐   │
│  │    FastAPI 서버 (로컬)          │   │
│  └────────────┬───────────────────┘   │
│               │                        │
│  ┌────────────▼───────────────────┐   │
│  │    SQLite (로컬 파일)           │   │
│  │    outputs/ (로컬 디렉토리)      │   │
│  │    models/ (로컬 디렉토리)       │   │
│  └────────────┬───────────────────┘   │
│               │                        │
│  ┌────────────▼───────────────────┐   │
│  │    GPU (RTX 3090 등)           │   │
│  └────────────────────────────────┘   │
│                                         │
│  특징:                                  │
│  - 단일 사용자                          │
│  - 인증 없음                           │
│  - 무제한 사용                          │
│  - 수동 관리                           │
└─────────────────────────────────────────┘
```

### 1.2 목표 아키텍처 (AWS SaaS)

```
인터넷
  │
┌─▼──────────────────────────────────────────────────────┐
│            AWS CloudFront (CDN)                         │
│  - 정적 파일 캐싱 (React 빌드)                           │
│  - SSL/TLS 종료                                         │
│  - DDoS 보호                                            │
└─┬──────────────────────────────────────────────────────┘
  │
┌─▼──────────────────────────────────────────────────────┐
│     Application Load Balancer (ALB)                    │
│  - HTTPS 종료                                           │
│  - Auto Scaling 그룹과 통합                              │
│  - Health Check                                         │
└─┬──────────────────────────────────────────────────────┘
  │
┌─▼──────────────────────────────────────────────────────┐
│         ECS Fargate / EC2 Auto Scaling                 │
│                                                         │
│  ┌─────────────────────────────────────────────────┐  │
│  │  Container 1 (사용자 A, B, C)                    │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │  FastAPI (멀티테넌트)                     │  │  │
│  │  │  - JWT 인증                               │  │  │
│  │  │  - 사용자별 격리                          │  │  │
│  │  │  - 할당량 체크                            │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐  │
│  │  Container 2 (GPU 워커)                          │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │  Celery Worker (비동기 처리)              │  │  │
│  │  │  - 이미지 생성 작업                       │  │  │
│  │  │  - 우선순위 큐                            │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
  │
┌─▼──────────────────────────────────────────────────────┐
│              데이터 레이어                               │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │ RDS (PostgreSQL) │ ElastiCache │ │ S3 (이미지)  │  │
│  │  - 사용자 정보│  │ (Redis)     │  │  - 생성 이미지│  │
│  │  - 구독 정보 │  │  - 세션     │  │  - 모델 파일 │  │
│  │  - 이미지 메타│  │  - 작업 큐  │  │              │  │
│  └─────────────┘  └─────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
  │
┌─▼──────────────────────────────────────────────────────┐
│           외부 서비스 통합                               │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │  Stripe  │  │ Cognito  │  │ CloudWatch       │    │
│  │  (결제)  │  │  (인증)  │  │ (모니터링/로깅)   │    │
│  └──────────┘  └──────────┘  └──────────────────┘    │
└─────────────────────────────────────────────────────────┘

특징:
✅ 멀티 사용자 (수천~수만 명)
✅ JWT 기반 인증/인가
✅ 구독 기반 과금
✅ 사용량 제한 및 모니터링
✅ 자동 스케일링
✅ 고가용성 (99.9% SLA)
```

### 1.3 주요 변경사항 요약

| 항목 | 현재 (로컬) | 목표 (SaaS) |
|-----|-----------|-----------|
| **사용자** | 단일 | 멀티테넌트 (수천 명) |
| **인증** | 없음 | JWT + AWS Cognito |
| **데이터베이스** | SQLite (로컬) | PostgreSQL (RDS) |
| **파일 저장** | 로컬 디스크 | S3 |
| **GPU** | 로컬 GPU | EC2 GPU 인스턴스 (p3/g4dn) |
| **작업 처리** | 동기 (대기) | 비동기 (Celery + Redis) |
| **결제** | 없음 | Stripe 구독 |
| **사용량 제한** | 없음 | 플랜별 할당량 |
| **스케일링** | 수동 | 자동 (ASG) |
| **모니터링** | 없음 | CloudWatch + Sentry |
| **배포** | 수동 | CI/CD (GitHub Actions) |

---

## 2. 전체 로드맵

### 2.1 개발 단계 (3-6개월)

```
Month 1: 기초 인프라 및 인증
  Week 1-2: AWS 계정 설정, VPC/네트워크 구성
  Week 3-4: 사용자 인증 시스템 구축

Month 2: 멀티테넌시 및 데이터 격리
  Week 1-2: DB 스키마 변경, 사용자별 격리
  Week 3-4: S3 통합, 파일 업로드 변경

Month 3: 비동기 작업 처리
  Week 1-2: Celery 통합, Redis 설정
  Week 3-4: 작업 큐 및 우선순위

Month 4: 구독 및 결제
  Week 1-2: Stripe 통합
  Week 3-4: 플랜별 할당량 시스템

Month 5: 스케일링 및 성능
  Week 1-2: Auto Scaling 설정
  Week 3-4: 성능 최적화, 캐싱

Month 6: 운영 및 모니터링
  Week 1-2: CI/CD 파이프라인
  Week 3-4: 모니터링, 알림, 백업
```

### 2.2 우선순위

**P0 (필수 - 런치 전):**
- ✅ 사용자 인증 및 회원가입
- ✅ 멀티테넌시 (사용자별 데이터 격리)
- ✅ 결제 시스템 (Stripe)
- ✅ 기본 할당량 (무료: 월 100장, Pro: 월 1000장)
- ✅ S3 통합

**P1 (중요 - 런치 후 1개월):**
- ✅ 비동기 작업 처리
- ✅ Auto Scaling
- ✅ 모니터링 및 알림
- ✅ 에러 추적 (Sentry)

**P2 (나중에):**
- 🔲 고급 분석 대시보드
- 🔲 팀 기능
- 🔲 API 제공
- 🔲 Webhook

---

## Phase 1: 사용자 인증 및 멀티테넌시

### 3.1 왜 필요한가?

**현재 문제점:**
- 누구나 접속 가능 (보안 취약)
- 사용자 구분 불가
- 데이터 격리 없음

**해결책:**
- AWS Cognito로 사용자 관리
- JWT 토큰으로 인증
- DB에 user_id 추가하여 데이터 격리

### 3.2 AWS Cognito 설정

#### Step 1: Cognito User Pool 생성

```bash
# AWS CLI로 User Pool 생성
aws cognito-idp create-user-pool \
  --pool-name invokeai-users \
  --policies "PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true}" \
  --auto-verified-attributes email \
  --mfa-configuration OFF \
  --schema '[
    {
      "Name": "email",
      "Required": true,
      "Mutable": false
    },
    {
      "Name": "name",
      "Required": true,
      "Mutable": true
    }
  ]'
```

**또는 Terraform으로:**

```hcl
# terraform/cognito.tf
resource "aws_cognito_user_pool" "main" {
  name = "invokeai-users"

  # 비밀번호 정책
  password_policy {
    minimum_length    = 8
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
  }

  # 이메일 검증
  auto_verified_attributes = ["email"]

  # 사용자 속성
  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = false
  }

  schema {
    name                = "name"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }

  # 계정 복구
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

# App Client 생성
resource "aws_cognito_user_pool_client" "web" {
  name         = "web-client"
  user_pool_id = aws_cognito_user_pool.main.id

  # OAuth 설정
  allowed_oauth_flows  = ["code", "implicit"]
  allowed_oauth_scopes = ["email", "openid", "profile"]
  callback_urls        = ["https://yourdomain.com/callback"]
  logout_urls          = ["https://yourdomain.com/logout"]

  # 토큰 유효기간
  id_token_validity      = 1  # 1일
  access_token_validity  = 1  # 1일
  refresh_token_validity = 30 # 30일

  token_validity_units {
    id_token      = "days"
    access_token  = "days"
    refresh_token = "days"
  }
}
```

#### Step 2: 백엔드에 인증 미들웨어 추가

**의존성 추가:**

```toml
# pyproject.toml
[project.dependencies]
python-jose = "^3.3.0"        # JWT 처리
boto3 = "^1.28.0"             # AWS SDK
pydantic-settings = "^2.0.0"  # 설정 관리
```

**JWT 검증 유틸리티:**

```python
# invokeai/app/services/auth/jwt_service.py
from datetime import datetime, timedelta
from typing import Optional

from jose import JWTError, jwt
from pydantic import BaseModel


class TokenData(BaseModel):
    """JWT 토큰 데이터"""
    user_id: str
    email: str
    subscription_tier: str  # free, pro, enterprise
    exp: datetime


class JWTService:
    """JWT 토큰 검증 서비스"""

    def __init__(self, cognito_region: str, cognito_user_pool_id: str):
        self.region = cognito_region
        self.user_pool_id = cognito_user_pool_id

        # Cognito의 공개 키를 가져옴
        self.jwks_url = (
            f"https://cognito-idp.{region}.amazonaws.com/"
            f"{user_pool_id}/.well-known/jwks.json"
        )

    def verify_token(self, token: str) -> Optional[TokenData]:
        """
        JWT 토큰 검증

        Args:
            token: Bearer 토큰에서 추출한 JWT

        Returns:
            검증된 토큰 데이터 또는 None
        """
        try:
            # 1. 토큰 디코딩 (서명 검증 포함)
            payload = jwt.decode(
                token,
                # Cognito 공개 키로 검증
                self._get_public_key(),
                algorithms=["RS256"],
                audience=self.client_id,
            )

            # 2. 필수 필드 확인
            user_id = payload.get("sub")
            email = payload.get("email")

            if not user_id or not email:
                return None

            # 3. 커스텀 속성 추출
            subscription_tier = payload.get("custom:subscription_tier", "free")

            # 4. 만료 시간 확인
            exp = datetime.fromtimestamp(payload.get("exp"))

            return TokenData(
                user_id=user_id,
                email=email,
                subscription_tier=subscription_tier,
                exp=exp,
            )

        except JWTError as e:
            logger.warning(f"JWT verification failed: {e}")
            return None

    def _get_public_key(self):
        """Cognito에서 공개 키 가져오기 (캐시됨)"""
        # 실제 구현에서는 jwks_url에서 키를 가져와 캐시
        pass
```

**FastAPI 의존성 주입:**

```python
# invokeai/app/api/dependencies.py
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from invokeai.app.services.auth.jwt_service import JWTService, TokenData


security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    jwt_service: JWTService = Depends(lambda: ApiDependencies.jwt_service),
) -> TokenData:
    """
    현재 인증된 사용자 가져오기

    모든 보호된 엔드포인트에서 사용:
        @router.get("/protected")
        async def protected_route(user: TokenData = Depends(get_current_user)):
            ...
    """
    token = credentials.credentials

    # JWT 검증
    token_data = jwt_service.verify_token(token)

    if token_data is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 만료 확인
    if token_data.exp < datetime.now():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return token_data


async def get_current_pro_user(
    user: TokenData = Depends(get_current_user),
) -> TokenData:
    """Pro 이상 플랜 사용자만 허용"""
    if user.subscription_tier not in ["pro", "enterprise"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Pro plan required",
        )
    return user
```

**API 라우터에 적용:**

```python
# invokeai/app/api/routers/session_queue.py
from invokeai.app.api.dependencies import get_current_user, TokenData


@router.post("/enqueue_batch")
async def enqueue_batch(
    queue_batch: EnqueueBatchParams,
    user: TokenData = Depends(get_current_user),  # ✅ 인증 필수
    queue: SessionQueueService = Depends(ApiDependencies.queue),
):
    """배치를 큐에 추가 (인증된 사용자만)"""

    # 사용자 정보를 배치에 추가
    queue_batch.user_id = user.user_id

    # 할당량 체크 (나중에 구현)
    if not await check_quota(user.user_id):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Monthly quota exceeded. Please upgrade your plan.",
        )

    enqueue_result = queue.enqueue_batch(queue_batch)
    return enqueue_result
```

#### Step 3: 프론트엔드 인증 플로우

**1) AWS Amplify 설정:**

```bash
cd invokeai/frontend/web
npm install aws-amplify @aws-amplify/ui-react
```

**2) Amplify 초기화:**

```typescript
// src/app/amplify.ts
import { Amplify } from 'aws-amplify';

Amplify.configure({
  Auth: {
    region: 'us-east-1',
    userPoolId: 'us-east-1_XXXXXXXXX',
    userPoolWebClientId: 'xxxxxxxxxxxxxxxxxxxxxxxxxx',
    mandatorySignIn: true,
    oauth: {
      domain: 'your-domain.auth.us-east-1.amazoncognito.com',
      scope: ['email', 'openid', 'profile'],
      redirectSignIn: 'https://yourdomain.com/',
      redirectSignOut: 'https://yourdomain.com/',
      responseType: 'code',
    },
  },
});
```

**3) 로그인 컴포넌트:**

```typescript
// src/features/auth/components/LoginPage.tsx
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

export const LoginPage = () => {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <div>
          <h1>Welcome {user?.username}</h1>
          <button onClick={signOut}>Sign out</button>
          {/* 실제 앱 컨텐츠 */}
          <App />
        </div>
      )}
    </Authenticator>
  );
};
```

**4) API 요청에 토큰 추가:**

```typescript
// src/services/api/index.ts
import { Auth } from 'aws-amplify';

export const api = createApi({
  baseQuery: fetchBaseQuery({
    baseUrl: '/api/v1',
    prepareHeaders: async (headers, { getState }) => {
      try {
        // Cognito에서 토큰 가져오기
        const session = await Auth.currentSession();
        const token = session.getIdToken().getJwtToken();

        // Authorization 헤더에 추가
        headers.set('Authorization', `Bearer ${token}`);
      } catch (error) {
        console.error('Failed to get auth token:', error);
      }

      return headers;
    },
  }),
  // ... 나머지 설정
});
```

**5) 보호된 라우트:**

```typescript
// src/app/App.tsx
import { useAuthenticator } from '@aws-amplify/ui-react';
import { Navigate } from 'react-router-dom';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuthenticator();

  if (!user) {
    return <Navigate to="/login" />;
  }

  return <>{children}</>;
};

export const App = () => {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
};
```

### 3.3 데이터베이스 멀티테넌시

#### Step 1: PostgreSQL 마이그레이션

**왜 PostgreSQL?**
- ✅ 멀티테넌트에 적합 (Row Level Security)
- ✅ 확장성 (수백만 행 처리 가능)
- ✅ JSON 지원 (워크플로우 저장)
- ✅ AWS RDS 완전 관리형

**RDS 생성 (Terraform):**

```hcl
# terraform/rds.tf
resource "aws_db_instance" "main" {
  identifier = "invokeai-db"

  # 엔진
  engine         = "postgres"
  engine_version = "15.4"

  # 인스턴스 크기
  instance_class = "db.t3.medium"  # 시작은 작게

  # 스토리지
  allocated_storage     = 100  # GB
  max_allocated_storage = 1000 # 자동 확장 최대치
  storage_type          = "gp3"
  storage_encrypted     = true

  # 데이터베이스
  db_name  = "invokeai"
  username = "admin"
  password = random_password.db_password.result  # Secrets Manager 사용 권장

  # 네트워크
  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.main.name
  publicly_accessible    = false  # VPC 내부에서만 접근

  # 백업
  backup_retention_period = 7  # 7일 보관
  backup_window          = "03:00-04:00"  # UTC

  # 유지보수
  maintenance_window = "sun:04:00-sun:05:00"

  # 삭제 방지
  deletion_protection = true
  skip_final_snapshot = false

  tags = {
    Environment = "production"
  }
}
```

#### Step 2: DB 스키마 변경

**마이그레이션 도구 설정:**

```bash
pip install alembic asyncpg
```

```python
# alembic/versions/001_add_user_id.py
"""Add user_id to all tables

Revision ID: 001
"""
from alembic import op
import sqlalchemy as sa


def upgrade():
    # 1. users 테이블 생성
    op.create_table(
        'users',
        sa.Column('id', sa.String(36), primary_key=True),  # Cognito sub
        sa.Column('email', sa.String(255), unique=True, nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('subscription_tier', sa.String(50), default='free'),
        sa.Column('subscription_status', sa.String(50), default='active'),
        sa.Column('stripe_customer_id', sa.String(255), unique=True),
        sa.Column('monthly_quota', sa.Integer, default=100),  # 월 이미지 생성 한도
        sa.Column('used_quota', sa.Integer, default=0),
        sa.Column('quota_reset_date', sa.DateTime),
        sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime, onupdate=sa.func.now()),
    )
    op.create_index('idx_users_email', 'users', ['email'])

    # 2. 기존 테이블에 user_id 추가
    op.add_column('images', sa.Column('user_id', sa.String(36), nullable=True))
    op.add_column('boards', sa.Column('user_id', sa.String(36), nullable=True))
    op.add_column('workflows', sa.Column('user_id', sa.String(36), nullable=True))
    op.add_column('session_queue', sa.Column('user_id', sa.String(36), nullable=True))

    # 3. 외래 키 추가
    op.create_foreign_key('fk_images_user', 'images', 'users', ['user_id'], ['id'])
    op.create_foreign_key('fk_boards_user', 'boards', 'users', ['user_id'], ['id'])
    op.create_foreign_key('fk_workflows_user', 'workflows', 'users', ['user_id'], ['id'])

    # 4. 인덱스 추가 (성능)
    op.create_index('idx_images_user_id', 'images', ['user_id'])
    op.create_index('idx_boards_user_id', 'boards', ['user_id'])

    # 5. Row Level Security (선택적)
    # PostgreSQL의 RLS를 사용하면 쿼리에 자동으로 user_id 필터 적용
    op.execute("""
        ALTER TABLE images ENABLE ROW LEVEL SECURITY;

        CREATE POLICY user_images_policy ON images
        FOR ALL
        USING (user_id = current_setting('app.current_user_id')::text);
    """)


def downgrade():
    # 롤백 로직
    pass
```

#### Step 3: 서비스 레이어 수정

**이미지 서비스에 사용자 필터 추가:**

```python
# invokeai/app/services/images/images_default.py
class ImageService:
    """이미지 서비스 (멀티테넌트 지원)"""

    def save(
        self,
        image: Image.Image,
        user_id: str,  # ✅ 추가됨
        image_origin: ImageOrigin,
        image_category: ImageCategory,
        **kwargs,
    ) -> ImageDTO:
        """이미지 저장"""

        image_name = str(uuid.uuid4())

        # 1. S3에 저장 (사용자별 디렉토리)
        s3_key = f"users/{user_id}/images/{image_name}.png"
        self._s3_client.put_object(
            Bucket=self._bucket_name,
            Key=s3_key,
            Body=image_to_bytes(image),
            ContentType='image/png',
        )

        # 2. DB 레코드 생성
        record = ImageRecord(
            image_name=image_name,
            user_id=user_id,  # ✅ 추가됨
            image_origin=image_origin,
            image_category=image_category,
            s3_key=s3_key,
            width=image.width,
            height=image.height,
        )
        self._records.save(record)

        return ImageDTO.from_record(record)

    def list_images(
        self,
        user_id: str,  # ✅ 추가됨
        board_id: Optional[str] = None,
        offset: int = 0,
        limit: int = 20,
    ) -> List[ImageDTO]:
        """사용자의 이미지 목록 조회"""

        # ✅ user_id 필터 자동 추가
        query = (
            select(ImageRecord)
            .where(ImageRecord.user_id == user_id)
            .where(ImageRecord.deleted_at.is_(None))
        )

        if board_id:
            query = query.where(ImageRecord.board_id == board_id)

        query = query.offset(offset).limit(limit)

        records = self._db.execute(query).scalars().all()
        return [ImageDTO.from_record(r) for r in records]
```

**API 라우터 수정:**

```python
# invokeai/app/api/routers/images.py
@router.get("/")
async def list_images(
    user: TokenData = Depends(get_current_user),  # ✅ 인증
    board_id: Optional[str] = None,
    offset: int = 0,
    limit: int = 20,
    images: ImageService = Depends(ApiDependencies.images),
) -> ImageListResponse:
    """이미지 목록 조회 (사용자별로 필터링됨)"""

    # ✅ user.user_id 자동 전달
    image_list = images.list_images(
        user_id=user.user_id,
        board_id=board_id,
        offset=offset,
        limit=limit,
    )

    return ImageListResponse(items=image_list, total=len(image_list))
```

### 3.4 테스트

**단위 테스트:**

```python
# tests/test_auth.py
import pytest
from fastapi.testclient import TestClient


def test_unauthenticated_request_fails(client: TestClient):
    """인증 없이 요청 시 401 반환"""
    response = client.get("/api/v1/images/")
    assert response.status_code == 401


def test_authenticated_request_succeeds(client: TestClient, auth_headers):
    """인증된 요청 성공"""
    response = client.get("/api/v1/images/", headers=auth_headers)
    assert response.status_code == 200


def test_user_cannot_access_other_users_images(
    client: TestClient,
    user1_headers,
    user2_headers,
):
    """사용자 A는 사용자 B의 이미지를 볼 수 없음"""

    # 사용자 1이 이미지 생성
    response = client.post(
        "/api/v1/images/upload",
        headers=user1_headers,
        files={"file": ("test.png", b"fake image data")},
    )
    image_name = response.json()["image_name"]

    # 사용자 2가 해당 이미지 조회 시도 (실패해야 함)
    response = client.get(
        f"/api/v1/images/{image_name}",
        headers=user2_headers,
    )
    assert response.status_code == 404  # 또는 403
```

---

이어서 Phase 2 AWS 인프라 설계를 작성하겠습니다. 계속할까요?
