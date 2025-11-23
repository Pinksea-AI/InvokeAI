# Phase 3: AWS 인프라 구축

이 가이드는 Terraform을 사용하여 AWS 클라우드 인프라를 프로비저닝하는 과정을 다룹니다.

## 목차
1. [사전 준비](#사전-준비)
2. [Terraform 프로젝트 구조](#terraform-프로젝트-구조)
3. [VPC 및 네트워크](#vpc-및-네트워크)
4. [EKS 클러스터](#eks-클러스터)
5. [RDS Aurora PostgreSQL](#rds-aurora-postgresql)
6. [ElastiCache Redis](#elasticache-redis)
7. [S3 및 CloudFront](#s3-및-cloudfront)
8. [EFS 파일시스템](#efs-파일시스템)
9. [인프라 배포](#인프라-배포)
10. [검증 및 테스트](#검증-및-테스트)

---

## 사전 준비

### 1. AWS CLI 설정

```bash
# AWS CLI 설치 확인
aws --version

# AWS 계정 설정
aws configure

# 입력 항목:
# AWS Access Key ID: AKIA...
# AWS Secret Access Key: ...
# Default region name: us-east-1
# Default output format: json

# 확인
aws sts get-caller-identity
```

---

### 2. Terraform 설치

```bash
# macOS
brew install terraform

# Ubuntu
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform

# 확인
terraform version
```

---

### 3. kubectl 및 eksctl 설치

```bash
# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# eksctl
curl --silent --location "https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz" | tar xz -C /tmp
sudo mv /tmp/eksctl /usr/local/bin

# 확인
kubectl version --client
eksctl version
```

---

## Terraform 프로젝트 구조

```bash
# 디렉토리 생성
mkdir -p infra/terraform/{modules,environments/{dev,prod}}
cd infra/terraform
```

**최종 구조**:
```
infra/terraform/
├── modules/
│   ├── vpc/
│   ├── eks/
│   ├── rds/
│   ├── elasticache/
│   ├── s3/
│   └── efs/
├── environments/
│   ├── dev/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── terraform.tfvars
│   │   └── outputs.tf
│   └── prod/
│       └── (same structure)
└── README.md
```

---

## VPC 및 네트워크

### 1. VPC 모듈

`infra/terraform/modules/vpc/main.tf`:
```hcl
# VPC
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.environment}-pingvas-vpc"
    Environment = var.environment
  }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.environment}-pingvas-igw"
  }
}

# Public Subnets
resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                           = "${var.environment}-pingvas-public-${var.azs[count.index]}"
    "kubernetes.io/role/elb"                       = "1"
    "kubernetes.io/cluster/${var.cluster_name}"    = "shared"
  }
}

# Private Subnets
resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.azs[count.index]

  tags = {
    Name                                           = "${var.environment}-pingvas-private-${var.azs[count.index]}"
    "kubernetes.io/role/internal-elb"              = "1"
    "kubernetes.io/cluster/${var.cluster_name}"    = "shared"
  }
}

# NAT Gateway EIP
resource "aws_eip" "nat" {
  count  = var.enable_nat_gateway ? length(var.azs) : 0
  domain = "vpc"

  tags = {
    Name = "${var.environment}-pingvas-nat-eip-${count.index + 1}"
  }
}

# NAT Gateway
resource "aws_nat_gateway" "main" {
  count         = var.enable_nat_gateway ? length(var.azs) : 0
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "${var.environment}-pingvas-nat-${count.index + 1}"
  }

  depends_on = [aws_internet_gateway.main]
}

# Public Route Table
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.environment}-pingvas-public-rt"
  }
}

# Public Route Table Association
resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private Route Tables
resource "aws_route_table" "private" {
  count  = length(var.azs)
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = {
    Name = "${var.environment}-pingvas-private-rt-${count.index + 1}"
  }
}

# Private Route Table Association
resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}
```

`infra/terraform/modules/vpc/variables.tf`:
```hcl
variable "environment" {
  description = "Environment name (dev/prod)"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "azs" {
  description = "Availability Zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDR blocks"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDR blocks"
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]
}

variable "enable_nat_gateway" {
  description = "Enable NAT Gateway"
  type        = bool
  default     = true
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
}
```

`infra/terraform/modules/vpc/outputs.tf`:
```hcl
output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}
```

---

## EKS 클러스터

### 1. EKS 모듈

`infra/terraform/modules/eks/main.tf`:
```hcl
# EKS Cluster IAM Role
resource "aws_iam_role" "cluster" {
  name = "${var.cluster_name}-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster_AmazonEKSClusterPolicy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.cluster.name
}

# EKS Cluster
resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = concat(var.public_subnet_ids, var.private_subnet_ids)
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = ["0.0.0.0/0"]
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  depends_on = [
    aws_iam_role_policy_attachment.cluster_AmazonEKSClusterPolicy
  ]

  tags = {
    Name = var.cluster_name
  }
}

# Node Group IAM Role
resource "aws_iam_role" "node_group" {
  name = "${var.cluster_name}-node-group-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "node_group_AmazonEKSWorkerNodePolicy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.node_group.name
}

resource "aws_iam_role_policy_attachment" "node_group_AmazonEKS_CNI_Policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.node_group.name
}

resource "aws_iam_role_policy_attachment" "node_group_AmazonEC2ContainerRegistryReadOnly" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.node_group.name
}

# System Node Group (General Purpose)
resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-system-nodes"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = var.private_subnet_ids

  scaling_config {
    desired_size = var.system_node_desired_size
    max_size     = var.system_node_max_size
    min_size     = var.system_node_min_size
  }

  instance_types = ["t3.medium"]
  capacity_type  = "ON_DEMAND"

  update_config {
    max_unavailable = 1
  }

  labels = {
    role = "system"
  }

  tags = {
    Name = "${var.cluster_name}-system-nodes"
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_group_AmazonEKSWorkerNodePolicy,
    aws_iam_role_policy_attachment.node_group_AmazonEKS_CNI_Policy,
    aws_iam_role_policy_attachment.node_group_AmazonEC2ContainerRegistryReadOnly,
  ]
}

# OIDC Provider for IRSA
data "tls_certificate" "cluster" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.cluster.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
}
```

`infra/terraform/modules/eks/variables.tf`:
```hcl
variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.28"
}

variable "public_subnet_ids" {
  description = "Public subnet IDs"
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnet IDs"
  type        = list(string)
}

variable "system_node_desired_size" {
  description = "Desired number of system nodes"
  type        = number
  default     = 2
}

variable "system_node_max_size" {
  description = "Maximum number of system nodes"
  type        = number
  default     = 4
}

variable "system_node_min_size" {
  description = "Minimum number of system nodes"
  type        = number
  default     = 2
}
```

`infra/terraform/modules/eks/outputs.tf`:
```hcl
output "cluster_id" {
  value = aws_eks_cluster.main.id
}

output "cluster_endpoint" {
  value = aws_eks_cluster.main.endpoint
}

output "cluster_certificate_authority_data" {
  value = aws_eks_cluster.main.certificate_authority[0].data
}

output "cluster_oidc_issuer_url" {
  value = aws_eks_cluster.main.identity[0].oidc[0].issuer
}
```

---

## RDS Aurora PostgreSQL

### 1. RDS 모듈

`infra/terraform/modules/rds/main.tf`:
```hcl
# DB Subnet Group
resource "aws_db_subnet_group" "main" {
  name       = "${var.environment}-pingvas-db-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "${var.environment}-pingvas-db-subnet-group"
  }
}

# Security Group for RDS
resource "aws_security_group" "rds" {
  name        = "${var.environment}-pingvas-rds-sg"
  description = "Security group for RDS Aurora PostgreSQL"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
    description = "PostgreSQL access from EKS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.environment}-pingvas-rds-sg"
  }
}

# RDS Aurora Cluster
resource "aws_rds_cluster" "main" {
  cluster_identifier      = "${var.environment}-pingvas-aurora"
  engine                  = "aurora-postgresql"
  engine_version          = var.engine_version
  database_name           = var.database_name
  master_username         = var.master_username
  master_password         = var.master_password
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]

  backup_retention_period = var.backup_retention_period
  preferred_backup_window = "03:00-04:00"
  preferred_maintenance_window = "mon:04:00-mon:05:00"

  enabled_cloudwatch_logs_exports = ["postgresql"]
  storage_encrypted               = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = var.skip_final_snapshot
  final_snapshot_identifier       = var.skip_final_snapshot ? null : "${var.environment}-pingvas-final-snapshot-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"

  tags = {
    Name = "${var.environment}-pingvas-aurora"
  }
}

# Aurora Cluster Instances
resource "aws_rds_cluster_instance" "main" {
  count              = var.instance_count
  identifier         = "${var.environment}-pingvas-aurora-${count.index + 1}"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = var.instance_class
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version

  performance_insights_enabled = true

  tags = {
    Name = "${var.environment}-pingvas-aurora-${count.index + 1}"
  }
}
```

`infra/terraform/modules/rds/variables.tf`:
```hcl
variable "environment" {
  description = "Environment name"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs"
  type        = list(string)
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to access RDS"
  type        = list(string)
}

variable "engine_version" {
  description = "PostgreSQL engine version"
  type        = string
  default     = "15.4"
}

variable "instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.r6g.large"
}

variable "instance_count" {
  description = "Number of RDS instances"
  type        = number
  default     = 2
}

variable "database_name" {
  description = "Database name"
  type        = string
  default     = "pingvas_saas"
}

variable "master_username" {
  description = "Master username"
  type        = string
  default     = "pingvas_admin"
}

variable "master_password" {
  description = "Master password"
  type        = string
  sensitive   = true
}

variable "backup_retention_period" {
  description = "Backup retention period in days"
  type        = number
  default     = 7
}

variable "deletion_protection" {
  description = "Enable deletion protection"
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip final snapshot on deletion"
  type        = bool
  default     = false
}
```

`infra/terraform/modules/rds/outputs.tf`:
```hcl
output "cluster_endpoint" {
  value = aws_rds_cluster.main.endpoint
}

output "reader_endpoint" {
  value = aws_rds_cluster.main.reader_endpoint
}

output "database_name" {
  value = aws_rds_cluster.main.database_name
}
```

---

## ElastiCache Redis

### 1. ElastiCache 모듈

`infra/terraform/modules/elasticache/main.tf`:
```hcl
# Subnet Group
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.environment}-pingvas-redis-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "${var.environment}-pingvas-redis-subnet-group"
  }
}

# Security Group
resource "aws_security_group" "redis" {
  name        = "${var.environment}-pingvas-redis-sg"
  description = "Security group for Redis"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
    description = "Redis access from EKS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.environment}-pingvas-redis-sg"
  }
}

# Redis Replication Group (Cluster Mode Disabled)
resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "${var.environment}-pingvas-redis"
  replication_group_description = "Redis cluster for ${var.environment}"
  engine                     = "redis"
  engine_version             = var.engine_version
  node_type                  = var.node_type
  num_cache_clusters         = var.num_cache_nodes
  parameter_group_name       = aws_elasticache_parameter_group.main.name
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]

  automatic_failover_enabled = var.num_cache_nodes > 1
  multi_az_enabled           = var.num_cache_nodes > 1

  at_rest_encryption_enabled = true
  transit_encryption_enabled = false  # Disabled for dev, enable in prod

  snapshot_retention_limit = var.snapshot_retention_limit
  snapshot_window          = "03:00-05:00"
  maintenance_window       = "mon:05:00-mon:07:00"

  tags = {
    Name = "${var.environment}-pingvas-redis"
  }
}

# Parameter Group
resource "aws_elasticache_parameter_group" "main" {
  name   = "${var.environment}-pingvas-redis-params"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  parameter {
    name  = "timeout"
    value = "300"
  }
}
```

`infra/terraform/modules/elasticache/variables.tf`:
```hcl
variable "environment" {
  description = "Environment name"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs"
  type        = list(string)
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to access Redis"
  type        = list(string)
}

variable "engine_version" {
  description = "Redis engine version"
  type        = string
  default     = "7.0"
}

variable "node_type" {
  description = "Redis node type"
  type        = string
  default     = "cache.r6g.large"
}

variable "num_cache_nodes" {
  description = "Number of cache nodes"
  type        = number
  default     = 2
}

variable "snapshot_retention_limit" {
  description = "Snapshot retention in days"
  type        = number
  default     = 5
}
```

`infra/terraform/modules/elasticache/outputs.tf`:
```hcl
output "primary_endpoint_address" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "reader_endpoint_address" {
  value = aws_elasticache_replication_group.main.reader_endpoint_address
}
```

---

## S3 및 CloudFront

### 1. S3 모듈

`infra/terraform/modules/s3/main.tf`:
```hcl
# Images Bucket
resource "aws_s3_bucket" "images" {
  bucket = "${var.environment}-pingvas-images"

  tags = {
    Name        = "${var.environment}-pingvas-images"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 180
      storage_class = "GLACIER"
    }
  }
}

# Models Bucket
resource "aws_s3_bucket" "models" {
  bucket = "${var.environment}-pingvas-models"

  tags = {
    Name = "${var.environment}-pingvas-models"
  }
}

# CloudFront Origin Access Identity
resource "aws_cloudfront_origin_access_identity" "main" {
  comment = "OAI for ${var.environment} Pingvas"
}

# S3 Bucket Policy for CloudFront
resource "aws_s3_bucket_policy" "images" {
  bucket = aws_s3_bucket.images.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontAccess"
        Effect = "Allow"
        Principal = {
          AWS = aws_cloudfront_origin_access_identity.main.iam_arn
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.images.arn}/*"
      }
    ]
  })
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.environment} Pingvas CDN"
  default_root_object = "index.html"

  origin {
    domain_name = aws_s3_bucket.images.bucket_regional_domain_name
    origin_id   = "S3-${aws_s3_bucket.images.id}"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.main.cloudfront_access_identity_path
    }
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.images.id}"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
    compress               = true
  }

  price_class = "PriceClass_100"

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name = "${var.environment}-pingvas-cdn"
  }
}
```

---

## EFS 파일시스템

### 1. EFS 모듈

`infra/terraform/modules/efs/main.tf`:
```hcl
# EFS File System
resource "aws_efs_file_system" "models" {
  creation_token = "${var.environment}-pingvas-models-efs"
  encrypted      = true

  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = {
    Name = "${var.environment}-pingvas-models-efs"
  }
}

# Security Group
resource "aws_security_group" "efs" {
  name        = "${var.environment}-pingvas-efs-sg"
  description = "Security group for EFS"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 2049
    to_port     = 2049
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
    description = "NFS access from EKS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.environment}-pingvas-efs-sg"
  }
}

# Mount Targets
resource "aws_efs_mount_target" "main" {
  count           = length(var.private_subnet_ids)
  file_system_id  = aws_efs_file_system.models.id
  subnet_id       = var.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}
```

---

## 인프라 배포

### 1. Dev 환경 설정

`infra/terraform/environments/dev/main.tf`:
```hcl
terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket = "pingvas-terraform-state"
    key    = "dev/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
}

# VPC
module "vpc" {
  source = "../../modules/vpc"

  environment          = var.environment
  vpc_cidr             = var.vpc_cidr
  cluster_name         = var.cluster_name
  enable_nat_gateway   = true
}

# EKS
module "eks" {
  source = "../../modules/eks"

  cluster_name              = var.cluster_name
  kubernetes_version        = var.kubernetes_version
  public_subnet_ids         = module.vpc.public_subnet_ids
  private_subnet_ids        = module.vpc.private_subnet_ids
  system_node_desired_size  = 2
  system_node_max_size      = 4
  system_node_min_size      = 2
}

# RDS
module "rds" {
  source = "../../modules/rds"

  environment          = var.environment
  vpc_id               = module.vpc.vpc_id
  private_subnet_ids   = module.vpc.private_subnet_ids
  allowed_cidr_blocks  = [var.vpc_cidr]
  master_password      = var.db_password
  instance_count       = 1  # Dev: single instance
  deletion_protection  = false
  skip_final_snapshot  = true
}

# ElastiCache
module "elasticache" {
  source = "../../modules/elasticache"

  environment         = var.environment
  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  allowed_cidr_blocks = [var.vpc_cidr]
  num_cache_nodes     = 1  # Dev: single node
}

# S3 & CloudFront
module "s3" {
  source = "../../modules/s3"

  environment = var.environment
}

# EFS
module "efs" {
  source = "../../modules/efs"

  environment         = var.environment
  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  allowed_cidr_blocks = [var.vpc_cidr]
}
```

`infra/terraform/environments/dev/variables.tf`:
```hcl
variable "aws_region" {
  default = "us-east-1"
}

variable "environment" {
  default = "dev"
}

variable "cluster_name" {
  default = "dev-pingvas-eks"
}

variable "kubernetes_version" {
  default = "1.28"
}

variable "vpc_cidr" {
  default = "10.0.0.0/16"
}

variable "db_password" {
  description = "RDS master password"
  type        = string
  sensitive   = true
}
```

`infra/terraform/environments/dev/terraform.tfvars`:
```hcl
aws_region         = "us-east-1"
environment        = "dev"
cluster_name       = "dev-pingvas-eks"
kubernetes_version = "1.28"
vpc_cidr           = "10.0.0.0/16"
# db_password는 환경 변수로 설정: export TF_VAR_db_password="your_password"
```

---

### 2. 배포 실행

```bash
cd infra/terraform/environments/dev

# 초기화
terraform init

# 계획 확인
terraform plan

# 배포 (약 20-30분 소요)
terraform apply

# 출력 확인
terraform output
```

---

## 검증 및 테스트

### 1. EKS 클러스터 접속

```bash
# kubeconfig 업데이트
aws eks update-kubeconfig --name dev-pingvas-eks --region us-east-1

# 노드 확인
kubectl get nodes

# 네임스페이스 생성
kubectl create namespace dev
kubectl create namespace prod
```

---

### 2. RDS 접속 테스트

```bash
# Bastion Pod 생성
kubectl run bastion --image=postgres:15 -it --rm --restart=Never -- bash

# 컨테이너 내부에서
psql -h <RDS_ENDPOINT> -U pingvas_admin -d pingvas_saas
```

---

### 3. S3 및 CloudFront 테스트

```bash
# 테스트 파일 업로드
aws s3 cp test.jpg s3://dev-pingvas-images/test.jpg

# CloudFront URL로 접근
curl https://<CLOUDFRONT_DOMAIN>/test.jpg
```

---

## 다음 단계

AWS 인프라 구축이 완료되었습니다! 이제 GPU 오토스케일링으로 넘어갑니다:

**👉 [Phase 4 - GPU 오토스케일링](./phase-04-gpu-autoscaling.md)**

---

## 체크리스트

- [ ] AWS CLI 설정
- [ ] Terraform 설치
- [ ] VPC 및 네트워크 배포
- [ ] EKS 클러스터 생성
- [ ] RDS Aurora 구축
- [ ] ElastiCache Redis 구축
- [ ] S3 버킷 생성
- [ ] CloudFront 배포
- [ ] EFS 파일시스템 생성
- [ ] kubectl로 클러스터 접근 확인
