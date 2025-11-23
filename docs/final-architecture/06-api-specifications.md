# 06. API Specifications

**Document Version**: 1.0
**Last Updated**: 2025-11-23
**Architecture**: InvokeAI SaaS Platform - RESTful API

---

## Table of Contents

1. [Overview](#overview)
2. [API Architecture](#api-architecture)
3. [Authentication](#authentication)
4. [Common Patterns](#common-patterns)
5. [User Service API](#user-service-api)
6. [Payment Service API](#payment-service-api)
7. [Generation Service API](#generation-service-api)
8. [Gallery Service API](#gallery-service-api)
9. [Model Service API](#model-service-api)
10. [WebSocket API](#websocket-api)
11. [Error Handling](#error-handling)
12. [Rate Limiting](#rate-limiting)
13. [Versioning Strategy](#versioning-strategy)

---

## 1. Overview

The InvokeAI SaaS platform exposes a comprehensive RESTful API across 5 microservices, totaling **119 endpoints**. All APIs follow OpenAPI 3.1 specifications and use JSON for request/response payloads.

### Base URLs

**Development** (dev namespace):
```
https://dev.api.pingvas.ai/api/v1
```

**Production** (prod namespace):
```
https://api.pingvas.ai/api/v1
```

### API Services

| Service | Base Path | Port | Endpoints | Description |
|---------|-----------|------|-----------|-------------|
| User Service | `/users` | 8001 | 28 | Authentication, OAuth, user management |
| Payment Service | `/payments` | 8002 | 22 | Credits, subscriptions, Lemon Squeezy integration |
| Generation Service | `/generation` | 8003 | 31 | Image generation, job queue management |
| Gallery Service | `/gallery` | 8004 | 25 | Image storage, boards, public gallery |
| Model Service | `/models` | 8005 | 13 | AI model catalog and metadata |

### API Design Principles

1. **RESTful**: Resource-oriented URLs, HTTP verbs (GET, POST, PUT, PATCH, DELETE)
2. **JSON**: All requests/responses use `application/json`
3. **Hypermedia**: Include links to related resources where applicable
4. **Pagination**: Cursor-based pagination for list endpoints
5. **Filtering**: Query parameters for filtering and sorting
6. **Versioning**: URL-based versioning (`/api/v1`, `/api/v2`)
7. **CORS**: Enabled for `https://app.pingvas.ai` and `https://dev.app.pingvas.ai`
8. **Rate Limiting**: Token bucket algorithm with tier-based limits
9. **Idempotency**: Support idempotency keys for POST/PUT operations

---

## 2. API Architecture

### Service Communication

```mermaid
graph TB
    Client[Web Client] -->|HTTPS| ALB[ALB + WAF]
    ALB --> Ingress[NGINX Ingress Controller]

    Ingress -->|/api/v1/users/*| UserSvc[User Service :8001]
    Ingress -->|/api/v1/payments/*| PaymentSvc[Payment Service :8002]
    Ingress -->|/api/v1/generation/*| GenSvc[Generation Service :8003]
    Ingress -->|/api/v1/gallery/*| GallerySvc[Gallery Service :8004]
    Ingress -->|/api/v1/models/*| ModelSvc[Model Service :8005]

    UserSvc <-->|gRPC| PaymentSvc
    GenSvc <-->|gRPC| PaymentSvc
    GenSvc <-->|gRPC| ModelSvc
    GallerySvc <-->|gRPC| GenSvc

    UserSvc --> DB[(PostgreSQL<br/>RDS Aurora)]
    PaymentSvc --> DB
    GenSvc --> DB
    GallerySvc --> DB
    ModelSvc --> DB

    GenSvc --> Redis[(Redis Queue)]
    PaymentSvc --> Redis

    GallerySvc --> S3[S3 + CloudFront]
```

### API Gateway Pattern

**NGINX Ingress Configuration**:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  annotations:
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.pingvas.ai"
    nginx.ingress.kubernetes.io/enable-cors: "true"
spec:
  rules:
  - host: api.pingvas.ai
    http:
      paths:
      - path: /api/v1/users
        pathType: Prefix
        backend:
          service:
            name: user-service
            port:
              number: 8001
      - path: /api/v1/payments
        pathType: Prefix
        backend:
          service:
            name: payment-service
            port:
              number: 8002
      # ... other services
```

---

## 3. Authentication

### Authentication Methods

1. **JWT Bearer Token**: Primary method for authenticated requests
2. **OAuth 2.0**: Google, GitHub, Discord sign-in
3. **API Key**: For programmatic access (future feature)

### JWT Token Structure

**Access Token** (15 minutes expiry):
```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "username": "johndoe",
  "role": "user",
  "exp": 1700000000,
  "iat": 1699999100,
  "type": "access"
}
```

**Refresh Token** (7 days expiry):
```json
{
  "sub": "user-uuid",
  "exp": 1700604800,
  "iat": 1700000000,
  "type": "refresh"
}
```

### Authentication Header

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Authentication Flow

```mermaid
sequenceDiagram
    Client->>UserSvc: POST /api/v1/users/auth/login
    UserSvc->>DB: Verify credentials
    UserSvc->>Client: 200 {access_token, refresh_token}
    Client->>GenSvc: POST /api/v1/generation/create<br/>Authorization: Bearer {access_token}
    GenSvc->>UserSvc: Verify token (gRPC)
    UserSvc->>GenSvc: User verified
    GenSvc->>Client: 201 {job_id}
```

---

## 4. Common Patterns

### 4.1 Pagination

**Cursor-based Pagination**:
```http
GET /api/v1/gallery/images?limit=20&cursor=eyJpZCI6IjEyMyIsImNyZWF0ZWRfYXQiOiIyMDI1LTAxLTAxIn0=
```

**Response**:
```json
{
  "data": [...],
  "pagination": {
    "next_cursor": "eyJpZCI6IjE0MyIsImNyZWF0ZWRfYXQiOiIyMDI1LTAxLTAyIn0=",
    "has_more": true,
    "total_count": 1234
  }
}
```

### 4.2 Filtering and Sorting

**Query Parameters**:
```http
GET /api/v1/generation/jobs?status=completed&sort_by=created_at&sort_order=desc&limit=50
```

### 4.3 Partial Updates (PATCH)

**JSON Patch Format**:
```http
PATCH /api/v1/users/profile
Content-Type: application/json

{
  "full_name": "John Doe Updated",
  "preferences": {
    "theme": "dark",
    "language": "en"
  }
}
```

### 4.4 Idempotency

**Idempotency Key Header**:
```http
POST /api/v1/payments/credits/purchase
Idempotency-Key: unique-key-12345
```

### 4.5 Standard Response Format

**Success Response**:
```json
{
  "success": true,
  "data": { ... },
  "message": "Operation completed successfully",
  "timestamp": "2025-11-23T10:30:00Z"
}
```

**Error Response**:
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "Insufficient credits to perform this operation",
    "details": {
      "required": 10,
      "available": 5
    }
  },
  "timestamp": "2025-11-23T10:30:00Z"
}
```

---

## 5. User Service API

**Base Path**: `/api/v1/users`
**Port**: 8001
**Total Endpoints**: 28

### 5.1 Authentication Endpoints

#### POST /auth/register

**Description**: Register a new user account with email/password.

**Request Body**:
```json
{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "SecureP@ssw0rd",
  "full_name": "John Doe"
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "username": "johndoe",
      "full_name": "John Doe",
      "role": "user",
      "email_verified": false,
      "created_at": "2025-11-23T10:30:00Z"
    },
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "token_type": "Bearer",
    "expires_in": 900
  },
  "message": "User registered successfully. Verification email sent."
}
```

**Errors**:
- `400 BAD_REQUEST`: Invalid email format, weak password
- `409 CONFLICT`: Email or username already exists

**Rate Limit**: 5 requests/hour per IP

---

#### POST /auth/login

**Description**: Login with email and password.

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "SecureP@ssw0rd"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "username": "johndoe",
      "full_name": "John Doe",
      "role": "user",
      "profile_image_url": "https://cdn.pingvas.ai/avatars/johndoe.jpg"
    },
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "token_type": "Bearer",
    "expires_in": 900
  }
}
```

**Errors**:
- `401 UNAUTHORIZED`: Invalid credentials
- `403 FORBIDDEN`: Account suspended or email not verified

**Rate Limit**: 10 requests/hour per IP

---

#### POST /auth/refresh

**Description**: Refresh access token using refresh token.

**Request Body**:
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "token_type": "Bearer",
    "expires_in": 900
  }
}
```

**Errors**:
- `401 UNAUTHORIZED`: Invalid or expired refresh token

**Rate Limit**: 100 requests/hour per user

---

#### POST /auth/logout

**Description**: Logout and invalidate refresh token.

**Authentication**: Required

**Request Body**:
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

#### POST /auth/forgot-password

**Description**: Request password reset email.

**Request Body**:
```json
{
  "email": "user@example.com"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Password reset email sent if account exists"
}
```

**Rate Limit**: 3 requests/hour per IP

---

#### POST /auth/reset-password

**Description**: Reset password using reset token from email.

**Request Body**:
```json
{
  "reset_token": "abc123xyz789",
  "new_password": "NewSecureP@ssw0rd"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Password reset successfully"
}
```

**Errors**:
- `400 BAD_REQUEST`: Invalid or expired reset token

---

#### POST /auth/verify-email

**Description**: Verify email address using verification token.

**Request Body**:
```json
{
  "verification_token": "def456uvw012"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Email verified successfully"
}
```

---

#### POST /auth/resend-verification

**Description**: Resend email verification email.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Verification email sent"
}
```

**Rate Limit**: 3 requests/hour per user

---

### 5.2 OAuth Endpoints

#### GET /oauth/{provider}/authorize

**Description**: Redirect to OAuth provider authorization page.

**Parameters**:
- `provider` (path): `google`, `github`, `discord`
- `redirect_uri` (query): Callback URL after authorization

**Response** (302 Redirect):
```
Location: https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...
```

---

#### GET /oauth/{provider}/callback

**Description**: OAuth callback endpoint.

**Parameters**:
- `provider` (path): `google`, `github`, `discord`
- `code` (query): Authorization code from provider
- `state` (query): CSRF protection state

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@gmail.com",
      "username": "user_12345",
      "full_name": "John Doe",
      "profile_image_url": "https://lh3.googleusercontent.com/..."
    },
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "is_new_user": false
  }
}
```

---

#### POST /oauth/connect

**Description**: Connect OAuth provider to existing account.

**Authentication**: Required

**Request Body**:
```json
{
  "provider": "google",
  "authorization_code": "4/0AX4XfWh..."
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "provider": "google",
    "connected_at": "2025-11-23T10:30:00Z"
  }
}
```

---

#### DELETE /oauth/{provider}/disconnect

**Description**: Disconnect OAuth provider from account.

**Authentication**: Required

**Parameters**:
- `provider` (path): `google`, `github`, `discord`

**Response** (200 OK):
```json
{
  "success": true,
  "message": "OAuth connection removed"
}
```

---

### 5.3 User Profile Endpoints

#### GET /me

**Description**: Get current user profile.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "username": "johndoe",
    "full_name": "John Doe",
    "profile_image_url": "https://cdn.pingvas.ai/avatars/johndoe.jpg",
    "role": "user",
    "is_active": true,
    "email_verified": true,
    "email_verified_at": "2025-11-01T10:00:00Z",
    "last_login_at": "2025-11-23T09:00:00Z",
    "preferences": {
      "theme": "dark",
      "language": "en",
      "notifications": {
        "email": true,
        "push": false
      }
    },
    "created_at": "2025-10-15T10:00:00Z",
    "credits": {
      "balance": 150,
      "lifetime_earned": 500,
      "lifetime_spent": 350
    },
    "subscription": {
      "plan_type": "pro",
      "status": "active",
      "current_period_end": "2025-12-15T10:00:00Z"
    },
    "oauth_connections": [
      {
        "provider": "google",
        "connected_at": "2025-10-15T10:00:00Z"
      }
    ]
  }
}
```

---

#### PATCH /me

**Description**: Update current user profile.

**Authentication**: Required

**Request Body**:
```json
{
  "full_name": "John Doe Updated",
  "preferences": {
    "theme": "light",
    "language": "ko"
  }
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "username": "johndoe",
    "full_name": "John Doe Updated",
    "preferences": {
      "theme": "light",
      "language": "ko",
      "notifications": {
        "email": true,
        "push": false
      }
    },
    "updated_at": "2025-11-23T10:30:00Z"
  }
}
```

---

#### PATCH /me/username

**Description**: Change username (once per 30 days).

**Authentication**: Required

**Request Body**:
```json
{
  "username": "newusername"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "username": "newusername",
    "updated_at": "2025-11-23T10:30:00Z",
    "next_allowed_change": "2025-12-23T10:30:00Z"
  }
}
```

**Errors**:
- `409 CONFLICT`: Username already taken
- `429 TOO_MANY_REQUESTS`: Changed too recently

---

#### POST /me/avatar

**Description**: Upload profile avatar image.

**Authentication**: Required

**Request** (multipart/form-data):
```
POST /api/v1/users/me/avatar
Content-Type: multipart/form-data

file: [binary image data]
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "profile_image_url": "https://cdn.pingvas.ai/avatars/550e8400.jpg",
    "uploaded_at": "2025-11-23T10:30:00Z"
  }
}
```

**Constraints**:
- Max file size: 5 MB
- Allowed formats: JPEG, PNG, WebP
- Automatic resize: 256x256px

---

#### DELETE /me

**Description**: Delete user account (soft delete).

**Authentication**: Required

**Request Body**:
```json
{
  "password": "SecureP@ssw0rd",
  "confirmation": "DELETE"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Account scheduled for deletion. You have 30 days to cancel."
}
```

---

### 5.4 User Management Endpoints (Admin)

#### GET /users

**Description**: List all users (admin only).

**Authentication**: Required (admin role)

**Query Parameters**:
- `limit` (default: 50, max: 100)
- `cursor` (pagination cursor)
- `role` (filter: user, admin, moderator)
- `is_active` (filter: true, false)
- `search` (search by email/username)

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "username": "johndoe",
      "full_name": "John Doe",
      "role": "user",
      "is_active": true,
      "created_at": "2025-10-15T10:00:00Z",
      "last_login_at": "2025-11-23T09:00:00Z"
    }
  ],
  "pagination": {
    "next_cursor": "eyJpZCI6IjU1MGU4NDAwIn0=",
    "has_more": true,
    "total_count": 1234
  }
}
```

---

#### GET /users/{user_id}

**Description**: Get user by ID (admin only).

**Authentication**: Required (admin role)

**Parameters**:
- `user_id` (path): User UUID

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "username": "johndoe",
    "full_name": "John Doe",
    "role": "user",
    "is_active": true,
    "email_verified": true,
    "created_at": "2025-10-15T10:00:00Z",
    "stats": {
      "total_generations": 1234,
      "total_credits_spent": 5678,
      "total_images": 987
    }
  }
}
```

---

#### PATCH /users/{user_id}

**Description**: Update user (admin only).

**Authentication**: Required (admin role)

**Request Body**:
```json
{
  "role": "moderator",
  "is_active": false
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "role": "moderator",
    "is_active": false,
    "updated_at": "2025-11-23T10:30:00Z"
  }
}
```

---

#### GET /users/stats

**Description**: Get platform user statistics (admin only).

**Authentication**: Required (admin role)

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "total_users": 50000,
    "active_users_7d": 12000,
    "active_users_30d": 25000,
    "new_users_today": 150,
    "new_users_7d": 1200,
    "users_by_plan": {
      "free": 40000,
      "starter": 5000,
      "pro": 4000,
      "studio": 800,
      "enterprise": 200
    },
    "users_by_role": {
      "user": 49900,
      "moderator": 50,
      "admin": 50
    }
  }
}
```

