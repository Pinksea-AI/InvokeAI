# 데이터 흐름 다이어그램 및 플로우차트

이 문서는 InvokeAI SaaS 플랫폼의 논리적 데이터 흐름과 주요 비즈니스 프로세스를 설명합니다.

## 목차
1. [전체 데이터 흐름](#전체-데이터-흐름)
2. [사용자 인증 플로우](#사용자-인증-플로우)
3. [이미지 생성 플로우](#이미지-생성-플로우)
4. [크레딧 관리 플로우](#크레딧-관리-플로우)
5. [결제 플로우](#결제-플로우)
6. [GPU 스케일링 플로우](#gpu-스케일링-플로우)
7. [데이터 저장 플로우](#데이터-저장-플로우)

---

## 전체 데이터 흐름

### 고수준 데이터 흐름

```mermaid
graph TB
    User[👤 User] -->|1. HTTP Request| ALB[Application Load Balancer]

    ALB -->|2. Route| Services{Microservices}

    Services -->|User Service| UserDB[(PostgreSQL<br/>users, subscriptions)]
    Services -->|Payment Service| PaymentDB[(PostgreSQL<br/>credits, transactions)]
    Services -->|Generation Service| GenDB[(PostgreSQL<br/>jobs, images)]
    Services -->|Gallery Service| GalleryDB[(PostgreSQL<br/>boards, images)]

    Services -->|Queue Jobs| Redis[(Redis<br/>Priority Queue)]

    Redis -->|3. Dequeue| Worker[🖥️ GPU Worker]

    Worker -->|4. Load Model| EFS[/EFS<br/>AI Models/]
    Worker -->|5. Generate| GPU[NVIDIA GPU<br/>Inference]

    GPU -->|6. Image| Worker
    Worker -->|7. Upload| S3[S3 Bucket<br/>Images]
    Worker -->|8. Update Status| GenDB

    S3 -->|9. CDN| CloudFront[CloudFront]
    CloudFront -->|10. Deliver| User

    style User fill:#4A90E2
    style Services fill:#FF9F43
    style Worker fill:#95E1D3
    style GPU fill:#00D2D3
```

### 서비스 간 통신 패턴

```mermaid
graph LR
    subgraph "Client Layer"
        WebApp[Web Application<br/>React]
        MobileApp[Mobile App<br/>React Native]
    end

    subgraph "API Gateway"
        ALB[ALB<br/>Path-based Routing]
    end

    subgraph "Service Layer"
        UserSvc[User Service<br/>:8001]
        PaymentSvc[Payment Service<br/>:8002]
        GenSvc[Generation Service<br/>:8003]
        GallerySvc[Gallery Service<br/>:8004]
        ModelSvc[Model Service<br/>:8005]
    end

    subgraph "Data Layer"
        PostgreSQL[(PostgreSQL)]
        RedisDev[(Redis Dev)]
        RedisProd[(Redis Prod)]
    end

    subgraph "Worker Layer"
        Workers[GPU Workers<br/>Celery]
    end

    WebApp -->|/api/v1/auth| ALB
    MobileApp -->|/api/v1/auth| ALB

    ALB -->|/api/v1/users| UserSvc
    ALB -->|/api/v1/credits| PaymentSvc
    ALB -->|/api/v1/generation| GenSvc
    ALB -->|/api/v1/images| GallerySvc
    ALB -->|/api/v1/models| ModelSvc

    UserSvc <-->|gRPC/HTTP| PaymentSvc
    GenSvc <-->|HTTP| PaymentSvc
    GenSvc <-->|HTTP| UserSvc
    GallerySvc <-->|HTTP| UserSvc

    UserSvc --> PostgreSQL
    PaymentSvc --> PostgreSQL
    GenSvc --> PostgreSQL
    GallerySvc --> PostgreSQL

    GenSvc -->|Enqueue| RedisDev
    GenSvc -->|Enqueue| RedisProd

    Workers -->|Dequeue| RedisDev
    Workers -->|Dequeue| RedisProd
    Workers --> PostgreSQL

    style WebApp fill:#61DAFB
    style UserSvc fill:#FF6B6B
    style PaymentSvc fill:#48C774
    style GenSvc fill:#FFE66D
    style Workers fill:#95E1D3
```

---

## 사용자 인증 플로우

### OAuth 2.0 로그인 (Google)

```mermaid
sequenceDiagram
    participant User as 👤 User
    participant Frontend as React App
    participant ALB as ALB
    participant UserSvc as User Service
    participant Google as Google OAuth
    participant DB as PostgreSQL

    User->>Frontend: 1. Click "Login with Google"
    Frontend->>ALB: 2. GET /api/v1/oauth/google/login
    ALB->>UserSvc: 3. Forward request

    UserSvc->>Frontend: 4. Redirect to Google OAuth
    Frontend->>Google: 5. OAuth Authorization Request
    Google->>User: 6. Show consent screen
    User->>Google: 7. Grant permission

    Google->>Frontend: 8. Redirect with auth code
    Frontend->>ALB: 9. GET /api/v1/oauth/google/callback?code=xxx
    ALB->>UserSvc: 10. Forward callback

    UserSvc->>Google: 11. Exchange code for access token
    Google->>UserSvc: 12. Return access token
    UserSvc->>Google: 13. Get user info
    Google->>UserSvc: 14. User profile

    UserSvc->>DB: 15. Upsert user record
    DB->>UserSvc: 16. User created/updated

    UserSvc->>UserSvc: 17. Generate JWT token
    UserSvc->>Frontend: 18. Redirect with JWT

    Frontend->>Frontend: 19. Store JWT in localStorage
    Frontend->>User: 20. Show dashboard
```

### JWT 인증 플로우

```mermaid
graph TB
    Start[Client Request] -->|Authorization: Bearer <token>| ValidateJWT{Validate JWT}

    ValidateJWT -->|Invalid/Expired| Reject[401 Unauthorized<br/>Redirect to login]

    ValidateJWT -->|Valid| ExtractUser[Extract user_id from token]

    ExtractUser --> CheckDB{User exists in DB?}

    CheckDB -->|No| Reject
    CheckDB -->|Yes| CheckActive{User is active?}

    CheckActive -->|No| Reject403[403 Forbidden<br/>Account deactivated]
    CheckActive -->|Yes| SetContext[Set user context<br/>current_user_id]

    SetContext --> ProcessRequest[Process Request]

    ProcessRequest --> Response[Return Response]

    style ValidateJWT fill:#FFE66D
    style CheckDB fill:#4ECDC4
    style CheckActive fill:#FF9F43
    style ProcessRequest fill:#48C774
```

---

## 이미지 생성 플로우

### 전체 생성 프로세스

```mermaid
flowchart TB
    Start([User submits generation request]) --> ValidateInput{Validate Input}

    ValidateInput -->|Invalid| ReturnError[Return 400 Bad Request]
    ValidateInput -->|Valid| GetUserTier[Get user tier from User Service]

    GetUserTier --> CheckCredits{Check credit balance}

    CheckCredits -->|Insufficient| ReturnInsufficientCredits[Return 402 Payment Required]

    CheckCredits -->|Sufficient| EstimateCredits[Estimate credits needed<br/>base_time × resolution × model_factor]

    EstimateCredits --> CreateJob[Create generation_jobs record<br/>status = 'pending']

    CreateJob --> EnqueueJob[Enqueue to Redis priority queue<br/>score = -(priority × 1000000) + timestamp]

    EnqueueJob --> ReturnJobID[Return job_id to user<br/>201 Created]

    %% Worker Process
    ReturnJobID -.-> WorkerDequeue[Worker: Dequeue from Redis]

    WorkerDequeue --> CheckWorkerCredits{Re-check credits<br/>(Race condition)}

    CheckWorkerCredits -->|Insufficient| UpdateJobFailed1[Update job<br/>status = 'failed'<br/>error = 'Insufficient credits']

    CheckWorkerCredits -->|Sufficient| ReserveCredits[Reserve credits<br/>(optimistic locking)]

    ReserveCredits --> UpdateJobInProgress[Update job<br/>status = 'in_progress'<br/>started_at = NOW()]

    UpdateJobInProgress --> LoadModel[Load AI model from EFS<br/>/models/stable-diffusion-v1-5]

    LoadModel --> GenerateImage[Generate image<br/>GPU inference]

    GenerateImage --> SaveLocal[Save image locally<br/>/tmp/output.png]

    SaveLocal --> UploadS3[Upload to S3<br/>pingvas-{env}-images/]

    UploadS3 --> CreateImageRecord[Create images record<br/>s3_key, metadata]

    CreateImageRecord --> CalculateDuration[Calculate duration<br/>completed_at - started_at]

    CalculateDuration --> DeductCredits[Deduct credits<br/>Atomic transaction]

    DeductCredits --> UpdateJobCompleted[Update job<br/>status = 'completed'<br/>image_url, duration, credits_consumed]

    UpdateJobCompleted --> End([Generation Complete])

    style CheckCredits fill:#FFE66D
    style EnqueueJob fill:#FF9F43
    style GenerateImage fill:#95E1D3
    style DeductCredits fill:#FF6B6B
```

### 우선순위 큐 처리

```mermaid
graph TB
    subgraph "Redis Priority Queue (Sorted Set)"
        Queue[(Sorted Set: generation_queue<br/>Member: job_data JSON<br/>Score: -(priority × 1000000) + timestamp)]
    end

    subgraph "Enqueue Logic"
        Job1[Enterprise Job<br/>priority = 100<br/>score = -100000000 + 1674567890123]

        Job2[Pro Job<br/>priority = 50<br/>score = -50000000 + 1674567890456]

        Job3[Starter Job<br/>priority = 25<br/>score = -25000000 + 1674567890789]

        Job1 --> Queue
        Job2 --> Queue
        Job3 --> Queue
    end

    subgraph "Dequeue Logic"
        Worker[GPU Worker]

        Worker -->|ZPOPMIN| GetHighest{Get highest priority<br/>(lowest score)}

        GetHighest --> Process[Process Job 1<br/>(Enterprise, earliest)]
    end

    Queue --> GetHighest

    style Job1 fill:#FF6B6B
    style Job2 fill:#FFE66D
    style Job3 fill:#4ECDC4
    style Worker fill:#95E1D3
```

### 티어별 동시 실행 제한

```mermaid
stateDiagram-v2
    [*] --> CheckConcurrency: New job arrives

    CheckConcurrency --> GetUserJobs: Count in_progress jobs

    GetUserJobs --> CompareTier: Get tier limit

    state CompareTier <<choice>>
    CompareTier --> AllowExecution: Count < Tier Limit
    CompareTier --> RejectExecution: Count >= Tier Limit

    AllowExecution --> ExecuteJob: Start generation
    ExecuteJob --> [*]

    RejectExecution --> ReturnError: 429 Too Many Requests
    ReturnError --> [*]

    note right of CompareTier
        Tier Limits:
        - Free: 0 concurrent
        - Starter: 1 concurrent
        - Pro: 1 concurrent
        - Studio: 3 concurrent
        - Enterprise: Unlimited
    end note
```

---

## 크레딧 관리 플로우

### 원자적 크레딧 차감

```mermaid
sequenceDiagram
    participant Worker as GPU Worker
    participant PaymentSvc as Payment Service
    participant DB as PostgreSQL

    Worker->>PaymentSvc: POST /api/v1/credits/deduct<br/>{user_id, amount, job_id}

    PaymentSvc->>DB: BEGIN TRANSACTION

    PaymentSvc->>DB: SELECT balance FROM credit_balances<br/>WHERE user_id = 'xxx'<br/>FOR UPDATE

    DB->>PaymentSvc: balance = 5000

    PaymentSvc->>PaymentSvc: Check: balance >= amount

    alt Sufficient balance
        PaymentSvc->>DB: UPDATE credit_balances<br/>SET balance = 5000 - 100<br/>WHERE user_id = 'xxx'

        PaymentSvc->>DB: INSERT INTO credit_transactions<br/>(user_id, amount, type, job_id, balance_after)

        PaymentSvc->>DB: COMMIT

        PaymentSvc->>Worker: 200 OK {success: true, balance: 4900}
    else Insufficient balance
        PaymentSvc->>DB: ROLLBACK

        PaymentSvc->>Worker: 402 Payment Required<br/>{error: "Insufficient credits"}
    end

    Note over PaymentSvc,DB: FOR UPDATE prevents race conditions<br/>Multiple workers cannot deduct simultaneously
```

### 크레딧 예상 알고리즘

```mermaid
flowchart LR
    Input[Input Parameters] --> Steps[steps]
    Input --> Width[width]
    Input --> Height[height]
    Input --> Model[model]

    Steps --> BaseTime[base_time = steps × 0.5 sec]

    Width --> Resolution[resolution_factor =<br/>(width × height) / (512 × 512)]
    Height --> Resolution

    Model --> ModelFactor{Model Factor}
    ModelFactor -->|SD 1.5| Factor1[1.0x]
    ModelFactor -->|SDXL| Factor2[1.5x]
    ModelFactor -->|Flux| Factor3[2.0x]

    BaseTime --> Calculate[estimated_seconds =<br/>base_time × resolution_factor × model_factor]
    Resolution --> Calculate
    Factor1 --> Calculate
    Factor2 --> Calculate
    Factor3 --> Calculate

    Calculate --> Max{Max with minimum}
    Max --> Result[credits = max(estimated_seconds, 10)]

    style Calculate fill:#FFE66D
    style Result fill:#48C774
```

---

## 결제 플로우

### Lemon Squeezy 구독 플로우

```mermaid
sequenceDiagram
    participant User as 👤 User
    participant Frontend as React App
    participant PaymentSvc as Payment Service
    participant LS as Lemon Squeezy
    participant Webhook as Webhook Handler
    participant UserSvc as User Service
    participant DB as PostgreSQL

    User->>Frontend: 1. Select "Pro Plan"
    Frontend->>PaymentSvc: 2. POST /api/v1/payments/create-checkout<br/>{tier: "pro"}

    PaymentSvc->>LS: 3. Create checkout session<br/>custom_data: {user_id, tier}
    LS->>PaymentSvc: 4. checkout_url

    PaymentSvc->>Frontend: 5. Return checkout_url
    Frontend->>User: 6. Redirect to Lemon Squeezy

    User->>LS: 7. Enter payment details
    LS->>User: 8. Process payment

    LS->>Webhook: 9. POST /api/v1/webhooks/lemon-squeezy<br/>event: subscription_created

    Webhook->>Webhook: 10. Verify signature (HMAC)

    Webhook->>DB: 11. Create subscription record
    Webhook->>DB: 12. Allocate monthly credits<br/>(Pro: 10,000 credits)

    Webhook->>UserSvc: 13. PATCH /api/v1/users/{user_id}/tier<br/>{tier: "pro"}
    UserSvc->>DB: 14. Update users.tier = 'pro'

    Webhook->>LS: 15. Return 200 OK

    LS->>Frontend: 16. Redirect to success page
    Frontend->>User: 17. Show "Subscription Active"

    Note over Webhook,DB: Transaction ensures atomicity<br/>If any step fails, entire process rolls back
```

### 구독 갱신 플로우

```mermaid
flowchart TB
    Start[Billing Cycle End] --> LSCharge[Lemon Squeezy:<br/>Attempt to charge card]

    LSCharge --> PaymentSuccess{Payment Success?}

    PaymentSuccess -->|Yes| WebhookRenewal[Webhook: subscription_updated<br/>event]

    WebhookRenewal --> AllocateCredits[Allocate new monthly credits<br/>Reset credit balance]

    AllocateCredits --> UpdatePeriod[Update subscription:<br/>current_period_start/end]

    UpdatePeriod --> NotifyUser[Send email:<br/>"Subscription renewed"]

    NotifyUser --> End1([✅ Subscription Active])

    PaymentSuccess -->|No| WebhookFailed[Webhook: subscription_payment_failed]

    WebhookFailed --> RetryPayment{Retry Count}

    RetryPayment -->|< 3| ScheduleRetry[Schedule retry<br/>after 3 days]
    ScheduleRetry --> NotifyRetry[Send email:<br/>"Payment failed, will retry"]
    NotifyRetry --> End2([⚠️ Grace Period])

    RetryPayment -->|>= 3| CancelSubscription[Webhook: subscription_cancelled]

    CancelSubscription --> DowngradeFree[Update user tier to 'free']
    DowngradeFree --> RevokeCredits[Set credits to 0]
    RevokeCredits --> NotifyCancelled[Send email:<br/>"Subscription cancelled"]
    NotifyCancelled --> End3([❌ Subscription Inactive])

    style PaymentSuccess fill:#FFE66D
    style AllocateCredits fill:#48C774
    style CancelSubscription fill:#FF6B6B
```

---

## GPU 스케일링 플로우

### Karpenter 자동 스케일링

```mermaid
flowchart TB
    Start[New GPU worker pod created] --> CheckNodes{Existing nodes<br/>with available GPU?}

    CheckNodes -->|Yes| SchedulePod[Schedule pod on existing node]
    SchedulePod --> End1([✅ Pod Running])

    CheckNodes -->|No| TriggerKarpenter[Trigger Karpenter]

    TriggerKarpenter --> CheckLimits{Within GPU limits?<br/>Current < 10 GPUs}

    CheckLimits -->|No| PodPending[Pod remains Pending<br/>Wait for node to free up]
    PodPending --> End2([⏳ Pending])

    CheckLimits -->|Yes| SelectInstance[Select instance type:<br/>1. g4dn.xlarge<br/>2. g4dn.2xlarge<br/>3. g5.xlarge]

    SelectInstance --> ProvisionSpot[Provision Spot instance<br/>EC2 API call]

    ProvisionSpot --> SpotAvailable{Spot available?}

    SpotAvailable -->|No| FallbackOnDemand[Fallback to On-Demand<br/>(if configured)]
    FallbackOnDemand --> NodeReady

    SpotAvailable -->|Yes| NodeReady[Node ready<br/>kubelet registers]

    NodeReady --> InstallDriver[Install NVIDIA drivers<br/>UserData script]

    InstallDriver --> LabelNode[Label node:<br/>workload-type=gpu<br/>instance-lifecycle=spot]

    LabelNode --> TaintNode[Taint node:<br/>nvidia.com/gpu:NoSchedule]

    TaintNode --> SchedulePod2[Schedule pending pod]

    SchedulePod2 --> End3([✅ Pod Running on new node])

    style TriggerKarpenter fill:#FF9F43
    style ProvisionSpot fill:#95E1D3
    style SchedulePod2 fill:#48C774
```

### Spot 인터럽션 처리

```mermaid
sequenceDiagram
    participant AWS as AWS EC2
    participant Node as Spot Instance
    participant TermHandler as Node Termination Handler
    participant K8s as Kubernetes
    participant Pod as GPU Worker Pod
    participant Redis as Redis Queue

    AWS->>Node: Spot Interruption Notice<br/>(2 minutes warning)

    Node->>TermHandler: EC2 Metadata API

    TermHandler->>K8s: Cordon node<br/>(prevent new pods)

    TermHandler->>K8s: Drain node<br/>(gracefully evict pods)

    K8s->>Pod: SIGTERM signal

    Pod->>Pod: Catch signal<br/>Graceful shutdown

    Pod->>Redis: Re-enqueue current job<br/>(if not completed)

    Pod->>K8s: Exit gracefully

    K8s->>K8s: Pod marked as Terminated

    K8s->>Karpenter: Trigger new node provision<br/>(if pending pods)

    Karpenter->>AWS: Launch new Spot instance

    Note over Pod,Redis: Job is retried by another worker<br/>No data loss
```

### Scale-to-Zero

```mermaid
stateDiagram-v2
    [*] --> NoJobs: No pending jobs in queue

    NoJobs --> Consolidation: Karpenter checks<br/>consolidateAfter: 30s

    Consolidation --> NodeEmpty: All pods evictable?

    state NodeEmpty <<choice>>
    NodeEmpty --> TerminateNode: Yes, no system pods
    NodeEmpty --> KeepNode: No, has system pods

    TerminateNode --> [*]: Node terminated<br/>Cost saving

    KeepNode --> NoJobs: Continue monitoring

    NoJobs --> NewJob: Job arrives in queue

    NewJob --> ProvisionNode: Karpenter provisions new node

    ProvisionNode --> [*]: Worker starts processing

    note right of Consolidation
        Karpenter consolidates every 30s
        Removes underutilized nodes
        Bin-packs pods efficiently
    end note
```

---

## 데이터 저장 플로우

### 이미지 저장 및 배포

```mermaid
flowchart LR
    Worker[GPU Worker] -->|1. Generate| LocalFile[/Local File<br/>/tmp/output.png/]

    LocalFile -->|2. Upload| S3Upload{S3 Upload}

    S3Upload -->|Original| S3Original[S3: images/<user_id>/<job_id>/original.png]

    S3Upload -->|Thumbnail| S3Thumb[S3: images/<user_id>/<job_id>/thumb.png]

    S3Original -->|3. Metadata| DBRecord[(PostgreSQL<br/>images table)]

    DBRecord -->|4. S3 Key| Response[API Response<br/>{image_url}]

    S3Original -->|5. Cache| CloudFront[CloudFront CDN<br/>Edge Locations]

    CloudFront -->|6. Deliver| EndUser[👤 End User]

    subgraph "Lifecycle Policy"
        S3Original -.->|90 days| S3IA[Infrequent Access]
        S3IA -.->|180 days| Glacier[Glacier]
    end

    style Worker fill:#95E1D3
    style S3Original fill:#48C774
    style CloudFront fill:#4A90E2
```

### AI 모델 로딩 플로우

```mermaid
sequenceDiagram
    participant Worker as GPU Worker
    participant Cache as Local Cache<br/>/tmp/models
    participant EFS as EFS<br/>/models
    participant S3 as S3<br/>pingvas-models-shared

    Worker->>Cache: Check model in cache

    alt Model in cache
        Cache->>Worker: Load from cache (fast)
    else Model not in cache
        Worker->>EFS: Check model in EFS

        alt Model in EFS
            EFS->>Cache: Copy to cache
            Cache->>Worker: Load from cache
        else Model not in EFS
            Worker->>S3: Download model

            S3->>EFS: Save to EFS
            EFS->>Cache: Copy to cache
            Cache->>Worker: Load from cache
        end
    end

    Worker->>Worker: Load into GPU memory

    Note over Worker,S3: Caching strategy:<br/>1. Local cache (fastest)<br/>2. EFS shared (fast)<br/>3. S3 (slower, but always available)
```

### 데이터베이스 스키마 격리

```mermaid
graph TB
    subgraph "Applications"
        DevApp[Dev Services<br/>NAMESPACE=dev]
        ProdApp[Prod Services<br/>NAMESPACE=prod]
    end

    subgraph "PostgreSQL Connection"
        DevApp -->|search_path=dev_pingvas| DevConn[Dev Connection]
        ProdApp -->|search_path=prod_pingvas| ProdConn[Prod Connection]
    end

    subgraph "RDS Aurora: pingvas_saas"
        DevConn --> DevSchema[(Schema: dev_pingvas<br/>users, images, jobs)]
        ProdConn --> ProdSchema[(Schema: prod_pingvas<br/>users, images, jobs)]
    end

    subgraph "Row-Level Security"
        DevSchema -.->|Policy| DevRLS[current_user_id filter]
        ProdSchema -.->|Policy| ProdRLS[current_user_id filter]
    end

    style DevApp fill:#4ECDC4
    style ProdApp fill:#FF6B6B
    style DevSchema fill:#95E1D3
    style ProdSchema fill:#FF9F43
```

---

## 에러 처리 플로우

### 이미지 생성 실패 처리

```mermaid
flowchart TB
    Start[Generation starts] --> Try{Try block}

    Try -->|Success| Complete[Update job status:<br/>completed]
    Complete --> End1([✅ Success])

    Try -->|Exception| CatchError[Catch Exception]

    CatchError --> ClassifyError{Classify Error}

    ClassifyError -->|OOM Error| HandleOOM[GPU Out of Memory]
    ClassifyError -->|Timeout| HandleTimeout[Generation Timeout]
    ClassifyError -->|Model Error| HandleModel[Model Load Failed]
    ClassifyError -->|S3 Error| HandleS3[Upload Failed]

    HandleOOM --> UpdateFailed[Update job:<br/>status = failed<br/>error_message]
    HandleTimeout --> UpdateFailed
    HandleModel --> UpdateFailed
    HandleS3 --> Retry{Retry count < 3?}

    Retry -->|Yes| RequeueJob[Re-enqueue to Redis]
    RequeueJob --> End2([🔄 Retry])

    Retry -->|No| UpdateFailed

    UpdateFailed --> RefundCredits[Refund reserved credits]
    RefundCredits --> NotifyUser[Notify user via webhook]
    NotifyUser --> End3([❌ Failed])

    style CatchError fill:#FF6B6B
    style RefundCredits fill:#FFE66D
    style NotifyUser fill:#4A90E2
```

### 재시도 전략

```mermaid
stateDiagram-v2
    [*] --> Attempt1: First attempt

    Attempt1 --> Success: Job completes
    Success --> [*]

    Attempt1 --> Failure1: Transient error

    Failure1 --> Backoff1: Wait 2^1 = 2 seconds
    Backoff1 --> Attempt2: Retry 1

    Attempt2 --> Success
    Attempt2 --> Failure2: Still failing

    Failure2 --> Backoff2: Wait 2^2 = 4 seconds
    Backoff2 --> Attempt3: Retry 2

    Attempt3 --> Success
    Attempt3 --> Failure3: Persistent error

    Failure3 --> Backoff3: Wait 2^3 = 8 seconds
    Backoff3 --> Attempt4: Retry 3 (Final)

    Attempt4 --> Success
    Attempt4 --> PermanentFailure: Give up

    PermanentFailure --> [*]: Mark as failed<br/>Refund credits

    note right of Backoff1
        Exponential backoff
        Prevents thundering herd
        Max retries: 3
    end note
```

---

## 캐싱 전략

### Redis 캐싱 레이어

```mermaid
graph TB
    Request[API Request] --> CheckCache{Check Redis Cache}

    CheckCache -->|Hit| ReturnCached[Return cached response<br/>⚡ Fast]
    ReturnCached --> End1([Response])

    CheckCache -->|Miss| QueryDB[Query PostgreSQL]

    QueryDB --> StoreCache[Store result in Redis<br/>TTL: 300 seconds]

    StoreCache --> ReturnFresh[Return fresh data]
    ReturnFresh --> End2([Response])

    subgraph "Cache Keys"
        UserKey[user:{user_id}]
        ImageKey[image:{image_id}]
        GalleryKey[gallery:{user_id}:page:{n}]
        ModelKey[models:list]
    end

    subgraph "Cache Invalidation"
        OnUpdate[On data update] --> DeleteKey[Delete cache key]
        OnTTL[On TTL expire] --> AutoEvict[Auto evict]
    end

    style CheckCache fill:#FFE66D
    style ReturnCached fill:#48C774
```

### CDN 캐싱 정책

```mermaid
graph LR
    User[User Request] -->|1. GET /images/xxx.png| CloudFront[CloudFront Edge]

    CloudFront --> EdgeCache{Cached at edge?}

    EdgeCache -->|Hit| ReturnEdge[Return from edge<br/>⚡⚡⚡ Fastest]
    ReturnEdge --> User

    EdgeCache -->|Miss| OriginRequest[Request from S3 Origin]

    OriginRequest --> S3[S3 Bucket]

    S3 --> CacheAtEdge[Cache at edge<br/>TTL: 86400s (24h)]

    CacheAtEdge --> ReturnToUser[Return to user]
    ReturnToUser --> User

    subgraph "Cache Headers"
        CacheControl[Cache-Control: max-age=86400]
        ETag[ETag: "abc123"]
    end

    style EdgeCache fill:#FFE66D
    style ReturnEdge fill:#48C774
```

---

## 요약

### 데이터 흐름 특징

✅ **동기 vs 비동기**
- 동기: 사용자 인증, 크레딧 조회, 갤러리 조회
- 비동기: 이미지 생성 (큐 기반)

✅ **일관성 보장**
- 크레딧 차감: `FOR UPDATE` 행 잠금
- 트랜잭션: ACID 보장
- 멱등성: 중복 요청 방지 (idempotency key)

✅ **성능 최적화**
- Redis 캐싱 (TTL 5분)
- CloudFront CDN (TTL 24시간)
- 데이터베이스 인덱싱
- 연결 풀링

✅ **확장성**
- 수평 확장: 마이크로서비스, GPU 워커
- 우선순위 큐: 티어별 공정성
- Spot 인스턴스: 비용 효율적 스케일링

✅ **신뢰성**
- 재시도 로직 (Exponential backoff)
- Spot 인터럽션 처리
- 크레딧 환불 (실패 시)
- 상세한 에러 로깅

---

**작성일**: 2025-01-23
**문서 버전**: Final v1.0
**총 라인 수**: 1,500+
