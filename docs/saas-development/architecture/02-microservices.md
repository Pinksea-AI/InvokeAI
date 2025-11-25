# 마이크로서비스 아키텍처 설계

## 개요

Pingvas Studio는 단일 InvokeAI 애플리케이션을 다음 마이크로서비스로 분리합니다:
- **User Service**: 사용자 인증 및 프로필 관리
- **Generation Service**: 이미지 생성 요청 처리 및 큐 관리
- **Payment Service**: 결제 및 구독 관리
- **Gallery Service**: 이미지 및 메타데이터 관리
- **AI Worker**: 실제 이미지 생성 (GPU)

---

## 서비스 통신 패턴

```mermaid
flowchart LR
    subgraph Client["클라이언트"]
        WebApp["React SPA"]
    end

    subgraph Gateway["API Gateway"]
        Nginx["Nginx Ingress"]
    end

    subgraph Services["마이크로서비스"]
        User["User Service"]
        Gen["Generation Service"]
        Pay["Payment Service"]
        Gallery["Gallery Service"]
    end

    subgraph Workers["AI Workers"]
        W1["AI Worker 1"]
        W2["AI Worker 2"]
    end

    subgraph Data["데이터 계층"]
        PG["PostgreSQL"]
        Redis["Redis"]
        S3["S3"]
        EFS["EFS"]
    end

    WebApp <-->|HTTP/WebSocket| Nginx
    Nginx --> User
    Nginx --> Gen
    Nginx --> Pay
    Nginx --> Gallery

    User --> PG
    User --> Redis
    Gen --> Redis
    Gen --> PG
    Pay --> PG
    Gallery --> PG
    Gallery --> S3

    Redis -->|Job Queue| W1
    Redis -->|Job Queue| W2
    W1 --> EFS
    W2 --> EFS
    W1 --> S3
    W2 --> S3
    W1 -->|Progress Events| Redis
    W2 -->|Progress Events| Redis
```

---

## 1. User Service (사용자 서비스)

### 역할
- 회원가입/로그인 (이메일, Google OAuth, Discord OAuth)
- JWT 토큰 발급 및 검증
- 사용자 프로필 관리
- 구독 상태 조회 (Payment Service 연동)

### 기술 스택
- FastAPI
- SQLAlchemy (PostgreSQL)
- Passlib (비밀번호 해싱)
- python-jose (JWT)
- Authlib (OAuth)

### API 엔드포인트

```yaml
# 인증
POST   /api/v1/auth/register          # 회원가입
POST   /api/v1/auth/login             # 로그인
POST   /api/v1/auth/logout            # 로그아웃
POST   /api/v1/auth/refresh           # 토큰 갱신
POST   /api/v1/auth/forgot-password   # 비밀번호 재설정 요청
POST   /api/v1/auth/reset-password    # 비밀번호 재설정

# OAuth
GET    /api/v1/auth/google            # Google OAuth 시작
GET    /api/v1/auth/google/callback   # Google OAuth 콜백
GET    /api/v1/auth/discord           # Discord OAuth 시작
GET    /api/v1/auth/discord/callback  # Discord OAuth 콜백

# 사용자
GET    /api/v1/users/me               # 현재 사용자 정보
PATCH  /api/v1/users/me               # 프로필 수정
DELETE /api/v1/users/me               # 계정 삭제
GET    /api/v1/users/me/subscription  # 구독 상태 조회
GET    /api/v1/users/me/credits       # 크레딧 잔액 조회
GET    /api/v1/users/me/usage         # 사용량 통계
```

### Kubernetes 배포

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
  namespace: pingvas-prod
spec:
  replicas: 2
  selector:
    matchLabels:
      app: user-service
  template:
    metadata:
      labels:
        app: user-service
    spec:
      containers:
      - name: user-service
        image: pingvas/user-service:latest
        ports:
        - containerPort: 8000
        resources:
          requests:
            cpu: "250m"
            memory: "256Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
        envFrom:
        - secretRef:
            name: user-service-secrets
        - configMapRef:
            name: user-service-config
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /ready
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 10
```

---

## 2. Generation Service (생성 서비스)

### 역할
- 이미지 생성 요청 수신 및 검증
- 티어별 기능 제한 적용
- Redis 작업 큐에 작업 등록
- 크레딧 사전 검증 및 차감
- WebSocket을 통한 진행률 전송

### 기술 스택
- FastAPI
- python-socketio
- Redis (큐 및 Pub/Sub)
- SQLAlchemy (메타데이터)

### API 엔드포인트

```yaml
# 생성 요청
POST   /api/v1/generate/text-to-image    # 텍스트→이미지 생성
POST   /api/v1/generate/image-to-image   # 이미지→이미지 변환
POST   /api/v1/generate/upscale          # 업스케일
POST   /api/v1/generate/inpaint          # 인페인팅
POST   /api/v1/generate/workflow         # 워크플로우 실행