---

## 6. Payment Service API

**Base Path**: `/api/v1/payments`
**Port**: 8002
**Total Endpoints**: 22

### 6.1 Credit Endpoints

#### GET /credits/balance

**Description**: Get user's current credit balance.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "balance": 150,
    "lifetime_earned": 500,
    "lifetime_spent": 350,
    "last_recharged_at": "2025-11-15T10:00:00Z"
  }
}
```

---

#### GET /credits/transactions

**Description**: Get credit transaction history.

**Authentication**: Required

**Query Parameters**:
- `limit` (default: 50, max: 100)
- `cursor` (pagination cursor)
- `transaction_type` (filter: purchase, bonus, refund, spend, subscription_grant)
- `start_date`, `end_date` (filter by date range)

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "tx-550e8400",
      "transaction_type": "purchase",
      "amount": 100,
      "balance_after": 250,
      "description": "Credit purchase - 100 credits",
      "reference_id": "ord_abc123",
      "reference_type": "payment",
      "created_at": "2025-11-15T10:00:00Z"
    },
    {
      "id": "tx-660e9500",
      "transaction_type": "spend",
      "amount": -10,
      "balance_after": 240,
      "description": "Image generation - Job #12345",
      "reference_id": "job-xyz789",
      "reference_type": "generation_job",
      "created_at": "2025-11-16T14:30:00Z"
    }
  ],
  "pagination": {
    "next_cursor": "eyJ0eXBlIjoic3BlbmQifQ==",
    "has_more": true,
    "total_count": 567
  }
}
```

