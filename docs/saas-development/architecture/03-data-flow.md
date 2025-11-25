# 데이터 흐름 및 시퀀스 다이어그램

## 개요

이 문서는 Pingvas Studio의 주요 사용자 시나리오에 대한 데이터 흐름과 시퀀스 다이어그램을 제공합니다.

---

## 1. 사용자 인증 흐름

### 1.1 이메일 회원가입/로그인

```mermaid
sequenceDiagram
    participant U as 사용자
    participant F as Frontend
    participant US as User Service
    participant DB as PostgreSQL
    participant R as Redis

    %% 회원가입
    U->>F: 회원가입 폼 제출
    F->>US: POST /api/v1/auth/register
    US->>DB: 이메일 중복 확인
    DB-->>US: 결과
    US->>DB: 사용자 생성
    US->>US: 비밀번호 해싱 (bcrypt)
    DB-->>US: 사용자 ID
    US->>R: 이메일 인증 토큰 저장
    US-->>F: 201 Created
    F-->>U: 이메일 인증 안내

    %% 로그인
    U->>F: 로그인 폼 제출
    F->>US: POST /api/v1/auth/login
    US->>DB: 사용자 조회
    DB-->>US: 사용자 정보
    US->>US: 비밀번호 검증
    US->>US: JWT Access Token 생성
    US->>R: Refresh Token 저장
    US-->>F: {access_token, refresh_token}
    F->>F: 토큰 저장 (httpOnly Cookie)
    F-->>U: 대시보드로 이동
```

### 1.2 Google/Discord OAuth 로그인

```mermaid
sequenceDiagram
    participant U as 사용자
    participant F as Frontend
    participant US as User Service
    participant OAuth as OAuth Provider
    participant DB as PostgreSQL
    participant R as Redis

    U->>F: "Google로 로그인" 클릭
    F->>US: GET /api/v1/auth/google
    US-->>F: Redirect to Google
    F-->>U: Google 로그인 페이지
    U->>OAuth: 로그인 및 권한 허용
    OAuth-->>US: GET /api/v1/auth/google/callback?code=xxx
    US->>OAuth: code로 access_token 요청
    OAuth-->>US: {access_token, user_info}
    US->>DB: 사용자 조회 또는 생성
    DB-->>US: 사용자 정보
    US->>R: Refresh Token 저장
    US-->>F: Redirect with tokens
    F->>F: 토큰 저장
    F-->>U: 대시보드로 이동
```

---

## 2. 이미지 생성 흐름

### 2.1 전체 생성 흐름

```mermaid
sequenceDiagram
    participant U as 사용자
    participant F as Frontend
    participant GS as Generation Service
    participant PS as Payment Service
    participant R as Redis
    participant W as AI Worker
    participant S3 as S3
    participant EFS as EFS
    participant DB as PostgreSQL

    %% 1. 생성 요청
    U->>F: 프롬프트 입력 및 생성 버튼 클릭
    F->>GS: POST /api/v1/generate/text-to-image
    Note over GS: JWT 토큰 검증

    %% 2. 크레딧 검증
    GS->>DB: 사용자 크레딧 조회
    DB-->>GS: 현재 크레딧
    alt 크레딧 부족
        GS-->>F: 402 Payment Required
        F-->>U: 크레딧 부족 알림
    end

    %% 3. 티어 기능 검증
    GS->>DB: 사용자 티어 조회
    DB-->>GS: 티어 정보
    alt Flux 모델 + Starter 티어
        GS-->>F: 403 Forbidden (기능 잠금)
        F-->>U: 업그레이드 필요 알림
    end

    %% 4. 크레딧 예약 및 큐 등록
    GS->>DB: 크레딧 예약
    GS->>R: 작업 큐에 등록 (티어별 큐)
    R-->>GS: job_id
    GS-->>F: 202 Accepted {job_id}

    %% 5. WebSocket 연결
    F->>GS: WS /ws/queue/{queue_id}
    GS-->>F: WebSocket 연결 완료

    %% 6. AI Worker 처리
    W->>R: 큐에서 작업 가져오기 (우선순위순)
    R-->>W: 작업 데이터
    W->>EFS: 모델 로드 (Warm Cache)
    EFS-->>W: 모델 데이터

    loop 생성 진행
        W->>W: 이미지 생성 (스텝별)
        W->>R: PUBLISH progress_event
        R->>GS: 이벤트 수신
        GS->>F: WebSocket 진행률 전송
        F->>F: 프로그레스 바 업데이트
        F-->>U: 진행률 표시 (25%, 50%...)
    end

    %% 7. 결과 저장
    W->>S3: 이미지 업로드
    S3-->>W: image_url
    W->>DB: 메타데이터 저장

    %% 8. 크레딧 정산
    W->>W: 소요 시간 계산
    W->>DB: 크레딧 차감 (예약 → 확정)

    %% 9. 완료 알림
    W->>R: PUBLISH completion_event
    R->>GS: 완료 이벤트 수신
    GS->>F: WebSocket 완료 전송
    F-->>U: 생성된 이미지 표시
```

