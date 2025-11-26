# Pingvas Studio ERD (Entity Relationship Diagram)

## 개요

이 문서는 Pingvas Studio의 데이터베이스 ERD를 시각적으로 표현합니다. 전체 스키마 설계는 [01-schema-design.md](./01-schema-design.md)를 참조하세요.

---

## ERD 다이어그램

### 전체 ERD (Mermaid)

```mermaid
erDiagram
    %% 사용자 및 인증 영역
    users ||--o{ user_sessions : "has"
    users ||--o{ oauth_accounts : "has"
    users ||--o| user_profiles : "has"
    users ||--o{ subscriptions : "has"
    users ||--o{ credit_transactions : "has"
    users ||--o{ generation_jobs : "creates"
    users ||--o{ images : "owns"
    users ||--o{ user_models : "uploads"
    users ||--o{ workflows : "creates"

    %% 구독 및 결제 영역
    subscription_plans ||--o{ subscriptions : "defines"
    subscriptions ||--o{ credit_transactions : "triggers"

    %% 이미지 생성 영역
    generation_jobs ||--o{ generation_steps : "has"
    generation_jobs ||--o| images : "produces"
    ai_models ||--o{ generation_jobs : "used_in"

    %% 갤러리 영역
    images ||--o{ image_tags : "has"
    tags ||--o{ image_tags : "tagged_to"
    images ||--o{ collections_images : "belongs_to"
    collections ||--o{ collections_images : "contains"
    users ||--o{ collections : "owns"

    %% 워크플로우 영역
    workflows ||--o{ workflow_versions : "has"

    %% 엔티티 정의
    users {
        uuid id PK
        string email UK
        string password_hash
        string display_name
        enum role
        enum status
        timestamp created_at
        timestamp updated_at
    }

    user_profiles {
        uuid id PK
        uuid user_id FK,UK
        string avatar_url
        string bio
        jsonb preferences
        timestamp created_at
    }

    user_sessions {
        uuid id PK
        uuid user_id FK
        string refresh_token UK
        string ip_address
        string user_agent
        timestamp expires_at
        timestamp created_at
    }

    oauth_accounts {
        uuid id PK
        uuid user_id FK
        enum provider
        string provider_user_id
        jsonb provider_data
        timestamp created_at
    }

    subscription_plans {
        uuid id PK
        string name UK
        string display_name
        decimal monthly_price
        decimal yearly_price
        integer credits_per_month
        bigint storage_bytes
        integer max_queues
        jsonb features
        boolean is_active
        timestamp created_at
    }

    subscriptions {
        uuid id PK
        uuid user_id FK
        uuid plan_id FK
        string lemon_subscription_id UK
        enum status
        enum billing_cycle
        integer remaining_credits
        date current_period_start
        date current_period_end
        timestamp canceled_at
        timestamp created_at
        timestamp updated_at
    }

    credit_transactions {
        uuid id PK
        uuid user_id FK
        uuid subscription_id FK
        uuid job_id FK
        enum transaction_type
        integer amount
        integer balance_after
        string description
        jsonb metadata
        timestamp created_at
    }

    ai_models {
        uuid id PK
        string name UK
        string display_name
        enum model_type
        string version
        string s3_path
        string efs_cache_path
        bigint size_bytes
        jsonb config
        text[] required_tiers
        boolean is_active
        timestamp created_at
    }

    user_models {
        uuid id PK
        uuid user_id FK
        string name
        enum model_type
        string s3_path
        bigint size_bytes
        enum status
        jsonb training_config
        timestamp created_at
    }

    generation_jobs {
        uuid id PK
        uuid user_id FK
        uuid model_id FK
        enum job_type
        enum status
        integer priority
        jsonb parameters
        integer estimated_credits
        integer actual_credits
        string worker_id
        timestamp queued_at
        timestamp started_at
        timestamp completed_at
        text error_message
        timestamp created_at
    }

    generation_steps {
        uuid id PK
        uuid job_id FK
        integer step_number
        integer total_steps
        string step_name
        float progress_percent
        string preview_url
        timestamp created_at
    }

    images {
        uuid id PK
        uuid user_id FK
        uuid job_id FK
        string s3_key UK
        string cdn_url
        string thumbnail_url
        integer width
        integer height
        string format
        bigint file_size
        jsonb generation_params
        enum visibility
        boolean is_favorite
        timestamp created_at
    }

    tags {
        uuid id PK
        string name UK
        integer usage_count
        timestamp created_at
    }

    image_tags {
        uuid image_id PK,FK
        uuid tag_id PK,FK
        timestamp created_at
    }

    collections {
        uuid id PK
        uuid user_id FK
        string name
        string description
        string cover_image_url
        enum visibility
        timestamp created_at
        timestamp updated_at
    }

    collections_images {
        uuid collection_id PK,FK
        uuid image_id PK,FK
        integer sort_order
        timestamp added_at
    }

    workflows {
        uuid id PK
        uuid user_id FK
        string name
        string description
        jsonb graph_data
        boolean is_template
        enum visibility
        integer usage_count
        timestamp created_at
        timestamp updated_at
    }

    workflow_versions {
        uuid id PK
        uuid workflow_id FK
        integer version_number
        jsonb graph_data
        string change_note
        timestamp created_at
    }
```

