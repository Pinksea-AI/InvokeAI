# 스토리지 전략 (EFS/S3) 설계

## 목차
1. [스토리지 요구사항](#스토리지-요구사항)
2. [EFS 모델 캐시](#efs-모델-캐시)
3. [S3 이미지 스토리지](#s3-이미지-스토리지)
4. [CloudFront CDN](#cloudfront-cdn)
5. [백업 및 복구 전략](#백업-및-복구-전략)

---

## 스토리지 요구사항

### 데이터 타입별 저장소

| 데이터 타입 | 저장소 | 이유 | 예상 크기 |
|------------|--------|------|----------|
| **AI 모델 파일** | EFS | GPU 노드 간 공유, 빠른 로딩 | 500GB |
| **생성 이미지** | S3 | 저렴, 내구성, CDN 연동 | 10TB+ |
| **썸네일** | S3 (Intelligent-Tiering) | 접근 패턴 최적화 | 1TB |
| **사용자 업로드 파일** | S3 | 안전성, 버저닝 | 5TB |
| **백업** | S3 Glacier | 저렴한 장기 보관 | 20TB |
| **로그** | S3 (30일 후 삭제) | 비용 최소화 | 100GB/월 |

---

## EFS 모델 캐시

### 1. EFS 생성 (Terraform)

```hcl
# infra/terraform/efs.tf
resource "aws_efs_file_system" "models" {
  creation_token = "pingvas-studio-models"
  encrypted = true
  kms_key_id = aws_kms_key.efs.arn

  performance_mode = "generalPurpose"  # 기본 성능 모드
  throughput_mode = "bursting"         # 버스팅 처리량

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"  # 30일 미사용 → IA 클래스
  }

  lifecycle_policy {
    transition_to_primary_storage_class = "AFTER_1_ACCESS"  # 1회 접근 시 Standard로 복귀
  }

  tags = {
    Name = "pingvas-studio-models"
    Purpose = "AI model cache"
  }
}

# Mount Targets (각 AZ)
resource "aws_efs_mount_target" "models_az_a" {
  file_system_id = aws_efs_file_system.models.id
  subnet_id = module.vpc.private_subnets[0]  # AZ-a
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_mount_target" "models_az_c" {
  file_system_id = aws_efs_file_system.models.id
  subnet_id = module.vpc.private_subnets[1]  # AZ-c
  security_groups = [aws_security_group.efs.id]
}

# Security Group (EKS 노드만 접근)
resource "aws_security_group" "efs" {
  name = "efs-models-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port = 2049
    to_port = 2049
    protocol = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    from_port = 0
    to_port = 0
    protocol = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

### 2. Kubernetes PersistentVolume

```yaml
# k8s/storage/efs-pv.yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: efs-models-pv
spec:
  capacity:
    storage: 500Gi
  volumeMode: Filesystem
  accessModes:
    - ReadOnlyMany  # 여러 Pod에서 읽기만
  persistentVolumeReclaimPolicy: Retain
  storageClassName: efs-sc
  csi:
    driver: efs.csi.aws.com
    volumeHandle: fs-0123456789abcdef::  # EFS ID
    volumeAttributes:
      path: /models
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: efs-models-pvc
  namespace: prod
spec:
  accessModes:
    - ReadOnlyMany
  storageClassName: efs-sc
  resources:
    requests:
      storage: 500Gi
```

### 3. 모델 다운로드 초기화 Job

```yaml
# k8s/jobs/model-sync.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: model-sync-job
  namespace: prod
spec:
  template:
    spec:
      restartPolicy: OnFailure

      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: efs-models-pvc-rw  # ReadWriteMany (초기화용)

      containers:
        - name: model-downloader
          image: amazon/aws-cli:latest

          volumeMounts:
            - name: models
              mountPath: /models

          command:
            - /bin/bash
            - -c
            - |
              #!/bin/bash
              set -e

              # S3에서 모델 동기화
              echo "Syncing models from S3..."
              aws s3 sync s3://pingvas-studio-models/sd15/ /models/sd15/
              aws s3 sync s3://pingvas-studio-models/sdxl/ /models/sdxl/
              aws s3 sync s3://pingvas-studio-models/flux/ /models/flux/

              # 권한 설정
              chmod -R 755 /models

              echo "Model sync completed!"

          env:
            - name: AWS_REGION
              value: ap-northeast-2

          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
```

### 4. 모델 로딩 최적화

```python
# services/worker/utils/model_loader.py
import os
from pathlib import Path

EFS_MODELS_PATH = Path("/models")
S3_MODELS_BUCKET = "pingvas-studio-models"

def load_model_from_efs(model_name: str, base_model: str):
    """
    EFS에서 모델 로드 (없으면 S3에서 다운로드)
    """
    model_path = EFS_MODELS_PATH / base_model / f"{model_name}.safetensors"

    # 1. EFS에 이미 있는지 확인
    if model_path.exists():
        logger.info(f"Model {model_name} found in EFS cache")
        return str(model_path)

    # 2. EFS에 없으면 S3에서 다운로드 (동시 다운로드 방지)
    lock_key = f"model:download:lock:{model_name}"

    with redis_lock(lock_key, timeout=600):  # 10분 타임아웃
        # 다시 확인 (다른 워커가 이미 다운로드했을 수 있음)
        if model_path.exists():
            logger.info(f"Model {model_name} downloaded by another worker")
            return str(model_path)

        # S3에서 다운로드
        logger.info(f"Downloading model {model_name} from S3...")
        s3_key = f"{base_model}/{model_name}.safetensors"

        # EFS에 직접 다운로드
        model_path.parent.mkdir(parents=True, exist_ok=True)

        s3_client.download_file(
            Bucket=S3_MODELS_BUCKET,
            Key=s3_key,
            Filename=str(model_path)
        )

        logger.info(f"Model {model_name} cached to EFS")

    return str(model_path)
```

---

## S3 이미지 스토리지

### 1. S3 버킷 생성 (Terraform)

```hcl
# infra/terraform/s3.tf
resource "aws_s3_bucket" "images" {
  bucket = "pingvas-studio-images"

  tags = {
    Name = "Generated Images"
    Environment = "production"
  }
}

# 버저닝 활성화
resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id

  versioning_configuration {
    status = "Enabled"
  }
}

# 암호화 (SSE-S3)
resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 라이프사이클 정책
resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    id = "transition_to_glacier"
    status = "Enabled"

    transition {
      days = 30
      storage_class = "GLACIER_IR"  # Instant Retrieval
    }

    transition {
      days = 90
      storage_class = "DEEP_ARCHIVE"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# CORS 설정
resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = [
      "https://pingvas.studio",
      "https://www.pingvas.studio"
    ]
    max_age_seconds = 3600
  }
}

# 퍼블릭 액세스 차단 (CloudFront만 접근)
resource "aws_s3_bucket_public_access_block" "images" {
  bucket = aws_s3_bucket.images.id

  block_public_acls = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}
```

### 2. 이미지 업로드 헬퍼

```python
# services/worker/utils/s3_uploader.py
import boto3
from PIL import Image
import io

s3_client = boto3.client('s3', region_name='ap-northeast-2')

BUCKET_NAME = "pingvas-studio-images"

def upload_image_to_s3(
    image: Image.Image,
    user_id: str,
    job_id: str,
    format: str = "png"
) -> dict:
    """
    이미지를 S3에 업로드
    """
    # 1. S3 키 생성 (경로 구조)
    from datetime import datetime
    now = datetime.utcnow()
    s3_key = f"{user_id}/{now.year}/{now.month:02d}/{job_id}.{format}"

    # 2. 이미지를 바이트로 변환
    buffer = io.BytesIO()
    image.save(buffer, format=format.upper(), quality=95)
    buffer.seek(0)

    # 3. S3 업로드
    s3_client.upload_fileobj(
        buffer,
        BUCKET_NAME,
        s3_key,
        ExtraArgs={
            "ContentType": f"image/{format}",
            "Metadata": {
                "user_id": user_id,
                "job_id": job_id,
                "uploaded_at": now.isoformat()
            }
        }
    )

    # 4. 썸네일 생성 및 업로드
    thumbnail = create_thumbnail(image, size=(256, 256))
    thumbnail_key = f"{user_id}/{now.year}/{now.month:02d}/thumbnails/{job_id}.webp"

    thumbnail_buffer = io.BytesIO()
    thumbnail.save(thumbnail_buffer, format="WEBP", quality=85)
    thumbnail_buffer.seek(0)

    s3_client.upload_fileobj(
        thumbnail_buffer,
        BUCKET_NAME,
        thumbnail_key,
        ExtraArgs={"ContentType": "image/webp"}
    )

    return {
        "s3_bucket": BUCKET_NAME,
        "s3_key": s3_key,
        "thumbnail_key": thumbnail_key,
        "file_size": buffer.getbuffer().nbytes
    }

def create_thumbnail(image: Image.Image, size: tuple) -> Image.Image:
    """
    썸네일 생성
    """
    image.thumbnail(size, Image.Resampling.LANCZOS)
    return image
```

---

## CloudFront CDN

### 1. CloudFront Distribution (Terraform)

```hcl
# infra/terraform/cloudfront.tf
resource "aws_cloudfront_distribution" "images_cdn" {
  enabled = true
  is_ipv6_enabled = true
  comment = "Pingvas Studio Images CDN"

  # S3 Origin
  origin {
    domain_name = aws_s3_bucket.images.bucket_regional_domain_name
    origin_id = "S3-pingvas-studio-images"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.images.cloudfront_access_identity_path
    }
  }

  # 기본 캐시 동작
  default_cache_behavior {
    target_origin_id = "S3-pingvas-studio-images"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl = 0
    default_ttl = 86400     # 1일
    max_ttl = 31536000      # 1년

    compress = true
  }

  # 썸네일 캐시 동작 (더 긴 TTL)
  ordered_cache_behavior {
    path_pattern = "*/thumbnails/*"
    target_origin_id = "S3-pingvas-studio-images"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD"]
    cached_methods = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl = 86400
    default_ttl = 2592000   # 30일
    max_ttl = 31536000      # 1년

    compress = true
  }

  # 제한
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # SSL 인증서
  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate.cdn.arn
    ssl_support_method = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # 가격 클래스 (아시아/유럽/북미)
  price_class = "PriceClass_200"

  tags = {
    Name = "Images CDN"
  }
}

# Origin Access Identity (S3 접근 권한)
resource "aws_cloudfront_origin_access_identity" "images" {
  comment = "OAI for images bucket"
}

# S3 버킷 정책 (CloudFront만 접근 허용)
resource "aws_s3_bucket_policy" "images_cloudfront" {
  bucket = aws_s3_bucket.images.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        AWS = aws_cloudfront_origin_access_identity.images.iam_arn
      }
      Action = "s3:GetObject"
      Resource = "${aws_s3_bucket.images.arn}/*"
    }]
  })
}
```

### 2. 이미지 URL 생성

```python
# services/gallery/utils/url_builder.py
CLOUDFRONT_DOMAIN = "d1234567890abc.cloudfront.net"