### 2.2 크레딧 차감 상세

```mermaid
flowchart TB
    subgraph 요청단계["요청 단계"]
        A[생성 요청] --> B{크레딧 충분?}
        B -->|아니오| C[402 에러 반환]
        B -->|예| D[예상 크레딧 계산]
        D --> E[크레딧 예약<br/>reserved_credits 테이블]
    end

    subgraph 처리단계["처리 단계"]
        E --> F[AI Worker 작업 시작]
        F --> G[시작 시간 기록]
        G --> H[이미지 생성]
        H --> I[종료 시간 기록]
    end

    subgraph 정산단계["정산 단계"]
        I --> J{내부 GPU?}
        J -->|예| K[실제 소요시간 × 1 크레딧/초]
        J -->|아니오| L[외부 API: 20 크레딧/회]
        K --> M[실제 사용 크레딧 계산]
        L --> M
        M --> N[예약 → 확정 크레딧 이동]
        N --> O[잔여 예약 크레딧 환불]
    end

    subgraph 에러처리["에러 처리"]
        H -->|에러 발생| P[예약 크레딧 전액 환불]
        P --> Q[에러 알림]
    end
```

---

## 3. 결제/구독 흐름

### 3.1 신규 구독

```mermaid
sequenceDiagram
    participant U as 사용자
    participant F as Frontend
    participant PayS as Payment Service
    participant LS as Lemon Squeezy
    participant DB as PostgreSQL
    participant US as User Service

    %% 1. 플랜 선택
    U->>F: Pro 플랜 선택
    F->>PayS: POST /api/v1/subscriptions/checkout
    PayS->>LS: Create Checkout Session
    LS-->>PayS: checkout_url
    PayS-->>F: {checkout_url}
    F-->>U: Lemon Squeezy 결제 페이지로 이동

    %% 2. 결제 완료
    U->>LS: 결제 정보 입력 및 완료
    LS->>LS: 결제 처리

    %% 3. 웹훅 전송
    LS->>PayS: POST /api/v1/webhooks/lemon-squeezy<br/>{event: subscription_created}
    Note over PayS: 웹훅 시그니처 검증
    PayS->>DB: 구독 정보 저장
    PayS->>DB: 사용자 티어 업데이트 (starter → pro)
    PayS->>DB: 크레딧 충전 (15,000)
    PayS->>DB: 스토리지 할당량 업데이트 (100GB)
    PayS-->>LS: 200 OK

    %% 4. 사용자 알림
    LS-->>U: 결제 완료 페이지
    U->>F: 대시보드로 복귀
    F->>US: GET /api/v1/users/me
    US->>DB: 사용자 정보 조회
    DB-->>US: 업데이트된 정보
    US-->>F: {tier: "pro", credits: 15000}
    F-->>U: 업그레이드 완료 표시
```

