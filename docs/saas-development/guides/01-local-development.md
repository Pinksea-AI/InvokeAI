# 로컬 개발 환경 설정 가이드

## 개요

이 문서는 Pingvas Studio 개발을 위한 로컬 환경 설정 방법을 설명합니다. MacBook Pro M2 Max 96GB 환경을 기준으로 작성되었습니다.

---

## 필수 도구 설치

### 1. Homebrew (macOS)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. 개발 도구 설치

```bash
# Git
brew install git

# Python 3.12
brew install python@3.12

# Node.js 22 LTS
brew install node@22

# pnpm (패키지 매니저)
brew install pnpm

# Docker Desktop
brew install --cask docker

# VS Code
brew install --cask visual-studio-code

# AWS CLI
brew install awscli

# Terraform
brew install terraform

# kubectl
brew install kubectl

# Helm
brew install helm
```

### 3. VS Code 확장

```bash
# Python 확장
code --install-extension ms-python.python
code --install-extension ms-python.vscode-pylance
code --install-extension charliermarsh.ruff

# JavaScript/TypeScript 확장
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode

# Docker 확장
code --install-extension ms-azuretools.vscode-docker

# Kubernetes 확장
code --install-extension ms-kubernetes-tools.vscode-kubernetes-tools

# 기타 유용한 확장
code --install-extension eamodio.gitlens
code --install-extension bradlc.vscode-tailwindcss
```

---

## 프로젝트 클론 및 설정

### 1. 레포지토리 클론

```bash
# 프로젝트 디렉토리 생성
mkdir -p ~/Projects/pingvas
cd ~/Projects/pingvas

# 메인 레포 클론
git clone https://github.com/pingvas/pingvas-studio.git
git clone https://github.com/pingvas/pingvas-gitops.git

cd pingvas-studio
```

### 2. Python 가상환경 설정

```bash
# 가상환경 생성
python3.12 -m venv .venv

# 활성화
source .venv/bin/activate

# pip 업그레이드
pip install --upgrade pip

# 의존성 설치
pip install -r requirements.txt
pip install -r requirements-dev.txt
```

### 3. 프론트엔드 설정

```bash
cd frontend/web

# 의존성 설치
pnpm install

# 환경 변수 설정
cp .env.example .env.local
```

`.env.local` 파일:
```env
VITE_API_URL=http://localhost:8000
VITE_WS_URL=ws://localhost:8000
VITE_ENVIRONMENT=development
```

---

## Docker Compose 로컬 환경

### Docker Compose 파일

```yaml
# docker-compose.yml
version: '3.8'

services:
  # PostgreSQL
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
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pingvas"]
      interval: 5s
      timeout: 5s
      retries: 5

  # Redis
  redis:
    image: redis:7-alpine
    container_name: pingvas-redis
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  # MinIO (S3 대체)
  minio:
    image: minio/minio:latest
    container_name: pingvas-minio
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin123
    ports:
      - "9000:9000"
      - "9001:9001"
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 5s
      timeout: 5s
      retries: 5

  # Mailhog (이메일 테스트)
  mailhog:
    image: mailhog/mailhog
    container_name: pingvas-mailhog
    ports:
      - "1025:1025"  # SMTP
      - "8025:8025"  # Web UI

volumes:
  postgres_data:
  redis_data:
  minio_data:
```

### 서비스 시작

```bash
# 모든 서비스 시작
docker-compose up -d

# 로그 확인
docker-compose logs -f

# 상태 확인
docker-compose ps

# 서비스 중지
docker-compose down

# 볼륨까지 삭제 (데이터 초기화)
docker-compose down -v
```

---

## 데이터베이스 마이그레이션

### Alembic 설정

```bash
# 마이그레이션 디렉토리 초기화 (최초 1회)
cd services/user-service
alembic init alembic

# alembic.ini 설정
# sqlalchemy.url 수정
```

### 마이그레이션 실행

```bash
# 새 마이그레이션 생성
alembic revision --autogenerate -m "Initial migration"

# 마이그레이션 적용
alembic upgrade head

# 마이그레이션 롤백
alembic downgrade -1

# 현재 버전 확인
alembic current

# 히스토리 확인
alembic history
```

---

## 백엔드 서비스 실행

### 개별 서비스 실행

```bash
# User Service
cd services/user-service
uvicorn app.main:app --reload --port 8001

# Generation Service
cd services/generation-service
uvicorn app.main:app --reload --port 8002

# Payment Service
cd services/payment-service
uvicorn app.main:app --reload --port 8003

# Gallery Service
cd services/gallery-service
uvicorn app.main:app --reload --port 8004
```

### 환경 변수 설정

```bash
# .env 파일 (각 서비스)
DATABASE_URL=postgresql://pingvas:pingvas_dev_password@localhost:5432/pingvas_dev
REDIS_URL=redis://localhost:6379/0
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin123
S3_BUCKET=pingvas-images
JWT_SECRET=your-dev-secret-key-change-in-production
LEMON_SQUEEZY_API_KEY=test_xxx
LEMON_SQUEEZY_WEBHOOK_SECRET=test_webhook_secret
```

### API Gateway (Nginx 프록시)