---

#### POST /credits/purchase

**Description**: Create credit purchase order via Lemon Squeezy.

**Authentication**: Required

**Request Body**:
```json
{
  "package": "credits_100",
  "return_url": "https://app.pingvas.ai/credits/success"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "order_id": "ord_abc123xyz",
    "checkout_url": "https://lemonsqueezy.com/checkout/buy/abc123?embed=1",
    "package": "credits_100",
    "price_usd": 9.99,
    "credits": 100,
    "bonus_credits": 10,
    "total_credits": 110
  }
}
```

---

#### GET /credits/packages

**Description**: Get available credit packages.

**Authentication**: Optional

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "credits_100",
      "name": "Starter Pack",
      "credits": 100,
      "bonus_credits": 10,
      "total_credits": 110,
      "price_usd": 9.99,
      "price_per_credit": 0.0999,
      "popular": false
    },
    {
      "id": "credits_500",
      "name": "Value Pack",
      "credits": 500,
      "bonus_credits": 75,
      "total_credits": 575,
      "price_usd": 39.99,
      "price_per_credit": 0.0799,
      "popular": true
    },
    {
      "id": "credits_1000",
      "name": "Pro Pack",
      "credits": 1000,
      "bonus_credits": 200,
      "total_credits": 1200,
      "price_usd": 69.99,
      "price_per_credit": 0.0699,
      "popular": false
    }
  ]
}
```

---

### 6.2 Subscription Endpoints

#### GET /subscriptions/me

**Description**: Get user's current subscription.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "sub-550e8400",
    "plan_type": "pro",
    "status": "active",
    "current_period_start": "2025-11-15T10:00:00Z",
    "current_period_end": "2025-12-15T10:00:00Z",
    "cancel_at_period_end": false,
    "monthly_credit_quota": 500,
    "last_credit_grant_at": "2025-11-15T10:00:00Z",
    "created_at": "2025-10-15T10:00:00Z"
  }
}
```

---