### 3.2 구독 업그레이드

```mermaid
sequenceDiagram
    participant U as 사용자
    participant F as Frontend
    participant PayS as Payment Service
    participant LS as Lemon Squeezy
    participant DB as PostgreSQL

    U->>F: "Studio로 업그레이드" 클릭
    F->>F: 확인 모달 표시<br/>"지금 업그레이드하면 갱신기간이 15일 남았는데,<br/>즉시 업그레이드 되며, 크레딧은<br/>업그레이드한 플랜 크레딧으로<br/>새로 갱신됩니다."
    U->>F: "진행" 클릭
    F->>PayS: POST /api/v1/subscriptions/upgrade
    PayS->>LS: Update Subscription
    LS-->>PayS: subscription_updated
    LS->>PayS: Webhook: subscription_updated
    PayS->>DB: 티어 변경 (pro → studio)
    PayS->>DB: 크레딧 갱신 (→ 30,000)
    PayS->>DB: 스토리지 업데이트 (→ 200GB)
    PayS->>DB: 큐 개수 업데이트 (1 → 3)
    PayS-->>LS: 200 OK
    F-->>U: 업그레이드 완료
```

### 3.3 구독 취소 및 만료

```mermaid
sequenceDiagram
    participant U as 사용자
    participant F as Frontend
    participant PayS as Payment Service
    participant LS as Lemon Squeezy
    participant DB as PostgreSQL
    participant Cron as Celery Beat

    %% 구독 취소
    U->>F: "구독 취소" 클릭
    F->>PayS: POST /api/v1/subscriptions/cancel
    PayS->>LS: Cancel Subscription
    LS-->>PayS: {ends_at: "2025-12-25T00:00:00Z"}
    PayS->>DB: 취소 예정 상태 저장
    PayS-->>F: {status: "cancelling", ends_at}
    F-->>U: "12월 25일까지 사용 가능" 표시

    %% 매일 자정 체크
    loop 매일 00:00 UTC
        Cron->>PayS: process_expired_subscriptions()
        PayS->>DB: 만료된 구독 조회
        DB-->>PayS: 만료 구독 목록
    end

    %% 만료 처리
    Note over PayS: ends_at 도달
    PayS->>DB: 티어 다운그레이드 (→ free/제한)
    PayS->>DB: 잔여 크레딧 회수
    PayS->>DB: 스토리지 할당량 제거
    PayS->>PayS: 스토리지 초과 시 경고 이메일 발송
```

---

## 4. 티어별 기능 제한 흐름

### 4.1 Feature Flag 검증

```mermaid
flowchart TB
    subgraph 요청["API 요청"]
        A[이미지 생성 요청]
        B[모델: Flux]
    end

    subgraph 검증["미들웨어 검증"]
        C{사용자 티어 확인}
        D[Starter]
        E[Pro]
        F[Studio]
        G[Enterprise]
    end

    subgraph 기능확인["기능 권한 확인"]
        H{Flux 모델 허용?}
        I[거부: 403 Forbidden]
        J[허용: 계속 진행]
    end

    A --> B --> C
    C --> D
    C --> E
    C --> F
    C --> G

    D --> H
    H -->|아니오| I
    E --> H
    F --> H
    G --> H
    H -->|예| J
```

### 4.2 큐 우선순위 처리

```mermaid
flowchart LR
    subgraph 요청["사용자 요청"]
        E1[Enterprise 사용자]
        S1[Studio 사용자]
        P1[Pro 사용자]
        St1[Starter 사용자]
    end

    subgraph 큐["Redis 큐"]
        QE[queue:enterprise<br/>우선순위: 1]
        QS[queue:studio<br/>우선순위: 2]
        QP[queue:pro<br/>우선순위: 3]
        QSt[queue:starter<br/>우선순위: 4]
    end

    subgraph Worker["AI Worker"]
        W[Worker]
        W1[1. enterprise 확인]
        W2[2. studio 확인]
        W3[3. pro 확인]
        W4[4. starter 확인]
    end

    E1 --> QE
    S1 --> QS
    P1 --> QP
    St1 --> QSt

    W --> W1
    W1 -->|비어있으면| W2
    W2 -->|비어있으면| W3
    W3 -->|비어있으면| W4

    QE -.->|작업 있으면| W1
    QS -.->|작업 있으면| W2
    QP -.->|작업 있으면| W3
    QSt -.->|작업 있으면| W4
```