# 큐 관리
GET    /api/v1/queue/status              # 큐 상태 조회
GET    /api/v1/queue/items               # 큐 아이템 목록
DELETE /api/v1/queue/items/{item_id}     # 작업 취소
POST   /api/v1/queue/clear               # 큐 초기화

# 모델 정보
GET    /api/v1/models                    # 사용 가능 모델 목록
GET    /api/v1/models/{model_id}         # 모델 상세 정보

# WebSocket
WS     /ws/queue/{queue_id}              # 진행률 실시간 구독
```

### 큐 우선순위 시스템

```python
# Redis 큐 구조
QUEUE_PRIORITIES = {
    "enterprise": "queue:enterprise",  # 최고 우선순위
    "studio": "queue:studio",          # 높음
    "pro": "queue:pro",                # 중간
    "starter": "queue:starter",        # 낮음
}

# Celery Worker 설정
app.conf.task_routes = {
    'tasks.generate_image': {
        'queue': 'default',
        'routing_key': 'generation.#',
    }
}

# Worker가 큐를 확인하는 순서
# 1. enterprise → 2. studio → 3. pro → 4. starter
```

### 크레딧 차감 로직

```python
async def process_generation_request(request: GenerationRequest, user: User):
    # 1. 사전 검증
    estimated_credits = estimate_credits(request)
    if user.credits < estimated_credits:
        raise InsufficientCreditsError()

    # 2. 크레딧 예약 (차감은 아직 안 함)
    reservation = await reserve_credits(user.id, estimated_credits)

    # 3. 작업 큐에 등록
    job = await enqueue_job(request, user, reservation.id)

    # 4. 작업 완료 후 실제 사용량으로 정산
    # (AI Worker에서 처리)

    return {"job_id": job.id, "estimated_credits": estimated_credits}
```

### WebSocket 이벤트

```typescript
// 클라이언트 구독
socket.emit('subscribe_queue', { queue_id: 'user_123' });

// 서버 → 클라이언트 이벤트
interface ProgressEvent {
  job_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;        // 0-100
  current_step: number;
  total_steps: number;
  preview_image?: string;  // Base64 썸네일
  estimated_time?: number; // 예상 남은 시간 (초)
}

interface CompletionEvent {
  job_id: string;
  status: 'completed';
  result: {
    image_id: string;
    image_url: string;
    metadata: object;
  };
  credits_used: number;
}

interface ErrorEvent {
  job_id: string;
  status: 'failed';
  error_code: string;
  error_message: string;
  credits_refunded: number;
}
```

---

## 3. Payment Service (결제 서비스)

### 역할
- Lemon Squeezy 웹훅 처리
- 구독 상태 관리
- 크레딧 충전/차감
- 결제 내역 관리
- 업그레이드/다운그레이드 처리

### 기술 스택
- FastAPI
- SQLAlchemy (PostgreSQL)
- Celery Beat (스케줄러)

### API 엔드포인트

```yaml
# 웹훅 (Lemon Squeezy → Pingvas)
POST   /api/v1/webhooks/lemon-squeezy    # 웹훅 수신

# 구독 관리
GET    /api/v1/subscriptions/plans       # 플랜 목록
GET    /api/v1/subscriptions/current     # 현재 구독 조회
POST   /api/v1/subscriptions/checkout    # 체크아웃 URL 생성
POST   /api/v1/subscriptions/cancel      # 구독 취소
POST   /api/v1/subscriptions/upgrade     # 업그레이드

# 크레딧
GET    /api/v1/credits/balance           # 잔액 조회
GET    /api/v1/credits/history           # 사용 내역
POST   /api/v1/credits/purchase          # 추가 크레딧 구매

# Enterprise
POST   /api/v1/enterprise/request        # Enterprise 문의
POST   /api/v1/enterprise/activate       # Enterprise 활성화 (관리자)
```

### Lemon Squeezy 웹훅 처리

```python
# 웹훅 이벤트 타입
WEBHOOK_EVENTS = {
    "subscription_created": handle_subscription_created,
    "subscription_updated": handle_subscription_updated,
    "subscription_cancelled": handle_subscription_cancelled,
    "subscription_resumed": handle_subscription_resumed,
    "subscription_expired": handle_subscription_expired,
    "subscription_payment_success": handle_payment_success,
    "subscription_payment_failed": handle_payment_failed,
    "order_created": handle_order_created,
}

