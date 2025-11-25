# API 명세서

## 개요

Pingvas Studio API는 RESTful 원칙을 따르며, JWT 기반 인증을 사용합니다.

### 기본 정보
- **Base URL**: `https://api.studio.pingvas.com/api/v1`
- **인증**: Bearer Token (JWT)
- **Content-Type**: `application/json`
- **Rate Limiting**: 티어별 차등 적용

### 응답 형식

**성공 응답**
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "page": 1,
    "per_page": 20,
    "total": 100
  }
}
```

**에러 응답**
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "크레딧이 부족합니다.",
    "details": {
      "required": 100,
      "available": 50
    }
  }
}
```

---

## 인증 API

### POST /auth/register
회원가입

**Request**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "name": "홍길동"
}
```

**Response (201)**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "name": "홍길동",
    "email_verified": false
  },
  "message": "인증 이메일이 발송되었습니다."
}
```

**Errors**
| Code | Status | Description |
|------|--------|-------------|
| EMAIL_EXISTS | 409 | 이미 사용 중인 이메일 |
| INVALID_EMAIL | 400 | 유효하지 않은 이메일 형식 |
| WEAK_PASSWORD | 400 | 비밀번호 요구사항 미충족 |

---

### POST /auth/login
로그인

**Request**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response (200)**
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
    "token_type": "Bearer",
    "expires_in": 3600,
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "name": "홍길동",
      "tier": "pro",
      "credits": 15000
    }
  }
}
```

---

### POST /auth/refresh
토큰 갱신

**Request**
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response (200)**
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    "expires_in": 3600
  }
}
```

---

### GET /auth/google
Google OAuth 시작

**Response**: Redirect to Google OAuth

---

### GET /auth/google/callback
Google OAuth 콜백

**Query Parameters**
- `code`: OAuth authorization code
- `state`: CSRF 방지 토큰

**Response**: Redirect with tokens

---

### GET /auth/discord
Discord OAuth 시작

---

### GET /auth/discord/callback
Discord OAuth 콜백

---

## 사용자 API

### GET /users/me
현재 사용자 정보 조회

**Headers**
```
Authorization: Bearer {access_token}
```

**Response (200)**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "name": "홍길동",
    "avatar_url": "https://...",
    "tier": "pro",
    "credits": 14500,
    "storage_used": 5368709120,
    "storage_quota": 107374182400,
    "subscription": {
      "plan": "pro",
      "status": "active",
      "current_period_end": "2025-12-25T00:00:00Z"
    },
    "features": {
      "sd_models": true,
      "flux_model": true,
      "nano_banana_api": true,
      "lora_training": false,
      "queue_count": 1
    },
    "created_at": "2024-01-15T10:30:00Z"
  }
}
```

---

### PATCH /users/me
프로필 수정

**Request**
```json
{
  "name": "김철수",
  "avatar_url": "https://..."
}
```

**Response (200)**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "김철수",
    "avatar_url": "https://..."
  }
}
```

---

### GET /users/me/credits
크레딧 잔액 및 내역 조회

**Query Parameters**
- `page`: 페이지 번호 (기본: 1)
- `per_page`: 페이지당 항목 수 (기본: 20, 최대: 100)
- `type`: 거래 유형 필터 (optional)

**Response (200)**
```json
{
  "success": true,
  "data": {
    "balance": 14500,
    "reserved": 100,
    "available": 14400,
    "transactions": [
      {
        "id": "tx-001",
        "type": "generation_use",
        "amount": -45,
        "description": "이미지 생성 (45초)",
        "balance_after": 14500,
        "created_at": "2025-11-25T10:30:00Z"
      },
      {
        "id": "tx-002",
        "type": "subscription_grant",
        "amount": 15000,
        "description": "Pro 플랜 월간 크레딧",
        "balance_after": 14545,
        "created_at": "2025-11-01T00:00:00Z"
      }
    ]
  },
  "meta": {
    "page": 1,
    "per_page": 20,
    "total": 45
  }
}
```

---

### GET /users/me/usage
사용량 통계 조회

**Query Parameters**
- `period`: day, week, month (기본: month)

**Response (200)**
```json
{
  "success": true,
  "data": {
    "period": "month",
    "start_date": "2025-11-01",
    "end_date": "2025-11-25",
    "summary": {
      "total_generations": 156,
      "total_credits_used": 4520,
      "total_images_created": 312,
      "storage_used_bytes": 5368709120,
      "api_calls": 23
    },
    "daily": [
      {
        "date": "2025-11-25",
        "generations": 12,
        "credits_used": 340,
        "images_created": 24
      }
    ],
    "by_model": [
      {
        "model": "stable-diffusion-xl",
        "generations": 100,
        "credits_used": 3000
      },
      {
        "model": "flux",
        "generations": 56,
        "credits_used": 1520
      }
    ]
  }
}
```