#### GET /subscriptions/plans

**Description**: Get available subscription plans.

**Authentication**: Optional

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "plan_type": "free",
      "name": "Free",
      "price_usd": 0,
      "billing_period": "monthly",
      "monthly_credits": 100,
      "features": [
        "100 credits/month",
        "Basic models",
        "Community support",
        "512x512 max resolution"
      ],
      "limits": {
        "max_resolution": "512x512",
        "max_queue_size": 3,
        "priority": 0
      }
    },
    {
      "plan_type": "starter",
      "name": "Starter",
      "price_usd": 9.99,
      "billing_period": "monthly",
      "monthly_credits": 500,
      "features": [
        "500 credits/month",
        "All models",
        "Email support",
        "1024x1024 max resolution",
        "Higher priority queue"
      ],
      "limits": {
        "max_resolution": "1024x1024",
        "max_queue_size": 10,
        "priority": 50
      },
      "lemon_squeezy_product_id": "123456",
      "popular": false
    },
    {
      "plan_type": "pro",
      "name": "Pro",
      "price_usd": 29.99,
      "billing_period": "monthly",
      "monthly_credits": 2000,
      "features": [
        "2000 credits/month",
        "All models + early access",
        "Priority support",
        "2048x2048 max resolution",
        "Highest priority queue",
        "Private gallery"
      ],
      "limits": {
        "max_resolution": "2048x2048",
        "max_queue_size": 50,
        "priority": 100
      },
      "lemon_squeezy_product_id": "123457",
      "popular": true
    }
  ]
}
```

---

#### POST /subscriptions/subscribe

**Description**: Subscribe to a plan via Lemon Squeezy.

**Authentication**: Required

**Request Body**:
```json
{
  "plan_type": "pro",
  "billing_period": "monthly",
  "return_url": "https://app.pingvas.ai/subscription/success"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "checkout_url": "https://lemonsqueezy.com/checkout/buy/abc123?embed=1",
    "plan_type": "pro",
    "price_usd": 29.99,
    "billing_period": "monthly"
  }
}
```

---

#### POST /subscriptions/cancel

**Description**: Cancel subscription at period end.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "sub-550e8400",
    "plan_type": "pro",
    "status": "active",
    "cancel_at_period_end": true,
    "current_period_end": "2025-12-15T10:00:00Z",
    "message": "Subscription will be cancelled on 2025-12-15"
  }
}
```

---

#### POST /subscriptions/resume

**Description**: Resume cancelled subscription.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "sub-550e8400",
    "plan_type": "pro",
    "status": "active",
    "cancel_at_period_end": false,
    "current_period_end": "2025-12-15T10:00:00Z"
  }
}
```

---

#### POST /subscriptions/upgrade

**Description**: Upgrade subscription plan.

**Authentication**: Required

**Request Body**:
```json
{
  "new_plan_type": "studio"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "checkout_url": "https://lemonsqueezy.com/checkout/buy/abc123?embed=1",
    "current_plan": "pro",
    "new_plan": "studio",
    "prorated_amount": 15.00
  }
}
```

---

### 6.3 Lemon Squeezy Webhook Endpoints

#### POST /webhooks/lemon-squeezy

**Description**: Receive webhooks from Lemon Squeezy.

**Authentication**: Webhook signature verification

**Request Body** (example: order_created):
```json
{
  "meta": {
    "event_name": "order_created",
    "custom_data": {
      "user_id": "550e8400-e29b-41d4-a716-446655440000"
    }
  },
  "data": {
    "id": "123456",
    "type": "orders",
    "attributes": {
      "status": "paid",
      "total": 9990,
      "currency": "USD",
      "first_order_item": {
        "product_name": "100 Credits"
      }
    }
  }
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Webhook processed"
}
```

**Supported Events**:
- `order_created`: Credit purchase completed
- `subscription_created`: New subscription activated
- `subscription_updated`: Subscription plan changed
- `subscription_cancelled`: Subscription cancelled
- `subscription_resumed`: Cancelled subscription resumed
- `subscription_expired`: Subscription expired
- `subscription_payment_success`: Recurring payment successful
- `subscription_payment_failed`: Recurring payment failed

---

## 7. Generation Service API

**Base Path**: `/api/v1/generation`
**Port**: 8003
**Total Endpoints**: 31

### 7.1 Job Creation Endpoints

#### POST /create

**Description**: Create a new image generation job.

**Authentication**: Required

**Request Body**:
```json
{
  "model_id": "model-550e8400",
  "prompt": "A beautiful sunset over mountains, vibrant colors, 4k, detailed",
  "negative_prompt": "blurry, low quality, distorted, ugly",
  "parameters": {
    "width": 1024,
    "height": 1024,
    "steps": 30,
    "cfg_scale": 7.5,
    "seed": -1,
    "sampler": "DPM++ 2M Karras"
  }
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "job_id": "job-660e9500",
    "status": "pending",
    "estimated_credits": 10,
    "estimated_time_seconds": 15,
    "queue_position": 3,
    "created_at": "2025-11-23T10:30:00Z"
  },
  "message": "Generation job created successfully"
}
```

**Errors**:
- `400 BAD_REQUEST`: Invalid parameters
- `402 PAYMENT_REQUIRED`: Insufficient credits
- `429 TOO_MANY_REQUESTS`: Queue limit reached

---

#### POST /batch-create

**Description**: Create multiple generation jobs in batch.

**Authentication**: Required

**Request Body**:
```json
{
  "model_id": "model-550e8400",
  "prompts": [
    "A beautiful sunset",
    "A serene lake",
    "A majestic mountain"
  ],
  "negative_prompt": "blurry, low quality",
  "parameters": {
    "width": 512,
    "height": 512,
    "steps": 20,
    "cfg_scale": 7.0
  },
  "variation_seeds": true
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "job_id": "job-660e9501",
        "prompt": "A beautiful sunset",
        "status": "pending"
      },
      {
        "job_id": "job-660e9502",
        "prompt": "A serene lake",
        "status": "pending"
      },
      {
        "job_id": "job-660e9503",
        "prompt": "A majestic mountain",
        "status": "pending"
      }
    ],
    "total_jobs": 3,
    "total_estimated_credits": 30
  }
}
```

**Limits**:
- Max batch size: 10 (Free), 50 (Pro), 100 (Studio)

---

#### POST /img2img

**Description**: Create image-to-image generation job.

**Authentication**: Required

**Request** (multipart/form-data):
```
POST /api/v1/generation/img2img
Content-Type: multipart/form-data