async def handle_subscription_created(payload: dict):
    """
    새 구독 생성 처리
    1. 사용자 티어 업그레이드
    2. 크레딧 충전
    3. 스토리지 할당량 업데이트
    """
    user_id = payload["meta"]["custom_data"]["user_id"]
    plan = payload["data"]["attributes"]["variant_name"]

    # 티어 업그레이드
    await update_user_tier(user_id, plan)

    # 크레딧 충전
    credits = PLAN_CREDITS[plan]
    await add_credits(user_id, credits)

    # 스토리지 할당량 설정
    storage = PLAN_STORAGE[plan]
    await set_storage_quota(user_id, storage)

async def handle_subscription_cancelled(payload: dict):
    """
    구독 취소 처리 (종료일까지 서비스 유지)
    """
    user_id = payload["meta"]["custom_data"]["user_id"]
    ends_at = payload["data"]["attributes"]["ends_at"]

    # 취소 예정 상태로 변경
    await mark_subscription_cancelling(user_id, ends_at)
```

### 스케줄러 작업 (Celery Beat)

```python
# 매일 00:00 UTC에 실행
@celery.task
def process_expired_subscriptions():
    """
    만료된 구독 처리
    1. 티어 다운그레이드
    2. 잔여 크레딧 회수
    3. 스토리지 초과 시 경고
    """
    expired = await get_expired_subscriptions()
    for subscription in expired:
        await downgrade_user(subscription.user_id)
        await revoke_credits(subscription.user_id)
        await check_storage_overage(subscription.user_id)

# 매월 1일 00:00 UTC에 실행
@celery.task
def renew_monthly_credits():
    """
    월간 크레딧 갱신
    """
    active_subscriptions = await get_active_subscriptions()
    for sub in active_subscriptions:
        credits = PLAN_CREDITS[sub.plan]
        await reset_credits(sub.user_id, credits)
```

---

## 4. Gallery Service (갤러리 서비스)

### 역할
- 생성된 이미지 저장/조회
- 이미지 메타데이터 관리
- 보드(컬렉션) 관리
- 공유 기능
- 대시보드 데이터 제공

### 기술 스택
- FastAPI
- SQLAlchemy (PostgreSQL)
- boto3 (S3)
- Pillow (이미지 처리)

### API 엔드포인트

```yaml
# 이미지
GET    /api/v1/images                    # 이미지 목록 (페이지네이션)
GET    /api/v1/images/{image_id}         # 이미지 상세
DELETE /api/v1/images/{image_id}         # 이미지 삭제
PATCH  /api/v1/images/{image_id}         # 메타데이터 수정
POST   /api/v1/images/{image_id}/star    # 즐겨찾기 추가
DELETE /api/v1/images/{image_id}/star    # 즐겨찾기 제거

# 보드
GET    /api/v1/boards                    # 보드 목록
POST   /api/v1/boards                    # 보드 생성
GET    /api/v1/boards/{board_id}         # 보드 상세
PATCH  /api/v1/boards/{board_id}         # 보드 수정
DELETE /api/v1/boards/{board_id}         # 보드 삭제
POST   /api/v1/boards/{board_id}/images  # 보드에 이미지 추가
DELETE /api/v1/boards/{board_id}/images/{image_id}  # 보드에서 이미지 제거

# 공유
POST   /api/v1/images/{image_id}/share   # 공유 링크 생성
GET    /api/v1/shared/{share_token}      # 공유 이미지 조회

# 스토리지
GET    /api/v1/storage/usage             # 스토리지 사용량
GET    /api/v1/storage/quota             # 스토리지 할당량

# 대시보드
GET    /api/v1/dashboard/stats           # 통계 데이터
GET    /api/v1/dashboard/recent          # 최근 활동
```

### S3 이미지 저장 구조

```
s3://pingvas-images-prod/
├── users/
│   └── {user_id}/
│       ├── images/
│       │   └── {image_id}/
│       │       ├── original.png
│       │       ├── thumbnail.webp
│       │       └── metadata.json
│       └── boards/
│           └── {board_id}/
│               └── cover.webp
└── shared/
    └── {share_token}/
        └── image.png