---

## 이미지 생성 API

### POST /generate/text-to-image
텍스트에서 이미지 생성

**Request**
```json
{
  "prompt": "A beautiful sunset over mountains, highly detailed, 4k",
  "negative_prompt": "blurry, low quality, watermark",
  "model": "stable-diffusion-xl",
  "width": 1024,
  "height": 1024,
  "steps": 30,
  "cfg_scale": 7.5,
  "sampler": "euler_a",
  "seed": -1,
  "batch_size": 1,
  "loras": [
    {
      "name": "add_detail",
      "weight": 0.8
    }
  ],
  "controlnet": {
    "model": "canny",
    "image": "base64_encoded_image",
    "weight": 1.0
  },
  "save_to_board": "board-id-optional"
}
```

**Response (202)**
```json
{
  "success": true,
  "data": {
    "job_id": "job-550e8400-e29b-41d4",
    "status": "queued",
    "queue_position": 3,
    "estimated_wait_seconds": 45,
    "estimated_credits": 30,
    "websocket_channel": "user_550e8400"
  }
}
```

**Errors**
| Code | Status | Description |
|------|--------|-------------|
| INSUFFICIENT_CREDITS | 402 | 크레딧 부족 |
| MODEL_NOT_AVAILABLE | 403 | 티어에서 사용 불가능한 모델 |
| INVALID_PARAMETERS | 400 | 잘못된 파라미터 |
| QUOTA_EXCEEDED | 429 | 큐 제한 초과 |

---

### POST /generate/image-to-image
이미지에서 이미지 생성

**Request**
```json
{
  "prompt": "Add cyberpunk style lighting",
  "negative_prompt": "blurry",
  "model": "stable-diffusion-xl",
  "source_image": "base64_or_image_id",
  "strength": 0.75,
  "steps": 30,
  "cfg_scale": 7.5
}
```

---

### POST /generate/upscale
이미지 업스케일

**Request**
```json
{
  "image": "image_id_or_base64",
  "scale": 2,
  "model": "real-esrgan"
}
```

---

### POST /generate/inpaint
인페인팅

**Request**
```json
{
  "prompt": "A red sports car",
  "source_image": "image_id_or_base64",
  "mask_image": "base64_mask",
  "model": "stable-diffusion-xl",
  "steps": 30
}
```

---

### POST /generate/workflow
워크플로우 실행

**Request**
```json
{
  "workflow_id": "workflow-uuid",
  "inputs": {
    "prompt": "Custom prompt",
    "seed": 12345
  }
}
```

---

## 큐 관리 API

### GET /queue/status
큐 상태 조회

**Response (200)**
```json
{
  "success": true,
  "data": {
    "active_jobs": 2,
    "queued_jobs": 5,
    "completed_today": 45,
    "processing": [
      {
        "job_id": "job-001",
        "status": "processing",
        "progress": 65,
        "started_at": "2025-11-25T10:30:00Z"
      }
    ],
    "queued": [
      {
        "job_id": "job-002",
        "status": "queued",
        "position": 1,
        "queued_at": "2025-11-25T10:31:00Z"
      }
    ]
  }
}
```

---

### GET /queue/items
큐 아이템 목록

**Query Parameters**
- `status`: queued, processing, completed, failed (optional)
- `page`: 페이지 번호
- `per_page`: 페이지당 항목 수

---

### DELETE /queue/items/{job_id}
작업 취소

**Response (200)**
```json
{
  "success": true,
  "data": {
    "job_id": "job-001",
    "status": "cancelled",
    "credits_refunded": 30
  }
}
```

---

### GET /queue/items/{job_id}
작업 상세 조회

**Response (200)**
```json
{
  "success": true,
  "data": {
    "job_id": "job-001",
    "status": "completed",
    "job_type": "text_to_image",
    "params": {
      "prompt": "...",
      "model": "stable-diffusion-xl"
    },
    "credits_used": 45,
    "result": {
      "image_id": "img-001",
      "image_url": "https://..."
    },
    "queued_at": "2025-11-25T10:30:00Z",
    "started_at": "2025-11-25T10:31:00Z",
    "completed_at": "2025-11-25T10:32:15Z"
  }
}
```

---

## 갤러리 API

### GET /images
이미지 목록 조회

**Query Parameters**
- `page`: 페이지 번호
- `per_page`: 페이지당 항목 수 (최대: 50)
- `board_id`: 보드 필터 (optional)
- `starred`: true/false (optional)
- `sort`: created_at, file_size (기본: created_at)
- `order`: asc, desc (기본: desc)