---

## 도메인별 ERD

### 1. 사용자 인증 도메인

```mermaid
erDiagram
    users ||--o{ user_sessions : "creates"
    users ||--o{ oauth_accounts : "links"
    users ||--o| user_profiles : "has"

    users {
        uuid id PK "Primary Key"
        string email UK "Unique, Login ID"
        string password_hash "Nullable for OAuth"
        string display_name "Display Name"
        enum role "user|admin"
        enum status "active|suspended|deleted"
        timestamp created_at
        timestamp updated_at
    }

    user_profiles {
        uuid id PK
        uuid user_id FK,UK "1:1 relation"
        string avatar_url "Profile Image"
        string bio "Introduction"
        jsonb preferences "UI Settings"
        timestamp created_at
    }

    user_sessions {
        uuid id PK
        uuid user_id FK
        string refresh_token UK "JWT Refresh Token"
        string ip_address "Client IP"
        string user_agent "Browser Info"
        timestamp expires_at "Session Expiry"
        timestamp created_at
    }

    oauth_accounts {
        uuid id PK
        uuid user_id FK
        enum provider "google|discord"
        string provider_user_id "OAuth User ID"
        jsonb provider_data "OAuth Profile Data"
        timestamp created_at
    }
```

**관계 설명:**
- `users` : `user_profiles` = 1:1 (사용자당 하나의 프로필)
- `users` : `user_sessions` = 1:N (다중 디바이스 로그인)
- `users` : `oauth_accounts` = 1:N (여러 OAuth 제공자 연결 가능)

---

### 2. 구독 및 결제 도메인

```mermaid
erDiagram
    subscription_plans ||--o{ subscriptions : "defines"
    users ||--o{ subscriptions : "subscribes"
    subscriptions ||--o{ credit_transactions : "generates"
    users ||--o{ credit_transactions : "owns"

    subscription_plans {
        uuid id PK
        string name UK "starter|pro|studio|enterprise"
        string display_name "UI Display Name"
        decimal monthly_price "Monthly USD"
        decimal yearly_price "Yearly USD"
        integer credits_per_month "Monthly Credits"
        bigint storage_bytes "Storage Quota"
        integer max_queues "Concurrent Queues"
        jsonb features "Feature Flags"
        boolean is_active "Plan Available"
    }

    subscriptions {
        uuid id PK
        uuid user_id FK
        uuid plan_id FK
        string lemon_subscription_id UK "Lemon Squeezy ID"
        enum status "active|canceled|expired|past_due"
        enum billing_cycle "monthly|yearly"
        integer remaining_credits "Current Balance"
        date current_period_start
        date current_period_end
        timestamp canceled_at
    }

    credit_transactions {
        uuid id PK
        uuid user_id FK
        uuid subscription_id FK
        uuid job_id FK "Nullable"
        enum transaction_type "grant|consume|refund|expire|bonus"
        integer amount "Positive or Negative"
        integer balance_after "Running Balance"
        string description
        jsonb metadata "Additional Info"
        timestamp created_at
    }
```