model_id: model-550e8400
prompt: "Convert to oil painting style, vibrant colors"
init_image: [binary image data]
strength: 0.7
steps: 30
cfg_scale: 7.5
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "job_id": "job-770e9600",
    "status": "pending",
    "estimated_credits": 15,
    "init_image_url": "https://cdn.pingvas.ai/temp/init-770e9600.jpg"
  }
}
```

---

#### POST /upscale

**Description**: Create upscale job for existing image.

**Authentication**: Required

**Request Body**:
```json
{
  "image_id": "img-880e9700",
  "scale_factor": 2,
  "model": "ESRGAN"
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "job_id": "job-990ea800",
    "status": "pending",
    "estimated_credits": 20,
    "original_resolution": "1024x1024",
    "target_resolution": "2048x2048"
  }
}
```

---

### 7.2 Job Management Endpoints

#### GET /jobs/{job_id}

**Description**: Get generation job details.

**Authentication**: Required

**Parameters**:
- `job_id` (path): Job UUID

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "job-660e9500",
    "user_id": "user-550e8400",
    "model_id": "model-770e9600",
    "status": "completed",
    "prompt": "A beautiful sunset over mountains",
    "negative_prompt": "blurry, low quality",
    "parameters": {
      "width": 1024,
      "height": 1024,
      "steps": 30,
      "cfg_scale": 7.5,
      "seed": 42,
      "sampler": "DPM++ 2M Karras"
    },
    "priority": 50,
    "estimated_credits": 10,
    "actual_credits": 10,
    "worker_id": "worker-abc123",
    "created_at": "2025-11-23T10:30:00Z",
    "started_at": "2025-11-23T10:30:15Z",
    "completed_at": "2025-11-23T10:30:30Z",
    "processing_time_seconds": 15,
    "result_metadata": {
      "seed": 42,
      "actual_steps": 30,
      "inference_time_ms": 14523
    },
    "image": {
      "id": "img-880e9700",
      "cloudfront_url": "https://cdn.pingvas.ai/images/user-550e8400/job-660e9500.png"
    }
  }
}
```

---

#### GET /jobs

**Description**: List user's generation jobs.

**Authentication**: Required

**Query Parameters**:
- `limit` (default: 20, max: 100)
- `cursor` (pagination cursor)
- `status` (filter: pending, queued, processing, completed, failed, cancelled)
- `model_id` (filter by model)

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "job-660e9500",
      "status": "completed",
      "prompt": "A beautiful sunset",
      "thumbnail_url": "https://cdn.pingvas.ai/thumbs/job-660e9500.jpg",
      "actual_credits": 10,
      "created_at": "2025-11-23T10:30:00Z",
      "completed_at": "2025-11-23T10:30:30Z"
    }
  ],
  "pagination": {
    "next_cursor": "eyJpZCI6ImpvYi02NjBlOTUwMCJ9",
    "has_more": true,
    "total_count": 1234
  }
}
```

---

#### DELETE /jobs/{job_id}

**Description**: Cancel pending/queued job.

**Authentication**: Required

**Parameters**:
- `job_id` (path): Job UUID

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "job-660e9500",
    "status": "cancelled",
    "refunded_credits": 10
  },
  "message": "Job cancelled and credits refunded"
}
```

**Errors**:
- `400 BAD_REQUEST`: Job already processing or completed

---

#### GET /queue/status

**Description**: Get user's queue status.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "pending_jobs": 2,
    "processing_jobs": 1,
    "queue_limit": 10,
    "estimated_wait_time_seconds": 45,
    "jobs": [
      {
        "id": "job-660e9501",
        "status": "processing",
        "progress_percent": 65,
        "started_at": "2025-11-23T10:29:00Z"
      },
      {
        "id": "job-660e9502",
        "status": "queued",
        "queue_position": 1,
        "estimated_start_time": "2025-11-23T10:30:45Z"
      },
      {
        "id": "job-660e9503",
        "status": "pending",
        "queue_position": 2,
        "estimated_start_time": "2025-11-23T10:31:00Z"
      }
    ]
  }
}
```

---

#### GET /queue/global-status

**Description**: Get global queue statistics.

**Authentication**: Optional

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "total_pending": 156,
    "total_processing": 45,
    "available_workers": 12,
    "average_wait_time_seconds": 30,
    "average_processing_time_seconds": 15,
    "queue_health": "healthy"
  }
}
```

---

### 7.3 Prompt Enhancement Endpoints

#### POST /prompt/enhance

**Description**: Enhance user prompt using AI (GPT-4).

**Authentication**: Required

**Request Body**:
```json
{
  "prompt": "sunset",
  "style": "photorealistic"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "original_prompt": "sunset",
    "enhanced_prompt": "A breathtaking sunset over mountains, vibrant orange and pink hues painting the sky, golden hour lighting, photorealistic, highly detailed, 4k, professional photography",
    "suggested_negative_prompt": "blurry, low quality, distorted, oversaturated, cartoon",
    "suggested_parameters": {
      "steps": 30,
      "cfg_scale": 7.5,
      "sampler": "DPM++ 2M Karras"
    }
  }
}
```

**Cost**: 1 credit per enhancement

---

#### POST /prompt/translate

**Description**: Translate prompt to English.

**Authentication**: Required

**Request Body**:
```json
{
  "prompt": "아름다운 석양",
  "source_language": "ko"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "original_prompt": "아름다운 석양",
    "translated_prompt": "Beautiful sunset",
    "source_language": "ko",
    "confidence": 0.98
  }
}
```

---

### 7.4 Generation Statistics Endpoints

#### GET /stats/me

