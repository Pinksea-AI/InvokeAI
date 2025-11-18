# PingvasAI SaaS 최종 구현 가이드

> InvokeAI를 완전한 Multi-Tenant SaaS로 전환하는 최종 통합 핸즈온 가이드

**작성일**: 2025-11-18
**대상**: 신입 개발자도 따라할 수 있는 단계별 가이드
**목표**: React SPA + FastAPI + EKS 기반 프로덕션 SaaS 구축
**예상 기간**: 14주 (3.5개월)
**예상 비용**: $827.15/월

---

## 📋 목차

1. [아키텍처 개요](#1-아키텍처-개요)
2. [사전 준비 (Week 0)](#2-사전-준비-week-0)
3. [Phase 1: 기초 인프라 구축 (Week 1-2)](#3-phase-1-기초-인프라-구축-week-1-2)
4. [Phase 2: EKS 클러스터 설정 (Week 3-4)](#4-phase-2-eks-클러스터-설정-week-3-4)
5. [Phase 3: 애플리케이션 마이그레이션 (Week 5-6)](#5-phase-3-애플리케이션-마이그레이션-week-5-6)
6. [Phase 4: 멀티테넌시 & 인증 (Week 7-8)](#6-phase-4-멀티테넌시--인증-week-7-8)
7. [Phase 5: 결제 시스템 (Week 9-10)](#7-phase-5-결제-시스템-week-9-10)
8. [Phase 6: 이메일 서비스 (Week 11)](#8-phase-6-이메일-서비스-week-11)
9. [Phase 7: 검색 서비스 (Week 12)](#9-phase-7-검색-서비스-week-12)
10. [Phase 8: 모니터링 & CI/CD (Week 13-14)](#10-phase-8-모니터링--cicd-week-13-14)
11. [테스트 & 검증](#11-테스트--검증)
12. [프로덕션 배포](#12-프로덕션-배포)
13. [운영 가이드](#13-운영-가이드)

---

## 1. 아키텍처 개요

### 1.1 전체 구조

```
┌─────────────────────────────────────────────────────────────┐
│                      AWS Cloud (Seoul)                       │
│                                                               │
│  👥 Users → CloudFront → WAF → ALB                          │
│                              ↓                               │
│         ┌────────────────────────────────────┐              │
│         │     Amazon EKS Cluster              │              │
│         │  ┌──────────┬──────────┬─────────┐ │              │
│         │  │ Frontend │ Backend  │ GPU AI  │ │              │
│         │  │  Pods    │  Pods    │ Pods    │ │              │
│         │  └──────────┴──────────┴─────────┘ │              │
│         │  ┌──────────┬──────────┬─────────┐ │              │
│         │  │ Email    │ Celery   │Monitor  │ │              │
│         │  │ Service  │ Workers  │ Stack   │ │              │
│         │  └──────────┴──────────┴─────────┘ │              │
│         └────────────────────────────────────┘              │
│                      ↓         ↓         ↓                   │
│         ┌──────────┬──────────┬──────────┬──────────┐       │
│         │ Aurora   │ElastiCache│   S3    │    EFS   │       │
│         │PostgreSQL│  Redis   │Buckets  │  Share   │       │
│         └──────────┴──────────┴──────────┴──────────┘       │
│                      ↓                                        │
│         ┌──────────────────────────────────┐                │
│         │  Elasticsearch Cluster (3 nodes) │                │
│         └──────────────────────────────────┘                │
│                                                               │
│  External: Lemon Squeezy (Payment) | SES (Email)           │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 기술 스택

| 레이어 | 기술 | 설명 |
|-------|------|------|
| **Frontend** | React 18 + TypeScript + Redux | SPA, Vite, TailwindCSS |
| **Backend** | FastAPI + Python 3.12 | Async, Pydantic, SQLAlchemy 2.0 |
| **AI Engine** | InvokeAI + PyTorch 2.1 | CUDA 12.1, Mixed Precision |
| **Database** | Aurora PostgreSQL 15 | Multi-AZ, Auto-scaling |
| **Cache** | ElastiCache Redis 7.0 | Session + Celery Queue |
| **Storage** | S3 + EFS | Images + Models |
| **Search** | Elasticsearch 8.11.0 | Korean (Nori) Analyzer |
| **Email** | AWS SES + Lambda | Transactional + Newsletter |
| **Payment** | Lemon Squeezy | MoR, Global Tax |
| **Orchestration** | Amazon EKS 1.31 | Kubernetes, Spot Instances |
| **CI/CD** | GitHub Actions + ArgoCD | GitOps Deployment |
| **Monitoring** | Prometheus + Grafana | In-cluster OSS |

### 1.3 비용 분석

| 항목 | 월 비용 | 설명 |
|-----|--------|------|
| **CDN + Security** | $30.00 | CloudFront, WAF, Route 53, Shield |
| **Load Balancer** | $19.00 | ALB Multi-AZ |
| **EKS + Compute** | $372.00 | Control Plane ($73) + 6 CPU ($73x3) + 1 GPU ($299) |
| **Data Layer** | $314.00 | Aurora, ElastiCache, S3, EFS, NAT, Secrets |
| **Search** | $16.15 | Elasticsearch 3 nodes |
| **Email** | $7.00 | SES, SQS, Lambda |
| **Monitoring** | $5.00 | CloudWatch |
| **총계** | **$827.15** | **약 110만원/월** |

**비용 절감 포인트:**
- Spot Instances 사용 (70% 할인)
- In-cluster 모니터링 (Prometheus/Grafana OSS)
- Shared Aurora (dev + prod)
- EFS Infrequent Access (30일 후)
- S3 Intelligent-Tiering

### 1.4 예상 ROI

**수익 시나리오 (보수적):**
- 총 사용자: 10,000명
- 유료 전환율: 10% (1,000명)
- 평균 결제: $29/월

**월 수익**: $29,000
**월 비용**: $827
**순익**: **$28,173** (ROI: 3,407%)

---

## 2. 사전 준비 (Week 0)

### 2.1 필수 도구 설치

#### macOS

```bash
# Homebrew 설치 (이미 설치되어 있으면 생략)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 필수 도구 설치
brew install \
  awscli \
  terraform \
  kubectl \
  helm \
  argocd \
  jq \
  git \
  docker \
  python@3.12 \
  node@20

# Docker Desktop 설치
brew install --cask docker

# VS Code 설치 (선택사항)
brew install --cask visual-studio-code
```

#### Ubuntu/Debian

```bash
# AWS CLI
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# Terraform
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# ArgoCD CLI
curl -sSL -o argocd-linux-amd64 https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
sudo install -m 555 argocd-linux-amd64 /usr/local/bin/argocd

# Docker
sudo apt-get update
sudo apt-get install docker.io docker-compose
sudo usermod -aG docker $USER

# Python 3.12
sudo apt-get install python3.12 python3.12-venv python3-pip

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### 버전 확인

```bash
# 모든 도구 버전 확인
aws --version          # aws-cli/2.x.x
terraform --version    # Terraform v1.6+
kubectl version --client  # v1.28+
helm version           # v3.13+
docker --version       # 24.0+
python3.12 --version   # 3.12+
node --version         # v20.x+
```

### 2.2 AWS 계정 설정

#### AWS 계정 생성 및 설정

```bash
# AWS CLI 설정
aws configure

# 입력 예시:
# AWS Access Key ID: AKIAIOSFODNN7EXAMPLE
# AWS Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# Default region name: ap-northeast-2  # Seoul
# Default output format: json

# 설정 확인
aws sts get-caller-identity

# 출력 예시:
# {
#     "UserId": "AIDAI...",
#     "Account": "123456789012",
#     "Arn": "arn:aws:iam::123456789012:user/admin"
# }
```

#### IAM 사용자 권한 설정

최소 필요 권한:
- AmazonEKSClusterPolicy
- AmazonEKSWorkerNodePolicy
- AmazonEC2ContainerRegistryFullAccess
- AmazonS3FullAccess
- AmazonRDSFullAccess
- AmazonElastiCacheFullAccess
- AmazonSESFullAccess
- CloudWatchFullAccess
- IAMFullAccess (인프라 생성용)

**보안 권장사항:**
- 루트 계정 직접 사용 금지
- IAM 사용자 + MFA 활성화
- 최소 권한 원칙 적용

### 2.3 프로젝트 구조 생성

```bash
# 프로젝트 디렉토리 생성
mkdir -p ~/pingvasai-saas
cd ~/pingvasai-saas

# 디렉토리 구조 생성
mkdir -p {terraform,k8s,docker,scripts,docs}
mkdir -p k8s/{base,overlays/{dev,prod}}
mkdir -p terraform/{modules,environments/{dev,prod}}

# Git 초기화
git init
git remote add origin https://github.com/your-org/pingvasai-saas.git

# .gitignore 생성
cat > .gitignore << 'EOF'
# Terraform
*.tfstate
*.tfstate.*
.terraform/
.terraform.lock.hcl

# Kubernetes
*.kubeconfig

# Python
__pycache__/
*.py[cod]
*$py.class
venv/
.env

# Secrets
*.pem
*.key
secrets.yaml
.env.local
.env.production

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
EOF
```

### 2.4 InvokeAI 소스코드 클론

```bash
# InvokeAI 클론
cd ~/pingvasai-saas
git clone https://github.com/invoke-ai/InvokeAI.git original-invokeai

# 우리 프로젝트로 복사
cp -r original-invokeai/invokeai ./backend/
cp -r original-invokeai/invokeai/frontend ./frontend/

# Python 의존성 확인
cd backend
cat requirements.txt

# Node.js 의존성 확인
cd ../frontend
cat package.json
```

### 2.5 체크리스트

완료한 항목에 체크하세요:

- [ ] AWS CLI 설치 및 설정 완료
- [ ] Terraform 설치 완료
- [ ] kubectl 설치 완료
- [ ] Helm 설치 완료
- [ ] Docker 설치 및 실행 확인
- [ ] AWS 계정 생성 및 IAM 권한 설정
- [ ] 프로젝트 디렉토리 구조 생성
- [ ] InvokeAI 소스코드 클론 완료
- [ ] Git 저장소 초기화
- [ ] 팀원들과 Git 저장소 공유

---

## 3. Phase 1: 기초 인프라 구축 (Week 1-2)

**목표**: VPC, Networking, 기본 AWS 서비스 설정
**예상 시간**: 2주
**비용**: ~$0 (프리 티어 내)

### 3.1 Terraform 백엔드 설정

#### S3 버킷 생성 (Terraform State 저장용)

```bash
cd ~/pingvasai-saas/terraform

# S3 버킷 생성 (수동, 한 번만)
aws s3api create-bucket \
  --bucket pingvasai-terraform-state \
  --region ap-northeast-2 \
  --create-bucket-configuration LocationConstraint=ap-northeast-2

# 버전 관리 활성화
aws s3api put-bucket-versioning \
  --bucket pingvasai-terraform-state \
  --versioning-configuration Status=Enabled

# 암호화 활성화
aws s3api put-bucket-encryption \
  --bucket pingvasai-terraform-state \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# DynamoDB 테이블 생성 (State Lock용)
aws dynamodb create-table \
  --table-name pingvasai-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-northeast-2
```

#### Terraform 백엔드 설정

```hcl
# terraform/backend.tf
terraform {
  backend "s3" {
    bucket         = "pingvasai-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "ap-northeast-2"
    encrypt        = true
    dynamodb_table = "pingvasai-terraform-locks"
  }

  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.24"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
  }
}
```

### 3.2 VPC 및 네트워크 구성

```hcl
# terraform/modules/vpc/main.tf

# VPC 생성
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "pingvasai-vpc"
    Environment = var.environment
    Terraform   = "true"
  }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "pingvasai-igw"
  }
}

# Public Subnets (3 AZs)
resource "aws_subnet" "public" {
  count = 3

  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.${count.index}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                           = "pingvasai-public-${count.index + 1}"
    "kubernetes.io/role/elb"                       = "1"
    "kubernetes.io/cluster/pingvasai-eks-cluster" = "shared"
  }
}

# Private Subnets - App (3 AZs)
resource "aws_subnet" "private_app" {
  count = 3

  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index + 10}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name                                           = "pingvasai-private-app-${count.index + 1}"
    "kubernetes.io/role/internal-elb"              = "1"
    "kubernetes.io/cluster/pingvasai-eks-cluster" = "shared"
  }
}

# Private Subnets - Database (3 AZs)
resource "aws_subnet" "private_db" {
  count = 3

  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index + 20}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "pingvasai-private-db-${count.index + 1}"
  }
}

# Elastic IPs for NAT Gateways
resource "aws_eip" "nat" {
  count  = 3
  domain = "vpc"

  tags = {
    Name = "pingvasai-nat-eip-${count.index + 1}"
  }

  depends_on = [aws_internet_gateway.main]
}

# NAT Gateways (3 AZs for HA)
resource "aws_nat_gateway" "main" {
  count = 3

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "pingvasai-nat-${count.index + 1}"
  }

  depends_on = [aws_internet_gateway.main]
}

# Route Tables - Public
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "pingvasai-public-rt"
  }
}

# Route Table Associations - Public
resource "aws_route_table_association" "public" {
  count = 3

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Route Tables - Private App (각 AZ별로 NAT Gateway 사용)
resource "aws_route_table" "private_app" {
  count = 3

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = {
    Name = "pingvasai-private-app-rt-${count.index + 1}"
  }
}

# Route Table Associations - Private App
resource "aws_route_table_association" "private_app" {
  count = 3

  subnet_id      = aws_subnet.private_app[count.index].id
  route_table_id = aws_route_table.private_app[count.index].id
}

# Route Tables - Private DB
resource "aws_route_table" "private_db" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "pingvasai-private-db-rt"
  }
}

# Route Table Associations - Private DB
resource "aws_route_table_association" "private_db" {
  count = 3

  subnet_id      = aws_subnet.private_db[count.index].id
  route_table_id = aws_route_table.private_db.id
}

# VPC Endpoints (비용 절감)
resource "aws_vpc_endpoint" "s3" {
  vpc_id       = aws_vpc.main.id
  service_name = "com.amazonaws.ap-northeast-2.s3"

  tags = {
    Name = "pingvasai-s3-endpoint"
  }
}

resource "aws_vpc_endpoint_route_table_association" "s3_private_app" {
  count = 3

  route_table_id  = aws_route_table.private_app[count.index].id
  vpc_endpoint_id = aws_vpc_endpoint.s3.id
}

# Data Sources
data "aws_availability_zones" "available" {
  state = "available"
}

# Outputs
output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_app_subnet_ids" {
  value = aws_subnet.private_app[*].id
}

output "private_db_subnet_ids" {
  value = aws_subnet.private_db[*].id
}
```

### 3.3 Security Groups

```hcl
# terraform/modules/security_groups/main.tf

# ALB Security Group
resource "aws_security_group" "alb" {
  name        = "pingvasai-alb-sg"
  description = "Security group for ALB"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP from Internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from Internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pingvasai-alb-sg"
  }
}

# EKS Node Security Group
resource "aws_security_group" "eks_nodes" {
  name        = "pingvasai-eks-nodes-sg"
  description = "Security group for EKS worker nodes"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow nodes to communicate with each other"
    from_port       = 0
    to_port         = 65535
    protocol        = "-1"
    self            = true
  }

  ingress {
    description     = "Allow ALB to reach pods"
    from_port       = 0
    to_port         = 65535
    protocol        = "-1"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pingvasai-eks-nodes-sg"
  }
}

# RDS Security Group
resource "aws_security_group" "rds" {
  name        = "pingvasai-rds-sg"
  description = "Security group for RDS"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from EKS nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pingvasai-rds-sg"
  }
}

# ElastiCache Security Group
resource "aws_security_group" "elasticache" {
  name        = "pingvasai-elasticache-sg"
  description = "Security group for ElastiCache Redis"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis from EKS nodes"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pingvasai-elasticache-sg"
  }
}

# EFS Security Group
resource "aws_security_group" "efs" {
  name        = "pingvasai-efs-sg"
  description = "Security group for EFS"
  vpc_id      = var.vpc_id

  ingress {
    description     = "NFS from EKS nodes"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pingvasai-efs-sg"
  }
}

# Elasticsearch Security Group
resource "aws_security_group" "elasticsearch" {
  name        = "pingvasai-elasticsearch-sg"
  description = "Security group for Elasticsearch"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Elasticsearch from EKS nodes"
    from_port       = 9200
    to_port         = 9200
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  ingress {
    description     = "Elasticsearch transport from EKS nodes"
    from_port       = 9300
    to_port         = 9300
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pingvasai-elasticsearch-sg"
  }
}
```

### 3.4 인프라 배포

```bash
cd ~/pingvasai-saas/terraform

# Terraform 초기화
terraform init

# 계획 확인
terraform plan -out=tfplan

# 검토 후 적용
terraform apply tfplan

# 출력 확인
terraform output

# 예상 출력:
# vpc_id = "vpc-xxxxx"
# public_subnet_ids = ["subnet-xxxxx", "subnet-yyyyy", "subnet-zzzzz"]
# private_app_subnet_ids = ["subnet-aaaaa", "subnet-bbbbb", "subnet-ccccc"]
```

### 3.5 검증

```bash
# VPC 확인
aws ec2 describe-vpcs --filters "Name=tag:Name,Values=pingvasai-vpc"

# Subnets 확인
aws ec2 describe-subnets --filters "Name=vpc-id,Values=$(terraform output -raw vpc_id)"

# NAT Gateways 확인
aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$(terraform output -raw vpc_id)"

# Security Groups 확인
aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$(terraform output -raw vpc_id)"
```

### 3.6 Phase 1 체크리스트

- [ ] Terraform 백엔드 (S3 + DynamoDB) 생성
- [ ] VPC 생성 (10.0.0.0/16)
- [ ] Public Subnets 3개 생성
- [ ] Private App Subnets 3개 생성
- [ ] Private DB Subnets 3개 생성
- [ ] NAT Gateways 3개 생성
- [ ] Security Groups 생성 (ALB, EKS, RDS, ElastiCache, EFS, ES)
- [ ] VPC Endpoints 생성 (S3)
- [ ] 네트워크 연결 테스트 완료

---

## 4. Phase 2: EKS 클러스터 설정 (Week 3-4)

**목표**: EKS 클러스터 생성 및 노드 그룹 설정
**예상 시간**: 2주
**비용**: ~$73/월 (Control Plane)

### 4.1 EKS 클러스터 생성

```hcl
# terraform/modules/eks/main.tf

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 19.0"

  cluster_name    = "pingvasai-eks-cluster"
  cluster_version = "1.31"

  vpc_id                   = var.vpc_id
  subnet_ids               = var.private_app_subnet_ids
  control_plane_subnet_ids = var.public_subnet_ids

  # 클러스터 엔드포인트 설정
  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true

  # 클러스터 애드온
  cluster_addons = {
    coredns = {
      most_recent = true
    }
    kube-proxy = {
      most_recent = true
    }
    vpc-cni = {
      most_recent = true
    }
    aws-ebs-csi-driver = {
      most_recent = true
    }
  }

  # EKS Managed Node Groups
  eks_managed_node_groups = {
    # General Purpose Nodes (CPU 워크로드)
    general = {
      name = "general-ng"

      instance_types = ["t3.medium"]
      capacity_type  = "SPOT"  # 70% 할인

      min_size     = 3
      max_size     = 10
      desired_size = 3

      disk_size = 50  # GB

      labels = {
        role = "general"
      }

      tags = {
        "k8s.io/cluster-autoscaler/enabled"                   = "true"
        "k8s.io/cluster-autoscaler/pingvasai-eks-cluster"    = "owned"
      }
    }

    # GPU Nodes (AI 워크로드)
    gpu = {
      name = "gpu-ng"

      instance_types = ["g5.xlarge"]  # A10G 24GB VRAM
      capacity_type  = "ON_DEMAND"     # Hot 노드는 On-Demand

      min_size     = 1
      max_size     = 5
      desired_size = 1

      disk_size = 100  # GB (모델 캐시용)

      # GPU 노드는 taint 설정 (GPU 작업만 스케줄링)
      taints = [{
        key    = "nvidia.com/gpu"
        value  = "true"
        effect = "NoSchedule"
      }]

      labels = {
        role = "gpu-worker"
        "nvidia.com/gpu" = "true"
      }

      tags = {
        "k8s.io/cluster-autoscaler/enabled"                   = "true"
        "k8s.io/cluster-autoscaler/pingvasai-eks-cluster"    = "owned"
      }
    }
  }

  # IRSA (IAM Roles for Service Accounts)
  enable_irsa = true

  # 클러스터 보안 그룹 규칙
  cluster_security_group_additional_rules = {
    ingress_nodes_ephemeral_ports_tcp = {
      description                = "Nodes on ephemeral ports"
      protocol                   = "tcp"
      from_port                  = 1025
      to_port                    = 65535
      type                       = "ingress"
      source_node_security_group = true
    }
  }

  # 노드 보안 그룹 규칙
  node_security_group_additional_rules = {
    ingress_self_all = {
      description = "Node to node all ports/protocols"
      protocol    = "-1"
      from_port   = 0
      to_port     = 0
      type        = "ingress"
      self        = true
    }
    ingress_alb_all = {
      description              = "ALB to node all ports"
      protocol                 = "-1"
      from_port                = 0
      to_port                  = 0
      type                     = "ingress"
      source_security_group_id = var.alb_security_group_id
    }
  }

  tags = {
    Environment = "production"
    Terraform   = "true"
  }
}

# Outputs
output "cluster_id" {
  value = module.eks.cluster_id
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "cluster_security_group_id" {
  value = module.eks.cluster_security_group_id
}

output "cluster_certificate_authority_data" {
  value = module.eks.cluster_certificate_authority_data
}
```

### 4.2 EKS 클러스터 배포

```bash
cd ~/pingvasai-saas/terraform

# EKS 모듈 추가 후 적용
terraform plan -out=tfplan
terraform apply tfplan

# 완료까지 약 15-20분 소요
```

### 4.3 kubectl 설정

```bash
# kubeconfig 업데이트
aws eks update-kubeconfig \
  --region ap-northeast-2 \
  --name pingvasai-eks-cluster

# 클러스터 연결 확인
kubectl cluster-info

# 노드 확인
kubectl get nodes

# 예상 출력:
# NAME                                           STATUS   ROLES    AGE   VERSION
# ip-10-0-10-xxx.ap-northeast-2.compute.internal   Ready    <none>   5m    v1.31.0-eks-xxxxx
# ip-10-0-11-xxx.ap-northeast-2.compute.internal   Ready    <none>   5m    v1.31.0-eks-xxxxx
# ip-10-0-12-xxx.ap-northeast-2.compute.internal   Ready    <none>   5m    v1.31.0-eks-xxxxx
# ip-10-0-10-yyy.ap-northeast-2.compute.internal   Ready    <none>   5m    v1.31.0-eks-xxxxx  # GPU Node
```

### 4.4 네임스페이스 생성

```bash
# 네임스페이스 생성
kubectl create namespace dev
kubectl create namespace prod
kubectl create namespace ingress-nginx
kubectl create namespace monitoring
kubectl create namespace argocd

# 네임스페이스 확인
kubectl get namespaces

# 기본 네임스페이스 설정 (개발 시)
kubectl config set-context --current --namespace=dev
```

### 4.5 NVIDIA Device Plugin 설치 (GPU 지원)

```bash
# NVIDIA Device Plugin 배포
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.14.3/nvidia-device-plugin.yml

# 확인
kubectl get pods -n kube-system | grep nvidia-device-plugin

# GPU 리소스 확인
kubectl describe node <gpu-node-name> | grep nvidia.com/gpu

# 예상 출력:
# nvidia.com/gpu:     1
```

### 4.6 EBS CSI Driver 설정

```bash
# IAM 정책 생성 (Terraform으로 자동 생성됨)
# EBS CSI Driver는 EKS 애드온으로 이미 설치됨

# StorageClass 확인
kubectl get storageclass

# gp3 StorageClass 생성 (기본값)
cat > ebs-gp3-storageclass.yaml << 'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
EOF

kubectl apply -f ebs-gp3-storageclass.yaml
```

### 4.7 EFS CSI Driver 설치

```hcl
# terraform/modules/efs/main.tf

# EFS 파일 시스템 생성
resource "aws_efs_file_system" "models" {
  creation_token = "pingvasai-models"
  encrypted      = true

  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"  # Infrequent Access로 이동
  }

  tags = {
    Name = "pingvasai-models-efs"
  }
}

# EFS 마운트 타겟 (각 AZ)
resource "aws_efs_mount_target" "models" {
  count = 3

  file_system_id  = aws_efs_file_system.models.id
  subnet_id       = var.private_app_subnet_ids[count.index]
  security_groups = [var.efs_security_group_id]
}

# Outputs
output "efs_id" {
  value = aws_efs_file_system.models.id
}
```

```bash
# EFS CSI Driver 설치
helm repo add aws-efs-csi-driver https://kubernetes-sigs.github.io/aws-efs-csi-driver/
helm repo update

helm install aws-efs-csi-driver aws-efs-csi-driver/aws-efs-csi-driver \
  --namespace kube-system \
  --set controller.serviceAccount.create=true \
  --set controller.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/EFSCSIDriverRole"

# StorageClass 생성
cat > efs-storageclass.yaml << EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs
provisioner: efs.csi.aws.com
parameters:
  provisioningMode: efs-ap
  fileSystemId: $(terraform output -raw efs_id)
  directoryPerms: "700"
EOF

kubectl apply -f efs-storageclass.yaml
```

### 4.8 Cluster Autoscaler 설치

```bash
# Helm으로 Cluster Autoscaler 설치
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm repo update

helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  --namespace kube-system \
  --set autoDiscovery.clusterName=pingvasai-eks-cluster \
  --set awsRegion=ap-northeast-2 \
  --set rbac.serviceAccount.create=true \
  --set rbac.serviceAccount.name=cluster-autoscaler \
  --set rbac.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/ClusterAutoscalerRole" \
  --set extraArgs.balance-similar-node-groups=true \
  --set extraArgs.skip-nodes-with-system-pods=false

# 확인
kubectl get pods -n kube-system | grep cluster-autoscaler
```

### 4.9 Phase 2 체크리스트

- [ ] EKS 클러스터 생성 완료 (1.31)
- [ ] kubectl 설정 및 클러스터 접근 확인
- [ ] General Purpose Node Group 생성 (3 nodes, t3.medium Spot)
- [ ] GPU Node Group 생성 (1 node, g5.xlarge On-Demand)
- [ ] 네임스페이스 생성 (dev, prod, ingress-nginx, monitoring, argocd)
- [ ] NVIDIA Device Plugin 설치 및 GPU 인식 확인
- [ ] EBS CSI Driver 설치 및 gp3 StorageClass 생성
- [ ] EFS 생성 및 EFS CSI Driver 설치
- [ ] Cluster Autoscaler 설치

---

## 5. Phase 3: 애플리케이션 마이그레이션 (Week 5-6)

**목표**: InvokeAI를 Kubernetes에 배포
**예상 시간**: 2주
**비용**: +$144/월 (Frontend + Backend Pods)

### 5.1 Docker 이미지 빌드

#### Backend Dockerfile

```dockerfile
# docker/backend/Dockerfile

FROM python:3.12-slim

WORKDIR /app

# 시스템 의존성 설치
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    git \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Python 의존성 설치
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 코드 복사
COPY backend/ .

# 환경 변수
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# 헬스체크
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD python -c "import requests; requests.get('http://localhost:9090/api/v1/health')"

# 애플리케이션 실행
CMD ["uvicorn", "invokeai.app.run_app:app", "--host", "0.0.0.0", "--port", "9090"]
```

#### Frontend Dockerfile

```dockerfile
# docker/frontend/Dockerfile

# Build Stage
FROM node:20-alpine AS builder

WORKDIR /app

# 의존성 설치
COPY frontend/package*.json ./
RUN npm ci

# 애플리케이션 빌드
COPY frontend/ .
RUN npm run build

# Production Stage
FROM nginx:alpine

# Nginx 설정 복사
COPY docker/frontend/nginx.conf /etc/nginx/nginx.conf

# 빌드된 파일 복사
COPY --from=builder /app/dist /usr/share/nginx/html

# 헬스체크
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

#### Nginx 설정

```nginx
# docker/frontend/nginx.conf

user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log warn;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    tcp_nopush     on;
    tcp_nodelay    on;
    keepalive_timeout  65;
    types_hash_max_size 2048;

    gzip  on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/xml+rss application/javascript application/json;

    server {
        listen       80;
        server_name  localhost;

        root   /usr/share/nginx/html;
        index  index.html index.htm;

        # React Router 지원 (SPA)
        location / {
            try_files $uri $uri/ /index.html;
        }

        # API 프록시
        location /api/ {
            proxy_pass http://api-service.prod.svc.cluster.local:9090/api/;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
        }

        # 정적 파일 캐싱
        location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }

        # 헬스체크
        location /health {
            access_log off;
            return 200 "healthy\n";
            add_header Content-Type text/plain;
        }
    }
}
```

#### 이미지 빌드 및 푸시

```bash
# ECR 로그인
aws ecr get-login-password --region ap-northeast-2 | \
  docker login --username AWS --password-stdin \
  $(aws sts get-caller-identity --query Account --output text).dkr.ecr.ap-northeast-2.amazonaws.com

# ECR 레포지토리 생성
aws ecr create-repository --repository-name pingvasai/backend --region ap-northeast-2
aws ecr create-repository --repository-name pingvasai/frontend --region ap-northeast-2

# Backend 이미지 빌드
cd ~/pingvasai-saas
docker build -t pingvasai/backend:latest -f docker/backend/Dockerfile .

# Backend 이미지 태그 및 푸시
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
docker tag pingvasai/backend:latest \
  $ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com/pingvasai/backend:latest

docker push $ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com/pingvasai/backend:latest

# Frontend 이미지 빌드
docker build -t pingvasai/frontend:latest -f docker/frontend/Dockerfile .

# Frontend 이미지 태그 및 푸시
docker tag pingvasai/frontend:latest \
  $ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com/pingvasai/frontend:latest

docker push $ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com/pingvasai/frontend:latest
```

### 5.2 Kubernetes Manifests

#### ConfigMap (환경 변수)

```yaml
# k8s/base/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pingvasai-config
data:
  # 데이터베이스
  DB_HOST: "pingvasai-aurora.cluster-xxxxx.ap-northeast-2.rds.amazonaws.com"
  DB_PORT: "5432"
  DB_NAME: "pingvasai"

  # Redis
  REDIS_HOST: "pingvasai-redis.xxxxx.apne2.cache.amazonaws.com"
  REDIS_PORT: "6379"

  # S3
  S3_BUCKET: "pingvasai-images"
  S3_REGION: "ap-northeast-2"

  # 애플리케이션
  APP_ENV: "production"
  LOG_LEVEL: "INFO"
```

#### Secret

```bash
# Secrets 생성 (수동, 한 번만)
kubectl create secret generic db-credentials \
  --from-literal=DB_USER=pingvasai_prod \
  --from-literal=DB_PASSWORD='SecurePassword123!' \
  -n prod

kubectl create secret generic redis-password \
  --from-literal=REDIS_PASSWORD='RedisPassword123!' \
  -n prod

# JWT Secret
kubectl create secret generic jwt-secret \
  --from-literal=JWT_SECRET_KEY=$(openssl rand -hex 32) \
  -n prod
```

#### Backend Deployment

```yaml
# k8s/base/backend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  labels:
    app: api-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server

  template:
    metadata:
      labels:
        app: api-server
    spec:
      serviceAccountName: api-server-sa

      containers:
        - name: api
          image: ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com/pingvasai/backend:latest

          ports:
            - containerPort: 9090
              name: http

          envFrom:
            - configMapRef:
                name: pingvasai-config
            - secretRef:
                name: db-credentials
            - secretRef:
                name: redis-password
            - secretRef:
                name: jwt-secret

          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2000m"
              memory: "2Gi"

          livenessProbe:
            httpGet:
              path: /api/v1/health
              port: 9090
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3

          readinessProbe:
            httpGet:
              path: /api/v1/health
              port: 9090
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3

---
apiVersion: v1
kind: Service
metadata:
  name: api-service
  labels:
    app: api-server
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 9090
      protocol: TCP
      name: http
  selector:
    app: api-server
```

#### Frontend Deployment

```yaml
# k8s/base/frontend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  labels:
    app: frontend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: frontend

  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: nginx
          image: ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com/pingvasai/frontend:latest

          ports:
            - containerPort: 80
              name: http

          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "512Mi"

          livenessProbe:
            httpGet:
              path: /health
              port: 80
            initialDelaySeconds: 10
            periodSeconds: 10

          readinessProbe:
            httpGet:
              path: /health
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 5

---
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
  labels:
    app: frontend
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 80
      protocol: TCP
      name: http
  selector:
    app: frontend
```

#### HPA (Horizontal Pod Autoscaler)

```yaml
# k8s/base/hpa.yaml

# Backend HPA
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server

  minReplicas: 2
  maxReplicas: 6

  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80

  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 15

---
# Frontend HPA
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: frontend-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: frontend

  minReplicas: 2
  maxReplicas: 6

  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### 5.3 배포

```bash
# 네임스페이스 확인
kubectl config set-context --current --namespace=prod

# ConfigMap 적용
kubectl apply -f k8s/base/configmap.yaml -n prod

# Backend 배포
kubectl apply -f k8s/base/backend-deployment.yaml -n prod

# Frontend 배포
kubectl apply -f k8s/base/frontend-deployment.yaml -n prod

# HPA 배포
kubectl apply -f k8s/base/hpa.yaml -n prod

# 배포 상태 확인
kubectl get deployments -n prod
kubectl get pods -n prod
kubectl get svc -n prod
kubectl get hpa -n prod

# 로그 확인
kubectl logs -f deployment/api-server -n prod
kubectl logs -f deployment/frontend -n prod
```

### 5.4 Phase 3 체크리스트

- [ ] Backend Dockerfile 작성
- [ ] Frontend Dockerfile 작성
- [ ] ECR에 이미지 푸시
- [ ] ConfigMap 생성
- [ ] Secrets 생성
- [ ] Backend Deployment 배포
- [ ] Frontend Deployment 배포
- [ ] Service 생성
- [ ] HPA 설정
- [ ] Pod가 Running 상태 확인
- [ ] 로그 확인 (에러 없음)

---

**이 가이드는 계속 작성 중입니다. 다음 Phase들이 포함됩니다:**
- Phase 4: 멀티테넌시 & 인증 (Week 7-8)
- Phase 5: 결제 시스템 (Lemon Squeezy) (Week 9-10)
- Phase 6: 이메일 서비스 (AWS SES) (Week 11)
- Phase 7: 검색 서비스 (Elasticsearch) (Week 12)
- Phase 8: 모니터링 & CI/CD (Week 13-14)

**계속하시겠습니까? 다음 Phase를 작성해드릴까요?**
