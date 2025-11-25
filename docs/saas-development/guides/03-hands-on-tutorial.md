# 신입개발자용 종합 핸즈온 가이드

## 개요

이 가이드는 Pingvas Studio 프로젝트에 신규로 합류한 개발자가 처음부터 끝까지 따라할 수 있는 단계별 튜토리얼입니다.

**대상**: 프로젝트에 새로 합류한 개발자
**소요 시간**: 약 4-6시간
**개발 환경**: MacBook Pro M2 Max 96GB

---

## 1단계: 개발 환경 설정

### 1.1 Homebrew 설치

```bash
# Homebrew 설치 (없는 경우)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# PATH 설정 (zsh 사용 시)
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zshrc
source ~/.zshrc
```

### 1.2 필수 도구 설치

```bash
# Git (최신 버전)
brew install git
git config --global user.name "Your Name"
git config --global user.email "your.email@company.com"

# Python 3.12
brew install python@3.12

# Node.js 22 LTS
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc

# pnpm (패키지 관리자)
npm install -g pnpm

# Docker Desktop
brew install --cask docker

# 추가 도구
brew install kubectl helm terraform awscli jq
```

### 1.3 버전 확인

```bash
# 모든 도구 버전 확인
echo "Git: $(git --version)"
echo "Python: $(python3.12 --version)"
echo "Node: $(node --version)"
echo "pnpm: $(pnpm --version)"
echo "Docker: $(docker --version)"
echo "kubectl: $(kubectl version --client --short)"
echo "Terraform: $(terraform version)"
echo "AWS CLI: $(aws --version)"
```

**예상 출력**:
```
Git: git version 2.43.0
Python: Python 3.12.x
Node: v22.x.x
pnpm: 10.x.x
Docker: Docker version 25.x.x
kubectl: Client Version: v1.29.x
Terraform: Terraform v1.6.x
AWS CLI: aws-cli/2.x.x
```

---

## 2단계: 프로젝트 클론 및 설정

### 2.1 저장소 클론

```bash
# 작업 디렉토리 생성
mkdir -p ~/projects
cd ~/projects

# 저장소 클론
git clone https://github.com/Pinksea-AI/InvokeAI.git pingvas-studio
cd pingvas-studio

# 개발 브랜치 확인
git branch -a
git checkout develop
```

### 2.2 Python 가상환경 설정

```bash
# uv 설치 (현대적 Python 패키지 관리자)
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.zshrc

# 가상환경 생성
uv venv --python 3.12 .venv

# 가상환경 활성화
source .venv/bin/activate

# 개발 의존성 설치
uv pip install -e ".[dev,test]"
```

### 2.3 프론트엔드 설정

```bash
# 프론트엔드 디렉토리로 이동
cd invokeai/frontend/web

# 의존성 설치
pnpm install

# 개발 서버 실행 테스트
pnpm dev
# Ctrl+C로 종료
```

### 2.4 환경 변수 설정

```bash
# 프로젝트 루트로 이동
cd ~/projects/pingvas-studio

# 환경 변수 파일 생성
cat > .env.local << 'EOF'
# 데이터베이스
DATABASE_URL=postgresql://localhost:5432/pingvas_dev

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-development-jwt-secret-key

# Lemon Squeezy (개발용)
LEMON_SQUEEZY_API_KEY=your-dev-api-key
LEMON_SQUEEZY_WEBHOOK_SECRET=your-dev-webhook-secret

# S3 (로컬 MinIO 또는 AWS)
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET=pingvas-dev-images
S3_ENDPOINT=http://localhost:9000

# 환경
ENVIRONMENT=development
DEBUG=true
EOF
```

---

## 3단계: 로컬 개발 인프라 설정

### 3.1 Docker Compose로 로컬 서비스 실행

```bash
# docker-compose.local.yml 생성
cat > docker-compose.local.yml << 'EOF'
version: '3.8'

services:
  postgres:
    image: postgres:17
    container_name: pingvas-postgres
    environment:
      POSTGRES_USER: pingvas
      POSTGRES_PASSWORD: pingvas_dev_password
      POSTGRES_DB: pingvas_dev
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pingvas"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: pingvas-redis
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio
    container_name: pingvas-minio
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data
    command: server /data --console-address ":9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
  minio_data:
EOF

# 서비스 시작
docker-compose -f docker-compose.local.yml up -d

# 상태 확인
docker-compose -f docker-compose.local.yml ps
```

**예상 출력**:
```
NAME              COMMAND                  SERVICE    STATUS     PORTS
pingvas-minio     "/usr/bin/docker-ent…"  minio      running    0.0.0.0:9000->9000/tcp, 0.0.0.0:9001->9001/tcp
pingvas-postgres  "docker-entrypoint.s…"  postgres   running    0.0.0.0:5432->5432/tcp
pingvas-redis     "docker-entrypoint.s…"  redis      running    0.0.0.0:6379->6379/tcp
```

