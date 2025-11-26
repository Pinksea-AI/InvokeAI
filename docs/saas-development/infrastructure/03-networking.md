# VPC 및 네트워킹 설정 가이드

## 개요

이 문서는 Pingvas Studio의 AWS VPC 및 네트워크 아키텍처를 설명합니다. 보안, 고가용성, 비용 최적화를 고려한 설계입니다.

---

## 네트워크 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VPC (10.0.0.0/16)                              │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                         Public Subnets                              │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │    │
│  │  │ 10.0.1.0/24  │  │ 10.0.2.0/24  │  │ 10.0.3.0/24  │              │    │
│  │  │    AZ-a      │  │    AZ-b      │  │    AZ-c      │              │    │
│  │  │  NAT GW-a    │  │  NAT GW-b    │  │  (standby)   │              │    │
│  │  │  ALB         │  │  ALB         │  │  ALB         │              │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│                              Internet GW                                    │
│                                    │                                        │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                        Private Subnets (EKS)                        │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │    │
│  │  │ 10.0.11.0/24 │  │ 10.0.12.0/24 │  │ 10.0.13.0/24 │              │    │
│  │  │    AZ-a      │  │    AZ-b      │  │    AZ-c      │              │    │
│  │  │  EKS Nodes   │  │  EKS Nodes   │  │  EKS Nodes   │              │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                       Private Subnets (Data)                        │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │    │
│  │  │ 10.0.21.0/24 │  │ 10.0.22.0/24 │  │ 10.0.23.0/24 │              │    │
│  │  │    AZ-a      │  │    AZ-b      │  │    AZ-c      │              │    │
│  │  │  Aurora      │  │  Aurora      │  │  ElastiCache │              │    │
│  │  │  EFS         │  │  EFS         │  │  EFS         │              │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## IP 주소 계획

### CIDR 블록 할당

| 용도 | CIDR | IP 범위 | 호스트 수 |
|------|------|---------|----------|
| **VPC** | 10.0.0.0/16 | 10.0.0.0 - 10.0.255.255 | 65,536 |
| **Public Subnet AZ-a** | 10.0.1.0/24 | 10.0.1.0 - 10.0.1.255 | 251 |
| **Public Subnet AZ-b** | 10.0.2.0/24 | 10.0.2.0 - 10.0.2.255 | 251 |
| **Public Subnet AZ-c** | 10.0.3.0/24 | 10.0.3.0 - 10.0.3.255 | 251 |
| **Private Subnet (EKS) AZ-a** | 10.0.11.0/24 | 10.0.11.0 - 10.0.11.255 | 251 |
| **Private Subnet (EKS) AZ-b** | 10.0.12.0/24 | 10.0.12.0 - 10.0.12.255 | 251 |
| **Private Subnet (EKS) AZ-c** | 10.0.13.0/24 | 10.0.13.0 - 10.0.13.255 | 251 |
| **Private Subnet (Data) AZ-a** | 10.0.21.0/24 | 10.0.21.0 - 10.0.21.255 | 251 |
| **Private Subnet (Data) AZ-b** | 10.0.22.0/24 | 10.0.22.0 - 10.0.22.255 | 251 |
| **Private Subnet (Data) AZ-c** | 10.0.23.0/24 | 10.0.23.0 - 10.0.23.255 | 251 |

### 예약 IP 주소

| 용도 | IP 주소 |
|------|---------|
| VPC DNS | 10.0.0.2 |
| EKS Cluster IP | 10.0.11.10 |
| Aurora Writer | 10.0.21.10 |
| Aurora Reader | 10.0.22.10 |
| ElastiCache Primary | 10.0.21.20 |

---

## VPC 구성 (Terraform)

```hcl
# vpc.tf
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "pingvas-vpc"
    Environment = var.environment
  }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "pingvas-igw"
  }
}

# Public Subnets
resource "aws_subnet" "public" {
  count             = 3
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index + 1}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  map_public_ip_on_launch = true

  tags = {
    Name                                        = "pingvas-public-${count.index + 1}"
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/pingvas-cluster"     = "shared"
    "karpenter.sh/discovery"                    = "pingvas-cluster"
    Type                                        = "public"
  }
}

# Private Subnets (EKS)
resource "aws_subnet" "private_eks" {
  count             = 3
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index + 11}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name                                        = "pingvas-private-eks-${count.index + 1}"
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/pingvas-cluster"     = "shared"
    "karpenter.sh/discovery"                    = "pingvas-cluster"
    Type                                        = "private"
  }
}

# Private Subnets (Data)
resource "aws_subnet" "private_data" {
  count             = 3
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index + 21}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "pingvas-private-data-${count.index + 1}"
    Type = "private-data"
  }
}

# Elastic IP for NAT Gateway
resource "aws_eip" "nat" {
  count  = 2  # 비용 절감을 위해 2개만 (AZ-a, AZ-b)
  domain = "vpc"

  tags = {
    Name = "pingvas-nat-eip-${count.index + 1}"
  }
}

# NAT Gateway
resource "aws_nat_gateway" "main" {
  count         = 2
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "pingvas-nat-${count.index + 1}"
  }

  depends_on = [aws_internet_gateway.main]
}

# Route Table - Public
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "pingvas-rt-public"
  }
}

# Route Table - Private (EKS)
resource "aws_route_table" "private_eks" {
  count  = 3
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index % 2].id  # AZ-c는 NAT-b 사용
  }

  tags = {
    Name = "pingvas-rt-private-eks-${count.index + 1}"
  }
}

# Route Table - Private (Data) - NAT 없음 (인터넷 접근 불필요)
resource "aws_route_table" "private_data" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "pingvas-rt-private-data"
  }
}

# Route Table Associations
resource "aws_route_table_association" "public" {
  count          = 3
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private_eks" {
  count          = 3
  subnet_id      = aws_subnet.private_eks[count.index].id
  route_table_id = aws_route_table.private_eks[count.index].id
}

resource "aws_route_table_association" "private_data" {
  count          = 3
  subnet_id      = aws_subnet.private_data[count.index].id
  route_table_id = aws_route_table.private_data.id
}
```