**Description**: Get user's generation statistics.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "total_generations": 1234,
    "successful_generations": 1189,
    "failed_generations": 45,
    "total_credits_spent": 5678,
    "average_credits_per_generation": 4.6,
    "favorite_model": {
      "id": "model-550e8400",
      "name": "Stable Diffusion XL",
      "usage_count": 567
    },
    "generation_count_by_day": [
      {"date": "2025-11-23", "count": 45},
      {"date": "2025-11-22", "count": 38},
      {"date": "2025-11-21", "count": 52}
    ],
    "most_used_resolutions": [
      {"resolution": "1024x1024", "count": 789},
      {"resolution": "512x512", "count": 345}
    ]
  }
}
```

---

## 8. Gallery Service API

**Base Path**: `/api/v1/gallery`
**Port**: 8004
**Total Endpoints**: 25

### 8.1 Image Endpoints

#### GET /images

**Description**: Get user's images.

**Authentication**: Required

**Query Parameters**:
- `limit` (default: 20, max: 100)
- `cursor` (pagination cursor)
- `board_id` (filter by board)
- `sort_by` (created_at, like_count)
- `sort_order` (asc, desc)

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "img-880e9700",
      "cloudfront_url": "https://cdn.pingvas.ai/images/user-550e8400/img-880e9700.png",
      "thumbnail_url": "https://cdn.pingvas.ai/thumbs/img-880e9700.jpg",
      "width": 1024,
      "height": 1024,
      "file_size_bytes": 2458624,
      "prompt": "A beautiful sunset over mountains",
      "is_public": false,
      "like_count": 0,
      "view_count": 0,
      "created_at": "2025-11-23T10:30:30Z",
      "boards": [
        {
          "id": "board-990ea800",
          "name": "Landscapes"
        }
      ]
    }
  ],
  "pagination": {
    "next_cursor": "eyJpZCI6ImltZy04ODBlOTcwMCJ9",
    "has_more": true,
    "total_count": 987
  }
}
```

---

#### GET /images/{image_id}

**Description**: Get image details.

**Authentication**: Required (owner) or Optional (if public)

**Parameters**:
- `image_id` (path): Image UUID

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "img-880e9700",
    "cloudfront_url": "https://cdn.pingvas.ai/images/user-550e8400/img-880e9700.png",
    "thumbnail_url": "https://cdn.pingvas.ai/thumbs/img-880e9700.jpg",
    "width": 1024,
    "height": 1024,
    "file_size_bytes": 2458624,
    "mime_type": "image/png",
    "prompt": "A beautiful sunset over mountains",
    "is_public": false,
    "like_count": 0,
    "view_count": 0,
    "created_at": "2025-11-23T10:30:30Z",
    "metadata": {
      "model": "Stable Diffusion XL",
      "steps": 30,
      "cfg_scale": 7.5,
      "seed": 42,
      "sampler": "DPM++ 2M Karras"
    },
    "generation_job": {
      "id": "job-660e9500",
      "created_at": "2025-11-23T10:30:00Z"
    },
    "user": {
      "id": "user-550e8400",
      "username": "johndoe",
      "profile_image_url": "https://cdn.pingvas.ai/avatars/johndoe.jpg"
    }
  }
}
```

---

#### PATCH /images/{image_id}

**Description**: Update image metadata.

**Authentication**: Required (owner)

**Request Body**:
```json
{
  "is_public": true,
  "prompt": "Updated prompt text"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "img-880e9700",
    "is_public": true,
    "prompt": "Updated prompt text",
    "updated_at": "2025-11-23T11:00:00Z"
  }
}
```

---

#### DELETE /images/{image_id}

**Description**: Delete image (soft delete).

**Authentication**: Required (owner)

**Parameters**:
- `image_id` (path): Image UUID

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Image deleted successfully"
}
```

**Note**: S3 object deletion handled asynchronously.

---

#### POST /images/{image_id}/download

**Description**: Get presigned S3 URL for direct download.

**Authentication**: Required (owner) or Optional (if public)

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "download_url": "https://s3.amazonaws.com/pingvas-images/...?presigned",
    "expires_in_seconds": 3600,
    "file_name": "sunset_mountains.png",
    "file_size_bytes": 2458624
  }
}
```

---

#### POST /images/{image_id}/like

**Description**: Like an image.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "image_id": "img-880e9700",
    "like_count": 124,
    "liked": true
  }
}
```

---

#### DELETE /images/{image_id}/like

**Description**: Unlike an image.

**Authentication**: Required

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "image_id": "img-880e9700",
    "like_count": 123,
    "liked": false
  }
}
```

---

### 8.2 Board Endpoints

#### GET /boards

**Description**: Get user's boards.

**Authentication**: Required

**Query Parameters**:
- `limit` (default: 20, max: 100)
- `cursor` (pagination cursor)

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "board-990ea800",
      "name": "Landscapes",
      "description": "My favorite landscape images",
      "cover_image_url": "https://cdn.pingvas.ai/images/board-990ea800-cover.jpg",
      "is_private": true,
      "image_count": 45,
      "created_at": "2025-10-15T10:00:00Z",
      "updated_at": "2025-11-23T10:30:00Z"
    }
  ],
  "pagination": {
    "next_cursor": "eyJpZCI6ImJvYXJkLTk5MGVhODAwIn0=",
    "has_more": false,
    "total_count": 12
  }
}
```

---

#### POST /boards

**Description**: Create a new board.

**Authentication**: Required

**Request Body**:
```json
{
  "name": "Portraits",
  "description": "Portrait collection",
  "is_private": false
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "id": "board-aa0fb900",
    "name": "Portraits",
    "description": "Portrait collection",
    "is_private": false,
    "image_count": 0,
    "created_at": "2025-11-23T11:00:00Z"
  }
}
```

---

#### GET /boards/{board_id}

**Description**: Get board details with images.

**Authentication**: Required (owner) or Optional (if public)

**Parameters**:
- `board_id` (path): Board UUID

**Query Parameters**:
- `limit` (default: 20, max: 100)
- `cursor` (pagination cursor)

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "board-990ea800",
    "name": "Landscapes",
    "description": "My favorite landscape images",
    "cover_image_url": "https://cdn.pingvas.ai/images/board-990ea800-cover.jpg",
    "is_private": true,
    "image_count": 45,
    "created_at": "2025-10-15T10:00:00Z",
    "images": [
      {
        "id": "img-880e9700",
        "cloudfront_url": "https://cdn.pingvas.ai/images/img-880e9700.png",
        "thumbnail_url": "https://cdn.pingvas.ai/thumbs/img-880e9700.jpg",
        "width": 1024,
        "height": 1024,
        "display_order": 0,
        "added_at": "2025-11-23T10:30:30Z"
      }
    ],
    "pagination": {
      "next_cursor": "eyJpZCI6ImltZy04ODBlOTcwMCJ9",
      "has_more": true
    }
  }
}
```

---

#### PATCH /boards/{board_id}

**Description**: Update board metadata.

**Authentication**: Required (owner)

**Request Body**:
```json
{
  "name": "Updated Landscapes",
  "description": "Updated description",
  "is_private": false
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "board-990ea800",
    "name": "Updated Landscapes",
    "description": "Updated description",
    "is_private": false,
    "updated_at": "2025-11-23T11:00:00Z"
  }
}
```

---

#### DELETE /boards/{board_id}

**Description**: Delete board (soft delete, images remain).

**Authentication**: Required (owner)

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Board deleted successfully"
}
```

