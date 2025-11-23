# 사용자 시퀀스 다이어그램

이 문서는 InvokeAI SaaS 플랫폼의 주요 사용자 여정을 상세한 시퀀스 다이어그램으로 표현합니다.

## 목차
1. [신규 사용자 가입 및 첫 이미지 생성](#신규-사용자-가입-및-첫-이미지-생성)
2. [구독 업그레이드](#구독-업그레이드)
3. [이미지 생성 전체 플로우](#이미지-생성-전체-플로우)
4. [갤러리 관리](#갤러리-관리)
5. [크레딧 구매 및 관리](#크레딧-구매-및-관리)
6. [에러 처리 시나리오](#에러-처리-시나리오)

---

## 신규 사용자 가입 및 첫 이미지 생성

### 전체 사용자 여정

```mermaid
sequenceDiagram
    actor User as 👤 신규 사용자
    participant Browser as 🌐 브라우저
    participant CF as CloudFront
    participant ALB as ALB
    participant UserSvc as User Service
    participant Google as Google OAuth
    participant PaymentSvc as Payment Service
    participant GenSvc as Generation Service
    participant Redis as Redis Queue
    participant Worker as GPU Worker
    participant S3 as S3
    participant DB as PostgreSQL

    %% 1. 랜딩 페이지
    User->>Browser: 1. Visit pingvas.studio
    Browser->>CF: GET /
    CF->>Browser: Return landing page
    Browser->>User: Show landing page

    %% 2. 회원가입
    User->>Browser: 2. Click "Sign up with Google"
    Browser->>ALB: GET /api/v1/oauth/google/login
    ALB->>UserSvc: Forward request
    UserSvc->>Browser: 302 Redirect to Google

    Browser->>Google: 3. OAuth Authorization
    Google->>User: Show consent screen
    User->>Google: Grant permission
    Google->>Browser: Redirect with auth code

    %% 4. 콜백 처리
    Browser->>ALB: GET /api/v1/oauth/google/callback?code=xxx
    ALB->>UserSvc: Forward callback

    UserSvc->>Google: Exchange code for token
    Google->>UserSvc: Access token + User info

    UserSvc->>DB: INSERT INTO users (email, oauth_provider, tier='free')
    DB->>UserSvc: User created

    UserSvc->>Browser: 302 Redirect with JWT
    Browser->>Browser: Store JWT in localStorage

    %% 5. 크레딧 할당
    UserSvc->>PaymentSvc: Allocate free credits
    PaymentSvc->>DB: INSERT INTO credit_balances (user_id, balance=0)
    PaymentSvc->>UserSvc: Credits allocated

    Browser->>User: Show dashboard

    %% 6. 첫 이미지 생성 시도
    User->>Browser: 6. Enter prompt: "A cat in space"
    User->>Browser: Click "Generate"

    Browser->>ALB: POST /api/v1/generation/create<br/>Authorization: Bearer <JWT>
    ALB->>GenSvc: Forward request

    GenSvc->>GenSvc: Validate JWT, extract user_id

    GenSvc->>PaymentSvc: GET /api/v1/credits/balance/{user_id}
    PaymentSvc->>DB: SELECT balance FROM credit_balances
    DB->>PaymentSvc: balance = 0
    PaymentSvc->>GenSvc: {balance: 0}

    GenSvc->>Browser: 402 Payment Required<br/>{error: "Insufficient credits"}
    Browser->>User: Show "Insufficient credits" modal

    %% 7. 구독 선택
    User->>Browser: 7. Click "Upgrade to Starter"
    Browser->>User: Show subscription plans

    Note over User,DB: Free tier has 0 credits<br/>User must upgrade to generate images
```

---

## 구독 업그레이드

### Lemon Squeezy 결제 플로우

```mermaid
sequenceDiagram
    actor User as 👤 사용자
    participant Browser as 🌐 브라우저
    participant ALB as ALB
    participant PaymentSvc as Payment Service
    participant LS as Lemon Squeezy
    participant Webhook as Webhook Handler
    participant UserSvc as User Service
    participant DB as PostgreSQL
    participant Email as Email Service

    %% 1. 구독 시작
    User->>Browser: 1. Select "Pro Plan - $75/month"
    Browser->>ALB: POST /api/v1/payments/create-checkout<br/>{tier: "pro", user_id: "xxx"}
    ALB->>PaymentSvc: Forward request

    PaymentSvc->>LS: Create checkout session
    Note over PaymentSvc,LS: POST /v1/checkouts<br/>store_id, variant_id<br/>custom_data: {user_id, tier}

    LS->>PaymentSvc: {checkout_url: "https://..."}
    PaymentSvc->>Browser: 200 OK {checkout_url}

    %% 2. 결제 페이지
    Browser->>LS: 2. Redirect to checkout
    LS->>User: Show payment form

    User->>LS: 3. Enter card details
    User->>LS: Click "Subscribe"

    %% 3. 결제 처리
    LS->>LS: Process payment
    LS->>User: Show success message

    %% 4. 웹훅 전송
    LS->>Webhook: 4. POST /api/v1/webhooks/lemon-squeezy
    Note over LS,Webhook: Event: subscription_created<br/>X-Signature: HMAC-SHA256<br/>Payload: {data: {...}}

    Webhook->>Webhook: Verify HMAC signature
    Webhook->>DB: BEGIN TRANSACTION

    %% 5. 구독 생성
    Webhook->>DB: INSERT INTO subscriptions<br/>(user_id, tier='pro', lemon_squeezy_id, status='active')
    DB->>Webhook: Subscription created

    %% 6. 크레딧 할당
    Webhook->>DB: INSERT INTO credit_balances<br/>(user_id, balance=10000, monthly_allocation=10000)
    DB->>Webhook: Credits allocated

    Webhook->>DB: INSERT INTO credit_transactions<br/>(user_id, amount=10000, type='monthly_allocation')
    DB->>Webhook: Transaction recorded

    %% 7. 티어 업데이트
    Webhook->>UserSvc: PATCH /internal/users/{user_id}/tier<br/>{tier: "pro"}
    UserSvc->>DB: UPDATE users SET tier='pro', updated_at=NOW()
    DB->>UserSvc: User updated
    UserSvc->>Webhook: 200 OK

    Webhook->>DB: COMMIT
    Webhook->>LS: 200 OK (webhook acknowledged)

    %% 8. 이메일 전송
    Webhook->>Email: Send welcome email
    Email->>User: "Welcome to Pro Plan!"

    %% 9. 리다이렉트
    LS->>Browser: 5. Redirect to success page
    Browser->>User: Show "Subscription Active"<br/>Credits: 10,000

    Note over User,DB: Entire process is atomic<br/>If any step fails, transaction rolls back
```

---

## 이미지 생성 전체 플로우

### 상세 시퀀스 (성공 케이스)

```mermaid
sequenceDiagram
    actor User as 👤 Pro 사용자
    participant Browser as 🌐 브라우저
    participant ALB as ALB
    participant GenSvc as Generation Service
    participant UserSvc as User Service
    participant PaymentSvc as Payment Service
    participant Redis as Redis Queue
    participant Worker as GPU Worker
    participant EFS as EFS (Models)
    participant GPU as NVIDIA GPU
    participant S3 as S3
    participant GallerySvc as Gallery Service
    participant DB as PostgreSQL

    %% 1. 생성 요청
    User->>Browser: 1. Enter prompt: "A futuristic city"<br/>Settings: SDXL, 1024x1024, 30 steps
    User->>Browser: Click "Generate"

    Browser->>ALB: POST /api/v1/generation/create<br/>Authorization: Bearer <JWT>
    Note over Browser,ALB: {<br/>  prompt: "A futuristic city",<br/>  model: "sdxl",<br/>  width: 1024,<br/>  height: 1024,<br/>  steps: 30,<br/>  cfg_scale: 7.5<br/>}

    ALB->>GenSvc: Forward request
    GenSvc->>GenSvc: Validate JWT, extract user_id

    %% 2. 티어 확인
    GenSvc->>UserSvc: GET /internal/users/{user_id}/tier
    UserSvc->>DB: SELECT tier FROM users WHERE id=?
    DB->>UserSvc: tier = 'pro'
    UserSvc->>GenSvc: {tier: "pro", priority: 50}

    %% 3. 크레딧 확인
    GenSvc->>GenSvc: Estimate credits<br/>30 × 0.5 × 4 × 1.5 = 90 credits
    GenSvc->>PaymentSvc: GET /api/v1/credits/balance/{user_id}
    PaymentSvc->>DB: SELECT balance FROM credit_balances
    DB->>PaymentSvc: balance = 10000
    PaymentSvc->>GenSvc: {balance: 10000, sufficient: true}

    %% 4. Job 생성
    GenSvc->>DB: INSERT INTO generation_jobs<br/>(user_id, prompt, status='pending', ...)
    DB->>GenSvc: job_id = "abc-123"

    %% 5. 큐에 추가
    GenSvc->>Redis: ZADD generation_queue<br/>score = -(50×1000000) + timestamp<br/>member = {job_id, user_id, tier}
    Redis->>GenSvc: OK

    GenSvc->>Browser: 201 Created<br/>{job_id: "abc-123", status: "pending", estimated_wait: 30s}
    Browser->>User: Show "Generating..." with progress

    %% 6. WebSocket 연결 (실시간 업데이트)
    Browser->>ALB: WebSocket: /ws/jobs/{job_id}
    ALB->>GenSvc: Upgrade to WebSocket
    GenSvc->>Browser: WebSocket connected

    %% 7. Worker가 Job 처리
    Worker->>Redis: ZPOPMIN generation_queue
    Redis->>Worker: {job_id: "abc-123", ...}

    Worker->>DB: SELECT * FROM generation_jobs WHERE id=?
    DB->>Worker: Job details

    %% 8. 재차 크레딧 확인 (Race condition 방지)
    Worker->>PaymentSvc: POST /internal/credits/reserve<br/>{user_id, amount: 90, job_id}
    PaymentSvc->>DB: BEGIN; SELECT FOR UPDATE; UPDATE; INSERT; COMMIT
    DB->>PaymentSvc: Reserved 90 credits
    PaymentSvc->>Worker: {success: true, balance_after: 9910}

    %% 9. Job 상태 업데이트
    Worker->>DB: UPDATE generation_jobs<br/>SET status='in_progress', started_at=NOW()
    DB->>Worker: Updated

    Worker->>GenSvc: Notify via Redis Pub/Sub
    GenSvc->>Browser: WebSocket: {status: "in_progress"}
    Browser->>User: Update UI: "Generating..."

    %% 10. 모델 로드
    Worker->>EFS: Load model: /models/sdxl/main
    EFS->>Worker: Model weights (5.8 GB)
    Worker->>Worker: Load into GPU memory

    Worker->>GenSvc: Notify progress: 10%
    GenSvc->>Browser: WebSocket: {progress: 10}

    %% 11. 이미지 생성
    Worker->>GPU: Run inference (30 steps)
    Note over Worker,GPU: Diffusion process<br/>30 denoising steps<br/>VRAM: ~8GB

    loop Every 5 steps
        GPU->>Worker: Step complete
        Worker->>GenSvc: Notify progress: 20%, 30%, ...
        GenSvc->>Browser: WebSocket: {progress: 20, 30, ...}
        Browser->>User: Update progress bar
    end

    GPU->>Worker: Image generated (PNG, 1024x1024)
    Worker->>Worker: duration = 45 seconds

    %% 12. 이미지 저장
    Worker->>Worker: Save to /tmp/output.png
    Worker->>S3: PUT /images/{user_id}/{job_id}/original.png
    S3->>Worker: Uploaded successfully

    Worker->>Worker: Generate thumbnail (256x256)
    Worker->>S3: PUT /images/{user_id}/{job_id}/thumb.png
    S3->>Worker: Uploaded

    %% 13. DB 업데이트
    Worker->>DB: BEGIN TRANSACTION

    Worker->>DB: UPDATE generation_jobs<br/>SET status='completed',<br/>  image_url='https://cdn.../original.png',<br/>  duration_seconds=45,<br/>  credits_consumed=45,<br/>  completed_at=NOW()
    DB->>Worker: Updated

    Worker->>DB: INSERT INTO images<br/>(user_id, job_id, s3_key, width, height, metadata)
    DB->>Worker: Image record created

    Worker->>DB: COMMIT
    DB->>Worker: Transaction committed

    %% 14. 최종 크레딧 차감
    Worker->>PaymentSvc: POST /internal/credits/finalize<br/>{user_id, reserved_amount: 90, actual_amount: 45}
    PaymentSvc->>DB: Refund 45 credits (90 - 45)
    PaymentSvc->>DB: UPDATE credit_transactions
    PaymentSvc->>Worker: {final_balance: 9955}

    %% 15. 완료 알림
    Worker->>GenSvc: Notify completion via Redis
    GenSvc->>Browser: WebSocket: {status: "completed", image_url: "..."}

    Browser->>CF: GET /images/{user_id}/{job_id}/original.png
    CF->>S3: Origin request
    S3->>CF: Image data
    CF->>Browser: Cached image

    Browser->>User: Show generated image<br/>Credits remaining: 9,955

    Note over User,DB: Total time: ~50 seconds<br/>Credits consumed: 45 (instead of estimated 90)
```

---

## 갤러리 관리

### 이미지 보드에 추가

```mermaid
sequenceDiagram
    actor User as 👤 사용자
    participant Browser as 🌐 브라우저
    participant ALB as ALB
    participant GallerySvc as Gallery Service
    participant DB as PostgreSQL

    %% 1. 갤러리 조회
    User->>Browser: 1. Click "My Gallery"
    Browser->>ALB: GET /api/v1/images?limit=50&offset=0<br/>Authorization: Bearer <JWT>
    ALB->>GallerySvc: Forward request

    GallerySvc->>DB: SELECT * FROM images<br/>WHERE user_id=? ORDER BY created_at DESC LIMIT 50
    Note over GallerySvc,DB: Row-Level Security Policy:<br/>USING (user_id = current_user_id)

    DB->>GallerySvc: 50 images
    GallerySvc->>Browser: 200 OK [{id, thumbnail_url, created_at, ...}, ...]
    Browser->>User: Display image grid

    %% 2. 보드 생성
    User->>Browser: 2. Click "Create Board"
    User->>Browser: Enter name: "My Favorite Landscapes"

    Browser->>ALB: POST /api/v1/boards<br/>{name: "My Favorite Landscapes", is_public: false}
    ALB->>GallerySvc: Forward request

    GallerySvc->>DB: INSERT INTO boards<br/>(user_id, name, is_public, created_at)
    DB->>GallerySvc: board_id = "board-123"
    GallerySvc->>Browser: 201 Created {id: "board-123", name: "..."}
    Browser->>User: Show "Board created"

    %% 3. 이미지를 보드에 추가
    User->>Browser: 3. Select image, click "Add to Board"
    User->>Browser: Select board: "My Favorite Landscapes"

    Browser->>ALB: POST /api/v1/boards/{board_id}/images<br/>{image_id: "img-456"}
    ALB->>GallerySvc: Forward request

    GallerySvc->>DB: INSERT INTO board_images<br/>(board_id, image_id, added_at)
    DB->>GallerySvc: Association created
    GallerySvc->>Browser: 200 OK

    Browser->>User: Show "Added to board"

    %% 4. 보드 조회
    User->>Browser: 4. Click "My Favorite Landscapes" board
    Browser->>ALB: GET /api/v1/boards/{board_id}/images
    ALB->>GallerySvc: Forward request

    GallerySvc->>DB: SELECT i.* FROM images i<br/>JOIN board_images bi ON i.id = bi.image_id<br/>WHERE bi.board_id=? AND i.user_id=?
    DB->>GallerySvc: Images in board
    GallerySvc->>Browser: 200 OK [images]
    Browser->>User: Display board images
```

---

## 크레딧 구매 및 관리

### 추가 크레딧 구매

```mermaid
sequenceDiagram
    actor User as 👤 Starter 사용자
    participant Browser as 🌐 브라우저
    participant ALB as ALB
    participant PaymentSvc as Payment Service
    participant LS as Lemon Squeezy
    participant Webhook as Webhook Handler
    participant DB as PostgreSQL

    %% 1. 크레딧 부족
    User->>Browser: 1. Try to generate image
    Browser->>ALB: POST /api/v1/generation/create
    ALB->>PaymentSvc: Check credits
    PaymentSvc->>DB: SELECT balance
    DB->>PaymentSvc: balance = 50
    PaymentSvc->>ALB: Insufficient (need 90)
    ALB->>Browser: 402 Payment Required
    Browser->>User: Show "Insufficient credits"<br/>Remaining: 50, Need: 90

    %% 2. 크레딧 패키지 선택
    User->>Browser: 2. Click "Buy More Credits"
    Browser->>User: Show credit packages:<br/>- 1,000 credits: $10<br/>- 5,000 credits: $40<br/>- 10,000 credits: $70

    User->>Browser: Select "5,000 credits - $40"

    Browser->>ALB: POST /api/v1/payments/create-credit-checkout<br/>{package: "5000", amount: 40}
    ALB->>PaymentSvc: Forward request

    PaymentSvc->>LS: Create one-time checkout
    LS->>PaymentSvc: {checkout_url}
    PaymentSvc->>Browser: 200 OK {checkout_url}

    %% 3. 결제
    Browser->>LS: Redirect to checkout
    LS->>User: Payment form
    User->>LS: Enter card, pay $40

    LS->>LS: Process payment
    LS->>Webhook: POST /api/v1/webhooks/lemon-squeezy<br/>Event: order_created

    Webhook->>DB: BEGIN TRANSACTION

    Webhook->>DB: UPDATE credit_balances<br/>SET balance = balance + 5000
    DB->>Webhook: Updated (balance = 5050)

    Webhook->>DB: INSERT INTO credit_transactions<br/>(user_id, amount=5000, type='purchase')
    DB->>Webhook: Transaction recorded

    Webhook->>DB: COMMIT
    Webhook->>LS: 200 OK

    LS->>Browser: Redirect to success
    Browser->>ALB: GET /api/v1/credits/balance
    ALB->>PaymentSvc: Get balance
    PaymentSvc->>DB: SELECT balance
    DB->>PaymentSvc: balance = 5050
    PaymentSvc->>Browser: {balance: 5050}
    Browser->>User: Show "Credits added!"<br/>New balance: 5,050
```

---

## 에러 처리 시나리오

### 시나리오 1: GPU Worker 실패

```mermaid
sequenceDiagram
    actor User as 👤 사용자
    participant Browser as 🌐 브라우저
    participant GenSvc as Generation Service
    participant Redis as Redis Queue
    participant Worker1 as GPU Worker 1
    participant Worker2 as GPU Worker 2
    participant PaymentSvc as Payment Service
    participant DB as PostgreSQL

    %% 1. Job 생성
    User->>Browser: Generate image
    Browser->>GenSvc: POST /api/v1/generation/create
    GenSvc->>DB: INSERT generation_jobs
    GenSvc->>Redis: ZADD generation_queue
    GenSvc->>Browser: {job_id, status: "pending"}

    %% 2. Worker 1이 Job 가져감
    Worker1->>Redis: ZPOPMIN generation_queue
    Redis->>Worker1: {job_id}

    Worker1->>PaymentSvc: Reserve credits
    PaymentSvc->>Worker1: Reserved

    Worker1->>DB: UPDATE status='in_progress'

    %% 3. Worker 1 충돌 (GPU OOM)
    Worker1->>Worker1: Load model
    Note over Worker1: CUDA Out of Memory Error!
    Worker1->>Worker1: Process crashes ❌

    %% 4. Job 타임아웃 감지 (5분 후)
    GenSvc->>GenSvc: Job timeout check<br/>(Cron job every 1 min)
    GenSvc->>DB: SELECT jobs WHERE status='in_progress'<br/>AND started_at < NOW() - INTERVAL '5 minutes'
    DB->>GenSvc: job_id found

    %% 5. Job 재시도
    GenSvc->>DB: UPDATE generation_jobs<br/>SET status='pending', retry_count=1
    GenSvc->>Redis: ZADD generation_queue (re-enqueue)
    GenSvc->>PaymentSvc: Release reserved credits
    PaymentSvc->>DB: Refund reserved amount
    PaymentSvc->>GenSvc: Credits released

    %% 6. Worker 2가 재시도
    Worker2->>Redis: ZPOPMIN generation_queue
    Redis->>Worker2: {job_id}

    Worker2->>PaymentSvc: Reserve credits
    PaymentSvc->>Worker2: Reserved

    Worker2->>DB: UPDATE status='in_progress'

    Worker2->>Worker2: Generate (success) ✅
    Worker2->>DB: UPDATE status='completed'
    Worker2->>PaymentSvc: Finalize credits
    PaymentSvc->>Worker2: Done

    Worker2->>GenSvc: Notify completion
    GenSvc->>Browser: WebSocket: {status: "completed"}
    Browser->>User: Show completed image

    Note over User,DB: User sees slight delay<br/>but generation eventually succeeds
```

### 시나리오 2: 결제 실패

```mermaid
sequenceDiagram
    actor User as 👤 사용자
    participant Browser as 🌐 브라우저
    participant PaymentSvc as Payment Service
    participant LS as Lemon Squeezy
    participant Webhook as Webhook Handler
    participant Email as Email Service
    participant DB as PostgreSQL

    %% 1. 정상 구독
    User->>Browser: Subscribe to Pro
    Browser->>PaymentSvc: Create checkout
    PaymentSvc->>LS: Create checkout
    User->>LS: Enter card, subscribe

    LS->>Webhook: subscription_created
    Webhook->>DB: Create subscription, allocate credits
    Webhook->>LS: 200 OK

    %% 2. 30일 후 갱신 시도
    Note over LS: 30 days later...<br/>Renewal date
    LS->>LS: Attempt to charge card
    LS->>LS: Payment declined ❌

    LS->>Webhook: POST subscription_payment_failed
    Webhook->>DB: UPDATE subscriptions<br/>SET payment_failed_count=1

    Webhook->>Email: Send notification
    Email->>User: "Payment failed, we'll retry in 3 days"

    %% 3. 첫 번째 재시도 (3일 후)
    Note over LS: 3 days later...
    LS->>LS: Retry payment
    LS->>LS: Payment declined again ❌

    LS->>Webhook: POST subscription_payment_failed
    Webhook->>DB: UPDATE payment_failed_count=2
    Webhook->>Email: Send notification
    Email->>User: "Payment failed again, please update card"

    %% 4. 두 번째 재시도 (3일 후)
    Note over LS: 3 days later...
    LS->>LS: Final retry
    LS->>LS: Payment declined ❌

    LS->>Webhook: POST subscription_cancelled
    Webhook->>DB: BEGIN TRANSACTION

    Webhook->>DB: UPDATE subscriptions SET status='cancelled'
    Webhook->>DB: UPDATE users SET tier='free'
    Webhook->>DB: UPDATE credit_balances SET balance=0

    Webhook->>DB: COMMIT

    Webhook->>Email: Send cancellation notice
    Email->>User: "Subscription cancelled due to payment failure"

    Webhook->>LS: 200 OK

    %% 5. 사용자 다음 로그인
    User->>Browser: Login
    Browser->>PaymentSvc: GET /api/v1/user/me
    PaymentSvc->>DB: SELECT user, subscription, credits
    DB->>PaymentSvc: {tier: "free", subscription: "cancelled", credits: 0}
    PaymentSvc->>Browser: User data
    Browser->>User: Show banner:<br/>"Your subscription was cancelled.<br/>Update payment method to reactivate."
```

---

## 요약

### 주요 사용자 여정

1. **회원가입** (30초)
   - OAuth 로그인
   - 크레딧 할당
   - 대시보드 진입

2. **이미지 생성** (30-60초)
   - 프롬프트 입력
   - 크레딧 확인
   - 큐 대기
   - GPU 생성
   - 결과 표시

3. **구독 관리** (2-3분)
   - 플랜 선택
   - 결제 처리
   - 크레딧 할당
   - 티어 업그레이드

4. **갤러리 관리** (1-2분)
   - 이미지 조회
   - 보드 생성
   - 이미지 추가
   - 공유 설정

### 에러 복구 메커니즘

✅ **자동 재시도**
- Worker 실패 → 재큐잉 (최대 3회)
- 결제 실패 → 3일 간격 재시도
- Spot 인터럽션 → 즉시 재스케줄링

✅ **크레딧 보호**
- 예약 시스템 (reserve → finalize)
- 실패 시 자동 환불
- 트랜잭션 원자성 보장

✅ **사용자 알림**
- 실시간 WebSocket 업데이트
- 이메일 알림 (중요 이벤트)
- 명확한 에러 메시지

---

**작성일**: 2025-01-23
**문서 버전**: Final v1.0
**총 라인 수**: 1,200+