```nginx
# nginx.conf (로컬 개발용)
upstream user_service {
    server localhost:8001;
}

upstream generation_service {
    server localhost:8002;
}

upstream payment_service {
    server localhost:8003;
}

upstream gallery_service {
    server localhost:8004;
}

server {
    listen 8000;

    location /api/auth/ {
        proxy_pass http://user_service/;
    }

    location /api/users/ {
        proxy_pass http://user_service/;
    }

    location /api/generate/ {
        proxy_pass http://generation_service/;
    }

    location /api/queue/ {
        proxy_pass http://generation_service/;
    }

    location /api/payments/ {
        proxy_pass http://payment_service/;
    }

    location /api/subscriptions/ {
        proxy_pass http://payment_service/;
    }

    location /api/gallery/ {
        proxy_pass http://gallery_service/;
    }

    location /ws {
        proxy_pass http://generation_service;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## 프론트엔드 개발

### 개발 서버 실행

```bash
cd frontend/web

# 개발 서버
pnpm dev

# Storybook
pnpm storybook

# 타입 체크
pnpm typecheck

# 린트
pnpm lint

# 테스트
pnpm test

# 빌드
pnpm build
```

### 프록시 설정 (Vite)

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
});
```

---

## AI Worker 로컬 실행 (GPU)

### M2 Max MPS 사용

```bash
cd services/ai-worker

# MPS (Metal Performance Shaders) 활성화
export PYTORCH_ENABLE_MPS_FALLBACK=1

# 실행
python -m app.main
```

### 환경 변수

```bash
# .env
DEVICE=mps  # macOS Metal
# DEVICE=cuda  # NVIDIA GPU
# DEVICE=cpu  # CPU fallback

MODEL_CACHE_DIR=~/.cache/pingvas/models
REDIS_URL=redis://localhost:6379/1
```

---

## 테스트

### 백엔드 테스트

```bash
# 전체 테스트
pytest

# 커버리지 포함
pytest --cov=app --cov-report=html

# 특정 테스트만
pytest tests/test_users.py -v

# 특정 함수만
pytest tests/test_users.py::test_create_user -v

# 마커로 필터
pytest -m "not slow"
```

### 프론트엔드 테스트

```bash
cd frontend/web

# Vitest 실행
pnpm test

# Watch 모드
pnpm test:watch

# 커버리지
pnpm test:coverage

# E2E 테스트 (Playwright)
pnpm test:e2e
```

---

## 디버깅

### VS Code 디버그 설정

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python: FastAPI",
      "type": "python",
      "request": "launch",
      "module": "uvicorn",
      "args": ["app.main:app", "--reload", "--port", "8001"],
      "jinja": true,
      "cwd": "${workspaceFolder}/services/user-service"
    },
    {
      "name": "Debug Frontend",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:3000",
      "webRoot": "${workspaceFolder}/frontend/web/src"
    }
  ]
}
```

### 로그 설정

```python
# app/core/logging.py
import logging
import sys

def setup_logging():
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(sys.stdout)
        ]
    )

    # SQL 쿼리 로깅
    logging.getLogger('sqlalchemy.engine').setLevel(logging.INFO)
```

---

## Git 워크플로우

### 브랜치 전략

```bash
# 기능 브랜치 생성
git checkout -b feature/user-authentication

# 작업 후 커밋
git add .
git commit -m "feat: implement user authentication"

# 원격 푸시
git push -u origin feature/user-authentication

# PR 생성 후 머지

# develop 브랜치 업데이트
git checkout develop
git pull origin develop
```

### 커밋 메시지 컨벤션

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: 새 기능
- `fix`: 버그 수정
- `docs`: 문서
- `style`: 포맷팅
- `refactor`: 리팩토링
- `test`: 테스트
- `chore`: 기타

**예시:**
```
feat(auth): add Google OAuth login

- Add Google OAuth provider configuration
- Implement callback handler
- Add user profile sync from Google

Closes #123
```

---

## 유용한 스크립트

### Makefile

```makefile
# Makefile

.PHONY: setup dev test clean

# 초기 설정
setup:
	python -m venv .venv
	. .venv/bin/activate && pip install -r requirements.txt
	cd frontend/web && pnpm install

# 개발 환경 시작
dev:
	docker-compose up -d
	@echo "Waiting for services..."
	@sleep 5
	@echo "Starting backend..."
	cd services/user-service && uvicorn app.main:app --reload --port 8001 &
	cd frontend/web && pnpm dev

# 테스트 실행
test:
	pytest
	cd frontend/web && pnpm test

# 린트
lint:
	ruff check .
	cd frontend/web && pnpm lint

# 포맷팅
format:
	ruff format .
	cd frontend/web && pnpm format

# 정리
clean:
	docker-compose down -v
	rm -rf .venv
	rm -rf frontend/web/node_modules
	find . -type d -name __pycache__ -exec rm -rf {} +
```

---

## 트러블슈팅

### 일반적인 문제

**포트 충돌**
```bash
# 사용 중인 포트 확인
lsof -i :8000

# 프로세스 종료
kill -9 <PID>
```

**Docker 용량 부족**
```bash
# 사용하지 않는 이미지/컨테이너 정리
docker system prune -a
```

**Node 모듈 문제**
```bash
# node_modules 재설치
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

**Python 패키지 충돌**
```bash
# 가상환경 재생성
rm -rf .venv
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## 다음 단계

- [핸즈온 튜토리얼](./03-hands-on-tutorial.md)에서 실습 진행
- [API 명세](../api/01-api-specification.md)에서 API 확인
- [Storybook 가이드](../frontend/01-storybook-guide.md)에서 UI 개발 확인