---

## 보안 그룹 설정

### 보안 그룹 매트릭스

| 보안 그룹 | 인바운드 | 아웃바운드 |
|----------|----------|------------|
| ALB | 80, 443 (0.0.0.0/0) | All → EKS Nodes |
| EKS Nodes | All (ALB SG), All (Self) | All → 0.0.0.0/0 |
| Aurora | 5432 (EKS Nodes SG) | None |
| ElastiCache | 6379 (EKS Nodes SG) | None |
| EFS | 2049 (EKS Nodes SG) | None |
| VPN | 1194/UDP (VPN CIDR) | All → VPC |

### Terraform 설정

```hcl
# security-groups.tf

# ALB Security Group
resource "aws_security_group" "alb" {
  name        = "pingvas-alb-sg"
  description = "Security group for Application Load Balancer"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description     = "To EKS Nodes"
    from_port       = 0
    to_port         = 0
    protocol        = "-1"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  tags = {
    Name = "pingvas-alb-sg"
  }
}

# EKS Nodes Security Group
resource "aws_security_group" "eks_nodes" {
  name        = "pingvas-eks-nodes-sg"
  description = "Security group for EKS worker nodes"
  vpc_id      = aws_vpc.main.id

  # 자체 참조 (노드 간 통신)
  ingress {
    description = "Node to node"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  # ALB에서 트래픽
  ingress {
    description     = "From ALB"
    from_port       = 0
    to_port         = 65535
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # EKS Control Plane
  ingress {
    description = "EKS Control Plane"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  ingress {
    description = "EKS Control Plane webhook"
    from_port   = 1025
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name                                    = "pingvas-eks-nodes-sg"
    "kubernetes.io/cluster/pingvas-cluster" = "owned"
    "karpenter.sh/discovery"                = "pingvas-cluster"
  }
}

# Aurora Security Group
resource "aws_security_group" "aurora" {
  name        = "pingvas-aurora-sg"
  description = "Security group for Aurora PostgreSQL"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from EKS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  tags = {
    Name = "pingvas-aurora-sg"
  }
}

# ElastiCache Security Group
resource "aws_security_group" "elasticache" {
  name        = "pingvas-elasticache-sg"
  description = "Security group for ElastiCache Redis"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from EKS"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  tags = {
    Name = "pingvas-elasticache-sg"
  }
}

# EFS Security Group
resource "aws_security_group" "efs" {
  name        = "pingvas-efs-sg"
  description = "Security group for EFS"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "NFS from EKS"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id]
  }

  tags = {
    Name = "pingvas-efs-sg"
  }
}
```

---

## VPC Endpoints (PrivateLink)

비용과 보안을 위해 AWS 서비스에 프라이빗 연결합니다.

```hcl
# vpc-endpoints.tf

# S3 Gateway Endpoint (무료)
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    [aws_route_table.private_eks[*].id],
    [aws_route_table.private_data.id]
  )

  tags = {
    Name = "pingvas-vpce-s3"
  }
}

# ECR API Endpoint
resource "aws_vpc_endpoint" "ecr_api" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.ecr.api"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private_eks[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name = "pingvas-vpce-ecr-api"
  }
}

# ECR DKR Endpoint
resource "aws_vpc_endpoint" "ecr_dkr" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private_eks[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name = "pingvas-vpce-ecr-dkr"
  }
}

# STS Endpoint (IAM Role 사용)
resource "aws_vpc_endpoint" "sts" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.sts"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private_eks[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name = "pingvas-vpce-sts"
  }
}

# Secrets Manager Endpoint
resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private_eks[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name = "pingvas-vpce-secretsmanager"
  }
}

# CloudWatch Logs Endpoint
resource "aws_vpc_endpoint" "logs" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.logs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private_eks[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name = "pingvas-vpce-logs"
  }
}

# VPC Endpoints Security Group
resource "aws_security_group" "vpc_endpoints" {
  name        = "pingvas-vpce-sg"
  description = "Security group for VPC Endpoints"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  tags = {
    Name = "pingvas-vpce-sg"
  }
}
```

