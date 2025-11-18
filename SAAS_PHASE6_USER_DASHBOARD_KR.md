# Phase 6: User Dashboard - 개인 파일 관리 & 검색

> 개인 파일 관리 + 공유 리소스 + Elasticsearch 검색

**소요 시간**: Week 12-14 (3주, 100-120시간)
**난이도**: ⭐⭐⭐⭐ (상)
**예상 비용**: Elasticsearch $150/월 (r6g.large.search x 2)

---

## 📋 목차

1. [개요](#1-개요)
2. [데이터베이스 스키마](#2-데이터베이스-스키마)
3. [S3 스토리지 관리](#3-s3-스토리지-관리)
4. [파일 관리 API](#4-파일-관리-api)
5. [공유 기능](#5-공유-기능)
6. [Elasticsearch 검색](#6-elasticsearch-검색)
7. [썸네일 생성](#7-썸네일-생성)
8. [프론트엔드 UI](#8-프론트엔드-ui)
9. [테스트 및 검증](#9-테스트-및-검증)

---

## 1. 개요

### 1.1 목표

이 Phase에서 구현할 핵심 기능:

✅ **개인 파일 관리**
- 생성한 이미지 목록 조회
- 폴더 구조 (Collections)
- 태그 시스템
- 즐겨찾기

✅ **공유 기능**
- Public/Private 이미지
- 링크 공유 (Share Link)
- 팀 공유 (Workspace)
- 권한 관리 (View/Download/Edit)

✅ **검색 시스템**
- Elasticsearch + Nori (한글 분석기)
- 프롬프트 검색
- 메타데이터 필터 (모델, 크기, 날짜)
- 태그 자동완성

✅ **스토리지 관리**
- S3 업로드/다운로드
- 플랜별 용량 제한
- 자동 압축/최적화
- CDN (CloudFront)

### 1.2 아키텍처 흐름

```
┌─────────────┐
│   사용자     │
│  Dashboard  │
└──────┬──────┘
       │ 1. "내 이미지 보기" 요청
       ↓
┌─────────────────────────────────┐
│  FastAPI Backend                │
│  GET /api/v1/files?folder=xxx   │
│  - RLS로 user_id 필터링          │
│  - 폴더/태그 필터 적용             │
└──────┬──────────────────────────┘
       │ 2. PostgreSQL 조회
       ↓
┌─────────────────────────────────┐
│  Aurora PostgreSQL              │
│  SELECT * FROM images           │
│  WHERE user_id = current_user   │
└──────┬──────────────────────────┘
       │ 3. S3 Pre-signed URL 생성
       ↓
┌─────────────────────────────────┐
│  Amazon S3 + CloudFront         │
│  - 원본 이미지: /images/uuid.png │
│  - 썸네일: /thumbs/uuid_256.webp │
└──────┬──────────────────────────┘
       │ 4. 이미지 목록 + URL 반환
       ↓
┌─────────────────────────────────┐
│  React Dashboard                │
│  - Grid/List 뷰                 │
│  - Infinite Scroll              │
│  - 검색/필터                     │
└─────────────────────────────────┘
```

---

## 2. 데이터베이스 스키마

### 2.1 Images 테이블 확장

```sql
-- Phase 3에서 생성된 images 테이블 확장
ALTER TABLE images ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(folder_id);
ALTER TABLE images ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE;
ALTER TABLE images ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;
ALTER TABLE images ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0;
ALTER TABLE images ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0;
ALTER TABLE images ADD COLUMN IF NOT EXISTS share_token VARCHAR(255) UNIQUE;
ALTER TABLE images ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMP;

-- 썸네일 URL
ALTER TABLE images ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS thumbnail_256_url TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS thumbnail_512_url TEXT;

-- 파일 정보
ALTER TABLE images ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS mime_type VARCHAR(50) DEFAULT 'image/png';

-- 인덱스 추가
CREATE INDEX IF NOT EXISTS idx_images_folder_id ON images(folder_id);
CREATE INDEX IF NOT EXISTS idx_images_is_public ON images(is_public) WHERE is_public = TRUE;
CREATE INDEX IF NOT EXISTS idx_images_is_favorite ON images(is_favorite, user_id) WHERE is_favorite = TRUE;
CREATE INDEX IF NOT EXISTS idx_images_share_token ON images(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at DESC);
```

### 2.2 Folders (Collections) 테이블

```sql
CREATE TABLE folders (
    folder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- 폴더 정보
    name VARCHAR(255) NOT NULL,
    description TEXT,
    color VARCHAR(7),  -- Hex color (#FF5733)
    icon VARCHAR(50),  -- Icon name (folder, star, heart, etc.)

    -- 정렬
    sort_order INTEGER DEFAULT 0,

    -- 메타데이터
    image_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP,

    -- RLS
    CONSTRAINT fk_folders_user FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_folders_user_id ON folders(user_id);
CREATE INDEX idx_folders_sort_order ON folders(user_id, sort_order);

-- RLS 적용
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY folders_isolation_policy ON folders
    USING (user_id = current_setting('app.current_user_id')::UUID);
```

### 2.3 Tags 테이블

```sql
CREATE TABLE tags (
    tag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- 태그 정보
    name VARCHAR(100) NOT NULL,
    color VARCHAR(7),

    -- 사용 빈도
    usage_count INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- 중복 방지
    CONSTRAINT unique_user_tag UNIQUE (user_id, name)
);

CREATE INDEX idx_tags_user_id ON tags(user_id);
CREATE INDEX idx_tags_name ON tags(user_id, name);

-- RLS
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY tags_isolation_policy ON tags
    USING (user_id = current_setting('app.current_user_id')::UUID);
```

### 2.4 Image_Tags (Many-to-Many) 테이블

```sql
CREATE TABLE image_tags (
    image_id UUID NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (image_id, tag_id)
);

CREATE INDEX idx_image_tags_image_id ON image_tags(image_id);
CREATE INDEX idx_image_tags_tag_id ON image_tags(tag_id);
```

### 2.5 Shares 테이블

```sql
CREATE TABLE shares (
    share_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    image_id UUID NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- 공유 설정
    share_token VARCHAR(255) UNIQUE NOT NULL,
    share_type VARCHAR(20) DEFAULT 'link',  -- link, email, workspace
    permission VARCHAR(20) DEFAULT 'view',  -- view, download, edit

    -- 만료 설정
    expires_at TIMESTAMP,
    max_views INTEGER,
    current_views INTEGER DEFAULT 0,

    -- 보안
    password_hash VARCHAR(255),
    allowed_ips TEXT[],

    -- 메타데이터
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at TIMESTAMP
);

CREATE INDEX idx_shares_image_id ON shares(image_id);
CREATE INDEX idx_shares_user_id ON shares(user_id);
CREATE INDEX idx_shares_token ON shares(share_token);
CREATE INDEX idx_shares_expires_at ON shares(expires_at) WHERE expires_at IS NOT NULL;
```

### 2.6 Storage Usage 추적

```sql
CREATE TABLE storage_usage (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,

    -- 용량 (bytes)
    images_size BIGINT DEFAULT 0,
    thumbnails_size BIGINT DEFAULT 0,
    total_size BIGINT GENERATED ALWAYS AS (images_size + thumbnails_size) STORED,

    -- 파일 개수
    image_count INTEGER DEFAULT 0,

    -- 마지막 업데이트
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trigger: 이미지 추가 시 용량 업데이트
CREATE OR REPLACE FUNCTION update_storage_usage()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO storage_usage (user_id, images_size, image_count)
        VALUES (NEW.user_id, COALESCE(NEW.file_size_bytes, 0), 1)
        ON CONFLICT (user_id) DO UPDATE
        SET images_size = storage_usage.images_size + COALESCE(NEW.file_size_bytes, 0),
            image_count = storage_usage.image_count + 1,
            updated_at = CURRENT_TIMESTAMP;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE storage_usage
        SET images_size = images_size - COALESCE(OLD.file_size_bytes, 0),
            image_count = image_count - 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = OLD.user_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_storage_usage
AFTER INSERT OR DELETE ON images
FOR EACH ROW EXECUTE FUNCTION update_storage_usage();
```

---

## 3. S3 스토리지 관리

### 3.1 S3 버킷 구조

```bash
# Terraform 설정
# infrastructure/modules/s3/main.tf

resource "aws_s3_bucket" "images" {
  bucket = "pingvasai-images-${var.environment}"

  tags = {
    Name        = "PingvasAI Images"
    Environment = var.environment
  }
}

# 버전 관리
resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id

  versioning_configuration {
    status = "Enabled"
  }
}

# 수명 주기 정책
resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    id     = "delete-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  # 미완성 멀티파트 업로드 정리
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# CORS 설정
resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "DELETE"]
    allowed_origins = [
      "https://pingvasai.com",
      "https://*.pingvasai.com"
    ]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# 암호화
resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
```

### 3.2 CloudFront CDN 설정

```hcl
# infrastructure/modules/cloudfront/main.tf

resource "aws_cloudfront_distribution" "images_cdn" {
  origin {
    domain_name = aws_s3_bucket.images.bucket_regional_domain_name
    origin_id   = "S3-pingvasai-images"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.images.cloudfront_access_identity_path
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "PingvasAI Images CDN"
  default_root_object = ""

  aliases = ["cdn.pingvasai.com"]

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-pingvasai-images"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 86400    # 1 day
    max_ttl                = 31536000 # 1 year
    compress               = true
  }

  # 썸네일 캐싱 (더 긴 TTL)
  ordered_cache_behavior {
    path_pattern     = "/thumbs/*"
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-pingvasai-images"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl                = 0
    default_ttl            = 604800   # 7 days
    max_ttl                = 31536000
    compress               = true
    viewer_protocol_policy = "redirect-to-https"
  }

  price_class = "PriceClass_100"  # US, Canada, Europe

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate.cdn.arn
    ssl_support_method  = "sni-only"
  }
}

resource "aws_cloudfront_origin_access_identity" "images" {
  comment = "OAI for PingvasAI Images"
}

# S3 버킷 정책: CloudFront만 접근 허용
resource "aws_s3_bucket_policy" "images" {
  bucket = aws_s3_bucket.images.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontAccess"
        Effect = "Allow"
        Principal = {
          AWS = aws_cloudfront_origin_access_identity.images.iam_arn
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.images.arn}/*"
      }
    ]
  })
}
```

### 3.3 S3 클라이언트 (Python)

```python
# backend/invokeai/app/services/storage/s3_client.py

"""
S3 스토리지 클라이언트
"""

import boto3
from botocore.exceptions import ClientError
from typing import Optional, BinaryIO
import uuid
from datetime import timedelta

from invokeai.app.core.config import settings


class S3Client:
    def __init__(self):
        self.s3 = boto3.client(
            's3',
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            region_name=settings.AWS_REGION,
        )
        self.bucket_name = settings.S3_BUCKET_NAME
        self.cdn_domain = settings.CLOUDFRONT_DOMAIN  # cdn.pingvasai.com

    def upload_image(
        self,
        file: BinaryIO,
        user_id: str,
        filename: Optional[str] = None,
        content_type: str = "image/png",
    ) -> dict:
        """
        이미지 업로드

        Args:
            file: 파일 객체
            user_id: 사용자 ID
            filename: 파일명 (없으면 UUID 생성)
            content_type: MIME 타입

        Returns:
            dict: {
                "key": S3 키,
                "url": CloudFront URL,
                "size": 파일 크기
            }
        """
        if not filename:
            filename = f"{uuid.uuid4()}.png"

        # S3 키: users/{user_id}/images/{filename}
        s3_key = f"users/{user_id}/images/{filename}"

        try:
            # 파일 크기 측정
            file.seek(0, 2)  # EOF로 이동
            file_size = file.tell()
            file.seek(0)  # 처음으로 되돌림

            # S3 업로드
            self.s3.upload_fileobj(
                file,
                self.bucket_name,
                s3_key,
                ExtraArgs={
                    'ContentType': content_type,
                    'CacheControl': 'max-age=31536000',  # 1년
                    'Metadata': {
                        'user_id': user_id,
                        'uploaded_at': str(datetime.utcnow()),
                    }
                }
            )

            # CloudFront URL
            cdn_url = f"https://{self.cdn_domain}/{s3_key}"

            return {
                "key": s3_key,
                "url": cdn_url,
                "size": file_size,
            }

        except ClientError as e:
            raise Exception(f"S3 upload failed: {str(e)}")

    def upload_thumbnail(
        self,
        file: BinaryIO,
        user_id: str,
        image_id: str,
        size: int = 256,
    ) -> str:
        """
        썸네일 업로드

        Args:
            file: 썸네일 파일
            user_id: 사용자 ID
            image_id: 원본 이미지 ID
            size: 썸네일 크기 (256, 512 등)

        Returns:
            str: CloudFront URL
        """
        s3_key = f"users/{user_id}/thumbs/{image_id}_{size}.webp"

        self.s3.upload_fileobj(
            file,
            self.bucket_name,
            s3_key,
            ExtraArgs={
                'ContentType': 'image/webp',
                'CacheControl': 'max-age=2592000',  # 30일
            }
        )

        return f"https://{self.cdn_domain}/{s3_key}"

    def get_presigned_url(
        self,
        s3_key: str,
        expiration: int = 3600,
        filename: Optional[str] = None,
    ) -> str:
        """
        Pre-signed URL 생성 (다운로드용)

        Args:
            s3_key: S3 키
            expiration: 만료 시간 (초)
            filename: 다운로드 파일명

        Returns:
            str: Pre-signed URL
        """
        params = {
            'Bucket': self.bucket_name,
            'Key': s3_key,
        }

        if filename:
            params['ResponseContentDisposition'] = f'attachment; filename="{filename}"'

        try:
            url = self.s3.generate_presigned_url(
                'get_object',
                Params=params,
                ExpiresIn=expiration,
            )
            return url
        except ClientError as e:
            raise Exception(f"Failed to generate presigned URL: {str(e)}")

    def delete_image(self, s3_key: str):
        """
        이미지 삭제

        Args:
            s3_key: S3 키
        """
        try:
            self.s3.delete_object(
                Bucket=self.bucket_name,
                Key=s3_key,
            )
        except ClientError as e:
            raise Exception(f"S3 delete failed: {str(e)}")

    def delete_user_data(self, user_id: str):
        """
        사용자의 모든 데이터 삭제

        Args:
            user_id: 사용자 ID
        """
        prefix = f"users/{user_id}/"

        try:
            # 모든 객체 조회
            paginator = self.s3.get_paginator('list_objects_v2')
            pages = paginator.paginate(Bucket=self.bucket_name, Prefix=prefix)

            # 삭제할 객체 목록
            delete_keys = []
            for page in pages:
                if 'Contents' in page:
                    for obj in page['Contents']:
                        delete_keys.append({'Key': obj['Key']})

            # 배치 삭제 (최대 1000개씩)
            if delete_keys:
                for i in range(0, len(delete_keys), 1000):
                    batch = delete_keys[i:i+1000]
                    self.s3.delete_objects(
                        Bucket=self.bucket_name,
                        Delete={'Objects': batch}
                    )

        except ClientError as e:
            raise Exception(f"Failed to delete user data: {str(e)}")

    def get_storage_usage(self, user_id: str) -> dict:
        """
        사용자의 S3 스토리지 사용량 조회

        Args:
            user_id: 사용자 ID

        Returns:
            dict: {
                "total_size": 총 크기 (bytes),
                "image_count": 이미지 개수
            }
        """
        prefix = f"users/{user_id}/images/"

        total_size = 0
        image_count = 0

        try:
            paginator = self.s3.get_paginator('list_objects_v2')
            pages = paginator.paginate(Bucket=self.bucket_name, Prefix=prefix)

            for page in pages:
                if 'Contents' in page:
                    for obj in page['Contents']:
                        total_size += obj['Size']
                        image_count += 1

            return {
                "total_size": total_size,
                "image_count": image_count,
            }

        except ClientError as e:
            raise Exception(f"Failed to get storage usage: {str(e)}")
```

---

## 4. 파일 관리 API

### 4.1 이미지 목록 조회

```python
# backend/invokeai/app/api/routers/files.py

"""
파일 관리 API
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_
from typing import Optional, List
from pydantic import BaseModel

from invokeai.app.services.database import get_db
from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.models.user import User
from invokeai.app.models.image import Image
from invokeai.app.models.folder import Folder
from invokeai.app.models.tag import Tag


router = APIRouter(prefix="/files", tags=["Files"])


class ImageResponse(BaseModel):
    """이미지 응답"""
    image_id: str
    prompt: str
    negative_prompt: Optional[str]
    model: str
    width: int
    height: int
    image_url: str
    thumbnail_256_url: Optional[str]
    thumbnail_512_url: Optional[str]
    is_favorite: bool
    is_public: bool
    folder_id: Optional[str]
    tags: List[str]
    view_count: int
    download_count: int
    file_size_bytes: int
    created_at: str


class ImageListResponse(BaseModel):
    """이미지 목록 응답"""
    images: List[ImageResponse]
    total: int
    page: int
    page_size: int
    has_more: bool


@router.get("/images", response_model=ImageListResponse)
async def list_images(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    folder_id: Optional[str] = Query(None),
    is_favorite: Optional[bool] = Query(None),
    is_public: Optional[bool] = Query(None),
    tag: Optional[str] = Query(None),
    sort_by: str = Query("created_at", regex="^(created_at|view_count|download_count)$"),
    sort_order: str = Query("desc", regex="^(asc|desc)$"),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    이미지 목록 조회

    Query Parameters:
        - page: 페이지 번호 (1부터 시작)
        - page_size: 페이지 크기 (최대 100)
        - folder_id: 폴더 ID 필터
        - is_favorite: 즐겨찾기만 조회
        - is_public: Public 이미지만 조회
        - tag: 태그 필터
        - sort_by: 정렬 기준 (created_at, view_count, download_count)
        - sort_order: 정렬 순서 (asc, desc)

    Returns:
        ImageListResponse: 이미지 목록
    """
    # 기본 쿼리
    stmt = select(Image).where(Image.user_id == current_user.user_id)

    # 필터 적용
    if folder_id:
        stmt = stmt.where(Image.folder_id == folder_id)

    if is_favorite is not None:
        stmt = stmt.where(Image.is_favorite == is_favorite)

    if is_public is not None:
        stmt = stmt.where(Image.is_public == is_public)

    # 태그 필터
    if tag:
        stmt = stmt.join(Image.tags).where(Tag.name == tag)

    # 총 개수 조회
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total_result = await db.execute(count_stmt)
    total = total_result.scalar()

    # 정렬
    if sort_order == "desc":
        stmt = stmt.order_by(getattr(Image, sort_by).desc())
    else:
        stmt = stmt.order_by(getattr(Image, sort_by).asc())

    # 페이지네이션
    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size)

    # 실행
    result = await db.execute(stmt)
    images = result.scalars().all()

    # 응답 생성
    image_responses = []
    for image in images:
        # 태그 조회
        tags_stmt = select(Tag.name).join(Image.tags).where(Image.image_id == image.image_id)
        tags_result = await db.execute(tags_stmt)
        tags = [tag for tag in tags_result.scalars().all()]

        image_responses.append(ImageResponse(
            image_id=str(image.image_id),
            prompt=image.prompt,
            negative_prompt=image.negative_prompt,
            model=image.model,
            width=image.width,
            height=image.height,
            image_url=image.image_url,
            thumbnail_256_url=image.thumbnail_256_url,
            thumbnail_512_url=image.thumbnail_512_url,
            is_favorite=image.is_favorite,
            is_public=image.is_public,
            folder_id=str(image.folder_id) if image.folder_id else None,
            tags=tags,
            view_count=image.view_count,
            download_count=image.download_count,
            file_size_bytes=image.file_size_bytes or 0,
            created_at=image.created_at.isoformat(),
        ))

    has_more = (offset + page_size) < total

    return ImageListResponse(
        images=image_responses,
        total=total,
        page=page,
        page_size=page_size,
        has_more=has_more,
    )


@router.get("/images/{image_id}", response_model=ImageResponse)
async def get_image(
    image_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    이미지 상세 조회

    Args:
        image_id: 이미지 ID

    Returns:
        ImageResponse: 이미지 정보
    """
    stmt = select(Image).where(
        Image.image_id == image_id,
        Image.user_id == current_user.user_id,
    )
    result = await db.execute(stmt)
    image = result.scalar_one_or_none()

    if not image:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found",
        )

    # 태그 조회
    tags_stmt = select(Tag.name).join(Image.tags).where(Image.image_id == image.image_id)
    tags_result = await db.execute(tags_stmt)
    tags = [tag for tag in tags_result.scalars().all()]

    return ImageResponse(
        image_id=str(image.image_id),
        prompt=image.prompt,
        negative_prompt=image.negative_prompt,
        model=image.model,
        width=image.width,
        height=image.height,
        image_url=image.image_url,
        thumbnail_256_url=image.thumbnail_256_url,
        thumbnail_512_url=image.thumbnail_512_url,
        is_favorite=image.is_favorite,
        is_public=image.is_public,
        folder_id=str(image.folder_id) if image.folder_id else None,
        tags=tags,
        view_count=image.view_count,
        download_count=image.download_count,
        file_size_bytes=image.file_size_bytes or 0,
        created_at=image.created_at.isoformat(),
    )
```

### 4.2 이미지 업데이트

```python
class ImageUpdateRequest(BaseModel):
    """이미지 업데이트 요청"""
    is_favorite: Optional[bool] = None
    is_public: Optional[bool] = None
    folder_id: Optional[str] = None
    tags: Optional[List[str]] = None


@router.patch("/images/{image_id}")
async def update_image(
    image_id: str,
    request: ImageUpdateRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    이미지 정보 업데이트

    Args:
        image_id: 이미지 ID
        request: 업데이트할 정보

    Returns:
        dict: 업데이트된 이미지 정보
    """
    # 이미지 조회
    stmt = select(Image).where(
        Image.image_id == image_id,
        Image.user_id == current_user.user_id,
    )
    result = await db.execute(stmt)
    image = result.scalar_one_or_none()

    if not image:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found",
        )

    # 업데이트
    if request.is_favorite is not None:
        image.is_favorite = request.is_favorite

    if request.is_public is not None:
        image.is_public = request.is_public

    if request.folder_id is not None:
        # 폴더 존재 확인
        if request.folder_id:
            folder_stmt = select(Folder).where(
                Folder.folder_id == request.folder_id,
                Folder.user_id == current_user.user_id,
            )
            folder_result = await db.execute(folder_stmt)
            folder = folder_result.scalar_one_or_none()

            if not folder:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Folder not found",
                )

        image.folder_id = request.folder_id

    # 태그 업데이트
    if request.tags is not None:
        # 기존 태그 삭제
        await db.execute(
            delete(ImageTag).where(ImageTag.image_id == image_id)
        )

        # 새 태그 추가
        for tag_name in request.tags:
            # 태그 조회 또는 생성
            tag_stmt = select(Tag).where(
                Tag.user_id == current_user.user_id,
                Tag.name == tag_name,
            )
            tag_result = await db.execute(tag_stmt)
            tag = tag_result.scalar_one_or_none()

            if not tag:
                tag = Tag(
                    user_id=current_user.user_id,
                    name=tag_name,
                )
                db.add(tag)
                await db.flush()

            # ImageTag 생성
            image_tag = ImageTag(
                image_id=image_id,
                tag_id=tag.tag_id,
            )
            db.add(image_tag)

            # 태그 사용 빈도 증가
            tag.usage_count += 1

    await db.commit()
    await db.refresh(image)

    return {"message": "Image updated successfully"}


@router.delete("/images/{image_id}")
async def delete_image(
    image_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    이미지 삭제

    Args:
        image_id: 이미지 ID

    Returns:
        dict: 삭제 결과
    """
    # 이미지 조회
    stmt = select(Image).where(
        Image.image_id == image_id,
        Image.user_id == current_user.user_id,
    )
    result = await db.execute(stmt)
    image = result.scalar_one_or_none()

    if not image:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found",
        )

    # S3에서 삭제
    from invokeai.app.services.storage.s3_client import S3Client
    s3_client = S3Client()

    # 원본 이미지 삭제
    if image.s3_key:
        s3_client.delete_image(image.s3_key)

    # 썸네일 삭제 (TODO: 썸네일 키 저장 필요)

    # DB에서 삭제 (CASCADE로 자동 삭제: image_tags, shares)
    await db.delete(image)
    await db.commit()

    return {"message": "Image deleted successfully"}
```

### 4.3 폴더 관리

```python
class FolderCreateRequest(BaseModel):
    """폴더 생성 요청"""
    name: str
    description: Optional[str] = None
    color: Optional[str] = None
    icon: Optional[str] = None


class FolderResponse(BaseModel):
    """폴더 응답"""
    folder_id: str
    name: str
    description: Optional[str]
    color: Optional[str]
    icon: Optional[str]
    image_count: int
    created_at: str


@router.post("/folders", response_model=FolderResponse)
async def create_folder(
    request: FolderCreateRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    폴더 생성

    Args:
        request: 폴더 정보

    Returns:
        FolderResponse: 생성된 폴더
    """
    folder = Folder(
        user_id=current_user.user_id,
        name=request.name,
        description=request.description,
        color=request.color,
        icon=request.icon,
    )

    db.add(folder)
    await db.commit()
    await db.refresh(folder)

    return FolderResponse(
        folder_id=str(folder.folder_id),
        name=folder.name,
        description=folder.description,
        color=folder.color,
        icon=folder.icon,
        image_count=0,
        created_at=folder.created_at.isoformat(),
    )


@router.get("/folders", response_model=List[FolderResponse])
async def list_folders(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    폴더 목록 조회

    Returns:
        List[FolderResponse]: 폴더 목록
    """
    stmt = select(Folder).where(
        Folder.user_id == current_user.user_id
    ).order_by(Folder.sort_order, Folder.name)

    result = await db.execute(stmt)
    folders = result.scalars().all()

    folder_responses = []
    for folder in folders:
        # 폴더 내 이미지 개수 조회
        count_stmt = select(func.count()).where(
            Image.folder_id == folder.folder_id,
            Image.user_id == current_user.user_id,
        )
        count_result = await db.execute(count_stmt)
        image_count = count_result.scalar()

        folder_responses.append(FolderResponse(
            folder_id=str(folder.folder_id),
            name=folder.name,
            description=folder.description,
            color=folder.color,
            icon=folder.icon,
            image_count=image_count,
            created_at=folder.created_at.isoformat(),
        ))

    return folder_responses


@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: str,
    move_images_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    폴더 삭제

    Args:
        folder_id: 폴더 ID
        move_images_to: 이미지를 이동할 폴더 ID (None이면 이미지도 삭제)

    Returns:
        dict: 삭제 결과
    """
    # 폴더 조회
    stmt = select(Folder).where(
        Folder.folder_id == folder_id,
        Folder.user_id == current_user.user_id,
    )
    result = await db.execute(stmt)
    folder = result.scalar_one_or_none()

    if not folder:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder not found",
        )

    # 폴더 내 이미지 처리
    if move_images_to:
        # 이미지를 다른 폴더로 이동
        await db.execute(
            update(Image)
            .where(Image.folder_id == folder_id)
            .values(folder_id=move_images_to)
        )
    else:
        # 이미지의 folder_id를 NULL로 설정
        await db.execute(
            update(Image)
            .where(Image.folder_id == folder_id)
            .values(folder_id=None)
        )

    # 폴더 삭제
    await db.delete(folder)
    await db.commit()

    return {"message": "Folder deleted successfully"}
```

### 4.4 태그 관리

```python
class TagResponse(BaseModel):
    """태그 응답"""
    tag_id: str
    name: str
    color: Optional[str]
    usage_count: int


@router.get("/tags", response_model=List[TagResponse])
async def list_tags(
    query: Optional[str] = Query(None),
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    태그 목록 조회 (자동완성용)

    Args:
        query: 검색어 (태그명 부분 일치)

    Returns:
        List[TagResponse]: 태그 목록
    """
    stmt = select(Tag).where(Tag.user_id == current_user.user_id)

    if query:
        stmt = stmt.where(Tag.name.ilike(f"%{query}%"))

    stmt = stmt.order_by(Tag.usage_count.desc(), Tag.name)

    result = await db.execute(stmt)
    tags = result.scalars().all()

    return [
        TagResponse(
            tag_id=str(tag.tag_id),
            name=tag.name,
            color=tag.color,
            usage_count=tag.usage_count,
        )
        for tag in tags
    ]


@router.get("/storage-usage")
async def get_storage_usage(
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    스토리지 사용량 조회

    Returns:
        dict: 사용량 정보
    """
    from invokeai.app.core.plans import PLANS

    # DB에서 사용량 조회
    stmt = select(StorageUsage).where(StorageUsage.user_id == current_user.user_id)
    result = await db.execute(stmt)
    usage = result.scalar_one_or_none()

    if not usage:
        usage = StorageUsage(user_id=current_user.user_id)
        db.add(usage)
        await db.commit()
        await db.refresh(usage)

    # 플랜별 제한
    plan = PLANS[current_user.subscription_plan]
    quota_gb = plan.storage_gb

    # -1 = unlimited (Enterprise)
    quota_bytes = quota_gb * 1024 * 1024 * 1024 if quota_gb > 0 else -1

    return {
        "used_bytes": usage.total_size,
        "used_gb": round(usage.total_size / (1024 ** 3), 2),
        "quota_bytes": quota_bytes,
        "quota_gb": quota_gb,
        "percentage": (usage.total_size / quota_bytes * 100) if quota_bytes > 0 else 0,
        "image_count": usage.image_count,
    }
```

---

## 5. 공유 기능

### 5.1 공유 링크 생성

```python
# backend/invokeai/app/api/routers/shares.py

"""
공유 기능 API
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional
from pydantic import BaseModel
from datetime import datetime, timedelta
import secrets

from invokeai.app.services.database import get_db
from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.models.user import User
from invokeai.app.models.image import Image
from invokeai.app.models.share import Share


router = APIRouter(prefix="/shares", tags=["Shares"])


class ShareCreateRequest(BaseModel):
    """공유 링크 생성 요청"""
    image_id: str
    permission: str = "view"  # view, download
    expires_in_hours: Optional[int] = None  # None = 무제한
    max_views: Optional[int] = None
    password: Optional[str] = None


class ShareResponse(BaseModel):
    """공유 링크 응답"""
    share_id: str
    share_token: str
    share_url: str
    image_id: str
    permission: str
    expires_at: Optional[str]
    max_views: Optional[int]
    current_views: int
    is_active: bool
    created_at: str


@router.post("/", response_model=ShareResponse)
async def create_share(
    request: ShareCreateRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    공유 링크 생성

    Args:
        request: 공유 설정

    Returns:
        ShareResponse: 공유 링크 정보
    """
    # 이미지 소유권 확인
    stmt = select(Image).where(
        Image.image_id == request.image_id,
        Image.user_id == current_user.user_id,
    )
    result = await db.execute(stmt)
    image = result.scalar_one_or_none()

    if not image:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found",
        )

    # 공유 토큰 생성 (32 bytes = 64 hex chars)
    share_token = secrets.token_urlsafe(32)

    # 만료 시간 계산
    expires_at = None
    if request.expires_in_hours:
        expires_at = datetime.utcnow() + timedelta(hours=request.expires_in_hours)

    # 비밀번호 해시
    password_hash = None
    if request.password:
        from passlib.context import CryptContext
        pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
        password_hash = pwd_context.hash(request.password)

    # Share 생성
    share = Share(
        image_id=request.image_id,
        user_id=current_user.user_id,
        share_token=share_token,
        permission=request.permission,
        expires_at=expires_at,
        max_views=request.max_views,
        password_hash=password_hash,
    )

    db.add(share)
    await db.commit()
    await db.refresh(share)

    # 공유 URL
    share_url = f"https://pingvasai.com/share/{share_token}"

    return ShareResponse(
        share_id=str(share.share_id),
        share_token=share_token,
        share_url=share_url,
        image_id=str(share.image_id),
        permission=share.permission,
        expires_at=share.expires_at.isoformat() if share.expires_at else None,
        max_views=share.max_views,
        current_views=share.current_views,
        is_active=share.is_active,
        created_at=share.created_at.isoformat(),
    )


@router.get("/{share_token}")
async def get_shared_image(
    share_token: str,
    password: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """
    공유 링크로 이미지 조회 (인증 불필요)

    Args:
        share_token: 공유 토큰
        password: 비밀번호 (설정된 경우)

    Returns:
        dict: 이미지 정보
    """
    # Share 조회
    stmt = select(Share).where(
        Share.share_token == share_token,
        Share.is_active == True,
    )
    result = await db.execute(stmt)
    share = result.scalar_one_or_none()

    if not share:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Share not found or expired",
        )

    # 만료 확인
    if share.expires_at and share.expires_at < datetime.utcnow():
        share.is_active = False
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Share link has expired",
        )

    # 조회 수 제한 확인
    if share.max_views and share.current_views >= share.max_views:
        share.is_active = False
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Share link view limit reached",
        )

    # 비밀번호 확인
    if share.password_hash:
        if not password:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Password required",
            )

        from passlib.context import CryptContext
        pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
        if not pwd_context.verify(password, share.password_hash):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid password",
            )

    # 이미지 조회
    image_stmt = select(Image).where(Image.image_id == share.image_id)
    image_result = await db.execute(image_stmt)
    image = image_result.scalar_one()

    # 조회 수 증가
    share.current_views += 1
    share.last_accessed_at = datetime.utcnow()
    await db.commit()

    # 이미지 조회 수 증가
    image.view_count += 1
    await db.commit()

    return {
        "image_id": str(image.image_id),
        "image_url": image.image_url,
        "thumbnail_url": image.thumbnail_512_url or image.thumbnail_256_url,
        "prompt": image.prompt if share.permission in ["view", "download"] else None,
        "model": image.model,
        "width": image.width,
        "height": image.height,
        "permission": share.permission,
        "can_download": share.permission == "download",
    }


@router.delete("/{share_id}")
async def delete_share(
    share_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    공유 링크 삭제

    Args:
        share_id: 공유 ID

    Returns:
        dict: 삭제 결과
    """
    stmt = select(Share).where(
        Share.share_id == share_id,
        Share.user_id == current_user.user_id,
    )
    result = await db.execute(stmt)
    share = result.scalar_one_or_none()

    if not share:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Share not found",
        )

    await db.delete(share)
    await db.commit()

    return {"message": "Share deleted successfully"}
```

---

## 6. Elasticsearch 검색

### 6.1 Elasticsearch 설정

```bash
# Terraform으로 Elasticsearch 클러스터 생성
# infrastructure/modules/elasticsearch/main.tf

resource "aws_elasticsearch_domain" "images" {
  domain_name           = "pingvasai-images-${var.environment}"
  elasticsearch_version = "8.11"

  cluster_config {
    instance_type  = "r6g.large.search"
    instance_count = 2  # HA
    zone_awareness_enabled = true

    zone_awareness_config {
      availability_zone_count = 2
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_size = 100  # GB per node
    volume_type = "gp3"
  }

  encrypt_at_rest {
    enabled = true
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  advanced_options = {
    "rest.action.multi.allow_explicit_index" = "true"
  }

  access_policies = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = "*"
        }
        Action   = "es:*"
        Resource = "arn:aws:es:${var.aws_region}:${data.aws_caller_identity.current.account_id}:domain/pingvasai-images-${var.environment}/*"
        Condition = {
          IpAddress = {
            "aws:SourceIp" = var.allowed_ips  # EKS NAT Gateway IPs
          }
        }
      }
    ]
  })

  tags = {
    Name        = "PingvasAI Images Search"
    Environment = var.environment
  }
}

output "elasticsearch_endpoint" {
  value = aws_elasticsearch_domain.images.endpoint
}
```

### 6.2 인덱스 매핑 생성

```python
# backend/invokeai/app/services/search/elasticsearch_client.py

"""
Elasticsearch 클라이언트
"""

from elasticsearch import Elasticsearch, AsyncElasticsearch
from typing import List, Dict, Optional

from invokeai.app.core.config import settings


class ElasticsearchClient:
    def __init__(self):
        self.client = AsyncElasticsearch(
            hosts=[settings.ELASTICSEARCH_URL],
            http_auth=(settings.ELASTICSEARCH_USER, settings.ELASTICSEARCH_PASSWORD),
            verify_certs=True,
        )
        self.index_name = "images"

    async def create_index(self):
        """
        인덱스 생성 (최초 1회)
        """
        index_mapping = {
            "settings": {
                "analysis": {
                    "analyzer": {
                        "nori": {
                            "type": "custom",
                            "tokenizer": "nori_tokenizer",
                            "filter": ["nori_part_of_speech"]
                        }
                    }
                },
                "number_of_shards": 2,
                "number_of_replicas": 1,
            },
            "mappings": {
                "properties": {
                    "image_id": {"type": "keyword"},
                    "user_id": {"type": "keyword"},
                    "prompt": {
                        "type": "text",
                        "analyzer": "nori",  # 한글 분석기
                        "fields": {
                            "keyword": {"type": "keyword"}
                        }
                    },
                    "negative_prompt": {
                        "type": "text",
                        "analyzer": "nori"
                    },
                    "model": {"type": "keyword"},
                    "width": {"type": "integer"},
                    "height": {"type": "integer"},
                    "tags": {"type": "keyword"},
                    "folder_id": {"type": "keyword"},
                    "is_public": {"type": "boolean"},
                    "is_favorite": {"type": "boolean"},
                    "created_at": {"type": "date"},
                }
            }
        }

        try:
            await self.client.indices.create(
                index=self.index_name,
                body=index_mapping,
            )
            print(f"✅ Index '{self.index_name}' created")
        except Exception as e:
            if "resource_already_exists_exception" in str(e):
                print(f"Index '{self.index_name}' already exists")
            else:
                raise

    async def index_image(self, image_data: dict):
        """
        이미지 인덱싱

        Args:
            image_data: 이미지 메타데이터
        """
        await self.client.index(
            index=self.index_name,
            id=image_data["image_id"],
            document=image_data,
        )

    async def delete_image(self, image_id: str):
        """
        이미지 삭제

        Args:
            image_id: 이미지 ID
        """
        await self.client.delete(
            index=self.index_name,
            id=image_id,
        )

    async def search(
        self,
        user_id: str,
        query: Optional[str] = None,
        filters: Optional[Dict] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> Dict:
        """
        이미지 검색

        Args:
            user_id: 사용자 ID
            query: 검색어 (프롬프트 검색)
            filters: 필터 (model, tags, folder_id, etc.)
            page: 페이지 번호
            page_size: 페이지 크기

        Returns:
            dict: 검색 결과
        """
        # 기본 필터: 본인 이미지만
        must_filters = [
            {"term": {"user_id": user_id}}
        ]

        # 검색어
        if query:
            must_filters.append({
                "multi_match": {
                    "query": query,
                    "fields": ["prompt^2", "negative_prompt", "tags^1.5"],
                    "type": "best_fields",
                    "operator": "and",
                }
            })

        # 추가 필터
        if filters:
            if "model" in filters:
                must_filters.append({"term": {"model": filters["model"]}})

            if "tags" in filters:
                for tag in filters["tags"]:
                    must_filters.append({"term": {"tags": tag}})

            if "folder_id" in filters:
                must_filters.append({"term": {"folder_id": filters["folder_id"]}})

            if "is_favorite" in filters:
                must_filters.append({"term": {"is_favorite": filters["is_favorite"]}})

            if "width" in filters:
                must_filters.append({"term": {"width": filters["width"]}})

            if "height" in filters:
                must_filters.append({"term": {"height": filters["height"]}})

        # 검색 쿼리
        search_body = {
            "query": {
                "bool": {
                    "must": must_filters
                }
            },
            "sort": [
                {"created_at": {"order": "desc"}}
            ],
            "from": (page - 1) * page_size,
            "size": page_size,
        }

        # 실행
        response = await self.client.search(
            index=self.index_name,
            body=search_body,
        )

        # 결과 파싱
        hits = response["hits"]["hits"]
        total = response["hits"]["total"]["value"]

        results = [
            {
                **hit["_source"],
                "score": hit["_score"],
            }
            for hit in hits
        ]

        return {
            "results": results,
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": (page * page_size) < total,
        }

    async def suggest_tags(self, user_id: str, prefix: str) -> List[str]:
        """
        태그 자동완성

        Args:
            user_id: 사용자 ID
            prefix: 태그 접두사

        Returns:
            List[str]: 추천 태그 목록
        """
        search_body = {
            "query": {
                "bool": {
                    "must": [
                        {"term": {"user_id": user_id}},
                        {"prefix": {"tags": prefix}}
                    ]
                }
            },
            "aggs": {
                "tags": {
                    "terms": {
                        "field": "tags",
                        "include": f"{prefix}.*",
                        "size": 10,
                    }
                }
            },
            "size": 0,
        }

        response = await self.client.search(
            index=self.index_name,
            body=search_body,
        )

        buckets = response["aggregations"]["tags"]["buckets"]
        return [bucket["key"] for bucket in buckets]
```

### 6.3 검색 API

```python
# backend/invokeai/app/api/routers/search.py

"""
검색 API
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional, List

from invokeai.app.api.dependencies.auth import get_current_active_user
from invokeai.app.models.user import User
from invokeai.app.services.search.elasticsearch_client import ElasticsearchClient


router = APIRouter(prefix="/search", tags=["Search"])


@router.get("/images")
async def search_images(
    q: Optional[str] = Query(None, description="검색어 (프롬프트)"),
    model: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    folder_id: Optional[str] = Query(None),
    is_favorite: Optional[bool] = Query(None),
    width: Optional[int] = Query(None),
    height: Optional[int] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_active_user),
):
    """
    이미지 검색 (Elasticsearch)

    Query Parameters:
        - q: 검색어 (프롬프트, 태그)
        - model: 모델 필터
        - tags: 태그 필터 (복수 가능)
        - folder_id: 폴더 필터
        - is_favorite: 즐겨찾기 필터
        - width, height: 해상도 필터
        - page, page_size: 페이지네이션

    Returns:
        dict: 검색 결과
    """
    es_client = ElasticsearchClient()

    filters = {}
    if model:
        filters["model"] = model
    if tags:
        filters["tags"] = tags
    if folder_id:
        filters["folder_id"] = folder_id
    if is_favorite is not None:
        filters["is_favorite"] = is_favorite
    if width:
        filters["width"] = width
    if height:
        filters["height"] = height

    results = await es_client.search(
        user_id=str(current_user.user_id),
        query=q,
        filters=filters,
        page=page,
        page_size=page_size,
    )

    return results


@router.get("/tags/suggest")
async def suggest_tags(
    prefix: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_active_user),
):
    """
    태그 자동완성

    Args:
        prefix: 태그 접두사

    Returns:
        List[str]: 추천 태그
    """
    es_client = ElasticsearchClient()

    suggestions = await es_client.suggest_tags(
        user_id=str(current_user.user_id),
        prefix=prefix,
    )

    return {"suggestions": suggestions}
```

---

## 7. 썸네일 생성

### 7.1 Celery Task로 썸네일 생성

```python
# backend/invokeai/app/services/thumbnails/generator.py

"""
썸네일 생성 서비스
"""

from PIL import Image
from io import BytesIO
import asyncio

from invokeai.app.services.storage.s3_client import S3Client


class ThumbnailGenerator:
    def __init__(self):
        self.s3_client = S3Client()
        self.sizes = [256, 512]  # 256x256, 512x512

    def generate_thumbnail(
        self,
        image_bytes: bytes,
        size: int,
        format: str = "WEBP",
    ) -> BytesIO:
        """
        썸네일 생성

        Args:
            image_bytes: 원본 이미지 바이트
            size: 썸네일 크기 (정사각형)
            format: 출력 형식 (WEBP, JPEG, PNG)

        Returns:
            BytesIO: 썸네일 바이트
        """
        # PIL Image 로드
        image = Image.open(BytesIO(image_bytes))

        # RGBA -> RGB 변환 (WEBP는 RGBA 지원하지만 최적화)
        if image.mode == 'RGBA' and format != 'PNG':
            background = Image.new('RGB', image.size, (255, 255, 255))
            background.paste(image, mask=image.split()[3])
            image = background

        # 리사이즈 (비율 유지, Lanczos 필터)
        image.thumbnail((size, size), Image.Resampling.LANCZOS)

        # BytesIO로 저장
        output = BytesIO()
        image.save(
            output,
            format=format,
            quality=85 if format == 'WEBP' else 95,
            optimize=True,
        )
        output.seek(0)

        return output

    async def generate_and_upload(
        self,
        image_bytes: bytes,
        user_id: str,
        image_id: str,
    ) -> dict:
        """
        썸네일 생성 및 S3 업로드

        Args:
            image_bytes: 원본 이미지
            user_id: 사용자 ID
            image_id: 이미지 ID

        Returns:
            dict: {
                "thumbnail_256_url": str,
                "thumbnail_512_url": str,
            }
        """
        thumbnail_urls = {}

        for size in self.sizes:
            # 썸네일 생성
            thumbnail = self.generate_thumbnail(image_bytes, size, format="WEBP")

            # S3 업로드
            thumbnail_url = self.s3_client.upload_thumbnail(
                file=thumbnail,
                user_id=user_id,
                image_id=image_id,
                size=size,
            )

            thumbnail_urls[f"thumbnail_{size}_url"] = thumbnail_url

        return thumbnail_urls
```

### 7.2 Celery Task 등록

```python
# backend/invokeai/app/tasks/thumbnails.py

"""
썸네일 생성 Celery Task
"""

from celery import shared_task
import requests

from invokeai.app.services.thumbnails.generator import ThumbnailGenerator
from invokeai.app.services.database import get_db_sync
from invokeai.app.models.image import Image


@shared_task(name="generate_thumbnails")
def generate_thumbnails_task(image_id: str, image_url: str, user_id: str):
    """
    썸네일 생성 비동기 Task

    Args:
        image_id: 이미지 ID
        image_url: 원본 이미지 URL
        user_id: 사용자 ID
    """
    # 원본 이미지 다운로드
    response = requests.get(image_url, timeout=30)
    image_bytes = response.content

    # 썸네일 생성 및 업로드
    generator = ThumbnailGenerator()

    # asyncio.run으로 async 함수 실행 (Celery는 sync context)
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    thumbnail_urls = loop.run_until_complete(
        generator.generate_and_upload(image_bytes, user_id, image_id)
    )

    # DB 업데이트
    db = get_db_sync()
    stmt = select(Image).where(Image.image_id == image_id)
    result = db.execute(stmt)
    image = result.scalar_one()

    image.thumbnail_256_url = thumbnail_urls["thumbnail_256_url"]
    image.thumbnail_512_url = thumbnail_urls["thumbnail_512_url"]

    db.commit()
    db.close()

    return thumbnail_urls
```

---

## 8. 프론트엔드 UI

### 8.1 파일 목록 컴포넌트 (Grid View)

```tsx
// frontend/src/components/ImageGrid.tsx

import React, { useEffect, useState } from 'react';
import axios from 'axios';
import InfiniteScroll from 'react-infinite-scroll-component';

interface Image {
  image_id: string;
  prompt: string;
  model: string;
  width: number;
  height: number;
  image_url: string;
  thumbnail_256_url?: string;
  is_favorite: boolean;
  tags: string[];
  created_at: string;
}

export const ImageGrid: React.FC = () => {
  const [images, setImages] = useState<Image[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const fetchImages = async () => {
    if (loading) return;

    setLoading(true);
    try {
      const response = await axios.get('/api/v1/files/images', {
        params: { page, page_size: 20 },
      });

      setImages([...images, ...response.data.images]);
      setHasMore(response.data.has_more);
      setPage(page + 1);
    } catch (error) {
      console.error('Failed to fetch images:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchImages();
  }, []);

  const toggleFavorite = async (imageId: string, currentFavorite: boolean) => {
    try {
      await axios.patch(`/api/v1/files/images/${imageId}`, {
        is_favorite: !currentFavorite,
      });

      // UI 업데이트
      setImages(
        images.map((img) =>
          img.image_id === imageId
            ? { ...img, is_favorite: !currentFavorite }
            : img
        )
      );
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
    }
  };

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">My Images</h1>

      <InfiniteScroll
        dataLength={images.length}
        next={fetchImages}
        hasMore={hasMore}
        loader={<div className="text-center py-4">Loading...</div>}
        endMessage={
          <div className="text-center py-4 text-gray-500">
            No more images
          </div>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {images.map((image) => (
            <div
              key={image.image_id}
              className="bg-white rounded-lg shadow-lg overflow-hidden hover:shadow-xl transition-shadow"
            >
              {/* 썸네일 */}
              <div className="relative aspect-square">
                <img
                  src={image.thumbnail_256_url || image.image_url}
                  alt={image.prompt}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />

                {/* 즐겨찾기 버튼 */}
                <button
                  onClick={() =>
                    toggleFavorite(image.image_id, image.is_favorite)
                  }
                  className="absolute top-2 right-2 bg-white/80 rounded-full p-2 hover:bg-white transition"
                >
                  {image.is_favorite ? '⭐' : '☆'}
                </button>
              </div>

              {/* 메타데이터 */}
              <div className="p-4">
                <p className="text-sm text-gray-700 line-clamp-2 mb-2">
                  {image.prompt}
                </p>

                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{image.model}</span>
                  <span>
                    {image.width}x{image.height}
                  </span>
                </div>

                {/* 태그 */}
                {image.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {image.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </InfiniteScroll>
    </div>
  );
};
```

### 8.2 검색 컴포넌트

```tsx
// frontend/src/components/SearchBar.tsx

import React, { useState } from 'react';
import axios from 'axios';

interface Props {
  onResults: (results: any[]) => void;
}

export const SearchBar: React.FC<Props> = ({ onResults }) => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;

    setLoading(true);
    try {
      const response = await axios.get('/api/v1/search/images', {
        params: { q: query },
      });

      onResults(response.data.results);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-6">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search prompts, tags..."
          className="flex-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-transparent"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>
    </div>
  );
};
```

### 8.3 공유 다이얼로그

```tsx
// frontend/src/components/ShareDialog.tsx

import React, { useState } from 'react';
import axios from 'axios';

interface Props {
  imageId: string;
  onClose: () => void;
}

export const ShareDialog: React.FC<Props> = ({ imageId, onClose }) => {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [permission, setPermission] = useState<'view' | 'download'>('view');
  const [expiresInHours, setExpiresInHours] = useState<number | null>(24);
  const [password, setPassword] = useState('');

  const createShare = async () => {
    try {
      const response = await axios.post('/api/v1/shares/', {
        image_id: imageId,
        permission,
        expires_in_hours: expiresInHours,
        password: password || null,
      });

      setShareUrl(response.data.share_url);
    } catch (error) {
      console.error('Failed to create share:', error);
      alert('Failed to create share link');
    }
  };

  const copyToClipboard = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
      alert('Share link copied to clipboard!');
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full">
        <h2 className="text-2xl font-bold mb-4">Share Image</h2>

        {!shareUrl ? (
          <div className="space-y-4">
            {/* Permission */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Permission
              </label>
              <select
                value={permission}
                onChange={(e) =>
                  setPermission(e.target.value as 'view' | 'download')
                }
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="view">View Only</option>
                <option value="download">Allow Download</option>
              </select>
            </div>

            {/* Expiration */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Expires In
              </label>
              <select
                value={expiresInHours || ''}
                onChange={(e) =>
                  setExpiresInHours(e.target.value ? parseInt(e.target.value) : null)
                }
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="">Never</option>
                <option value="1">1 Hour</option>
                <option value="24">24 Hours</option>
                <option value="168">7 Days</option>
              </select>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Password (Optional)
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for no password"
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>

            <button
              onClick={createShare}
              className="w-full bg-purple-600 text-white py-2 rounded-lg hover:bg-purple-700"
            >
              Create Share Link
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-gray-100 p-3 rounded-lg break-all">
              {shareUrl}
            </div>

            <button
              onClick={copyToClipboard}
              className="w-full bg-purple-600 text-white py-2 rounded-lg hover:bg-purple-700"
            >
              Copy Link
            </button>
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full mt-4 bg-gray-200 text-gray-700 py-2 rounded-lg hover:bg-gray-300"
        >
          Close
        </button>
      </div>
    </div>
  );
};
```

---

## 9. 테스트 및 검증

### 9.1 API 테스트

```python
# backend/tests/test_files.py

"""
파일 관리 API 테스트
"""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_list_images(client: AsyncClient, auth_headers):
    """이미지 목록 조회 테스트"""
    response = await client.get(
        "/api/v1/files/images",
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert "images" in data
    assert "total" in data
    assert "page" in data


@pytest.mark.asyncio
async def test_update_image_favorite(client: AsyncClient, auth_headers, test_image_id):
    """즐겨찾기 토글 테스트"""
    response = await client.patch(
        f"/api/v1/files/images/{test_image_id}",
        json={"is_favorite": True},
        headers=auth_headers,
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_create_folder(client: AsyncClient, auth_headers):
    """폴더 생성 테스트"""
    response = await client.post(
        "/api/v1/files/folders",
        json={
            "name": "Test Folder",
            "description": "Test description",
            "color": "#FF5733",
        },
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Test Folder"


@pytest.mark.asyncio
async def test_create_share_link(client: AsyncClient, auth_headers, test_image_id):
    """공유 링크 생성 테스트"""
    response = await client.post(
        "/api/v1/shares/",
        json={
            "image_id": test_image_id,
            "permission": "view",
            "expires_in_hours": 24,
        },
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert "share_token" in data
    assert "share_url" in data


@pytest.mark.asyncio
async def test_search_images(client: AsyncClient, auth_headers):
    """이미지 검색 테스트"""
    response = await client.get(
        "/api/v1/search/images",
        params={"q": "portrait"},
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert "results" in data
```

### 9.2 수동 테스트 체크리스트

#### ✅ 파일 관리
- [ ] 이미지 목록 조회 (페이지네이션)
- [ ] 이미지 상세 조회
- [ ] 즐겨찾기 토글
- [ ] 폴더 생성/수정/삭제
- [ ] 이미지를 폴더로 이동
- [ ] 태그 추가/삭제
- [ ] 이미지 삭제 (S3 + DB)

#### ✅ 검색
- [ ] 프롬프트 검색 (한글/영문)
- [ ] 태그 필터
- [ ] 모델 필터
- [ ] 해상도 필터
- [ ] 즐겨찾기 필터
- [ ] 폴더 필터
- [ ] 태그 자동완성

#### ✅ 공유
- [ ] 공유 링크 생성
- [ ] 공유 링크 접근 (인증 없음)
- [ ] 비밀번호 보호
- [ ] 만료 시간 확인
- [ ] 조회 수 제한
- [ ] 공유 링크 삭제

#### ✅ 스토리지
- [ ] 이미지 업로드 (S3)
- [ ] CloudFront CDN 캐싱
- [ ] 썸네일 자동 생성
- [ ] 스토리지 사용량 조회
- [ ] 플랜별 용량 제한
- [ ] 사용자 데이터 삭제

#### ✅ Elasticsearch
- [ ] 인덱스 생성
- [ ] 이미지 인덱싱 (자동)
- [ ] 이미지 삭제 시 인덱스 삭제
- [ ] 한글 검색 (Nori 분석기)
- [ ] 복합 필터 검색

---

## 🎉 Phase 6 완료!

이제 다음이 구현되었습니다:

✅ **파일 관리**
- 이미지 목록/상세 조회
- 폴더 시스템
- 태그 시스템
- 즐겨찾기

✅ **공유 기능**
- 공유 링크 생성
- 비밀번호 보호
- 만료 시간/조회 수 제한
- 권한 관리 (View/Download)

✅ **검색 시스템**
- Elasticsearch + Nori (한글 분석기)
- 프롬프트/태그 검색
- 복합 필터
- 태그 자동완성

✅ **스토리지**
- S3 + CloudFront CDN
- 썸네일 자동 생성 (256px, 512px)
- 플랜별 용량 제한
- 사용량 추적

### 다음 단계

**Phase 7**: Admin Dashboard (모델 관리, 사용자 관리)
**Phase 8**: System Mailing (이메일 인증, 뉴스레터)
**Phase 9**: Queue & Worker Optimization (우선순위 큐, OOM 방지)

---

## 📚 참고 자료

- **AWS S3**: https://docs.aws.amazon.com/s3/
- **CloudFront**: https://docs.aws.amazon.com/cloudfront/
- **Elasticsearch**: https://www.elastic.co/guide/en/elasticsearch/reference/8.11/
- **Nori 한글 분석기**: https://www.elastic.co/guide/en/elasticsearch/plugins/current/analysis-nori.html
- **PIL (Pillow)**: https://pillow.readthedocs.io/
- **React Infinite Scroll**: https://www.npmjs.com/package/react-infinite-scroll-component