def get_image_url(s3_key: str) -> str:
    """
    CloudFront URL 생성
    """
    return f"https://{CLOUDFRONT_DOMAIN}/{s3_key}"

def get_thumbnail_url(s3_key: str) -> str:
    """
    썸네일 CloudFront URL
    """
    # s3_key: user_id/2025/11/job_id.png
    # thumbnail_key: user_id/2025/11/thumbnails/job_id.webp
    base_path = "/".join(s3_key.split("/")[:-1])
    filename = s3_key.split("/")[-1].replace(".png", ".webp")

    thumbnail_key = f"{base_path}/thumbnails/{filename}"

    return f"https://{CLOUDFRONT_DOMAIN}/{thumbnail_key}"
```

---

## 백업 및 복구 전략

### 1. S3 Cross-Region Replication

```hcl
# infra/terraform/s3_replication.tf
resource "aws_s3_bucket_replication_configuration" "images_replication" {
  bucket = aws_s3_bucket.images.id
  role = aws_iam_role.replication.arn

  rule {
    id = "ReplicateToTokyo"
    status = "Enabled"

    destination {
      bucket = aws_s3_bucket.images_replica_tokyo.arn
      storage_class = "STANDARD_IA"

      replication_time {
        status = "Enabled"
        time {
          minutes = 15
        }
      }

      metrics {
        status = "Enabled"
        event_threshold {
          minutes = 15
        }
      }
    }
  }
}