---

## 5. WebSocket 실시간 통신 흐름

### 5.1 연결 및 구독

```mermaid
sequenceDiagram
    participant F as Frontend
    participant GS as Generation Service
    participant R as Redis

    F->>GS: WebSocket Connect<br/>/ws/socket.io
    GS-->>F: Connected (sid: abc123)

    F->>GS: subscribe_queue<br/>{queue_id: "user_123"}
    GS->>GS: Room 추가 (user_123)
    GS-->>F: subscribed

    Note over F,GS: 이제 user_123의 모든<br/>이벤트를 수신합니다

    %% 이벤트 수신
    R->>GS: PUBLISH progress_event<br/>{queue_id: "user_123", ...}
    GS->>GS: Room "user_123" 조회
    GS->>F: invocation_progress<br/>{job_id, progress: 50, ...}
    F->>F: UI 업데이트
```

### 5.2 이벤트 타입

```mermaid
flowchart TB
    subgraph Events["WebSocket 이벤트"]
        direction TB
        QE[큐 이벤트]
        ME[모델 이벤트]
        SE[시스템 이벤트]
    end

    subgraph QueueEvents["큐 이벤트"]
        Q1[invocation_started<br/>작업 시작]
        Q2[invocation_progress<br/>진행률 업데이트]
        Q3[invocation_complete<br/>작업 완료]
        Q4[invocation_error<br/>작업 실패]
        Q5[queue_item_status_changed<br/>상태 변경]
    end

    subgraph ModelEvents["모델 이벤트"]
        M1[model_load_started<br/>모델 로드 시작]
        M2[model_load_complete<br/>모델 로드 완료]
        M3[model_install_progress<br/>설치 진행률]
    end

    subgraph SystemEvents["시스템 이벤트"]
        S1[connected<br/>연결 완료]
        S2[disconnected<br/>연결 끊김]
        S3[error<br/>오류]
    end

    QE --> Q1 & Q2 & Q3 & Q4 & Q5
    ME --> M1 & M2 & M3
    SE --> S1 & S2 & S3
```

---

## 6. 논리적 데이터 흐름

### 6.1 전체 시스템 데이터 흐름

```mermaid
flowchart TB
    subgraph Client["클라이언트 계층"]
        Browser["웹 브라우저"]
        Redux["Redux Store"]
        Socket["Socket.IO Client"]
    end

    subgraph Gateway["API Gateway"]
        Nginx["Nginx Ingress"]
        JWT["JWT 검증"]
    end

    subgraph Services["서비스 계층"]
        US["User Service"]
        GS["Generation Service"]
        PS["Payment Service"]
        GaS["Gallery Service"]
    end

    subgraph Queue["메시지 큐"]
        RedisQ["Redis Queue"]
        RedisPubSub["Redis Pub/Sub"]
    end

    subgraph Workers["워커 계층"]
        AW1["AI Worker 1"]
        AW2["AI Worker 2"]
    end

    subgraph Storage["스토리지 계층"]
        PG["PostgreSQL"]
        S3["S3"]
        EFS["EFS"]
    end

    %% 클라이언트 → 서비스
    Browser -->|HTTP/WS| Nginx
    Nginx -->|검증| JWT
    JWT -->|라우팅| US & GS & PS & GaS

    %% 서비스 → 데이터
    US --> PG
    GS --> PG
    PS --> PG
    GaS --> PG & S3

    %% 생성 흐름
    GS -->|작업 등록| RedisQ
    RedisQ -->|작업 가져오기| AW1 & AW2
    AW1 & AW2 -->|모델 로드| EFS
    AW1 & AW2 -->|이미지 저장| S3
    AW1 & AW2 -->|진행률| RedisPubSub
    RedisPubSub -->|이벤트| GS
    GS -->|WebSocket| Socket
    Socket -->|상태 업데이트| Redux
    Redux -->|렌더링| Browser
```