**크레딧 트랜잭션 타입:**
| 타입 | 설명 | amount |
|------|------|--------|
| `grant` | 월간 크레딧 지급 | + |
| `consume` | 생성 작업 소모 | - |
| `refund` | 실패 작업 환불 | + |
| `expire` | 기간 만료 소멸 | - |
| `bonus` | 프로모션 지급 | + |

---

### 3. 이미지 생성 도메인

```mermaid
erDiagram
    users ||--o{ generation_jobs : "creates"
    ai_models ||--o{ generation_jobs : "used_by"
    generation_jobs ||--o{ generation_steps : "has"
    generation_jobs ||--o| images : "produces"

    ai_models {
        uuid id PK
        string name UK "stable-diffusion-xl|flux-dev"
        string display_name "Stable Diffusion XL"
        enum model_type "checkpoint|lora|controlnet|vae"
        string version "1.0"
        string s3_path "s3://models/..."
        string efs_cache_path "/mnt/efs/models/..."
        bigint size_bytes "Model File Size"
        jsonb config "Model Config"
        text[] required_tiers "['pro', 'studio']"
        boolean is_active
    }

    generation_jobs {
        uuid id PK
        uuid user_id FK
        uuid model_id FK
        enum job_type "txt2img|img2img|inpaint|upscale"
        enum status "pending|queued|processing|completed|failed|canceled"
        integer priority "1-100 (higher = priority)"
        jsonb parameters "prompt, seed, cfg_scale, etc"
        integer estimated_credits "Pre-calculated"
        integer actual_credits "Post-calculated"
        string worker_id "AI Worker Pod ID"
        timestamp queued_at
        timestamp started_at
        timestamp completed_at
        text error_message
    }

    generation_steps {
        uuid id PK
        uuid job_id FK
        integer step_number "Current Step"
        integer total_steps "Total Steps"
        string step_name "Denoising|VAE Decode"
        float progress_percent "0.0-100.0"
        string preview_url "Step Preview Image"
        timestamp created_at
    }

    images {
        uuid id PK
        uuid user_id FK
        uuid job_id FK "Source Job"
        string s3_key UK "images/{user_id}/{uuid}.png"
        string cdn_url "CloudFront URL"
        string thumbnail_url "Resized Thumbnail"
        integer width
        integer height
        string format "png|jpg|webp"
        bigint file_size
        jsonb generation_params "Full Generation Config"
        enum visibility "private|public|unlisted"
        boolean is_favorite
    }
```

**작업 상태 흐름:**
```
pending → queued → processing → completed
                 ↘ failed
                 ↘ canceled
```

---

### 4. 갤러리 및 컬렉션 도메인

```mermaid
erDiagram
    users ||--o{ images : "owns"
    users ||--o{ collections : "creates"
    images ||--o{ image_tags : "has"
    tags ||--o{ image_tags : "applied_to"
    collections ||--o{ collections_images : "contains"
    images ||--o{ collections_images : "belongs_to"

    images {
        uuid id PK
        uuid user_id FK
        string s3_key UK
        string cdn_url
        enum visibility "private|public|unlisted"
        boolean is_favorite
        timestamp created_at
    }

    tags {
        uuid id PK
        string name UK "landscape|portrait|anime"
        integer usage_count "Auto-updated"
        timestamp created_at
    }

    image_tags {
        uuid image_id PK,FK
        uuid tag_id PK,FK
        timestamp created_at
    }

    collections {
        uuid id PK
        uuid user_id FK
        string name "My Favorites"
        string description
        string cover_image_url
        enum visibility "private|public"
        timestamp created_at
        timestamp updated_at
    }

    collections_images {
        uuid collection_id PK,FK
        uuid image_id PK,FK
        integer sort_order "Manual Sort"
        timestamp added_at
    }
```