### 3.2 데이터베이스 초기화

```bash
# 가상환경 활성화 확인
source .venv/bin/activate

# 환경 변수 로드
export $(cat .env.local | xargs)

# 데이터베이스 마이그레이션 실행
# (마이그레이션 스크립트가 있다고 가정)
alembic upgrade head
```

### 3.3 MinIO 버킷 생성

```bash
# MinIO CLI 설치
brew install minio/stable/mc

# MinIO 서버 등록
mc alias set local http://localhost:9000 minioadmin minioadmin

# 버킷 생성
mc mb local/pingvas-dev-images
mc mb local/pingvas-dev-assets

# 버킷 목록 확인
mc ls local
```

---

## 4단계: 백엔드 개발 시작

### 4.1 백엔드 서비스 구조 이해

```
services/
├── user-service/           # 사용자 인증
│   ├── app/
│   │   ├── api/            # API 라우터
│   │   ├── models/         # SQLAlchemy 모델
│   │   ├── schemas/        # Pydantic 스키마
│   │   ├── services/       # 비즈니스 로직
│   │   └── main.py         # FastAPI 앱
│   ├── tests/
│   └── pyproject.toml
├── generation-service/     # 이미지 생성
├── payment-service/        # 결제 처리
├── gallery-service/        # 갤러리 관리
└── ai-worker/              # GPU 워커
```

### 4.2 User Service 로컬 실행

```bash
# User Service 디렉토리로 이동
cd services/user-service

# 의존성 설치
uv pip install -e ".[dev]"

# 개발 서버 실행
uvicorn app.main:app --reload --port 8001

# 다른 터미널에서 API 테스트
curl http://localhost:8001/health
curl http://localhost:8001/docs  # Swagger UI
```

### 4.3 간단한 API 엔드포인트 추가 실습

```python
# services/user-service/app/api/routes/example.py

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import get_db

router = APIRouter(prefix="/example", tags=["example"])

@router.get("/hello")
async def hello_world():
    """간단한 헬로 월드 엔드포인트"""
    return {"message": "Hello, Pingvas Studio!"}

@router.get("/db-check")
async def check_database(db: Session = Depends(get_db)):
    """데이터베이스 연결 확인"""
    try:
        db.execute("SELECT 1")
        return {"status": "connected"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
```

```python
# services/user-service/app/main.py에 라우터 등록
from app.api.routes.example import router as example_router
app.include_router(example_router)
```

### 4.4 테스트 작성

```python
# services/user-service/tests/test_example.py

import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_hello_world():
    response = client.get("/example/hello")
    assert response.status_code == 200
    assert response.json()["message"] == "Hello, Pingvas Studio!"

def test_db_check():
    response = client.get("/example/db-check")
    assert response.status_code == 200
    assert response.json()["status"] == "connected"
```

```bash
# 테스트 실행
pytest tests/ -v
```

---

## 5단계: 프론트엔드 개발 시작

### 5.1 프론트엔드 구조 이해

```
invokeai/frontend/web/
├── src/
│   ├── app/                # 앱 레이아웃, 스토어
│   ├── features/           # 기능별 모듈
│   │   ├── auth/           # 인증 (신규)
│   │   ├── subscription/   # 구독 (신규)
│   │   ├── gallery/        # 갤러리
│   │   ├── parameters/     # 생성 파라미터
│   │   └── ...
│   ├── services/
│   │   ├── api/            # RTK Query
│   │   └── events/         # Socket.IO
│   └── common/             # 공유 컴포넌트
├── package.json
└── vite.config.ts
```

### 5.2 개발 서버 실행

```bash
cd invokeai/frontend/web

# 개발 서버 실행
pnpm dev

# 브라우저에서 http://localhost:5173 접속
```

### 5.3 새 컴포넌트 추가 실습

```typescript
// src/features/auth/components/LoginButton.tsx

import { Button } from '@invoke-ai/ui-library';
import { useCallback } from 'react';

interface LoginButtonProps {
  onLogin: () => void;
}

export const LoginButton = ({ onLogin }: LoginButtonProps) => {
  const handleClick = useCallback(() => {
    onLogin();
  }, [onLogin]);

  return (
    <Button
      colorScheme="invokeBlue"
      onClick={handleClick}
      size="md"
    >
      로그인
    </Button>
  );
};
```

### 5.4 Redux Slice 추가 실습

```typescript
// src/features/auth/store/authSlice.ts

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface User {
  id: string;
  email: string;
  name: string;
  tier: 'free' | 'starter' | 'pro' | 'studio' | 'enterprise';
  credits: number;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

const initialState: AuthState = {
  user: null,
  isAuthenticated: false,
  isLoading: false,
};

export const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setUser: (state, action: PayloadAction<User>) => {
      state.user = action.payload;
      state.isAuthenticated = true;
    },
    clearUser: (state) => {
      state.user = null;
      state.isAuthenticated = false;
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
  },
});

export const { setUser, clearUser, setLoading } = authSlice.actions;
export default authSlice.reducer;
```