```

---

## 5. AI Worker (AI 작업자)

### 역할
- Redis 큐에서 작업 가져오기
- InvokeAI 코어를 사용한 이미지 생성
- 진행률 실시간 전송
- 생성된 이미지 S3 업로드
- 크레딧 정산

### 기술 스택
- Python
- InvokeAI Core
- Celery
- PyTorch
- Redis (작업 큐, Pub/Sub)

### 작업 처리 흐름

```python
@celery.task(bind=True)
def generate_image(self, job_data: dict):
    job_id = job_data["job_id"]
    user_id = job_data["user_id"]
    params = job_data["params"]
    reservation_id = job_data["reservation_id"]

    try:
        # 1. 진행 시작 알림
        publish_progress(job_id, status="processing", progress=0)

        # 2. 시작 시간 기록
        start_time = time.time()

        # 3. 모델 로드 (EFS에서 Warm Cache)
        model = load_model(params["model_name"])

        # 4. 이미지 생성 (진행률 콜백 포함)
        def progress_callback(step, total_steps, preview=None):
            progress = int((step / total_steps) * 100)
            publish_progress(job_id,
                status="processing",
                progress=progress,
                current_step=step,
                total_steps=total_steps,
                preview_image=preview
            )

        result_image = generate(model, params, callback=progress_callback)

        # 5. 종료 시간 기록
        end_time = time.time()
        duration_seconds = int(end_time - start_time)

        # 6. S3에 이미지 업로드
        image_id = save_to_s3(result_image, user_id)

        # 7. 메타데이터 저장
        save_metadata(image_id, user_id, params, duration_seconds)

        # 8. 크레딧 정산
        credits_used = calculate_credits(duration_seconds, params)
        finalize_credits(reservation_id, credits_used)

        # 9. 완료 알림
        publish_completion(job_id, image_id, credits_used)

    except Exception as e:
        # 에러 시 크레딧 환불
        refund_credits(reservation_id)
        publish_error(job_id, str(e))
        raise
```

### Kubernetes 배포 (GPU 노드)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ai-worker
  namespace: pingvas-prod
spec:
  replicas: 0  # Karpenter가 자동 스케일링
  selector:
    matchLabels:
      app: ai-worker
  template:
    metadata:
      labels:
        app: ai-worker
    spec:
      nodeSelector:
        node.kubernetes.io/instance-type: g4dn.xlarge
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      containers:
      - name: ai-worker
        image: pingvas/ai-worker:latest
        resources:
          requests:
            cpu: "4"
            memory: "16Gi"
            nvidia.com/gpu: "1"
          limits:
            cpu: "4"
            memory: "16Gi"
            nvidia.com/gpu: "1"
        volumeMounts:
        - name: models
          mountPath: /models
          readOnly: true
        envFrom:
        - secretRef:
            name: ai-worker-secrets
      volumes:
      - name: models
        persistentVolumeClaim:
          claimName: efs-models-pvc
```

### KEDA 스케일링

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ai-worker-scaler
  namespace: pingvas-prod
spec:
  scaleTargetRef:
    name: ai-worker
  minReplicaCount: 0
  maxReplicaCount: 10
  triggers:
  - type: redis
    metadata:
      address: redis-sentinel:26379
      sentinelMaster: mymaster
      listName: "queue:enterprise"
      listLength: "1"
  - type: redis
    metadata:
      address: redis-sentinel:26379
      sentinelMaster: mymaster
      listName: "queue:studio"
      listLength: "2"
  - type: redis
    metadata:
      address: redis-sentinel:26379
      sentinelMaster: mymaster
      listName: "queue:pro"
      listLength: "3"
  - type: redis
    metadata:
      address: redis-sentinel:26379
      sentinelMaster: mymaster
      listName: "queue:starter"
      listLength: "5"
```

---

## 서비스 간 통신

### 동기 통신 (REST)
- User Service ↔ Payment Service: 구독 상태 확인
- Generation Service ↔ User Service: 인증 토큰 검증
- Gallery Service ↔ User Service: 권한 확인

### 비동기 통신 (Redis Pub/Sub)
- AI Worker → Generation Service: 진행률 이벤트
- Payment Service → User Service: 구독 상태 변경 이벤트

### 서비스 디스커버리
- Kubernetes DNS를 통한 서비스 발견
- 예: `user-service.pingvas-prod.svc.cluster.local`

---

## 환경 설정

### ConfigMap 예시

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: generation-service-config
  namespace: pingvas-prod
data:
  ENVIRONMENT: "production"
  LOG_LEVEL: "INFO"
  REDIS_HOST: "redis-sentinel.pingvas-prod.svc.cluster.local"
  REDIS_PORT: "26379"
  REDIS_SENTINEL_MASTER: "mymaster"
  DATABASE_URL: "postgresql://user:pass@aurora-cluster/pingvas_prod"
  S3_BUCKET: "pingvas-images-prod"
  AWS_REGION: "ap-northeast-2"
```

### Secret 예시

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: generation-service-secrets
  namespace: pingvas-prod
type: Opaque
stringData:
  JWT_SECRET: "your-jwt-secret"
  DATABASE_PASSWORD: "your-db-password"
  REDIS_PASSWORD: "your-redis-password"
```

---

## 다음 단계

1. [API 명세서](../api/01-api-specification.md)에서 상세 API를 확인합니다.
2. [데이터 흐름 설계](./03-data-flow.md)에서 시퀀스 다이어그램을 확인합니다.
3. [DB 스키마 설계](../database/01-schema-design.md)에서 테이블 구조를 확인합니다.
