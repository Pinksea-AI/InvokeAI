# 05. Database Specifications and ERD

**Document Version**: 1.0
**Last Updated**: 2025-11-23
**Architecture**: InvokeAI SaaS Platform - Single Cluster with Namespace Separation

---

## Table of Contents

1. [Overview](#overview)
2. [Database Architecture](#database-architecture)
3. [Schema Design](#schema-design)
4. [Entity Relationship Diagram (ERD)](#entity-relationship-diagram-erd)
5. [Table Specifications](#table-specifications)
   - [5.1 users](#51-users)
   - [5.2 oauth_connections](#52-oauth_connections)
   - [5.3 credits](#53-credits)
   - [5.4 credit_transactions](#54-credit_transactions)
   - [5.5 generation_jobs](#55-generation_jobs)
   - [5.6 images](#56-images)
   - [5.7 boards](#57-boards)
   - [5.8 board_images](#58-board_images)
   - [5.9 models](#59-models)
   - [5.10 subscriptions](#510-subscriptions)
6. [Indexes and Constraints](#indexes-and-constraints)
7. [Row-Level Security Policies](#row-level-security-policies)
8. [Database Migrations Strategy](#database-migrations-strategy)
9. [Sample Queries](#sample-queries)
10. [Performance Considerations](#performance-considerations)

---

## 1. Overview

This document provides comprehensive database specifications for the InvokeAI SaaS platform. The database uses **PostgreSQL 15.4** via **AWS RDS Aurora Serverless v2** with schema-based multi-tenancy.

### Key Characteristics

- **Database Engine**: PostgreSQL 15.4 (Aurora Serverless v2)
- **Multi-tenancy**: Schema-based separation (dev_pingvas, prod_pingvas)
- **Scaling**: 0.5-4 ACU (Aurora Capacity Units)
- **High Availability**: Multi-AZ deployment in production
- **Backup**: Automated daily snapshots, 7-day retention (dev), 30-day retention (prod)
- **Connection Pool**: PgBouncer (transaction mode)
- **ORM**: SQLAlchemy 2.0+ with Alembic for migrations

### Design Principles

1. **Normalized Design**: Minimize data redundancy (3NF compliance)
2. **Audit Trail**: Created_at, updated_at on all tables
3. **Soft Deletes**: Use deleted_at for soft deletion where applicable
4. **UUIDs**: Primary keys use UUID v4 for distributed generation
5. **Indexes**: Strategic indexing for query performance
6. **Foreign Keys**: Enforce referential integrity with CASCADE rules
7. **Row-Level Security**: Schema-based isolation + user-level RLS policies

---

## 2. Database Architecture

### Physical Architecture

```mermaid
graph TB
    subgraph "AWS RDS Aurora Cluster"
        Writer[Writer Instance<br/>Primary Endpoint]
        Reader1[Reader Instance 1<br/>Read Replica]
        Reader2[Reader Instance 2<br/>Read Replica]

        Writer -.->|Replication| Reader1
        Writer -.->|Replication| Reader2
    end

    subgraph "Kubernetes - Dev Namespace"
        DevServices[Dev Services] -->|Write| PgBouncerDev[PgBouncer Pool]
        PgBouncerDev -->|dev_pingvas schema| Writer
    end

    subgraph "Kubernetes - Prod Namespace"
        ProdServices[Prod Services] -->|Write| PgBouncerProd[PgBouncer Pool]
        ProdServicesRead[Prod Read Services] -->|Read| PgBouncerReadProd[PgBouncer Read Pool]

        PgBouncerProd -->|prod_pingvas schema| Writer
        PgBouncerReadProd -->|prod_pingvas schema| Reader1
        PgBouncerReadProd -->|prod_pingvas schema| Reader2
    end

    subgraph "Backup & Monitoring"
        Writer -.->|Automated Snapshots| S3Backup[S3 Backup Storage]
        Writer -.->|Logs & Metrics| CloudWatch[CloudWatch]
    end
```

### Connection Configuration

**Development (dev_pingvas schema)**:
```
Host: pingvas-shared-rds.cluster-xxxxx.us-east-1.rds.amazonaws.com
Port: 5432
Database: pingvas
Schema: dev_pingvas
User: dev_app_user
Max Connections: 20 (per service)
```

**Production (prod_pingvas schema)**:
```
Host: pingvas-shared-rds.cluster-xxxxx.us-east-1.rds.amazonaws.com (write)
Host: pingvas-shared-rds.cluster-ro-xxxxx.us-east-1.rds.amazonaws.com (read)
Port: 5432
Database: pingvas
Schema: prod_pingvas
User: prod_app_user
Max Connections: 50 (per service, write)
Max Connections: 100 (per service, read replicas)
```

---

## 3. Schema Design

### Schema Separation Strategy

```sql
-- Database structure
CREATE DATABASE pingvas;

-- Development schema
CREATE SCHEMA dev_pingvas;

-- Production schema
CREATE SCHEMA prod_pingvas;

-- Schema search path configuration
-- Development services
SET search_path TO dev_pingvas, public;

-- Production services
SET search_path TO prod_pingvas, public;
```

### Schema Ownership and Permissions

```sql
-- Create application users
CREATE USER dev_app_user WITH PASSWORD 'xxx';
CREATE USER prod_app_user WITH PASSWORD 'xxx';

-- Grant schema permissions
GRANT USAGE ON SCHEMA dev_pingvas TO dev_app_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA dev_pingvas TO dev_app_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA dev_pingvas TO dev_app_user;

GRANT USAGE ON SCHEMA prod_pingvas TO prod_app_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA prod_pingvas TO prod_app_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA prod_pingvas TO prod_app_user;

-- Default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA dev_pingvas
    GRANT ALL ON TABLES TO dev_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA dev_pingvas
    GRANT ALL ON SEQUENCES TO dev_app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA prod_pingvas
    GRANT ALL ON TABLES TO prod_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA prod_pingvas
    GRANT ALL ON SEQUENCES TO prod_app_user;
```

---

## 4. Entity Relationship Diagram (ERD)

### Complete ERD

```mermaid
erDiagram
    users ||--o{ oauth_connections : "has"
    users ||--o| credits : "has"
    users ||--o{ credit_transactions : "records"
    users ||--o{ generation_jobs : "creates"
    users ||--o{ images : "owns"
    users ||--o{ boards : "creates"
    users ||--o| subscriptions : "has"

    generation_jobs ||--o| images : "produces"

    boards ||--o{ board_images : "contains"
    images ||--o{ board_images : "belongs_to"

    models ||--o{ generation_jobs : "used_in"

    users {
        uuid id PK
        string email UK
        string username UK
        string hashed_password
        string full_name
        string profile_image_url
        enum role
        boolean is_active
        boolean email_verified
        timestamp email_verified_at
        timestamp last_login_at
        jsonb preferences
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    oauth_connections {
        uuid id PK
        uuid user_id FK
        string provider
        string provider_user_id UK
        string access_token
        string refresh_token
        timestamp token_expires_at
        jsonb provider_data
        timestamp created_at
        timestamp updated_at
    }

    credits {
        uuid id PK
        uuid user_id FK,UK
        integer balance
        integer lifetime_earned
        integer lifetime_spent
        timestamp last_recharged_at
        timestamp created_at
        timestamp updated_at
    }

    credit_transactions {
        uuid id PK
        uuid user_id FK
        enum transaction_type
        integer amount
        integer balance_after
        string description
        uuid reference_id
        string reference_type
        jsonb metadata
        timestamp created_at
    }

    generation_jobs {
        uuid id PK
        uuid user_id FK
        uuid model_id FK
        enum status
        text prompt
        text negative_prompt
        jsonb parameters
        integer priority
        integer estimated_credits
        integer actual_credits
        uuid worker_id
        timestamp started_at
        timestamp completed_at
        text error_message
        jsonb result_metadata
        timestamp created_at
        timestamp updated_at
    }

    images {
        uuid id PK
        uuid user_id FK
        uuid generation_job_id FK,UK
        string s3_key UK
        string s3_bucket
        string cloudfront_url
        integer width
        integer height
        integer file_size_bytes
        string mime_type
        text prompt
        jsonb metadata
        boolean is_public
        integer view_count
        integer like_count
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    boards {
        uuid id PK
        uuid user_id FK
        string name
        text description
        string cover_image_url
        boolean is_private
        integer image_count
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }

    board_images {
        uuid id PK
        uuid board_id FK
        uuid image_id FK
        integer display_order
        timestamp added_at
    }

    models {
        uuid id PK
        string name UK
        string display_name
        text description
        enum model_type
        string version
        string s3_path
        string efs_path
        integer file_size_gb
        jsonb default_parameters
        boolean is_active
        boolean is_nsfw
        integer popularity_score
        timestamp created_at
        timestamp updated_at
    }

    subscriptions {
        uuid id PK
        uuid user_id FK,UK
        string lemon_squeezy_subscription_id UK
        enum plan_type
        enum status
        timestamp current_period_start
        timestamp current_period_end
        boolean cancel_at_period_end
        timestamp canceled_at
        integer monthly_credit_quota
        timestamp last_credit_grant_at
        jsonb metadata
        timestamp created_at
        timestamp updated_at
    }
```

### Relationship Summary

| Relationship | Type | Description |
|-------------|------|-------------|
| users → oauth_connections | 1:N | User can have multiple OAuth providers |
| users → credits | 1:1 | Each user has one credit account |
| users → credit_transactions | 1:N | User has transaction history |
| users → generation_jobs | 1:N | User creates multiple generation jobs |
| users → images | 1:N | User owns multiple images |
| users → boards | 1:N | User creates multiple boards |
| users → subscriptions | 1:1 | User has one active subscription |
| generation_jobs → images | 1:1 | Each job produces one image |
| boards → board_images | 1:N | Board contains multiple images |
| images → board_images | 1:N | Image can be in multiple boards |
| models → generation_jobs | 1:N | Model is used in many jobs |

---

## 5. Table Specifications

### 5.1 users

**Purpose**: Core user authentication and profile information.

**Table Definition**:

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(50) NOT NULL UNIQUE,
    hashed_password VARCHAR(255),  -- NULL for OAuth-only users
    full_name VARCHAR(100),
    profile_image_url VARCHAR(500),
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    is_active BOOLEAN NOT NULL DEFAULT true,
    email_verified BOOLEAN NOT NULL DEFAULT false,
    email_verified_at TIMESTAMP WITH TIME ZONE,
    last_login_at TIMESTAMP WITH TIME ZONE,
    preferences JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT check_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    CONSTRAINT check_username_format CHECK (username ~* '^[A-Za-z0-9_-]+$'),
    CONSTRAINT check_role CHECK (role IN ('user', 'admin', 'moderator')),
    CONSTRAINT check_password_or_oauth CHECK (
        hashed_password IS NOT NULL OR
        EXISTS (SELECT 1 FROM oauth_connections WHERE oauth_connections.user_id = users.id)
    )
);

-- Comments
COMMENT ON TABLE users IS 'Core user accounts with authentication credentials';
COMMENT ON COLUMN users.id IS 'Primary key, UUID v4';
COMMENT ON COLUMN users.email IS 'Unique email address, used for login';
COMMENT ON COLUMN users.username IS 'Unique username, displayed publicly';
COMMENT ON COLUMN users.hashed_password IS 'bcrypt hashed password, NULL for OAuth-only users';
COMMENT ON COLUMN users.role IS 'User role: user (default), admin, moderator';
COMMENT ON COLUMN users.preferences IS 'User preferences JSON: {theme, language, notifications}';
COMMENT ON COLUMN users.deleted_at IS 'Soft delete timestamp, NULL if active';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| email | VARCHAR(255) | NO | - | Unique email address |
| username | VARCHAR(50) | NO | - | Unique username (alphanumeric, -, _) |
| hashed_password | VARCHAR(255) | YES | NULL | bcrypt hash, NULL for OAuth users |
| full_name | VARCHAR(100) | YES | NULL | Display name |
| profile_image_url | VARCHAR(500) | YES | NULL | URL to profile image (S3/CloudFront) |
| role | VARCHAR(20) | NO | 'user' | user, admin, moderator |
| is_active | BOOLEAN | NO | true | Account active status |
| email_verified | BOOLEAN | NO | false | Email verification status |
| email_verified_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Email verification timestamp |
| last_login_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Last successful login |
| preferences | JSONB | NO | '{}' | User preferences object |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Account creation time |
| updated_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Last update time |
| deleted_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Soft delete timestamp |

**Indexes**:

```sql
-- Primary key index (automatic)
-- users_pkey ON (id)

-- Unique constraints (automatic indexes)
CREATE UNIQUE INDEX users_email_unique_idx ON users(email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_username_unique_idx ON users(username) WHERE deleted_at IS NULL;

-- Query performance indexes
CREATE INDEX users_role_active_idx ON users(role, is_active) WHERE deleted_at IS NULL;
CREATE INDEX users_created_at_idx ON users(created_at DESC);
CREATE INDEX users_last_login_idx ON users(last_login_at DESC) WHERE last_login_at IS NOT NULL;
```

**Triggers**:

```sql
-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at_trigger
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

**Sample Data**:

```sql
INSERT INTO users (email, username, hashed_password, full_name, role, email_verified, email_verified_at) VALUES
('admin@pingvas.ai', 'admin', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NU7PJnXxQJIS', 'Admin User', 'admin', true, CURRENT_TIMESTAMP),
('john.doe@example.com', 'johndoe', '$2b$12$abcdefghijklmnopqrstuvwxyz', 'John Doe', 'user', true, CURRENT_TIMESTAMP),
('jane.smith@example.com', 'janesmith', NULL, 'Jane Smith', 'user', true, CURRENT_TIMESTAMP);  -- OAuth-only user
```

---

### 5.2 oauth_connections

**Purpose**: Store OAuth provider connections for users (Google, GitHub, Discord).

**Table Definition**:

```sql
CREATE TABLE oauth_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL,
    provider_user_id VARCHAR(255) NOT NULL,
    access_token TEXT,  -- Encrypted in application layer
    refresh_token TEXT,  -- Encrypted in application layer
    token_expires_at TIMESTAMP WITH TIME ZONE,
    provider_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_provider CHECK (provider IN ('google', 'github', 'discord')),
    CONSTRAINT oauth_connections_provider_unique UNIQUE (provider, provider_user_id)
);

-- Comments
COMMENT ON TABLE oauth_connections IS 'OAuth provider connections for user authentication';
COMMENT ON COLUMN oauth_connections.provider IS 'OAuth provider: google, github, discord';
COMMENT ON COLUMN oauth_connections.provider_user_id IS 'User ID from OAuth provider';
COMMENT ON COLUMN oauth_connections.access_token IS 'Encrypted access token';
COMMENT ON COLUMN oauth_connections.refresh_token IS 'Encrypted refresh token';
COMMENT ON COLUMN oauth_connections.provider_data IS 'Additional provider data (email, avatar, etc.)';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | UUID | NO | - | Foreign key to users.id |
| provider | VARCHAR(20) | NO | - | google, github, discord |
| provider_user_id | VARCHAR(255) | NO | - | User ID from OAuth provider |
| access_token | TEXT | YES | NULL | Encrypted OAuth access token |
| refresh_token | TEXT | YES | NULL | Encrypted OAuth refresh token |
| token_expires_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Token expiration time |
| provider_data | JSONB | NO | '{}' | Provider-specific data |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Connection created time |
| updated_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Last update time |

**Indexes**:

```sql
CREATE INDEX oauth_connections_user_id_idx ON oauth_connections(user_id);
CREATE INDEX oauth_connections_provider_idx ON oauth_connections(provider);
CREATE UNIQUE INDEX oauth_connections_provider_user_unique_idx
    ON oauth_connections(provider, provider_user_id);
```

**Triggers**:

```sql
CREATE TRIGGER oauth_connections_updated_at_trigger
    BEFORE UPDATE ON oauth_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

---

### 5.3 credits

**Purpose**: Store user credit balance and lifetime statistics.

**Table Definition**:

```sql
CREATE TABLE credits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance INTEGER NOT NULL DEFAULT 0,
    lifetime_earned INTEGER NOT NULL DEFAULT 0,
    lifetime_spent INTEGER NOT NULL DEFAULT 0,
    last_recharged_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_balance_non_negative CHECK (balance >= 0),
    CONSTRAINT check_lifetime_earned_non_negative CHECK (lifetime_earned >= 0),
    CONSTRAINT check_lifetime_spent_non_negative CHECK (lifetime_spent >= 0),
    CONSTRAINT check_lifetime_consistency CHECK (balance <= lifetime_earned - lifetime_spent)
);

-- Comments
COMMENT ON TABLE credits IS 'User credit balance and lifetime statistics';
COMMENT ON COLUMN credits.balance IS 'Current available credits';
COMMENT ON COLUMN credits.lifetime_earned IS 'Total credits earned (purchases + bonuses)';
COMMENT ON COLUMN credits.lifetime_spent IS 'Total credits spent on generations';
COMMENT ON COLUMN credits.last_recharged_at IS 'Last time credits were added (purchase or bonus)';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | UUID | NO | - | Foreign key to users.id, unique |
| balance | INTEGER | NO | 0 | Current available credits |
| lifetime_earned | INTEGER | NO | 0 | Total credits earned |
| lifetime_spent | INTEGER | NO | 0 | Total credits spent |
| last_recharged_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Last credit addition timestamp |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Record creation time |
| updated_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Last update time |

**Indexes**:

```sql
CREATE UNIQUE INDEX credits_user_id_unique_idx ON credits(user_id);
CREATE INDEX credits_balance_idx ON credits(balance);
```

**Triggers**:

```sql
CREATE TRIGGER credits_updated_at_trigger
    BEFORE UPDATE ON credits
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger to auto-create credits record when user is created
CREATE OR REPLACE FUNCTION create_user_credits()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO credits (user_id, balance, lifetime_earned)
    VALUES (NEW.id, 100, 100);  -- New users get 100 welcome credits
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_create_credits_trigger
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION create_user_credits();
```

---

### 5.4 credit_transactions

**Purpose**: Immutable audit log of all credit transactions.

**Table Definition**:

```sql
CREATE TABLE credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_type VARCHAR(20) NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    description TEXT NOT NULL,
    reference_id UUID,
    reference_type VARCHAR(50),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_transaction_type CHECK (
        transaction_type IN ('purchase', 'bonus', 'refund', 'spend', 'subscription_grant')
    ),
    CONSTRAINT check_reference_type CHECK (
        reference_type IS NULL OR
        reference_type IN ('generation_job', 'subscription', 'payment')
    )
);

-- Comments
COMMENT ON TABLE credit_transactions IS 'Immutable audit log of credit transactions';
COMMENT ON COLUMN credit_transactions.transaction_type IS 'purchase, bonus, refund, spend, subscription_grant';
COMMENT ON COLUMN credit_transactions.amount IS 'Transaction amount (positive for earn, negative for spend)';
COMMENT ON COLUMN credit_transactions.balance_after IS 'Balance after transaction';
COMMENT ON COLUMN credit_transactions.reference_id IS 'ID of related entity (job, subscription, payment)';
COMMENT ON COLUMN credit_transactions.reference_type IS 'Type of reference: generation_job, subscription, payment';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | UUID | NO | - | Foreign key to users.id |
| transaction_type | VARCHAR(20) | NO | - | purchase, bonus, refund, spend, subscription_grant |
| amount | INTEGER | NO | - | Credit amount (positive or negative) |
| balance_after | INTEGER | NO | - | Balance after transaction |
| description | TEXT | NO | - | Human-readable description |
| reference_id | UUID | YES | NULL | Related entity ID |
| reference_type | VARCHAR(50) | YES | NULL | Related entity type |
| metadata | JSONB | NO | '{}' | Additional transaction data |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Transaction timestamp |

**Indexes**:

```sql
CREATE INDEX credit_transactions_user_id_idx ON credit_transactions(user_id, created_at DESC);
CREATE INDEX credit_transactions_type_idx ON credit_transactions(transaction_type);
CREATE INDEX credit_transactions_reference_idx ON credit_transactions(reference_id, reference_type);
CREATE INDEX credit_transactions_created_at_idx ON credit_transactions(created_at DESC);
```

**No Triggers**: This table is append-only (no updates or deletes).

---

### 5.5 generation_jobs

**Purpose**: Track AI image generation jobs from submission to completion.

**Table Definition**:

```sql
CREATE TABLE generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    prompt TEXT NOT NULL,
    negative_prompt TEXT,
    parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    priority INTEGER NOT NULL DEFAULT 0,
    estimated_credits INTEGER NOT NULL,
    actual_credits INTEGER,
    worker_id UUID,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    result_metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_status CHECK (
        status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'cancelled')
    ),
    CONSTRAINT check_priority CHECK (priority BETWEEN 0 AND 100),
    CONSTRAINT check_credits_positive CHECK (
        estimated_credits > 0 AND (actual_credits IS NULL OR actual_credits > 0)
    ),
    CONSTRAINT check_completed_has_timestamps CHECK (
        (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL) OR
        status != 'completed'
    )
);

-- Comments
COMMENT ON TABLE generation_jobs IS 'AI image generation job queue and history';
COMMENT ON COLUMN generation_jobs.status IS 'pending, queued, processing, completed, failed, cancelled';
COMMENT ON COLUMN generation_jobs.parameters IS 'Generation parameters: {width, height, steps, cfg_scale, seed, sampler}';
COMMENT ON COLUMN generation_jobs.priority IS '0-100, higher = more priority (paid users get higher)';
COMMENT ON COLUMN generation_jobs.estimated_credits IS 'Estimated credits before generation';
COMMENT ON COLUMN generation_jobs.actual_credits IS 'Actual credits charged after generation';
COMMENT ON COLUMN generation_jobs.worker_id IS 'ID of worker pod that processed job';
COMMENT ON COLUMN generation_jobs.result_metadata IS 'Result data: {seed, actual_steps, inference_time_ms}';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | UUID | NO | - | Foreign key to users.id |
| model_id | UUID | NO | - | Foreign key to models.id |
| status | VARCHAR(20) | NO | 'pending' | Job status |
| prompt | TEXT | NO | - | Positive prompt |
| negative_prompt | TEXT | YES | NULL | Negative prompt |
| parameters | JSONB | NO | '{}' | Generation parameters |
| priority | INTEGER | NO | 0 | 0-100 priority score |
| estimated_credits | INTEGER | NO | - | Estimated credit cost |
| actual_credits | INTEGER | YES | NULL | Actual credit cost |
| worker_id | UUID | YES | NULL | Worker pod identifier |
| started_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Job start time |
| completed_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Job completion time |
| error_message | TEXT | YES | NULL | Error message if failed |
| result_metadata | JSONB | NO | '{}' | Result metadata |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Job creation time |
| updated_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Last update time |

**Indexes**:

```sql
CREATE INDEX generation_jobs_user_id_idx ON generation_jobs(user_id, created_at DESC);
CREATE INDEX generation_jobs_status_idx ON generation_jobs(status, created_at);
CREATE INDEX generation_jobs_model_id_idx ON generation_jobs(model_id);
CREATE INDEX generation_jobs_priority_idx ON generation_jobs(priority DESC, created_at)
    WHERE status IN ('pending', 'queued');
CREATE INDEX generation_jobs_worker_idx ON generation_jobs(worker_id)
    WHERE worker_id IS NOT NULL;
```

**Triggers**:

```sql
CREATE TRIGGER generation_jobs_updated_at_trigger
    BEFORE UPDATE ON generation_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

---

### 5.6 images

**Purpose**: Store metadata for generated images (actual images stored in S3).

**Table Definition**:

```sql
CREATE TABLE images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    generation_job_id UUID UNIQUE REFERENCES generation_jobs(id) ON DELETE SET NULL,
    s3_key VARCHAR(500) NOT NULL UNIQUE,
    s3_bucket VARCHAR(100) NOT NULL,
    cloudfront_url VARCHAR(500) NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    mime_type VARCHAR(50) NOT NULL DEFAULT 'image/png',
    prompt TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    is_public BOOLEAN NOT NULL DEFAULT false,
    view_count INTEGER NOT NULL DEFAULT 0,
    like_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT check_dimensions CHECK (width > 0 AND height > 0),
    CONSTRAINT check_file_size CHECK (file_size_bytes > 0),
    CONSTRAINT check_mime_type CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
    CONSTRAINT check_counts CHECK (view_count >= 0 AND like_count >= 0)
);

-- Comments
COMMENT ON TABLE images IS 'Generated image metadata (actual images in S3)';
COMMENT ON COLUMN images.s3_key IS 'S3 object key: {user_id}/{job_id}/{timestamp}.png';
COMMENT ON COLUMN images.s3_bucket IS 'S3 bucket name (dev-images or prod-images)';
COMMENT ON COLUMN images.cloudfront_url IS 'Full CloudFront CDN URL';
COMMENT ON COLUMN images.metadata IS 'EXIF data and generation parameters';
COMMENT ON COLUMN images.is_public IS 'Public gallery visibility';
COMMENT ON COLUMN images.deleted_at IS 'Soft delete (S3 deletion handled separately)';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | UUID | NO | - | Foreign key to users.id |
| generation_job_id | UUID | YES | - | Foreign key to generation_jobs.id, unique |
| s3_key | VARCHAR(500) | NO | - | S3 object key, unique |
| s3_bucket | VARCHAR(100) | NO | - | S3 bucket name |
| cloudfront_url | VARCHAR(500) | NO | - | Full CloudFront URL |
| width | INTEGER | NO | - | Image width in pixels |
| height | INTEGER | NO | - | Image height in pixels |
| file_size_bytes | INTEGER | NO | - | File size in bytes |
| mime_type | VARCHAR(50) | NO | 'image/png' | MIME type |
| prompt | TEXT | YES | NULL | Cached prompt from job |
| metadata | JSONB | NO | '{}' | EXIF and generation metadata |
| is_public | BOOLEAN | NO | false | Public gallery visibility |
| view_count | INTEGER | NO | 0 | View counter |
| like_count | INTEGER | NO | 0 | Like counter |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Upload timestamp |
| updated_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Last update time |
| deleted_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Soft delete timestamp |

**Indexes**:

```sql
CREATE INDEX images_user_id_idx ON images(user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX images_public_idx ON images(created_at DESC)
    WHERE is_public = true AND deleted_at IS NULL;
CREATE UNIQUE INDEX images_s3_key_unique_idx ON images(s3_key) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX images_job_id_unique_idx ON images(generation_job_id)
    WHERE generation_job_id IS NOT NULL;
CREATE INDEX images_like_count_idx ON images(like_count DESC)
    WHERE is_public = true AND deleted_at IS NULL;
```

**Triggers**:

```sql
CREATE TRIGGER images_updated_at_trigger
    BEFORE UPDATE ON images
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

---

### 5.7 boards

**Purpose**: User-created collections/albums for organizing images.

**Table Definition**:

```sql
CREATE TABLE boards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    cover_image_url VARCHAR(500),
    is_private BOOLEAN NOT NULL DEFAULT true,
    image_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT check_image_count CHECK (image_count >= 0)
);

-- Comments
COMMENT ON TABLE boards IS 'User-created image collections/albums';
COMMENT ON COLUMN boards.name IS 'Board name (e.g., "Fantasy Art", "Portraits")';
COMMENT ON COLUMN boards.cover_image_url IS 'URL to board cover image';
COMMENT ON COLUMN boards.is_private IS 'Board visibility (private or public)';
COMMENT ON COLUMN boards.image_count IS 'Cached count of images in board';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | UUID | NO | - | Foreign key to users.id |
| name | VARCHAR(100) | NO | - | Board name |
| description | TEXT | YES | NULL | Board description |
| cover_image_url | VARCHAR(500) | YES | NULL | Cover image URL |
| is_private | BOOLEAN | NO | true | Privacy setting |
| image_count | INTEGER | NO | 0 | Cached image count |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Creation time |
| updated_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Last update time |
| deleted_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Soft delete timestamp |

**Indexes**:

```sql
CREATE INDEX boards_user_id_idx ON boards(user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX boards_public_idx ON boards(created_at DESC)
    WHERE is_private = false AND deleted_at IS NULL;
```

**Triggers**:

```sql
CREATE TRIGGER boards_updated_at_trigger
    BEFORE UPDATE ON boards
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

---

### 5.8 board_images

**Purpose**: Many-to-many relationship between boards and images.

**Table Definition**:

```sql
CREATE TABLE board_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL DEFAULT 0,
    added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT board_images_unique UNIQUE (board_id, image_id)
);

-- Comments
COMMENT ON TABLE board_images IS 'Many-to-many relationship: boards ↔ images';
COMMENT ON COLUMN board_images.display_order IS 'Display order within board (user-sortable)';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| board_id | UUID | NO | - | Foreign key to boards.id |
| image_id | UUID | NO | - | Foreign key to images.id |
| display_order | INTEGER | NO | 0 | Display order in board |
| added_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Addition timestamp |

**Indexes**:

```sql
CREATE INDEX board_images_board_id_idx ON board_images(board_id, display_order);
CREATE INDEX board_images_image_id_idx ON board_images(image_id);
CREATE UNIQUE INDEX board_images_unique_idx ON board_images(board_id, image_id);
```

**Triggers**:

```sql
-- Update board.image_count when images are added/removed
CREATE OR REPLACE FUNCTION update_board_image_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE boards SET image_count = image_count + 1 WHERE id = NEW.board_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE boards SET image_count = image_count - 1 WHERE id = OLD.board_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER board_images_count_trigger
    AFTER INSERT OR DELETE ON board_images
    FOR EACH ROW
    EXECUTE FUNCTION update_board_image_count();
```

---

### 5.9 models

**Purpose**: AI model catalog (Stable Diffusion, SDXL, etc.).

**Table Definition**:

```sql
CREATE TABLE models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    display_name VARCHAR(150) NOT NULL,
    description TEXT,
    model_type VARCHAR(50) NOT NULL,
    version VARCHAR(50) NOT NULL,
    s3_path VARCHAR(500),
    efs_path VARCHAR(500) NOT NULL,
    file_size_gb NUMERIC(6, 2) NOT NULL,
    default_parameters JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_nsfw BOOLEAN NOT NULL DEFAULT false,
    popularity_score INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_model_type CHECK (
        model_type IN ('sd15', 'sdxl', 'sd3', 'flux', 'controlnet', 'lora')
    ),
    CONSTRAINT check_file_size CHECK (file_size_gb > 0),
    CONSTRAINT check_popularity CHECK (popularity_score >= 0)
);

-- Comments
COMMENT ON TABLE models IS 'AI model catalog and metadata';
COMMENT ON COLUMN models.name IS 'Model identifier (e.g., sd_v1-5_base)';
COMMENT ON COLUMN models.display_name IS 'Human-readable name';
COMMENT ON COLUMN models.model_type IS 'sd15, sdxl, sd3, flux, controlnet, lora';
COMMENT ON COLUMN models.s3_path IS 'S3 path for model files (if stored in S3)';
COMMENT ON COLUMN models.efs_path IS 'EFS mount path for worker pods';
COMMENT ON COLUMN models.file_size_gb IS 'Model file size in GB';
COMMENT ON COLUMN models.default_parameters IS 'Default generation parameters for this model';
COMMENT ON COLUMN models.popularity_score IS 'Usage popularity (incremented on use)';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| name | VARCHAR(100) | NO | - | Unique model identifier |
| display_name | VARCHAR(150) | NO | - | Display name |
| description | TEXT | YES | NULL | Model description |
| model_type | VARCHAR(50) | NO | - | Model type enum |
| version | VARCHAR(50) | NO | - | Model version |
| s3_path | VARCHAR(500) | YES | NULL | S3 storage path |
| efs_path | VARCHAR(500) | NO | - | EFS mount path |
| file_size_gb | NUMERIC(6, 2) | NO | - | File size in GB |
| default_parameters | JSONB | NO | '{}' | Default parameters |
| is_active | BOOLEAN | NO | true | Active status |
| is_nsfw | BOOLEAN | NO | false | NSFW content flag |
| popularity_score | INTEGER | NO | 0 | Usage popularity |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Creation time |
| updated_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Last update time |

**Indexes**:

```sql
CREATE UNIQUE INDEX models_name_unique_idx ON models(name);
CREATE INDEX models_type_active_idx ON models(model_type, is_active);
CREATE INDEX models_popularity_idx ON models(popularity_score DESC) WHERE is_active = true;
```

**Triggers**:

```sql
CREATE TRIGGER models_updated_at_trigger
    BEFORE UPDATE ON models
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

---

### 5.10 subscriptions

**Purpose**: User subscription plans via Lemon Squeezy.

**Table Definition**:

```sql
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    lemon_squeezy_subscription_id VARCHAR(255) UNIQUE NOT NULL,
    plan_type VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    canceled_at TIMESTAMP WITH TIME ZONE,
    monthly_credit_quota INTEGER NOT NULL,
    last_credit_grant_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_plan_type CHECK (
        plan_type IN ('free', 'starter', 'pro', 'studio', 'enterprise')
    ),
    CONSTRAINT check_status CHECK (
        status IN ('active', 'cancelled', 'paused', 'expired', 'past_due')
    ),
    CONSTRAINT check_credit_quota CHECK (monthly_credit_quota >= 0)
);

-- Comments
COMMENT ON TABLE subscriptions IS 'User subscription plans via Lemon Squeezy';
COMMENT ON COLUMN subscriptions.lemon_squeezy_subscription_id IS 'Lemon Squeezy subscription ID';
COMMENT ON COLUMN subscriptions.plan_type IS 'free, starter, pro, studio, enterprise';
COMMENT ON COLUMN subscriptions.status IS 'active, cancelled, paused, expired, past_due';
COMMENT ON COLUMN subscriptions.monthly_credit_quota IS 'Monthly credit grant amount';
COMMENT ON COLUMN subscriptions.last_credit_grant_at IS 'Last time monthly credits were granted';
```

**Column Specifications**:

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Primary key |
| user_id | UUID | NO | - | Foreign key to users.id, unique |
| lemon_squeezy_subscription_id | VARCHAR(255) | NO | - | Lemon Squeezy sub ID, unique |
| plan_type | VARCHAR(20) | NO | - | Subscription plan tier |
| status | VARCHAR(20) | NO | - | Subscription status |
| current_period_start | TIMESTAMP WITH TIME ZONE | NO | - | Billing period start |
| current_period_end | TIMESTAMP WITH TIME ZONE | NO | - | Billing period end |
| cancel_at_period_end | BOOLEAN | NO | false | Auto-cancel flag |
| canceled_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Cancellation time |
| monthly_credit_quota | INTEGER | NO | - | Monthly credit amount |
| last_credit_grant_at | TIMESTAMP WITH TIME ZONE | YES | NULL | Last credit grant time |
| metadata | JSONB | NO | '{}' | Additional subscription data |
| created_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Creation time |
| updated_at | TIMESTAMP WITH TIME ZONE | NO | CURRENT_TIMESTAMP | Last update time |

**Indexes**:

```sql
CREATE UNIQUE INDEX subscriptions_user_id_unique_idx ON subscriptions(user_id);
CREATE UNIQUE INDEX subscriptions_lemon_squeezy_id_unique_idx
    ON subscriptions(lemon_squeezy_subscription_id);
CREATE INDEX subscriptions_status_idx ON subscriptions(status);
CREATE INDEX subscriptions_period_end_idx ON subscriptions(current_period_end)
    WHERE status = 'active';
```

**Triggers**:

```sql
CREATE TRIGGER subscriptions_updated_at_trigger
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-create free subscription when user is created
CREATE OR REPLACE FUNCTION create_user_subscription()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO subscriptions (
        user_id,
        lemon_squeezy_subscription_id,
        plan_type,
        status,
        current_period_start,
        current_period_end,
        monthly_credit_quota
    ) VALUES (
        NEW.id,
        'free-' || NEW.id,  -- Dummy Lemon Squeezy ID for free tier
        'free',
        'active',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '1 year',
        100  -- Free tier: 100 credits/month
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_create_subscription_trigger
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION create_user_subscription();
```

---

## 6. Indexes and Constraints

### Index Strategy Summary

| Index Type | Purpose | Tables Applied |
|-----------|---------|----------------|
| Primary Key (B-tree) | Unique identification | All tables |
| Unique Indexes | Enforce uniqueness | users.email, users.username, oauth_connections, credits.user_id, images.s3_key, models.name, subscriptions |
| Foreign Key Indexes | Join performance | All FK columns |
| Composite Indexes | Multi-column queries | users(role, is_active), generation_jobs(status, created_at) |
| Partial Indexes | Filtered queries | deleted_at IS NULL, is_active = true |
| Descending Indexes | Latest-first queries | created_at DESC, like_count DESC |

### Constraint Types

**1. Primary Keys**: UUID v4 on all tables
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
```

**2. Foreign Keys with Cascade Rules**:
```sql
-- CASCADE: Delete children when parent is deleted
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE

-- RESTRICT: Prevent deletion of referenced parent
model_id UUID NOT NULL REFERENCES models(id) ON DELETE RESTRICT

-- SET NULL: Set FK to NULL when parent is deleted
generation_job_id UUID REFERENCES generation_jobs(id) ON DELETE SET NULL
```

**3. Check Constraints**:
```sql
-- Email format validation
CONSTRAINT check_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@...')

-- Enum validation
CONSTRAINT check_status CHECK (status IN ('pending', 'queued', ...))

-- Range validation
CONSTRAINT check_priority CHECK (priority BETWEEN 0 AND 100)

-- Non-negative validation
CONSTRAINT check_balance_non_negative CHECK (balance >= 0)

-- Cross-column validation
CONSTRAINT check_completed_has_timestamps CHECK (...)
```

**4. Unique Constraints**:
```sql
-- Single column unique
email VARCHAR(255) NOT NULL UNIQUE

-- Composite unique
CONSTRAINT oauth_connections_provider_unique UNIQUE (provider, provider_user_id)

-- Partial unique (ignore soft-deleted)
CREATE UNIQUE INDEX users_email_unique_idx ON users(email) WHERE deleted_at IS NULL;
```

---

## 7. Row-Level Security Policies

### Overview

PostgreSQL Row-Level Security (RLS) ensures users can only access their own data, even if application logic is bypassed.

### Enable RLS on Tables

```sql
-- Enable RLS on user-data tables
ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
```

### Policy Definitions

**1. credits Table**:
```sql
-- Users can only view and modify their own credits
CREATE POLICY credits_user_isolation ON credits
    FOR ALL
    USING (user_id = current_setting('app.current_user_id')::uuid);
```

**2. credit_transactions Table**:
```sql
-- Users can only view their own transactions (no updates/deletes)
CREATE POLICY credit_transactions_user_isolation ON credit_transactions
    FOR SELECT
    USING (user_id = current_setting('app.current_user_id')::uuid);
```

**3. generation_jobs Table**:
```sql
-- Users can CRUD their own jobs
CREATE POLICY generation_jobs_user_isolation ON generation_jobs
    FOR ALL
    USING (user_id = current_setting('app.current_user_id')::uuid);
```

**4. images Table**:
```sql
-- Users can manage their own images
CREATE POLICY images_owner_access ON images
    FOR ALL
    USING (user_id = current_setting('app.current_user_id')::uuid);

-- Anyone can view public images
CREATE POLICY images_public_read ON images
    FOR SELECT
    USING (is_public = true AND deleted_at IS NULL);
```

**5. boards Table**:
```sql
-- Users can manage their own boards
CREATE POLICY boards_owner_access ON boards
    FOR ALL
    USING (user_id = current_setting('app.current_user_id')::uuid);

-- Anyone can view public boards
CREATE POLICY boards_public_read ON boards
    FOR SELECT
    USING (is_private = false AND deleted_at IS NULL);
```

**6. board_images Table**:
```sql
-- Users can manage images in their own boards
CREATE POLICY board_images_owner_access ON board_images
    FOR ALL
    USING (
        board_id IN (
            SELECT id FROM boards WHERE user_id = current_setting('app.current_user_id')::uuid
        )
    );
```

**7. subscriptions Table**:
```sql
-- Users can only view their own subscription
CREATE POLICY subscriptions_user_isolation ON subscriptions
    FOR SELECT
    USING (user_id = current_setting('app.current_user_id')::uuid);
```

### Setting User Context in Application

**Python/FastAPI Example**:
```python
from sqlalchemy import text

async def set_user_context(db: AsyncSession, user_id: str):
    """Set current user context for RLS policies"""
    await db.execute(text(f"SET app.current_user_id = '{user_id}'"))

# In endpoint dependency
@app.get("/api/v1/credits/balance")
async def get_credit_balance(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    await set_user_context(db, str(current_user.id))
    credit = await db.execute(
        select(Credit).where(Credit.user_id == current_user.id)
    )
    return credit.scalar_one()
```

---

## 8. Database Migrations Strategy

### Migration Tool: Alembic

**Configuration**:
```python
# alembic.ini
[alembic]
script_location = alembic
sqlalchemy.url = postgresql+asyncpg://user:pass@host:5432/pingvas

# alembic/env.py
from app.database import Base
from app.config import settings

# Set schema based on environment
target_metadata = Base.metadata
target_metadata.schema = settings.db_schema  # dev_pingvas or prod_pingvas

def run_migrations_online():
    connectable = create_async_engine(settings.database_url)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_schemas=True,
            version_table_schema=settings.db_schema
        )

        with context.begin_transaction():
            context.run_migrations()
```

### Migration Workflow

**1. Create Migration**:
```bash
# Auto-generate migration from model changes
alembic revision --autogenerate -m "Add subscription plan upgrades"

# Manual migration
alembic revision -m "Add index for generation job priority"
```

**2. Review Migration**:
```python
# alembic/versions/abc123_add_subscription_plan_upgrades.py
def upgrade():
    op.add_column('subscriptions',
        sa.Column('upgrade_requested_plan', sa.String(20), nullable=True))
    op.create_index('subscriptions_upgrade_idx', 'subscriptions',
        ['upgrade_requested_plan'], unique=False,
        postgresql_where=sa.text('upgrade_requested_plan IS NOT NULL'))

def downgrade():
    op.drop_index('subscriptions_upgrade_idx')
    op.drop_column('subscriptions', 'upgrade_requested_plan')
```

**3. Apply Migration**:
```bash
# Development
export DB_SCHEMA=dev_pingvas
alembic upgrade head

# Production
export DB_SCHEMA=prod_pingvas
alembic upgrade head
```

**4. Rollback if Needed**:
```bash
# Rollback one migration
alembic downgrade -1

# Rollback to specific version
alembic downgrade abc123
```

### Migration Best Practices

1. **Always use transactions**: Alembic wraps migrations in transactions by default
2. **Test on dev first**: Apply to dev_pingvas schema before prod_pingvas
3. **Backward compatible**: Ensure migrations don't break running code
4. **Data migrations**: Use separate data migration scripts for complex transformations
5. **No destructive changes**: Never drop columns/tables without backup
6. **Index creation**: Use `CONCURRENTLY` for large tables (requires separate transaction)

```python
# Example: Create index concurrently
def upgrade():
    op.execute("""
        CREATE INDEX CONCURRENTLY IF NOT EXISTS generation_jobs_user_status_idx
        ON generation_jobs(user_id, status)
    """)
```

---

## 9. Sample Queries

### 9.1 User Authentication and Credits

**Check User Login Credentials**:
```sql
SELECT
    u.id,
    u.email,
    u.username,
    u.hashed_password,
    u.role,
    u.is_active,
    u.email_verified,
    c.balance as credit_balance
FROM users u
LEFT JOIN credits c ON c.user_id = u.id
WHERE u.email = 'user@example.com'
  AND u.deleted_at IS NULL;
```

**Get User with OAuth Connections**:
```sql
SELECT
    u.id,
    u.email,
    u.username,
    u.full_name,
    u.profile_image_url,
    json_agg(
        json_build_object(
            'provider', oc.provider,
            'provider_user_id', oc.provider_user_id,
            'connected_at', oc.created_at
        )
    ) FILTER (WHERE oc.id IS NOT NULL) as oauth_connections
FROM users u
LEFT JOIN oauth_connections oc ON oc.user_id = u.id
WHERE u.id = 'user-uuid'
GROUP BY u.id;
```

### 9.2 Credit Management

**Deduct Credits Atomically**:
```sql
-- Start transaction
BEGIN;

-- Lock user's credit row
SELECT balance
FROM credits
WHERE user_id = 'user-uuid'
FOR UPDATE;

-- Check sufficient balance
DO $$
DECLARE
    current_balance INTEGER;
    required_credits INTEGER := 10;
BEGIN
    SELECT balance INTO current_balance FROM credits WHERE user_id = 'user-uuid';

    IF current_balance < required_credits THEN
        RAISE EXCEPTION 'Insufficient credits: % available, % required',
            current_balance, required_credits;
    END IF;
END $$;

-- Deduct credits
UPDATE credits
SET
    balance = balance - 10,
    lifetime_spent = lifetime_spent + 10,
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 'user-uuid';

-- Record transaction
INSERT INTO credit_transactions (
    user_id, transaction_type, amount, balance_after,
    description, reference_id, reference_type
)
SELECT
    'user-uuid', 'spend', -10, balance,
    'Image generation - Job #123', 'job-uuid', 'generation_job'
FROM credits
WHERE user_id = 'user-uuid';

COMMIT;
```

**Credit Transaction History**:
```sql
SELECT
    ct.id,
    ct.transaction_type,
    ct.amount,
    ct.balance_after,
    ct.description,
    ct.created_at,
    CASE
        WHEN ct.reference_type = 'generation_job' THEN gj.id
        WHEN ct.reference_type = 'subscription' THEN s.plan_type
        ELSE NULL
    END as reference_details
FROM credit_transactions ct
LEFT JOIN generation_jobs gj ON ct.reference_id = gj.id AND ct.reference_type = 'generation_job'
LEFT JOIN subscriptions s ON ct.reference_id = s.id AND ct.reference_type = 'subscription'
WHERE ct.user_id = 'user-uuid'
ORDER BY ct.created_at DESC
LIMIT 50;
```

### 9.3 Generation Jobs

**Create Generation Job and Enqueue**:
```sql
INSERT INTO generation_jobs (
    user_id, model_id, status, prompt, negative_prompt,
    parameters, priority, estimated_credits
)
VALUES (
    'user-uuid',
    'model-uuid',
    'pending',
    'A beautiful sunset over mountains',
    'blurry, low quality',
    '{"width": 512, "height": 512, "steps": 30, "cfg_scale": 7.5, "seed": 42}',
    50,  -- Priority (paid users get higher)
    10   -- Estimated credits
)
RETURNING id, created_at;
```

**Get Next Job from Queue (Worker)**:
```sql
-- Get highest priority pending job
UPDATE generation_jobs
SET
    status = 'processing',
    worker_id = 'worker-pod-123',
    started_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE id = (
    SELECT id
    FROM generation_jobs
    WHERE status = 'pending'
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Complete Job with Result**:
```sql
UPDATE generation_jobs
SET
    status = 'completed',
    actual_credits = 10,
    completed_at = CURRENT_TIMESTAMP,
    result_metadata = '{"seed": 42, "actual_steps": 30, "inference_time_ms": 15234}',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'job-uuid';
```

**User's Generation History**:
```sql
SELECT
    gj.id,
    gj.status,
    gj.prompt,
    gj.actual_credits,
    gj.created_at,
    gj.completed_at,
    gj.completed_at - gj.started_at as processing_time,
    m.display_name as model_name,
    i.cloudfront_url as image_url
FROM generation_jobs gj
LEFT JOIN models m ON m.id = gj.model_id
LEFT JOIN images i ON i.generation_job_id = gj.id
WHERE gj.user_id = 'user-uuid'
ORDER BY gj.created_at DESC
LIMIT 20;
```

### 9.4 Image Gallery

**Get User's Images with Pagination**:
```sql
SELECT
    i.id,
    i.cloudfront_url,
    i.width,
    i.height,
    i.prompt,
    i.is_public,
    i.like_count,
    i.created_at,
    COALESCE(json_agg(
        json_build_object(
            'board_id', b.id,
            'board_name', b.name
        )
    ) FILTER (WHERE b.id IS NOT NULL), '[]') as boards
FROM images i
LEFT JOIN board_images bi ON bi.image_id = i.id
LEFT JOIN boards b ON b.id = bi.board_id
WHERE i.user_id = 'user-uuid'
  AND i.deleted_at IS NULL
GROUP BY i.id
ORDER BY i.created_at DESC
LIMIT 20 OFFSET 0;
```

**Public Gallery (Explore Page)**:
```sql
SELECT
    i.id,
    i.cloudfront_url,
    i.width,
    i.height,
    i.prompt,
    i.like_count,
    i.view_count,
    i.created_at,
    u.username as creator_username,
    u.profile_image_url as creator_avatar
FROM images i
JOIN users u ON u.id = i.user_id
WHERE i.is_public = true
  AND i.deleted_at IS NULL
  AND u.deleted_at IS NULL
ORDER BY i.like_count DESC, i.created_at DESC
LIMIT 50;
```

**Add Image to Board**:
```sql
-- Get max display_order
WITH max_order AS (
    SELECT COALESCE(MAX(display_order), 0) as max_val
    FROM board_images
    WHERE board_id = 'board-uuid'
)
INSERT INTO board_images (board_id, image_id, display_order)
SELECT 'board-uuid', 'image-uuid', max_val + 1
FROM max_order
ON CONFLICT (board_id, image_id) DO NOTHING;
```

### 9.5 Subscription Management

**Get User Subscription Status**:
```sql
SELECT
    s.plan_type,
    s.status,
    s.current_period_end,
    s.monthly_credit_quota,
    s.last_credit_grant_at,
    s.cancel_at_period_end,
    c.balance as current_balance
FROM subscriptions s
JOIN credits c ON c.user_id = s.user_id
WHERE s.user_id = 'user-uuid';
```

**Grant Monthly Credits (Cron Job)**:
```sql
-- Find users who need monthly credit grant
WITH eligible_users AS (
    SELECT
        s.id as subscription_id,
        s.user_id,
        s.monthly_credit_quota
    FROM subscriptions s
    WHERE s.status = 'active'
      AND s.plan_type != 'free'
      AND (
          s.last_credit_grant_at IS NULL OR
          s.last_credit_grant_at < DATE_TRUNC('month', CURRENT_TIMESTAMP)
      )
)
UPDATE credits c
SET
    balance = balance + eu.monthly_credit_quota,
    lifetime_earned = lifetime_earned + eu.monthly_credit_quota,
    last_recharged_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
FROM eligible_users eu
WHERE c.user_id = eu.user_id
RETURNING c.user_id, eu.monthly_credit_quota;

-- Update last_credit_grant_at in subscriptions
UPDATE subscriptions s
SET last_credit_grant_at = CURRENT_TIMESTAMP
FROM eligible_users eu
WHERE s.id = eu.subscription_id;

-- Record transactions
INSERT INTO credit_transactions (
    user_id, transaction_type, amount, balance_after,
    description, reference_id, reference_type
)
SELECT
    c.user_id,
    'subscription_grant',
    s.monthly_credit_quota,
    c.balance,
    'Monthly credit grant - ' || s.plan_type || ' plan',
    s.id,
    'subscription'
FROM credits c
JOIN subscriptions s ON s.user_id = c.user_id
WHERE s.last_credit_grant_at = CURRENT_TIMESTAMP;
```

### 9.6 Analytics Queries

**Daily Generation Stats**:
```sql
SELECT
    DATE_TRUNC('day', created_at) as date,
    COUNT(*) as total_jobs,
    COUNT(*) FILTER (WHERE status = 'completed') as completed_jobs,
    COUNT(*) FILTER (WHERE status = 'failed') as failed_jobs,
    AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (WHERE status = 'completed') as avg_processing_time_seconds,
    SUM(actual_credits) FILTER (WHERE status = 'completed') as total_credits_spent
FROM generation_jobs
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY date DESC;
```

**Top Models by Usage**:
```sql
SELECT
    m.display_name,
    m.model_type,
    COUNT(gj.id) as usage_count,
    AVG(EXTRACT(EPOCH FROM (gj.completed_at - gj.started_at))) as avg_inference_time
FROM models m
LEFT JOIN generation_jobs gj ON gj.model_id = m.id
WHERE gj.created_at >= CURRENT_DATE - INTERVAL '7 days'
  AND gj.status = 'completed'
GROUP BY m.id, m.display_name, m.model_type
ORDER BY usage_count DESC
LIMIT 10;
```

**User Engagement Metrics**:
```sql
SELECT
    u.id,
    u.username,
    u.created_at as signup_date,
    s.plan_type,
    c.balance,
    c.lifetime_spent,
    COUNT(DISTINCT gj.id) as total_generations,
    COUNT(DISTINCT i.id) as total_images,
    COUNT(DISTINCT b.id) as total_boards,
    MAX(gj.created_at) as last_generation_at
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id
LEFT JOIN credits c ON c.user_id = u.id
LEFT JOIN generation_jobs gj ON gj.user_id = u.id
LEFT JOIN images i ON i.user_id = u.id
LEFT JOIN boards b ON b.user_id = u.id
WHERE u.deleted_at IS NULL
GROUP BY u.id, s.plan_type, c.balance, c.lifetime_spent
ORDER BY c.lifetime_spent DESC
LIMIT 100;
```

---

## 10. Performance Considerations

### 10.1 Query Optimization

**1. Use Indexes Effectively**:
```sql
-- ✅ Good: Uses index
EXPLAIN ANALYZE
SELECT * FROM generation_jobs
WHERE status = 'pending'
ORDER BY priority DESC, created_at
LIMIT 10;

-- ❌ Bad: Table scan
EXPLAIN ANALYZE
SELECT * FROM generation_jobs
WHERE EXTRACT(YEAR FROM created_at) = 2025;

-- ✅ Good: Use date range instead
EXPLAIN ANALYZE
SELECT * FROM generation_jobs
WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01';
```

**2. Avoid N+1 Queries**:
```sql
-- ❌ Bad: N+1 queries in application code
-- Query 1: Get users
SELECT * FROM users LIMIT 10;
-- Query 2-11: Get credits for each user (10 queries)
SELECT * FROM credits WHERE user_id = ?;

-- ✅ Good: Single JOIN query
SELECT
    u.*,
    c.balance,
    c.lifetime_earned,
    c.lifetime_spent
FROM users u
LEFT JOIN credits c ON c.user_id = u.id
LIMIT 10;
```

**3. Use Covering Indexes**:
```sql
-- Create covering index for common query
CREATE INDEX generation_jobs_status_covering_idx
ON generation_jobs(status, priority, created_at)
INCLUDE (user_id, model_id, prompt)
WHERE status IN ('pending', 'processing');

-- Query uses index-only scan (faster)
SELECT user_id, model_id, prompt, created_at
FROM generation_jobs
WHERE status = 'pending'
ORDER BY priority DESC, created_at
LIMIT 10;
```

### 10.2 Connection Pooling

**PgBouncer Configuration**:
```ini
[databases]
pingvas = host=pingvas-shared-rds.cluster-xxxxx.us-east-1.rds.amazonaws.com port=5432 dbname=pingvas

[pgbouncer]
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25
reserve_pool_size = 5
reserve_pool_timeout = 3
max_db_connections = 100
```

**Application Connection Pool (SQLAlchemy)**:
```python
from sqlalchemy.ext.asyncio import create_async_engine

engine = create_async_engine(
    settings.database_url,
    pool_size=20,          # Core connections
    max_overflow=10,       # Additional connections
    pool_timeout=30,       # Wait timeout
    pool_recycle=3600,     # Recycle connections after 1 hour
    pool_pre_ping=True,    # Verify connections before use
    echo=False             # Disable SQL logging in prod
)
```

### 10.3 Read Replicas

**Use Read Replicas for Heavy Queries**:
```python
# Write engine (primary)
write_engine = create_async_engine(settings.database_write_url)

# Read engine (replicas)
read_engine = create_async_engine(settings.database_read_url)

# Use read replica for analytics
async with read_engine.connect() as conn:
    result = await conn.execute(text("""
        SELECT DATE_TRUNC('day', created_at) as date, COUNT(*)
        FROM generation_jobs
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY date
    """))
```

### 10.4 Caching Strategy

**Redis Caching for Hot Data**:
```python
import redis.asyncio as redis

# Cache user credits
async def get_user_credits(user_id: str, db: AsyncSession, cache: redis.Redis):
    # Try cache first
    cached = await cache.get(f"credits:{user_id}")
    if cached:
        return json.loads(cached)

    # Query database
    result = await db.execute(
        select(Credit).where(Credit.user_id == user_id)
    )
    credit = result.scalar_one()

    # Cache for 5 minutes
    await cache.setex(
        f"credits:{user_id}",
        300,
        json.dumps({"balance": credit.balance, "lifetime_earned": credit.lifetime_earned})
    )

    return credit
```

### 10.5 Partitioning Strategy (Future)

**Time-based Partitioning for Large Tables**:
```sql
-- Partition credit_transactions by month
CREATE TABLE credit_transactions_2025_01 PARTITION OF credit_transactions
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE credit_transactions_2025_02 PARTITION OF credit_transactions
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');

-- Auto-create partitions with pg_partman extension
SELECT partman.create_parent(
    p_parent_table := 'credit_transactions',
    p_control := 'created_at',
    p_type := 'native',
    p_interval := '1 month',
    p_premake := 3  -- Pre-create 3 months ahead
);
```

### 10.6 Monitoring and Alerts

**Key Metrics to Monitor**:

1. **Connection Pool Usage**:
   ```sql
   SELECT count(*) as active_connections
   FROM pg_stat_activity
   WHERE datname = 'pingvas';
   ```

2. **Slow Queries**:
   ```sql
   SELECT
       query,
       mean_exec_time,
       calls,
       total_exec_time
   FROM pg_stat_statements
   WHERE mean_exec_time > 1000  -- > 1 second
   ORDER BY mean_exec_time DESC
   LIMIT 10;
   ```

3. **Index Usage**:
   ```sql
   SELECT
       schemaname,
       tablename,
       indexname,
       idx_scan as index_scans,
       idx_tup_read as tuples_read
   FROM pg_stat_user_indexes
   WHERE idx_scan = 0  -- Unused indexes
   ORDER BY pg_relation_size(indexrelid) DESC;
   ```

4. **Table Bloat**:
   ```sql
   SELECT
       schemaname,
       tablename,
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
       n_live_tup,
       n_dead_tup,
       round(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 2) as dead_tuple_percent
   FROM pg_stat_user_tables
   WHERE n_dead_tup > 1000
   ORDER BY n_dead_tup DESC;
   ```

---

## Summary

This document provides complete database specifications for the InvokeAI SaaS platform, including:

- ✅ **10 tables** with full column specifications, constraints, and indexes
- ✅ **Complete ERD** showing all relationships
- ✅ **Row-Level Security** policies for data isolation
- ✅ **Migration strategy** using Alembic
- ✅ **Sample queries** for all major operations
- ✅ **Performance optimization** guidelines

**Database Size Estimates** (Production, 1 year):

| Table | Estimated Rows | Storage Size |
|-------|---------------|--------------|
| users | 50,000 | 50 MB |
| oauth_connections | 75,000 | 30 MB |
| credits | 50,000 | 10 MB |
| credit_transactions | 5,000,000 | 2 GB |
| generation_jobs | 10,000,000 | 8 GB |
| images | 8,000,000 | 5 GB |
| boards | 200,000 | 100 MB |
| board_images | 3,000,000 | 150 MB |
| models | 100 | 1 MB |
| subscriptions | 20,000 | 10 MB |
| **Total** | **26,395,100** | **~15.5 GB** |

**Aurora Serverless v2 Scaling**:
- Dev: 0.5-1 ACU (sufficient for development load)
- Prod: 1-4 ACU (scales with user activity)
- Cost: ~$130-520/month based on load

---

**Document End**