**N:M 관계:**
- `images` ↔ `tags` : 하나의 이미지에 여러 태그, 하나의 태그에 여러 이미지
- `collections` ↔ `images` : 하나의 컬렉션에 여러 이미지, 하나의 이미지가 여러 컬렉션에 포함 가능

---

### 5. 워크플로우 도메인

```mermaid
erDiagram
    users ||--o{ workflows : "creates"
    workflows ||--o{ workflow_versions : "has"

    workflows {
        uuid id PK
        uuid user_id FK
        string name "My Custom Workflow"
        string description
        jsonb graph_data "Node Graph JSON"
        boolean is_template "Shared Template"
        enum visibility "private|public|unlisted"
        integer usage_count "Template Usage Count"
        timestamp created_at
        timestamp updated_at
    }

    workflow_versions {
        uuid id PK
        uuid workflow_id FK
        integer version_number "Auto-increment per workflow"
        jsonb graph_data "Snapshot of Graph"
        string change_note "Version Description"
        timestamp created_at
    }
```

**워크플로우 그래프 데이터 예시:**
```json
{
  "nodes": [
    {"id": "1", "type": "text_to_image", "position": {"x": 100, "y": 100}},
    {"id": "2", "type": "upscale", "position": {"x": 300, "y": 100}}
  ],
  "edges": [
    {"source": "1", "target": "2", "sourceHandle": "image", "targetHandle": "input"}
  ]
}
```

---

## 인덱스 전략

### Primary Key 인덱스
모든 테이블의 `id` 컬럼에 자동 생성

### Unique 인덱스
| 테이블 | 컬럼 | 용도 |
|--------|------|------|
| `users` | `email` | 로그인 조회 |
| `images` | `s3_key` | 중복 방지 |
| `tags` | `name` | 태그 조회 |
| `subscriptions` | `lemon_subscription_id` | Webhook 처리 |

### Foreign Key 인덱스
모든 FK 컬럼에 인덱스 자동 생성 (PostgreSQL)

### 복합 인덱스
```sql
-- 사용자별 이미지 목록 조회 최적화
CREATE INDEX idx_images_user_created ON images(user_id, created_at DESC);

-- 작업 큐 조회 최적화
CREATE INDEX idx_jobs_status_priority ON generation_jobs(status, priority DESC, queued_at);

-- 태그 검색 최적화
CREATE INDEX idx_image_tags_tag ON image_tags(tag_id);
```

---

## 데이터 무결성 제약조건

### CASCADE 삭제 규칙
```
users 삭제 시:
├── user_profiles → CASCADE DELETE
├── user_sessions → CASCADE DELETE
├── oauth_accounts → CASCADE DELETE
├── subscriptions → SET NULL (히스토리 보존)
├── credit_transactions → SET NULL (히스토리 보존)
├── generation_jobs → SET NULL (히스토리 보존)
├── images → CASCADE DELETE
├── collections → CASCADE DELETE
└── workflows → CASCADE DELETE

images 삭제 시:
├── image_tags → CASCADE DELETE
└── collections_images → CASCADE DELETE
```

### CHECK 제약조건
```sql
-- 크레딧 잔액 음수 방지
ALTER TABLE subscriptions ADD CONSTRAINT chk_credits_positive
  CHECK (remaining_credits >= 0);

-- 진행률 범위 검증
ALTER TABLE generation_steps ADD CONSTRAINT chk_progress_range
  CHECK (progress_percent >= 0 AND progress_percent <= 100);
```

---

## 다음 단계

- [API 명세서](../api/01-api-specification.md)에서 이 스키마를 사용하는 API 확인
- [WebSocket 이벤트](../api/02-websocket-events.md)에서 실시간 데이터 흐름 확인