### 6.2 데이터 저장 위치

```mermaid
flowchart LR
    subgraph PostgreSQL["PostgreSQL"]
        users["users<br/>사용자 정보"]
        subscriptions["subscriptions<br/>구독 정보"]
        credits["credits<br/>크레딧 내역"]
        images_meta["images<br/>이미지 메타데이터"]
        boards["boards<br/>보드/컬렉션"]
        workflows["workflows<br/>워크플로우"]
    end

    subgraph Redis["Redis"]
        sessions["sessions:*<br/>세션 데이터"]
        cache["cache:*<br/>API 캐시"]
        queue["queue:*<br/>작업 큐"]
        pubsub["pubsub<br/>실시간 이벤트"]
    end

    subgraph S3["S3"]
        images["images/<br/>생성된 이미지"]
        thumbnails["thumbnails/<br/>썸네일"]
        assets["assets/<br/>정적 파일"]
    end

    subgraph EFS["EFS"]
        models["models/<br/>AI 모델"]
        lora["lora/<br/>LoRA 모델"]
        shared["shared/<br/>공유 파일"]
    end
```

---

## 7. 에러 처리 흐름

### 7.1 API 에러 처리

```mermaid
flowchart TB
    A[API 요청] --> B{인증 확인}
    B -->|실패| C[401 Unauthorized]
    B -->|성공| D{권한 확인}
    D -->|실패| E[403 Forbidden]
    D -->|성공| F{입력 검증}
    F -->|실패| G[400 Bad Request]
    F -->|성공| H{리소스 존재}
    H -->|없음| I[404 Not Found]
    H -->|있음| J{크레딧 확인}
    J -->|부족| K[402 Payment Required]
    J -->|충분| L{처리}
    L -->|에러| M[500 Internal Error]
    L -->|성공| N[200 OK / 201 Created]

    subgraph 에러응답["에러 응답 형식"]
        R["{<br/>error_code: string,<br/>message: string,<br/>details?: object<br/>}"]
    end
```

### 7.2 AI Worker 에러 복구

```mermaid
flowchart TB
    A[작업 시작] --> B[모델 로드]
    B -->|실패| C{재시도 가능?}
    C -->|예| D[3회 재시도]
    D -->|성공| E[작업 계속]
    D -->|실패| F[작업 실패 처리]
    C -->|아니오| F
    B -->|성공| G[이미지 생성]
    G -->|OOM| H[메모리 부족 에러]
    G -->|Timeout| I[타임아웃 에러]
    G -->|기타 에러| J[일반 에러]
    H & I & J --> K[크레딧 환불]
    K --> L[에러 이벤트 발행]
    G -->|성공| M[결과 저장]
    M -->|S3 에러| N[로컬 임시 저장 후 재시도]
    M -->|성공| O[완료 이벤트 발행]
```

---

## 다이어그램 파일

상세 다이어그램은 다음 파일에서 확인할 수 있습니다:
- Mermaid: `../diagrams/data-flow.mmd`
- Draw.io: `../diagrams/data-flow.drawio`
- SVG: `../diagrams/sequence-diagrams.svg`

---

## 다음 단계

1. [DB 스키마 설계](../database/01-schema-design.md)에서 테이블 구조를 확인합니다.
2. [API 명세서](../api/01-api-specification.md)에서 상세 API를 확인합니다.
3. [WebSocket 이벤트 명세](../api/02-websocket-events.md)에서 이벤트 형식을 확인합니다.