### 5.5 Storybook으로 컴포넌트 확인

```bash
# Storybook 실행
pnpm storybook

# 브라우저에서 http://localhost:6006 접속
```

```typescript
// src/features/auth/components/LoginButton.stories.tsx

import type { Meta, StoryObj } from '@storybook/react';
import { LoginButton } from './LoginButton';

const meta: Meta<typeof LoginButton> = {
  title: 'Features/Auth/LoginButton',
  component: LoginButton,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof LoginButton>;

export const Default: Story = {
  args: {
    onLogin: () => console.log('Login clicked'),
  },
};
```

---

## 6단계: Git 워크플로우

### 6.1 브랜치 전략

```
main              # 프로덕션
  └── develop     # 개발 통합
       ├── feature/auth-login       # 기능 브랜치
       ├── feature/payment-webhook  # 기능 브랜치
       └── bugfix/credit-calc       # 버그 수정
```

### 6.2 새 기능 개발 시작

```bash
# develop 브랜치에서 시작
git checkout develop
git pull origin develop

# 기능 브랜치 생성
git checkout -b feature/auth-login

# 작업 수행...
# 커밋
git add .
git commit -m "feat(auth): implement login functionality

- Add LoginButton component
- Add authSlice for state management
- Add login API endpoint"

# 원격 저장소에 푸시
git push -u origin feature/auth-login
```

### 6.3 커밋 메시지 컨벤션

```
<type>(<scope>): <subject>

<body>

<footer>

Types:
- feat: 새 기능
- fix: 버그 수정
- docs: 문서 변경
- style: 코드 스타일 (포맷팅)
- refactor: 리팩토링
- test: 테스트 추가/수정
- chore: 빌드 프로세스, 도구 변경

Examples:
feat(auth): add Google OAuth login
fix(credits): correct credit calculation formula
docs(api): update API documentation
refactor(gallery): optimize image loading
```

### 6.4 Pull Request 생성

1. GitHub에서 PR 생성
2. PR 템플릿 작성:

```markdown
## 변경 사항
- 로그인 기능 구현
- Google OAuth 연동

## 테스트
- [ ] 단위 테스트 통과
- [ ] 로컬 환경에서 수동 테스트 완료

## 스크린샷
(해당되는 경우)

## 체크리스트
- [ ] 코드 리뷰 요청
- [ ] 문서 업데이트 (필요시)
```

---

## 7단계: 테스트 작성

### 7.1 백엔드 테스트

```python
# services/user-service/tests/test_auth.py

import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

class TestAuth:
    def test_register_success(self):
        """회원가입 성공 테스트"""
        response = client.post("/api/v1/auth/register", json={
            "email": "test@example.com",
            "password": "SecurePass123!",
            "name": "Test User"
        })
        assert response.status_code == 201
        assert "id" in response.json()["data"]

    def test_register_duplicate_email(self):
        """중복 이메일 회원가입 실패 테스트"""
        # 먼저 사용자 생성
        client.post("/api/v1/auth/register", json={
            "email": "duplicate@example.com",
            "password": "SecurePass123!",
            "name": "First User"
        })

        # 같은 이메일로 다시 시도
        response = client.post("/api/v1/auth/register", json={
            "email": "duplicate@example.com",
            "password": "AnotherPass123!",
            "name": "Second User"
        })
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "EMAIL_EXISTS"

    def test_login_success(self):
        """로그인 성공 테스트"""
        response = client.post("/api/v1/auth/login", json={
            "email": "test@example.com",
            "password": "SecurePass123!"
        })
        assert response.status_code == 200
        assert "access_token" in response.json()["data"]
```

### 7.2 프론트엔드 테스트

```typescript
// src/features/auth/components/LoginButton.test.tsx

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LoginButton } from './LoginButton';

describe('LoginButton', () => {
  it('renders login button', () => {
    render(<LoginButton onLogin={() => {}} />);
    expect(screen.getByText('로그인')).toBeInTheDocument();
  });

  it('calls onLogin when clicked', () => {
    const onLogin = vi.fn();
    render(<LoginButton onLogin={onLogin} />);

    fireEvent.click(screen.getByText('로그인'));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });
});
```

```bash
# 프론트엔드 테스트 실행
cd invokeai/frontend/web
pnpm test
```

---

## 8단계: AWS 연결 및 배포 준비

### 8.1 AWS CLI 설정