**Response (200)**
```json
{
  "success": true,
  "data": [
    {
      "id": "img-001",
      "thumbnail_url": "https://...",
      "full_url": "https://...",
      "width": 1024,
      "height": 1024,
      "file_size": 2048576,
      "is_starred": false,
      "created_at": "2025-11-25T10:30:00Z",
      "metadata": {
        "model": "stable-diffusion-xl",
        "prompt": "A beautiful sunset..."
      }
    }
  ],
  "meta": {
    "page": 1,
    "per_page": 20,
    "total": 312
  }
}
```

---

### GET /images/{image_id}
이미지 상세 조회

**Response (200)**
```json
{
  "success": true,
  "data": {
    "id": "img-001",
    "thumbnail_url": "https://...",
    "full_url": "https://...",
    "width": 1024,
    "height": 1024,
    "file_size": 2048576,
    "mime_type": "image/png",
    "is_starred": false,
    "is_public": false,
    "share_url": null,
    "boards": [
      {
        "id": "board-001",
        "name": "My Collection"
      }
    ],
    "metadata": {
      "model": "stable-diffusion-xl",
      "model_hash": "abc123...",
      "prompt": "A beautiful sunset over mountains",
      "negative_prompt": "blurry, low quality",
      "steps": 30,
      "cfg_scale": 7.5,
      "seed": 12345678,
      "sampler": "euler_a",
      "loras": [
        {"name": "add_detail", "weight": 0.8}
      ]
    },
    "generation_job_id": "job-001",
    "created_at": "2025-11-25T10:30:00Z"
  }
}
```

---

### DELETE /images/{image_id}
이미지 삭제

---

### POST /images/{image_id}/star
즐겨찾기 추가

---

### DELETE /images/{image_id}/star
즐겨찾기 제거

---

### POST /images/{image_id}/share
공유 링크 생성

**Response (200)**
```json
{
  "success": true,
  "data": {
    "share_url": "https://studio.pingvas.com/shared/abc123xyz",
    "share_token": "abc123xyz",
    "expires_at": null
  }
}
```

---

## 보드 API

### GET /boards
보드 목록

---

### POST /boards
보드 생성

**Request**
```json
{
  "name": "My Collection",
  "description": "Best AI artworks"
}
```

---

### PATCH /boards/{board_id}
보드 수정

---

### DELETE /boards/{board_id}
보드 삭제

---

### POST /boards/{board_id}/images
보드에 이미지 추가

**Request**
```json
{
  "image_ids": ["img-001", "img-002"]
}
```

---

### DELETE /boards/{board_id}/images/{image_id}
보드에서 이미지 제거

---

## 구독 API

### GET /subscriptions/plans
플랜 목록

**Response (200)**
```json
{
  "success": true,
  "data": [
    {
      "id": "plan-starter",
      "name": "starter",
      "display_name": "Starter",
      "monthly_price": 25.00,
      "yearly_price": 250.00,
      "credits": 5000,
      "storage_gb": 20,
      "queue_count": 1,
      "features": {
        "sd_models": true,
        "flux_model": false,
        "nano_banana_api": false,
        "lora_training": false
      }
    },
    {
      "id": "plan-pro",
      "name": "pro",
      "display_name": "Pro",
      "monthly_price": 75.00,
      "yearly_price": 750.00,
      "credits": 15000,
      "storage_gb": 100,
      "queue_count": 1,
      "features": {
        "sd_models": true,
        "flux_model": true,
        "nano_banana_api": true,
        "lora_training": false
      }
    }
  ]
}
```

---

### GET /subscriptions/current
현재 구독 조회

**Response (200)**
```json
{
  "success": true,
  "data": {
    "id": "sub-001",
    "plan": {
      "name": "pro",
      "display_name": "Pro"
    },
    "status": "active",
    "billing_cycle": "monthly",
    "current_period_start": "2025-11-01T00:00:00Z",
    "current_period_end": "2025-12-01T00:00:00Z",
    "cancel_at_period_end": false,
    "payment_method": {
      "type": "card",
      "last_four": "4242",
      "brand": "visa"
    }
  }
}
```

---

### POST /subscriptions/checkout
체크아웃 세션 생성

**Request**
```json
{
  "plan": "pro",
  "billing_cycle": "monthly"
}
```

**Response (200)**
```json
{
  "success": true,
  "data": {
    "checkout_url": "https://pingvas.lemonsqueezy.com/checkout/...",
    "expires_at": "2025-11-25T11:30:00Z"
  }
}
```

---

### POST /subscriptions/upgrade
구독 업그레이드

**Request**
```json
{
  "target_plan": "studio"
}
```

**Response (200)**
```json
{
  "success": true,
  "data": {
    "previous_plan": "pro",
    "new_plan": "studio",
    "effective_immediately": true,
    "credits_granted": 30000,
    "message": "Studio 플랜으로 업그레이드되었습니다."
  }
}
```

---

### POST /subscriptions/cancel
구독 취소