---

#### POST /boards/{board_id}/images

**Description**: Add image to board.

**Authentication**: Required (owner)

**Request Body**:
```json
{
  "image_id": "img-880e9700"
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "board_id": "board-990ea800",
    "image_id": "img-880e9700",
    "display_order": 45,
    "added_at": "2025-11-23T11:00:00Z"
  },
  "message": "Image added to board"
}
```

---

#### DELETE /boards/{board_id}/images/{image_id}

**Description**: Remove image from board.

**Authentication**: Required (owner)

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Image removed from board"
}
```

---

#### PATCH /boards/{board_id}/images/reorder

**Description**: Reorder images in board.

**Authentication**: Required (owner)

**Request Body**:
```json
{
  "image_orders": [
    {"image_id": "img-880e9700", "display_order": 0},
    {"image_id": "img-880e9701", "display_order": 1},
    {"image_id": "img-880e9702", "display_order": 2}
  ]
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Board images reordered successfully"
}
```

---

### 8.3 Public Gallery Endpoints

#### GET /public/images

**Description**: Get public gallery images (Explore page).

**Authentication**: Optional

**Query Parameters**:
- `limit` (default: 20, max: 100)
- `cursor` (pagination cursor)
- `sort_by` (created_at, like_count, view_count)
- `sort_order` (asc, desc)
- `model_id` (filter by model)

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "img-bb0fc910",
      "cloudfront_url": "https://cdn.pingvas.ai/images/img-bb0fc910.png",
      "thumbnail_url": "https://cdn.pingvas.ai/thumbs/img-bb0fc910.jpg",
      "width": 1024,
      "height": 1024,
      "prompt": "Cyberpunk cityscape at night",
      "like_count": 234,
      "view_count": 1567,
      "created_at": "2025-11-22T15:30:00Z",
      "user": {
        "id": "user-cc0fd920",
        "username": "artist123",
        "profile_image_url": "https://cdn.pingvas.ai/avatars/artist123.jpg"
      }
    }
  ],
  "pagination": {
    "next_cursor": "eyJpZCI6ImltZy1iYjBmYzkxMCJ9",
    "has_more": true
  }
}
```

---

#### GET /public/boards

**Description**: Get public boards.

**Authentication**: Optional

**Response**: Similar to GET /boards but filtered to public boards only.

---

## 9. Model Service API

**Base Path**: `/api/v1/models`
**Port**: 8005
**Total Endpoints**: 13

### 9.1 Model Catalog Endpoints

#### GET /models

**Description**: Get available AI models.

**Authentication**: Optional

**Query Parameters**:
- `model_type` (filter: sd15, sdxl, sd3, flux, controlnet, lora)
- `is_active` (filter: true, false)
- `sort_by` (popularity_score, created_at, name)

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "model-550e8400",
      "name": "sd_xl_base_1.0",
      "display_name": "Stable Diffusion XL 1.0",
      "description": "High-resolution text-to-image model, 1024x1024 native",
      "model_type": "sdxl",
      "version": "1.0",
      "file_size_gb": 6.9,
      "default_parameters": {
        "width": 1024,
        "height": 1024,
        "steps": 30,
        "cfg_scale": 7.5,
        "sampler": "DPM++ 2M Karras"
      },
      "is_active": true,
      "is_nsfw": false,
      "popularity_score": 9876,
      "sample_images": [
        "https://cdn.pingvas.ai/model-samples/sdxl-sample1.jpg"
      ],
      "created_at": "2025-01-15T10:00:00Z"
    },
    {
      "id": "model-660e9500",
      "name": "sd_1.5_base",
      "display_name": "Stable Diffusion 1.5",
      "description": "Classic stable diffusion model, 512x512 optimal",
      "model_type": "sd15",
      "version": "1.5",
      "file_size_gb": 4.2,
      "default_parameters": {
        "width": 512,
        "height": 512,
        "steps": 25,
        "cfg_scale": 7.0,
        "sampler": "Euler a"
      },
      "is_active": true,
      "is_nsfw": false,
      "popularity_score": 5432,
      "created_at": "2024-06-01T10:00:00Z"
    }
  ]
}
```

---

#### GET /models/{model_id}

**Description**: Get model details.

**Authentication**: Optional

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "model-550e8400",
    "name": "sd_xl_base_1.0",
    "display_name": "Stable Diffusion XL 1.0",
    "description": "High-resolution text-to-image model optimized for 1024x1024 images",
    "model_type": "sdxl",
    "version": "1.0",
    "efs_path": "/mnt/efs/models/sdxl/sd_xl_base_1.0.safetensors",
    "file_size_gb": 6.9,
    "default_parameters": {
      "width": 1024,
      "height": 1024,
      "steps": 30,
      "cfg_scale": 7.5,
      "sampler": "DPM++ 2M Karras"
    },
    "supported_resolutions": [
      "512x512", "768x768", "1024x1024", "1024x1536", "1536x1024"
    ],
    "supported_samplers": [
      "DPM++ 2M Karras", "Euler a", "DDIM", "LMS"
    ],
    "is_active": true,
    "is_nsfw": false,
    "popularity_score": 9876,
    "usage_stats": {
      "total_generations": 123456,
      "total_generations_7d": 5678
    },
    "sample_images": [
      "https://cdn.pingvas.ai/model-samples/sdxl-sample1.jpg",
      "https://cdn.pingvas.ai/model-samples/sdxl-sample2.jpg"
    ],
    "created_at": "2025-01-15T10:00:00Z",
    "updated_at": "2025-11-23T10:00:00Z"
  }
}
```

---

#### GET /models/{model_id}/stats

**Description**: Get model usage statistics.

**Authentication**: Optional

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "model_id": "model-550e8400",
    "total_generations": 123456,
    "successful_generations": 120123,
    "failed_generations": 3333,
    "average_inference_time_seconds": 14.5,
    "usage_by_day": [
      {"date": "2025-11-23", "count": 234},
      {"date": "2025-11-22", "count": 198}
    ],
    "popular_resolutions": [
      {"resolution": "1024x1024", "count": 89012},
      {"resolution": "1024x1536", "count": 23456}
    ]
  }
}
```

---

#### GET /samplers

**Description**: Get available samplers.

**Authentication**: Optional

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "name": "DPM++ 2M Karras",
      "description": "Fast and high quality, recommended for most use cases",
      "recommended": true,
      "typical_steps": 25-30
    },
    {
      "name": "Euler a",
      "description": "Classic sampler, good for creative results",
      "recommended": false,
      "typical_steps": 20-25
    }
  ]
}
```