```bash
# AWS 프로필 설정
aws configure --profile pingvas-dev

# 입력:
# AWS Access Key ID: (발급받은 키)
# AWS Secret Access Key: (발급받은 시크릿)
# Default region: ap-northeast-2
# Default output format: json

# 설정 확인
aws sts get-caller-identity --profile pingvas-dev
```

### 8.2 EKS 클러스터 연결

```bash
# kubeconfig 업데이트
aws eks update-kubeconfig \
  --region ap-northeast-2 \
  --name pingvas-dev-cluster \
  --profile pingvas-dev

# 연결 확인
kubectl get nodes
kubectl get namespaces
```

### 8.3 개발 환경 네임스페이스 확인

```bash
# 네임스페이스 목록
kubectl get ns

# pingvas-dev 네임스페이스의 리소스 확인
kubectl get all -n pingvas-dev

# 파드 로그 확인
kubectl logs -f deployment/user-service -n pingvas-dev
```

---

## 9단계: 자주 사용하는 명령어 모음

### 로컬 개발

```bash
# 가상환경 활성화
source .venv/bin/activate

# 로컬 인프라 시작
docker-compose -f docker-compose.local.yml up -d

# 로컬 인프라 중지
docker-compose -f docker-compose.local.yml down

# 백엔드 서버 실행
uvicorn app.main:app --reload --port 8001

# 프론트엔드 서버 실행
cd invokeai/frontend/web && pnpm dev

# 테스트 실행
pytest tests/ -v                    # 백엔드
pnpm test                           # 프론트엔드

# 린트 검사
ruff check .                        # 백엔드
pnpm lint                           # 프론트엔드
```

### Git

```bash
# 상태 확인
git status

# 변경사항 스테이징
git add .

# 커밋
git commit -m "feat(scope): message"

# 푸시
git push origin feature/branch-name

# 원격 변경사항 가져오기
git fetch origin
git pull origin develop
```

### Kubernetes

```bash
# 파드 목록
kubectl get pods -n pingvas-dev

# 파드 로그
kubectl logs -f pod/user-service-xxx -n pingvas-dev

# 파드 쉘 접속
kubectl exec -it pod/user-service-xxx -n pingvas-dev -- /bin/sh

# 서비스 포트포워딩
kubectl port-forward svc/user-service 8001:8000 -n pingvas-dev

# 리소스 재시작
kubectl rollout restart deployment/user-service -n pingvas-dev
```

---

## 10단계: 문제 해결 가이드

### 자주 발생하는 문제

#### 1. Docker 컨테이너 시작 실패

```bash
# 로그 확인
docker logs pingvas-postgres

# 볼륨 삭제 후 재시작
docker-compose -f docker-compose.local.yml down -v
docker-compose -f docker-compose.local.yml up -d
```

#### 2. Python 패키지 설치 오류

```bash
# 가상환경 재생성
rm -rf .venv
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip install -e ".[dev,test]"
```

#### 3. Node.js 의존성 오류

```bash
# node_modules 삭제 후 재설치
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

#### 4. kubectl 연결 오류

```bash
# kubeconfig 재설정
aws eks update-kubeconfig \
  --region ap-northeast-2 \
  --name pingvas-dev-cluster \
  --profile pingvas-dev

# 컨텍스트 확인
kubectl config get-contexts
kubectl config use-context arn:aws:eks:ap-northeast-2:...
```

---

## 체크리스트

개발 환경 설정 완료 확인:

- [ ] Homebrew 설치됨
- [ ] Git 설정됨
- [ ] Python 3.12 설치됨
- [ ] Node.js 22 설치됨
- [ ] pnpm 설치됨
- [ ] Docker Desktop 실행됨
- [ ] 프로젝트 클론됨
- [ ] Python 가상환경 설정됨
- [ ] 프론트엔드 의존성 설치됨
- [ ] 로컬 Docker 서비스 실행됨
- [ ] 데이터베이스 초기화됨
- [ ] 백엔드 서버 실행 확인됨
- [ ] 프론트엔드 서버 실행 확인됨
- [ ] 테스트 통과됨
- [ ] AWS CLI 설정됨
- [ ] EKS 클러스터 연결됨

---

## 다음 단계

1. [마이크로서비스 설계](../architecture/02-microservices.md)를 상세히 학습합니다.
2. [API 명세서](../api/01-api-specification.md)를 참고하여 API를 개발합니다.
3. [결제 연동 가이드](./02-payment-integration.md)를 따라 Lemon Squeezy를 연동합니다.
4. [Storybook 가이드](../frontend/01-storybook-guide.md)를 따라 UI 컴포넌트를 개발합니다.

---

## 도움말

질문이나 문제가 있으면:
1. 먼저 이 가이드의 "문제 해결" 섹션을 확인합니다.
2. 프로젝트 Wiki를 검색합니다.
3. 팀 Slack/Discord 채널에 질문합니다.
4. GitHub Issue를 생성합니다.