**Request**
```json
{
  "reason": "Too expensive",
  "feedback": "Optional feedback"
}
```

**Response (200)**
```json
{
  "success": true,
  "data": {
    "status": "cancelling",
    "ends_at": "2025-12-01T00:00:00Z",
    "message": "구독이 2025년 12월 1일에 종료됩니다."
  }
}
```

---

## 웹훅 API

### POST /webhooks/lemon-squeezy
Lemon Squeezy 웹훅 수신

**Headers**
```
X-Signature: sha256=...
Content-Type: application/json
```

**Request Body** (Lemon Squeezy 형식)
```json
{
  "meta": {
    "event_name": "subscription_created",
    "custom_data": {
      "user_id": "user-uuid"
    }
  },
  "data": {
    "type": "subscriptions",
    "id": "1234",
    "attributes": {
      "store_id": 12345,
      "customer_id": 67890,
      "variant_id": 11111,
      "variant_name": "Pro Monthly",
      "status": "active",
      "trial_ends_at": null,
      "renews_at": "2025-12-01T00:00:00Z",
      "ends_at": null,
      "created_at": "2025-11-01T00:00:00Z",
      "updated_at": "2025-11-01T00:00:00Z"
    }
  }
}
```

**Response (200)**
```json
{
  "success": true
}
```

---

## 모델 API

### GET /models
사용 가능한 모델 목록

**Query Parameters**
- `type`: main, vae, lora, controlnet (optional)
- `base`: sd-1, sd-2, sdxl, flux (optional)

**Response (200)**
```json
{
  "success": true,
  "data": [
    {
      "id": "model-001",
      "name": "stable-diffusion-xl",
      "display_name": "Stable Diffusion XL",
      "type": "main",
      "base": "sdxl",
      "description": "High-quality image generation",
      "thumbnail_url": "https://...",
      "min_tier": "starter",
      "is_available": true
    },
    {
      "id": "model-002",
      "name": "flux-dev",
      "display_name": "FLUX.1 Dev",
      "type": "main",
      "base": "flux",
      "description": "State-of-the-art image quality",
      "thumbnail_url": "https://...",
      "min_tier": "pro",
      "is_available": true
    }
  ]
}
```

---

## 워크플로우 API

### GET /workflows
워크플로우 목록

---

### POST /workflows
워크플로우 생성

**Request**
```json
{
  "name": "Portrait Enhancer",
  "description": "Enhance portrait photos",
  "definition": { /* InvokeAI workflow JSON */ },
  "is_public": false
}
```

---

### GET /workflows/{workflow_id}
워크플로우 상세

---

### PATCH /workflows/{workflow_id}
워크플로우 수정

---

### DELETE /workflows/{workflow_id}
워크플로우 삭제

---

## 스토리지 API

### GET /storage/usage
스토리지 사용량

**Response (200)**
```json
{
  "success": true,
  "data": {
    "used_bytes": 5368709120,
    "quota_bytes": 107374182400,
    "used_percentage": 5.0,
    "breakdown": {
      "images": 5000000000,
      "workflows": 100000000,
      "other": 268709120
    }
  }
}
```

---

## 에러 코드 목록

| Code | HTTP Status | Description |
|------|-------------|-------------|
| UNAUTHORIZED | 401 | 인증 필요 |
| INVALID_TOKEN | 401 | 유효하지 않은 토큰 |
| TOKEN_EXPIRED | 401 | 만료된 토큰 |
| FORBIDDEN | 403 | 권한 없음 |
| FEATURE_LOCKED | 403 | 티어에서 잠긴 기능 |
| NOT_FOUND | 404 | 리소스 없음 |
| EMAIL_EXISTS | 409 | 이메일 중복 |
| INSUFFICIENT_CREDITS | 402 | 크레딧 부족 |
| STORAGE_EXCEEDED | 402 | 스토리지 초과 |
| RATE_LIMITED | 429 | 요청 제한 초과 |
| QUEUE_FULL | 429 | 큐 가득 참 |
| INVALID_PARAMETERS | 400 | 잘못된 파라미터 |
| VALIDATION_ERROR | 400 | 유효성 검사 실패 |
| INTERNAL_ERROR | 500 | 서버 오류 |

---

## Rate Limiting

| Tier | Requests/min | Generations/min |
|------|--------------|-----------------|
| Free | 30 | 2 |
| Starter | 60 | 5 |
| Pro | 120 | 10 |
| Studio | 240 | 20 |
| Enterprise | Custom | Custom |

**Rate Limit Headers**
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1732527600
```

---

## 다음 단계

1. [WebSocket 이벤트 명세](./02-websocket-events.md)에서 실시간 이벤트를 확인합니다.
2. [Terraform 가이드](../infrastructure/01-terraform-guide.md)에서 인프라 구축을 시작합니다.