---

## 10. WebSocket API

**Base Path**: `wss://api.pingvas.ai/ws`

### 10.1 Real-time Job Updates

**Connection URL**:
```
wss://api.pingvas.ai/ws/generation/jobs?token={access_token}
```

**Authentication**: JWT token in query parameter

**Message Types**:

**1. Subscribe to Job**:
```json
{
  "type": "subscribe",
  "job_id": "job-660e9500"
}
```

**2. Job Status Update**:
```json
{
  "type": "job_status",
  "job_id": "job-660e9500",
  "status": "processing",
  "progress_percent": 45,
  "timestamp": "2025-11-23T10:30:15Z"
}
```

**3. Job Completed**:
```json
{
  "type": "job_completed",
  "job_id": "job-660e9500",
  "status": "completed",
  "image": {
    "id": "img-880e9700",
    "cloudfront_url": "https://cdn.pingvas.ai/images/img-880e9700.png",
    "thumbnail_url": "https://cdn.pingvas.ai/thumbs/img-880e9700.jpg"
  },
  "actual_credits": 10,
  "processing_time_seconds": 15,
  "timestamp": "2025-11-23T10:30:30Z"
}
```

**4. Job Failed**:
```json
{
  "type": "job_failed",
  "job_id": "job-660e9500",
  "status": "failed",
  "error_message": "GPU out of memory",
  "refunded_credits": 10,
  "timestamp": "2025-11-23T10:30:30Z"
}
```

**5. Unsubscribe**:
```json
{
  "type": "unsubscribe",
  "job_id": "job-660e9500"
}
```

---

## 11. Error Handling

### Standard Error Response

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      "field": "additional context"
    }
  },
  "timestamp": "2025-11-23T10:30:00Z",
  "request_id": "req-abc123xyz"
}
```

### HTTP Status Codes

| Status Code | Meaning | When Used |
|------------|---------|-----------|
| 200 OK | Success | Successful GET, PATCH, DELETE |
| 201 Created | Resource created | Successful POST |
| 204 No Content | Success, no response body | Successful DELETE (alternative) |
| 400 Bad Request | Invalid request | Validation errors, malformed JSON |
| 401 Unauthorized | Authentication required | Missing or invalid token |
| 402 Payment Required | Insufficient credits | Credit balance too low |
| 403 Forbidden | Access denied | Insufficient permissions |
| 404 Not Found | Resource not found | Invalid ID |
| 409 Conflict | Resource conflict | Duplicate email/username |
| 422 Unprocessable Entity | Validation errors | Business logic validation failed |
| 429 Too Many Requests | Rate limit exceeded | Too many requests |
| 500 Internal Server Error | Server error | Unexpected server error |
| 503 Service Unavailable | Service down | Maintenance or overload |

### Error Codes

| Code | HTTP Status | Description |
|------|------------|-------------|
| INVALID_REQUEST | 400 | Invalid request format |
| VALIDATION_ERROR | 400 | Request validation failed |
| UNAUTHORIZED | 401 | Authentication required |
| INVALID_TOKEN | 401 | JWT token invalid or expired |
| INSUFFICIENT_CREDITS | 402 | Not enough credits |
| FORBIDDEN | 403 | Access denied |
| NOT_FOUND | 404 | Resource not found |
| USER_EXISTS | 409 | Email/username already exists |
| QUEUE_LIMIT_REACHED | 429 | Too many pending jobs |
| RATE_LIMIT_EXCEEDED | 429 | Rate limit exceeded |
| INTERNAL_ERROR | 500 | Internal server error |
| SERVICE_UNAVAILABLE | 503 | Service temporarily unavailable |

### Example Error Responses

**Validation Error**:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {
      "prompt": "Prompt is required",
      "parameters.width": "Width must be between 512 and 2048"
    }
  },
  "timestamp": "2025-11-23T10:30:00Z"
}
```

**Insufficient Credits**:
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "Insufficient credits to perform this operation",
    "details": {
      "required": 10,
      "available": 5,
      "shortfall": 5
    }
  },
  "timestamp": "2025-11-23T10:30:00Z"
}
```

---

## 12. Rate Limiting

### Rate Limit Tiers

| Tier | Requests/Minute | Requests/Hour | Requests/Day |
|------|----------------|---------------|--------------|
| Free | 20 | 100 | 1000 |
| Starter | 60 | 500 | 5000 |
| Pro | 120 | 2000 | 20000 |
| Studio | 300 | 5000 | 50000 |
| Enterprise | Custom | Custom | Custom |

### Rate Limit Headers

**Response Headers**:
```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1700000000
```

### Rate Limit Exceeded Response

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded. Try again in 30 seconds.",
    "details": {
      "limit": 60,
      "retry_after_seconds": 30,
      "reset_at": "2025-11-23T10:31:00Z"
    }
  },
  "timestamp": "2025-11-23T10:30:30Z"
}
```

**HTTP Status**: 429 Too Many Requests

---

## 13. Versioning Strategy

### URL Versioning

Current version: **v1**

**Base URLs**:
- `/api/v1/*` (current)
- `/api/v2/*` (future)

### Deprecation Policy

1. **New version introduction**: Announce 3 months in advance
2. **Deprecation period**: Minimum 12 months support for old version
3. **Deprecation header**: `Deprecation: true` in responses
4. **Sunset header**: `Sunset: Sat, 31 Dec 2025 23:59:59 GMT`

### Backward Compatibility

- **Minor changes**: Backward compatible (add optional fields)
- **Major changes**: New version required (breaking changes)
- **Field removal**: 12-month deprecation period

---

## Summary

This document provides complete API specifications for the InvokeAI SaaS platform:

- ✅ **119 total endpoints** across 5 microservices
- ✅ **RESTful design** with consistent patterns
- ✅ **Complete request/response schemas** for all endpoints
- ✅ **Authentication and authorization** specifications
- ✅ **Error handling** with standard codes
- ✅ **Rate limiting** tier-based policies
- ✅ **WebSocket support** for real-time updates
- ✅ **Versioning strategy** for API evolution

**API Endpoint Breakdown**:
- User Service: 28 endpoints (auth, OAuth, profile, admin)
- Payment Service: 22 endpoints (credits, subscriptions, webhooks)
- Generation Service: 31 endpoints (job management, queue, stats)
- Gallery Service: 25 endpoints (images, boards, public gallery)
- Model Service: 13 endpoints (catalog, stats)

**Total**: 119 endpoints

---

**Document End**