# 도쿄 리전 복제본 버킷
resource "aws_s3_bucket" "images_replica_tokyo" {
  provider = aws.tokyo
  bucket = "pingvas-studio-images-replica-tokyo"
}
```

### 2. RDS 자동 백업

```hcl
# infra/terraform/rds.tf
resource "aws_db_instance" "postgresql" {
  # ...

  # 자동 백업
  backup_retention_period = 7  # 7일 보존
  backup_window = "03:00-04:00"  # UTC 03:00-04:00 (한국 시간 12:00-13:00)

  # 스냅샷
  skip_final_snapshot = false
  final_snapshot_identifier = "pingvas-studio-final-snapshot"

  # PITR (Point-in-Time Recovery)
  enabled_cloudwatch_logs_exports = ["postgresql"]
}
```

### 3. EFS 백업

```hcl
# infra/terraform/efs_backup.tf
resource "aws_backup_plan" "efs_models" {
  name = "efs-models-daily-backup"

  rule {
    rule_name = "daily_backup"
    target_vault_name = aws_backup_vault.main.name
    schedule = "cron(0 2 * * ? *)"  # 매일 02:00 UTC

    lifecycle {
      delete_after = 30  # 30일 후 삭제
    }
  }
}

resource "aws_backup_selection" "efs_models" {
  name = "efs-models-selection"
  plan_id = aws_backup_plan.efs_models.id
  iam_role_arn = aws_iam_role.backup.arn

  resources = [
    aws_efs_file_system.models.arn
  ]
}
```

---

## 비용 최적화

### Storage Class별 비용 (Seoul Region)

| Storage Class | 비용 (GB/월) | 검색 비용 | 사용 사례 |
|--------------|-------------|----------|----------|
| S3 Standard | $0.025 | 없음 | 최근 이미지 (30일) |
| S3 Intelligent-Tiering | $0.023 | 자동 | 썸네일 |
| S3 Glacier IR | $0.005 | $0.003/GB | 1-3개월 이미지 |
| S3 Glacier Deep Archive | $0.002 | $0.02/GB | 3개월+ 이미지 |
| EFS Standard | $0.30 | 없음 | AI 모델 (자주 사용) |
| EFS IA | $0.025 | 없음 | AI 모델 (30일 미사용) |

### 예상 월 비용

| 항목 | 사용량 | 비용 |
|------|--------|------|
| EFS (모델 캐시) | 500GB | $150 |
| S3 (이미지, Standard) | 1TB | $25 |
| S3 (이미지, Glacier IR) | 5TB | $25 |
| CloudFront (데이터 전송) | 1TB | $85 |
| **총 스토리지 비용** | | **$285/월** |

---

## 다음 단계

이제 보안 아키텍처로 넘어갑니다:
- [보안 아키텍처 (WAF, OAuth, API 인증)](./10-security-architecture.md)