---

## Network ACLs

추가 보안 계층으로 NACL을 설정합니다.

```hcl
# nacl.tf

# Public Subnet NACL
resource "aws_network_acl" "public" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = aws_subnet.public[*].id

  # Inbound Rules
  ingress {
    protocol   = "tcp"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 80
    to_port    = 80
  }

  ingress {
    protocol   = "tcp"
    rule_no    = 110
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 443
    to_port    = 443
  }

  ingress {
    protocol   = "tcp"
    rule_no    = 120
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 1024
    to_port    = 65535  # Ephemeral ports
  }

  # Outbound Rules
  egress {
    protocol   = "-1"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  tags = {
    Name = "pingvas-nacl-public"
  }
}

# Private Subnet NACL
resource "aws_network_acl" "private" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = concat(aws_subnet.private_eks[*].id, aws_subnet.private_data[*].id)

  # VPC 내부 통신 허용
  ingress {
    protocol   = "-1"
    rule_no    = 100
    action     = "allow"
    cidr_block = aws_vpc.main.cidr_block
    from_port  = 0
    to_port    = 0
  }

  # NAT 응답 허용
  ingress {
    protocol   = "tcp"
    rule_no    = 110
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 1024
    to_port    = 65535
  }

  egress {
    protocol   = "-1"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  tags = {
    Name = "pingvas-nacl-private"
  }
}
```

---

## DNS 설정

### Route 53 Private Hosted Zone

```hcl
# dns.tf

resource "aws_route53_zone" "private" {
  name = "pingvas.internal"

  vpc {
    vpc_id = aws_vpc.main.id
  }

  tags = {
    Name = "pingvas-internal-zone"
  }
}

# Aurora Endpoint
resource "aws_route53_record" "aurora" {
  zone_id = aws_route53_zone.private.zone_id
  name    = "db.pingvas.internal"
  type    = "CNAME"
  ttl     = 300
  records = [aws_rds_cluster.main.endpoint]
}

# Aurora Read Endpoint
resource "aws_route53_record" "aurora_read" {
  zone_id = aws_route53_zone.private.zone_id
  name    = "db-read.pingvas.internal"
  type    = "CNAME"
  ttl     = 300
  records = [aws_rds_cluster.main.reader_endpoint]
}

# ElastiCache Endpoint
resource "aws_route53_record" "redis" {
  zone_id = aws_route53_zone.private.zone_id
  name    = "redis.pingvas.internal"
  type    = "CNAME"
  ttl     = 300
  records = [aws_elasticache_replication_group.main.primary_endpoint_address]
}
```

---

## 연결 확인

### VPC 연결 테스트

```bash
# VPC 정보 확인
aws ec2 describe-vpcs --filters "Name=tag:Name,Values=pingvas-vpc"

# 서브넷 확인
aws ec2 describe-subnets --filters "Name=vpc-id,Values=vpc-xxx"

# NAT Gateway 상태
aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=vpc-xxx"

# VPC Endpoint 확인
aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=vpc-xxx"
```

### 연결성 테스트 (EKS Pod에서)

```bash
# DNS 테스트
kubectl run dns-test --rm -it --image=busybox -- nslookup db.pingvas.internal

# PostgreSQL 연결 테스트
kubectl run pg-test --rm -it --image=postgres:17 -- psql -h db.pingvas.internal -U pingvas -d pingvas_prod

# Redis 연결 테스트
kubectl run redis-test --rm -it --image=redis:7 -- redis-cli -h redis.pingvas.internal ping
```

---

## 비용 최적화 팁

### NAT Gateway 비용 절감

| 전략 | 설명 | 예상 절감 |
|------|------|----------|
| NAT 2개만 사용 | AZ-c는 NAT-b 공유 | ~33% |
| VPC Endpoints | S3, ECR 트래픽 NAT 우회 | ~20-40% |
| 데이터 계층 NAT 제외 | DB 서브넷은 인터넷 불필요 | 트래픽 감소 |

### 데이터 전송 비용

```
# 비용 발생
- NAT Gateway 처리: $0.045/GB
- 리전 간 전송: $0.02/GB

# 무료
- 같은 AZ 내 EC2 ↔ S3 (VPC Endpoint)
- 같은 AZ 내 EC2 ↔ EC2
- CloudFront → S3 Origin
```

---

## 다음 단계

- [EKS 설정](./02-eks-setup.md)에서 쿠버네티스 클러스터 구성
- [Terraform 가이드](./01-terraform-guide.md)에서 전체 IaC 확인
- [모니터링 설정](../devops/03-monitoring.md)에서 VPC Flow Logs 설정
