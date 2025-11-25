# MSP 환경에서 IAM Assume Role 및 OpenVPN 기반 인프라 구축 가이드

**문서 버전**: 1.0
**최종 업데이트**: 2025-11-25
**대상**: MSP(Managed Service Provider)를 통해 AWS를 사용하는 개발팀

---

## 목차

1. [개요](#개요)
2. [MSP 환경 이해](#msp-환경-이해)
3. [아키텍처 개요](#아키텍처-개요)
4. [전제 조건](#전제-조건)
5. [1단계: 계정 구조 설계](#1단계-계정-구조-설계)
6. [2단계: OpenVPN 서버 구축](#2단계-openvpn-서버-구축)
7. [3단계: IAM Role 및 Policy 설정](#3단계-iam-role-및-policy-설정)
8. [4단계: 개발자 IAM User 생성](#4단계-개발자-iam-user-생성)
9. [5단계: 개발자 로컬 환경 설정](#5단계-개발자-로컬-환경-설정)
10. [6단계: Terraform 백엔드 설정](#6단계-terraform-백엔드-설정)
11. [7단계: Terraform Provider 설정](#7단계-terraform-provider-설정)
12. [8단계: 인프라 배포 실행](#8단계-인프라-배포-실행)
13. [보안 Best Practices](#보안-best-practices)
14. [트러블슈팅](#트러블슈팅)
15. [영향받는 문서 수정사항](#영향받는-문서-수정사항)

---

## 개요

이 가이드는 MSP(Managed Service Provider)를 통해 AWS를 사용하는 환경에서, Identity Center 접근 권한 없이 IAM Assume Role과 OpenVPN을 활용하여 안전한 인프라 구축 환경을 설정하는 방법을 단계별로 설명합니다.

### 핵심 구성 요소

```mermaid
graph TB
    Dev1[개발자 1<br/>MacBook M2 Max] --> VPN[OpenVPN Server<br/>허용 IP 관리]
    Dev2[개발자 2<br/>개발 머신] --> VPN

    VPN --> AssumeRole[IAM Assume Role<br/>TerraformExecutionRole]

    AssumeRole --> AWS[AWS 리소스<br/>EKS, RDS, S3 등]

    Owner[계정 오너<br/>결제/회사정보] -.->|권한 없음| AWS

    style Dev1 fill:#4A90E2
    style Dev2 fill:#4A90E2
    style VPN fill:#FF9F43
    style AssumeRole fill:#5F27CD
    style AWS fill:#48C774
    style Owner fill:#E0E0E0
```

### 주요 특징

- ✅ **IAM Assume Role**: 개발자는 제한된 IAM User로 로그인 후 강력한 Role로 전환
- ✅ **OpenVPN 기반 IP 제한**: 허용된 IP에서만 AWS 접근 가능
- ✅ **MFA 강제**: 모든 개발자 계정에 다중 인증 필수
- ✅ **최소 권한 원칙**: 역할 기반 세분화된 권한 부여
- ✅ **확장 가능**: 개발자 추가 시 동일한 패턴 적용

---

## MSP 환경 이해

### MSP란?

MSP(Managed Service Provider)는 AWS 계정 관리, 청구, 기술 지원을 대행하는 서비스 제공자입니다.

### MSP 환경의 제약사항

| 항목 | 일반 AWS 계정 | MSP 계정 |
|------|-------------|----------|
| **Root 계정 접근** | 가능 | 제한적 (MSP 관리) |
| **Identity Center** | 자유롭게 설정 | MSP가 관리 (접근 불가) |
| **Organizations** | 직접 관리 | MSP가 관리 |
| **청구 정보** | 직접 확인 | MSP 포털을 통해 확인 |
| **IAM** | ✅ 완전 제어 가능 | ✅ 완전 제어 가능 |

### 우리의 접근 방식

MSP 환경에서 제한적인 부분을 우회하기 위해 **IAM + OpenVPN** 조합을 사용합니다:

1. **IAM User**: 각 개발자에게 기본 사용자 계정 발급
2. **IAM Role**: 강력한 권한을 가진 역할 생성
3. **Assume Role**: 개발자가 필요 시 Role로 권한 상승
4. **OpenVPN**: IP 기반 접근 제어로 보안 강화

---

## 아키텍처 개요

### 전체 인증/인가 흐름

```mermaid
sequenceDiagram
    actor Dev as 개발자
    participant Local as 로컬 환경
    participant VPN as OpenVPN 서버
    participant IAM as AWS IAM
    participant STS as AWS STS
    participant Resources as AWS 리소스

    Dev->>Local: 1. OpenVPN 연결
    Local->>VPN: 2. VPN 인증 (인증서)
    VPN->>Local: 3. 내부 IP 할당 (10.8.0.x)

    Dev->>Local: 4. aws configure (IAM User)
    Local->>IAM: 5. Access Key 인증

    Dev->>Local: 6. aws sts assume-role
    Local->>STS: 7. AssumeRole 요청

    STS->>STS: 8. 소스 IP 확인<br/>(OpenVPN IP인지)
    STS->>STS: 9. MFA 토큰 검증

    STS->>Local: 10. 임시 자격증명 발급<br/>(1시간 유효)

    Dev->>Local: 11. terraform apply
    Local->>Resources: 12. 인프라 생성/수정<br/>(임시 자격증명 사용)
    Resources->>Local: 13. 작업 완료
```

### 네트워크 구성

```mermaid
graph TB
    subgraph Internet[인터넷]
        Dev1[개발자 1<br/>집/사무실]
        Dev2[개발자 2<br/>집/사무실]
    end

    subgraph VPC[AWS VPC: 10.0.0.0/16]
        subgraph Public[퍼블릭 서브넷: 10.0.1.0/24]
            VPN[OpenVPN Server<br/>t3.micro<br/>EIP: 52.x.x.x]
        end

        subgraph Private[프라이빗 서브넷]
            EKS[EKS 클러스터]
            RDS[RDS Aurora]
        end
    end

    Dev1 -->|UDP 1194| VPN
    Dev2 -->|UDP 1194| VPN

    VPN -->|VPN Tunnel<br/>10.8.0.0/24| Dev1
    VPN -->|VPN Tunnel<br/>10.8.0.0/24| Dev2

    Dev1 -.->|Assume Role<br/>API 호출| IAM[IAM/STS]

    IAM -.->|소스 IP 확인<br/>10.8.0.x| VPN

    style VPN fill:#FF9F43
    style IAM fill:#5F27CD
    style EKS fill:#48C774
```

---

## 전제 조건

### 1. MSP로부터 받아야 할 정보

MSP 회사에 다음 정보를 요청하세요:

```bash
# AWS 계정 정보
AWS_ACCOUNT_ID="123456789012"
AWS_REGION="us-east-1"

# Root 계정 이메일 (청구용)
ROOT_EMAIL="billing@yourcompany.com"

# MSP 담당자 연락처
MSP_CONTACT="support@msp-company.com"
```

### 2. 계정 오너가 AWS Console에서 수행해야 할 작업

계정 오너(비개발자)가 **한 번만** 수행:

1. **IAM 전체 접근 권한을 가진 Admin User 생성**
   - AWS Console 로그인 (MSP 제공 계정)
   - IAM → Users → Add User
   - User Name: `account-admin`
   - Access Type: ✅ Programmatic access, ✅ AWS Management Console access
   - Permissions: `AdministratorAccess` 정책 연결
   - **Access Key ID와 Secret Access Key를 안전하게 저장**

2. **MFA 활성화 (필수)**
   - IAM → Users → account-admin → Security credentials
   - MFA device 등록 (Google Authenticator 등)

### 3. 개발자가 준비해야 할 것

**개발자 1 (MacBook M2 Max)**:
```bash
# 필수 도구 설치 확인
brew --version          # Homebrew
aws --version           # AWS CLI v2
terraform --version     # Terraform >= 1.5.0
openvpn --version      # OpenVPN Client
```

**개발자 2**:
```bash
# OS에 맞게 설치
# - AWS CLI: https://aws.amazon.com/cli/
# - Terraform: https://www.terraform.io/downloads
# - OpenVPN Client: https://openvpn.net/community-downloads/
```

---

## 1단계: 계정 구조 설계

### IAM 구조 설계

```
AWS Account (MSP 관리)
├── IAM Users (개발자)
│   ├── dev-user-1        # 개발자 1
│   ├── dev-user-2        # 개발자 2
│   └── (향후 추가)
│
├── IAM Roles (권한)
│   ├── TerraformExecutionRole    # Terraform 실행용 (강력한 권한)
│   ├── DeveloperReadOnlyRole     # 읽기 전용 역할
│   └── EKSAdminRole              # EKS 관리 역할
│
└── IAM Policies (정책)
    ├── AssumeRoleWithMFA         # MFA 필수 Assume Role 정책
    ├── RestrictedToVPN           # VPN IP만 허용
    └── TerraformFullAccess       # Terraform 필요 권한
```

### 역할별 권한 매트릭스

| 역할 | 용도 | 권한 범위 | MFA 필수 | VPN 필수 |
|------|------|---------|---------|---------|
| **IAM User** (dev-user-1, dev-user-2) | 기본 로그인 | 거의 없음 (AssumeRole만 가능) | ✅ | ✅ |
| **TerraformExecutionRole** | 인프라 구축/변경 | EC2, EKS, RDS, S3, IAM 등 거의 모든 권한 | ✅ | ✅ |
| **DeveloperReadOnlyRole** | 인프라 조회 | 읽기 전용 (DescribeOnly) | ❌ | ✅ |
| **EKSAdminRole** | Kubernetes 관리 | EKS 클러스터 접근, kubectl 사용 | ✅ | ✅ |

---

## 2단계: OpenVPN 서버 구축

### 2.1. OpenVPN 서버 EC2 인스턴스 생성

**계정 오너 또는 Admin이 AWS Console에서 수행:**

#### Step 1: EC2 인스턴스 시작

```bash
# 사양
Instance Type: t3.micro (vCPU 2개, 1GB RAM)
AMI: Ubuntu Server 22.04 LTS (HVM), SSD Volume Type
VPC: 메인 VPC (10.0.0.0/16)
Subnet: 퍼블릭 서브넷 (10.0.1.0/24)
Auto-assign Public IP: Enable
```

#### Step 2: 보안 그룹 설정

```yaml
Security Group Name: openvpn-server-sg

Inbound Rules:
  - Type: Custom UDP
    Port: 1194
    Source: 0.0.0.0/0  # OpenVPN 클라이언트 접속용
    Description: OpenVPN UDP

  - Type: SSH
    Port: 22
    Source: 개발자1_집_IP/32, 개발자2_집_IP/32
    Description: SSH 관리 접속 (제한적)

Outbound Rules:
  - Type: All traffic
    Destination: 0.0.0.0/0
```

#### Step 3: Elastic IP 할당

```bash
# EC2 인스턴스에 고정 IP 할당
# AWS Console: EC2 → Elastic IPs → Allocate → Associate to OpenVPN instance

# 예: 52.23.45.67
```

### 2.2. OpenVPN 서버 설치 및 설정

**SSH로 OpenVPN 서버 접속 후 실행:**

```bash
# Step 1: 시스템 업데이트
sudo apt update && sudo apt upgrade -y

# Step 2: OpenVPN 및 Easy-RSA 설치
sudo apt install -y openvpn easy-rsa

# Step 3: CA (Certificate Authority) 디렉토리 생성
make-cadir ~/openvpn-ca
cd ~/openvpn-ca

# Step 4: 변수 파일 수정
nano vars
```

#### vars 파일 내용:

```bash
# ~/openvpn-ca/vars

set_var EASYRSA_REQ_COUNTRY    "KR"
set_var EASYRSA_REQ_PROVINCE   "Seoul"
set_var EASYRSA_REQ_CITY       "Seoul"
set_var EASYRSA_REQ_ORG        "Pinksea AI"
set_var EASYRSA_REQ_EMAIL      "admin@pinksea-ai.com"
set_var EASYRSA_REQ_OU         "InvokeAI Development"
set_var EASYRSA_ALGO           "ec"
set_var EASYRSA_DIGEST         "sha512"
```

#### Step 5: CA 및 서버 인증서 생성

```bash
# 1. CA 초기화
cd ~/openvpn-ca
./easyrsa init-pki

# 2. CA 인증서 생성 (암호 설정 필요)
./easyrsa build-ca nopass

# 3. 서버 인증서 및 키 생성
./easyrsa gen-req server nopass
./easyrsa sign-req server server

# 4. Diffie-Hellman 파라미터 생성 (시간 소요)
./easyrsa gen-dh

# 5. TLS 인증 키 생성
openvpn --genkey secret ta.key

# 6. 인증서를 OpenVPN 디렉토리로 복사
sudo cp ~/openvpn-ca/pki/ca.crt /etc/openvpn/server/
sudo cp ~/openvpn-ca/pki/issued/server.crt /etc/openvpn/server/
sudo cp ~/openvpn-ca/pki/private/server.key /etc/openvpn/server/
sudo cp ~/openvpn-ca/pki/dh.pem /etc/openvpn/server/
sudo cp ~/openvpn-ca/ta.key /etc/openvpn/server/
```

### 2.3. OpenVPN 서버 설정 파일 생성

```bash
sudo nano /etc/openvpn/server/server.conf
```

#### /etc/openvpn/server/server.conf:

```conf
# 포트 및 프로토콜
port 1194
proto udp
dev tun

# 인증서 및 키
ca ca.crt
cert server.crt
key server.key
dh dh.pem
tls-auth ta.key 0

# 네트워크 설정
server 10.8.0.0 255.255.255.0
ifconfig-pool-persist /var/log/openvpn/ipp.txt

# VPN 클라이언트가 AWS 리소스에 접근 가능하도록 라우팅
push "route 10.0.0.0 255.255.0.0"

# DNS 서버 (AWS VPC DNS)
push "dhcp-option DNS 10.0.0.2"

# 클라이언트 간 통신 허용
client-to-client

# Keep-alive
keepalive 10 120

# 암호화 설정
cipher AES-256-GCM
auth SHA512

# 권한 설정
user nobody
group nogroup

# 재시작 시 키 유지
persist-key
persist-tun

# 로그
status /var/log/openvpn/openvpn-status.log
log-append /var/log/openvpn/openvpn.log
verb 3

# 최대 클라이언트 수
max-clients 10
```

### 2.4. 네트워크 설정

```bash
# Step 1: IP 포워딩 활성화
sudo nano /etc/sysctl.conf
```

다음 라인의 주석 해제:
```conf
net.ipv4.ip_forward=1
```

```bash
# 즉시 적용
sudo sysctl -p

# Step 2: NAT 설정 (iptables)
sudo nano /etc/rc.local
```

#### /etc/rc.local:

```bash
#!/bin/bash
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
exit 0
```

```bash
# 실행 권한 부여
sudo chmod +x /etc/rc.local

# NAT 즉시 적용
sudo iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE

# Step 3: OpenVPN 서비스 시작
sudo systemctl start openvpn-server@server
sudo systemctl enable openvpn-server@server

# 상태 확인
sudo systemctl status openvpn-server@server
```

### 2.5. 개발자용 클라이언트 인증서 생성

**개발자 1용 인증서 생성:**

```bash
cd ~/openvpn-ca

# 1. 클라이언트 인증서 요청 생성
./easyrsa gen-req dev-user-1 nopass

# 2. 클라이언트 인증서 서명
./easyrsa sign-req client dev-user-1

# 3. 클라이언트 설정 디렉토리 생성
mkdir -p ~/client-configs/keys
chmod 700 ~/client-configs/keys

# 4. 필요한 파일 복사
cp ~/openvpn-ca/pki/ca.crt ~/client-configs/keys/
cp ~/openvpn-ca/pki/issued/dev-user-1.crt ~/client-configs/keys/
cp ~/openvpn-ca/pki/private/dev-user-1.key ~/client-configs/keys/
cp ~/openvpn-ca/ta.key ~/client-configs/keys/
```

**개발자 2용 인증서 생성:**

```bash
# 동일한 과정 반복
./easyrsa gen-req dev-user-2 nopass
./easyrsa sign-req client dev-user-2

cp ~/openvpn-ca/pki/issued/dev-user-2.crt ~/client-configs/keys/
cp ~/openvpn-ca/pki/private/dev-user-2.key ~/client-configs/keys/
```

### 2.6. 클라이언트 설정 파일 생성

```bash
nano ~/client-configs/dev-user-1.ovpn
```

#### dev-user-1.ovpn:

```conf
client
dev tun
proto udp
remote 52.23.45.67 1194  # OpenVPN 서버의 Elastic IP
resolv-retry infinite
nobind
persist-key
persist-tun

remote-cert-tls server
cipher AES-256-GCM
auth SHA512
key-direction 1

verb 3

<ca>
# ca.crt 내용을 여기에 붙여넣기
</ca>

<cert>
# dev-user-1.crt 내용을 여기에 붙여넣기
</cert>

<key>
# dev-user-1.key 내용을 여기에 붙여넣기
</key>

<tls-auth>
# ta.key 내용을 여기에 붙여넣기
</tls-auth>
```

**파일 내용 삽입 자동화 스크립트:**

```bash
# make-client-config.sh
#!/bin/bash

CLIENT=$1
OVPN_SERVER_IP="52.23.45.67"

cat > ~/client-configs/${CLIENT}.ovpn << EOF
client
dev tun
proto udp
remote ${OVPN_SERVER_IP} 1194
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
auth SHA512
key-direction 1
verb 3

<ca>
$(cat ~/client-configs/keys/ca.crt)
</ca>

<cert>
$(cat ~/client-configs/keys/${CLIENT}.crt)
</cert>

<key>
$(cat ~/client-configs/keys/${CLIENT}.key)
</key>

<tls-auth>
$(cat ~/client-configs/keys/ta.key)
</tls-auth>
EOF

echo "생성 완료: ~/client-configs/${CLIENT}.ovpn"
```

```bash
# 스크립트 실행
chmod +x make-client-config.sh
./make-client-config.sh dev-user-1
./make-client-config.sh dev-user-2
```

### 2.7. 클라이언트 설정 파일 전달

**안전한 방법으로 개발자에게 전달:**

```bash
# 1. 파일 압축 및 암호화
cd ~/client-configs
zip -e dev-user-1.zip dev-user-1.ovpn
# 암호 입력: 강력한 암호 설정

# 2. 개발자에게 안전하게 전송
# - 이메일 (암호는 별도 전달)
# - USB 메모리
# - 안전한 파일 공유 서비스

# 전달 후 서버에서 삭제
rm ~/client-configs/dev-user-*.ovpn
rm ~/client-configs/dev-user-*.zip
```

---

## 3단계: IAM Role 및 Policy 설정

### 3.1. Terraform 실행용 IAM Role 생성

**계정 Admin이 AWS Console에서 수행:**

#### Step 1: IAM Role 생성

```
IAM → Roles → Create Role
```

**1. Trusted Entity 설정:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:root"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "IpAddress": {
          "aws:SourceIp": [
            "10.8.0.0/24"
          ]
        },
        "Bool": {
          "aws:MultiFactorAuthPresent": "true"
        }
      }
    }
  ]
}
```

**설명:**
- `aws:SourceIp: 10.8.0.0/24`: OpenVPN 네트워크에서만 AssumeRole 가능
- `aws:MultiFactorAuthPresent: true`: MFA 필수

**2. Role Name:**
```
TerraformExecutionRole
```

**3. Permissions (정책 연결):**

**옵션 A: 관리형 정책 사용 (빠른 시작)**
```
✅ AdministratorAccess
```
**주의**: 프로덕션 환경에서는 최소 권한 원칙에 따라 커스텀 정책 사용 권장

**옵션 B: 커스텀 정책 (권장)**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TerraformEKSFullAccess",
      "Effect": "Allow",
      "Action": [
        "eks:*",
        "ec2:*",
        "elasticloadbalancing:*",
        "autoscaling:*",
        "iam:CreateServiceLinkedRole",
        "iam:PassRole"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformRDSFullAccess",
      "Effect": "Allow",
      "Action": [
        "rds:*",
        "rds-db:connect"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformS3FullAccess",
      "Effect": "Allow",
      "Action": [
        "s3:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformVPCFullAccess",
      "Effect": "Allow",
      "Action": [
        "ec2:*Vpc*",
        "ec2:*Subnet*",
        "ec2:*Gateway*",
        "ec2:*RouteTable*",
        "ec2:*SecurityGroup*",
        "ec2:*NetworkAcl*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformIAMLimitedAccess",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:CreateInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformSecretsManager",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformKMS",
      "Effect": "Allow",
      "Action": [
        "kms:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformCloudWatch",
      "Effect": "Allow",
      "Action": [
        "logs:*",
        "cloudwatch:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformRoute53",
      "Effect": "Allow",
      "Action": [
        "route53:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformCloudFront",
      "Effect": "Allow",
      "Action": [
        "cloudfront:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformElastiCache",
      "Effect": "Allow",
      "Action": [
        "elasticache:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TerraformEFS",
      "Effect": "Allow",
      "Action": [
        "elasticfilesystem:*"
      ],
      "Resource": "*"
    }
  ]
}
```

**정책 이름:** `TerraformExecutionPolicy`

#### Step 2: 읽기 전용 Role 생성 (선택사항)

```
Role Name: DeveloperReadOnlyRole
Trusted Entity: 동일 (OpenVPN IP + MFA)
Permissions: ReadOnlyAccess (AWS 관리형 정책)
```

---

## 4단계: 개발자 IAM User 생성

### 4.1. 개발자 1 IAM User 생성

**계정 Admin이 AWS Console에서 수행:**

```
IAM → Users → Add User
```

**1. User Details:**
```
User Name: dev-user-1
Access type:
  ✅ Programmatic access (AWS CLI, Terraform)
  ✅ AWS Management Console access (선택사항)
```

**2. Set Permissions:**
```
Attach Policies Directly:
  ✅ (새 정책 생성)
```

**AssumeRoleOnlyPolicy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAssumeRoleThroughVPN",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::123456789012:role/TerraformExecutionRole",
        "arn:aws:iam::123456789012:role/DeveloperReadOnlyRole",
        "arn:aws:iam::123456789012:role/EKSAdminRole"
      ],
      "Condition": {
        "IpAddress": {
          "aws:SourceIp": "10.8.0.0/24"
        }
      }
    },
    {
      "Sid": "DenyAllExceptAssumeRole",
      "Effect": "Deny",
      "NotAction": [
        "sts:AssumeRole",
        "iam:GetUser",
        "iam:ListMFADevices",
        "iam:CreateVirtualMFADevice",
        "iam:EnableMFADevice",
        "iam:ResyncMFADevice",
        "iam:DeleteVirtualMFADevice",
        "iam:DeactivateMFADevice",
        "iam:ChangePassword"
      ],
      "Resource": "*"
    }
  ]
}
```

**설명:**
- IAM User는 AssumeRole 외에 아무 권한이 없음
- MFA 설정 및 비밀번호 변경만 허용

**3. Tags (선택사항):**
```
Key: Team, Value: Development
Key: Role, Value: Developer
```

**4. Review & Create:**
- **Access Key ID와 Secret Access Key를 안전하게 저장**
- 이 정보는 다시 볼 수 없으므로 즉시 개발자에게 전달

### 4.2. 개발자 2 IAM User 생성

**동일한 과정 반복:**
```
User Name: dev-user-2
정책: AssumeRoleOnlyPolicy (동일)
```

### 4.3. 개발자 MFA 설정

**개발자가 직접 수행:**

1. **AWS Console 로그인**
   - Account ID: `123456789012`
   - IAM User Name: `dev-user-1`
   - Password: (Admin이 설정한 초기 비밀번호)

2. **MFA 디바이스 등록**
   ```
   우측 상단 사용자 이름 클릭 → Security Credentials → Multi-factor authentication (MFA)
   → Activate MFA → Virtual MFA device
   ```

3. **Google Authenticator 앱 사용**
   - iOS: App Store에서 "Google Authenticator" 다운로드
   - Android: Play Store에서 "Google Authenticator" 다운로드
   - QR 코드 스캔
   - 연속된 두 개의 MFA 코드 입력하여 활성화

4. **MFA ARN 확인**
   ```
   arn:aws:iam::123456789012:mfa/dev-user-1
   ```
   이 ARN은 나중에 AWS CLI 설정에서 사용

---

## 5단계: 개발자 로컬 환경 설정

### 5.1. OpenVPN 클라이언트 연결

**MacBook (개발자 1):**

```bash
# Step 1: Tunnelblick 설치 (MacOS용 OpenVPN 클라이언트)
brew install --cask tunnelblick

# Step 2: .ovpn 파일 가져오기
# Admin으로부터 받은 dev-user-1.ovpn 파일을 더블클릭

# Step 3: Tunnelblick에서 연결
# 메뉴바 → Tunnelblick 아이콘 → dev-user-1 → Connect

# Step 4: 연결 확인
ifconfig | grep "inet.*10.8"
# 출력 예: inet 10.8.0.6 netmask 0xffffff00
```

**Windows/Linux (개발자 2):**

```bash
# Windows: OpenVPN GUI 사용
# 다운로드: https://openvpn.net/community-downloads/
# dev-user-2.ovpn을 C:\Program Files\OpenVPN\config\ 에 복사
# OpenVPN GUI 실행 → 우클릭 → Connect

# Linux:
sudo apt install openvpn
sudo openvpn --config dev-user-2.ovpn
```

### 5.2. AWS CLI 설정

**Step 1: IAM User 자격증명 설정**

```bash
aws configure --profile pingvas-base
```

입력 내용:
```
AWS Access Key ID: AKIAIOSFODNN7EXAMPLE
AWS Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Default region name: us-east-1
Default output format: json
```

**Step 2: MFA 세션 토큰 얻기**

```bash
# MFA 코드 확인 (Google Authenticator 앱)
# 예: 123456

# 세션 토큰 얻기
aws sts get-session-token \
  --serial-number arn:aws:iam::123456789012:mfa/dev-user-1 \
  --token-code 123456 \
  --profile pingvas-base
```

출력:
```json
{
  "Credentials": {
    "AccessKeyId": "ASIAIOSFODNN7EXAMPLE",
    "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "SessionToken": "FwoGZXIvYXdzEL...(매우 긴 문자열)",
    "Expiration": "2025-11-26T12:00:00Z"
  }
}
```

**Step 3: MFA 세션을 프로파일로 저장**

```bash
nano ~/.aws/credentials
```

```ini
[pingvas-base]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[pingvas-mfa]
aws_access_key_id = ASIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
aws_session_token = FwoGZXIvYXdzEL...(위에서 받은 SessionToken)
```

**Step 4: Assume Role 설정**

```bash
nano ~/.aws/config
```

```ini
[profile pingvas-base]
region = us-east-1
output = json

[profile pingvas-mfa]
region = us-east-1
output = json

[profile pingvas-terraform]
region = us-east-1
output = json
role_arn = arn:aws:iam::123456789012:role/TerraformExecutionRole
source_profile = pingvas-mfa
role_session_name = terraform-session
duration_seconds = 3600
```

**설명:**
- `pingvas-base`: 기본 IAM User 자격증명
- `pingvas-mfa`: MFA 세션 토큰 (12시간 유효)
- `pingvas-terraform`: TerraformExecutionRole로 전환 (1시간 유효)

### 5.3. Assume Role 테스트

```bash
# OpenVPN 연결 확인
ping -c 3 10.0.0.2
# VPC DNS에 ping이 가야 함

# Assume Role 테스트
aws sts get-caller-identity --profile pingvas-terraform
```

**성공 시 출력:**
```json
{
  "UserId": "AROAXXXXXXXXXXXXXXXXX:terraform-session",
  "Account": "123456789012",
  "Arn": "arn:aws:sts::123456789012:assumed-role/TerraformExecutionRole/terraform-session"
}
```

**실패 시 확인사항:**
1. OpenVPN 연결 상태 확인
2. MFA 세션 토큰 만료 여부 (12시간)
3. IP 주소가 10.8.0.0/24 대역인지 확인

### 5.4. 편의 스크립트 작성

**MFA 세션 갱신 스크립트:**

```bash
# ~/aws-mfa.sh
#!/bin/bash

read -p "Enter MFA Code: " MFA_CODE

SESSION=$(aws sts get-session-token \
  --serial-number arn:aws:iam::123456789012:mfa/dev-user-1 \
  --token-code $MFA_CODE \
  --profile pingvas-base \
  --output json)

ACCESS_KEY=$(echo $SESSION | jq -r '.Credentials.AccessKeyId')
SECRET_KEY=$(echo $SESSION | jq -r '.Credentials.SecretAccessKey')
SESSION_TOKEN=$(echo $SESSION | jq -r '.Credentials.SessionToken')

# ~/.aws/credentials 파일 업데이트
aws configure set aws_access_key_id $ACCESS_KEY --profile pingvas-mfa
aws configure set aws_secret_access_key $SECRET_KEY --profile pingvas-mfa
aws configure set aws_session_token $SESSION_TOKEN --profile pingvas-mfa

echo "✅ MFA 세션 갱신 완료 (12시간 유효)"
echo "이제 'aws --profile pingvas-terraform' 명령을 사용할 수 있습니다."
```

```bash
chmod +x ~/aws-mfa.sh
```

**사용법:**
```bash
# OpenVPN 연결 후 매일 1회 실행
~/aws-mfa.sh
# MFA 코드 입력: 123456
```

---

## 6단계: Terraform 백엔드 설정

### 6.1. S3 버킷 생성 (Terraform State 저장)

**Admin 또는 개발자가 AWS Console 또는 CLI로 수행:**

```bash
# S3 버킷 생성
aws s3api create-bucket \
  --bucket pingvas-terraform-state \
  --region us-east-1 \
  --profile pingvas-terraform

# 버전 관리 활성화
aws s3api put-bucket-versioning \
  --bucket pingvas-terraform-state \
  --versioning-configuration Status=Enabled \
  --profile pingvas-terraform

# 암호화 활성화
aws s3api put-bucket-encryption \
  --bucket pingvas-terraform-state \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }' \
  --profile pingvas-terraform

# 퍼블릭 액세스 차단
aws s3api put-public-access-block \
  --bucket pingvas-terraform-state \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
  --profile pingvas-terraform
```

### 6.2. DynamoDB 테이블 생성 (State Locking)

```bash
# DynamoDB 테이블 생성
aws dynamodb create-table \
  --table-name pingvas-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1 \
  --profile pingvas-terraform
```

### 6.3. 백엔드 설정 확인

```bash
# S3 버킷 확인
aws s3 ls s3://pingvas-terraform-state --profile pingvas-terraform

# DynamoDB 테이블 확인
aws dynamodb describe-table \
  --table-name pingvas-terraform-locks \
  --profile pingvas-terraform \
  --query 'Table.[TableName,TableStatus]'
```

---

## 7단계: Terraform Provider 설정

### 7.1. 프로젝트 디렉토리 구조

```bash
mkdir -p ~/Projects/invokeai-infrastructure
cd ~/Projects/invokeai-infrastructure

# 디렉토리 구조
mkdir -p {environments/{dev,prod},modules/{vpc,eks,rds,redis,s3}}
```

**전체 구조:**
```
invokeai-infrastructure/
├── environments/
│   ├── dev/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── terraform.tfvars
│   │   └── backend.tf
│   └── prod/
│       ├── main.tf
│       ├── variables.tf
│       ├── terraform.tfvars
│       └── backend.tf
├── modules/
│   ├── vpc/
│   ├── eks/
│   ├── rds/
│   ├── redis/
│   └── s3/
└── README.md
```

### 7.2. Backend 설정 파일

**environments/dev/backend.tf:**

```hcl
terraform {
  backend "s3" {
    bucket         = "pingvas-terraform-state"
    key            = "dev/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "pingvas-terraform-locks"

    # Assume Role 설정
    role_arn       = "arn:aws:iam::123456789012:role/TerraformExecutionRole"
    session_name   = "terraform-dev-session"
  }
}
```

**environments/prod/backend.tf:**

```hcl
terraform {
  backend "s3" {
    bucket         = "pingvas-terraform-state"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "pingvas-terraform-locks"

    # Assume Role 설정
    role_arn       = "arn:aws:iam::123456789012:role/TerraformExecutionRole"
    session_name   = "terraform-prod-session"
  }
}
```

### 7.3. Provider 설정 파일

**environments/dev/main.tf:**

```hcl
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.20"
    }
  }
}

# AWS Provider with Assume Role
provider "aws" {
  region = var.aws_region

  assume_role {
    role_arn     = "arn:aws:iam::123456789012:role/TerraformExecutionRole"
    session_name = "terraform-dev-session"
    duration     = "1h"
  }

  default_tags {
    tags = {
      Environment = "dev"
      Project     = "InvokeAI"
      ManagedBy   = "Terraform"
      Team        = "Development"
    }
  }
}

# Kubernetes Provider (EKS 생성 후 사용)
provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args = [
      "eks", "get-token",
      "--cluster-name", module.eks.cluster_name,
      "--region", var.aws_region,
      "--role-arn", "arn:aws:iam::123456789012:role/TerraformExecutionRole"
    ]
  }
}

# Variables
variable "aws_region" {
  description = "AWS Region"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "dev"
}

# Modules
module "vpc" {
  source = "../../modules/vpc"

  environment       = var.environment
  vpc_cidr          = "10.0.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

module "eks" {
  source = "../../modules/eks"

  environment    = var.environment
  vpc_id         = module.vpc.vpc_id
  subnet_ids     = module.vpc.private_subnet_ids
  cluster_version = "1.28"
}

# ... 추가 모듈
```

---

## 8단계: 인프라 배포 실행

### 8.1. 배포 전 체크리스트

**✅ 필수 확인사항:**

```bash
# 1. OpenVPN 연결 확인
ifconfig | grep "inet.*10.8"

# 2. MFA 세션 유효성 확인
aws sts get-caller-identity --profile pingvas-mfa

# 3. Assume Role 가능 여부 확인
aws sts get-caller-identity --profile pingvas-terraform

# 4. Terraform 버전 확인
terraform version
# Terraform v1.5.0 이상
```

### 8.2. 개발 환경 배포

**Step 1: 초기화**

```bash
cd ~/Projects/invokeai-infrastructure/environments/dev

# Terraform 초기화
terraform init
```

**출력 예시:**
```
Initializing the backend...

Successfully configured the backend "s3"! Terraform will automatically
use this backend unless the backend configuration changes.

Initializing provider plugins...
- Finding hashicorp/aws versions matching "~> 5.0"...
- Installing hashicorp/aws v5.30.0...

Terraform has been successfully initialized!
```

**Step 2: 계획 확인**

```bash
# Dry-run: 어떤 리소스가 생성될지 확인
terraform plan -out=tfplan
```

**출력 분석:**
```
Terraform will perform the following actions:

  # module.vpc.aws_vpc.main will be created
  + resource "aws_vpc" "main" {
      + cidr_block = "10.0.0.0/16"
      ...
    }

Plan: 47 to add, 0 to change, 0 to destroy.
```

**Step 3: 배포 실행**

```bash
# 실제 인프라 생성
terraform apply tfplan
```

**진행 상황:**
```
module.vpc.aws_vpc.main: Creating...
module.vpc.aws_vpc.main: Creation complete after 5s [id=vpc-0123456789abcdef]
module.vpc.aws_subnet.public[0]: Creating...
...
Apply complete! Resources: 47 added, 0 changed, 0 destroyed.

Outputs:
vpc_id = "vpc-0123456789abcdef"
eks_cluster_name = "pingvas-dev-eks"
rds_endpoint = "pingvas-dev.cluster-abcdefg.us-east-1.rds.amazonaws.com"
```

**소요 시간:**
- VPC, 서브넷: ~5분
- EKS 클러스터: ~15분
- RDS Aurora: ~10분
- Redis ElastiCache: ~10분
- 전체: 약 40-50분

### 8.3. 배포 후 검증

```bash
# 1. VPC 확인
aws ec2 describe-vpcs \
  --filters "Name=tag:Name,Values=pingvas-dev-vpc" \
  --profile pingvas-terraform

# 2. EKS 클러스터 확인
aws eks describe-cluster \
  --name pingvas-dev-eks \
  --profile pingvas-terraform

# 3. RDS 확인
aws rds describe-db-clusters \
  --db-cluster-identifier pingvas-dev-aurora \
  --profile pingvas-terraform

# 4. EKS 클러스터 접근 설정
aws eks update-kubeconfig \
  --name pingvas-dev-eks \
  --region us-east-1 \
  --profile pingvas-terraform

# 5. Kubernetes 접근 테스트
kubectl get nodes
kubectl get namespaces
```

### 8.4. 운영 환경 배포

**개발 환경 검증 완료 후 진행:**

```bash
cd ~/Projects/invokeai-infrastructure/environments/prod

# 초기화
terraform init

# 계획 확인 (매우 중요!)
terraform plan -out=tfplan

# 리뷰 후 배포
terraform apply tfplan
```

---

## 보안 Best Practices

### 1. MFA 세션 관리

```bash
# MFA 세션은 12시간마다 갱신 필요
# 매일 아침 OpenVPN 연결 후 실행
~/aws-mfa.sh
```

### 2. Assume Role 세션 타임아웃

```bash
# TerraformExecutionRole은 1시간 유효
# 장시간 작업 시 중간에 갱신 필요

# 방법 1: 세션 유지 스크립트
while true; do
  aws sts get-caller-identity --profile pingvas-terraform > /dev/null 2>&1
  if [ $? -ne 0 ]; then
    echo "⚠️  세션 만료됨. MFA 갱신 필요"
    ~/aws-mfa.sh
  fi
  sleep 3000  # 50분마다 체크
done

# 방법 2: 작업 전 갱신
~/aws-mfa.sh && terraform apply
```

### 3. Access Key 보안

```bash
# ~/.aws/credentials 파일 권한 설정
chmod 600 ~/.aws/credentials
chmod 600 ~/.aws/config

# Git에 절대 커밋하지 않기
echo ".aws/" >> ~/.gitignore
echo "*.tfvars" >> ~/Projects/invokeai-infrastructure/.gitignore
```

### 4. OpenVPN 인증서 관리

```bash
# 클라이언트 인증서는 1년마다 갱신 권장
# 인증서 유효기간 확인
openssl x509 -in ~/client-configs/keys/dev-user-1.crt -noout -enddate

# 갱신 방법
cd ~/openvpn-ca
./easyrsa renew dev-user-1
```

### 5. 개발자 퇴사 시 처리

```bash
# 1. IAM User 비활성화
aws iam delete-access-key --user-name dev-user-x --access-key-id AKIAXXXXXXX --profile pingvas-terraform
aws iam delete-login-profile --user-name dev-user-x --profile pingvas-terraform

# 2. OpenVPN 인증서 폐기
cd ~/openvpn-ca
./easyrsa revoke dev-user-x

# 3. CRL (Certificate Revocation List) 갱신
./easyrsa gen-crl
sudo cp ~/openvpn-ca/pki/crl.pem /etc/openvpn/server/
sudo systemctl restart openvpn-server@server
```

### 6. IP 화이트리스트 관리

```bash
# 개발자 집/사무실 IP 변경 시
# OpenVPN 서버 보안 그룹 업데이트
aws ec2 authorize-security-group-ingress \
  --group-id sg-xxxxxxxxx \
  --protocol tcp \
  --port 22 \
  --cidr 새IP주소/32 \
  --profile pingvas-terraform
```

### 7. Terraform State 파일 보안

```bash
# State 파일에는 민감 정보 포함 가능
# 절대 로컬에 저장하지 않고 S3 백엔드 사용

# State 파일 접근 로그 확인
aws s3api get-bucket-logging --bucket pingvas-terraform-state --profile pingvas-terraform

# 로깅 활성화 (선택사항)
aws s3api put-bucket-logging \
  --bucket pingvas-terraform-state \
  --bucket-logging-status '{
    "LoggingEnabled": {
      "TargetBucket": "pingvas-access-logs",
      "TargetPrefix": "terraform-state-access/"
    }
  }' \
  --profile pingvas-terraform
```

---

## 트러블슈팅

### 문제 1: AssumeRole 실패 - "Access Denied"

**증상:**
```
An error occurred (AccessDenied) when calling the AssumeRole operation:
User: arn:aws:iam::123456789012:user/dev-user-1 is not authorized to perform: sts:AssumeRole
```

**원인:**
- OpenVPN 연결이 안 됨
- MFA 세션 만료
- IP 조건 불일치

**해결:**
```bash
# 1. OpenVPN 연결 확인
ifconfig | grep "10.8.0"
# 출력이 없으면 OpenVPN 재연결

# 2. MFA 세션 갱신
~/aws-mfa.sh

# 3. 소스 IP 확인
curl https://checkip.amazonaws.com
# 10.8.0.x 대역이어야 함
```

### 문제 2: Terraform init 실패 - "Error configuring S3 Backend"

**증상:**
```
Error: error configuring S3 Backend: error validating provider credentials:
```

**해결:**
```bash
# 1. 프로파일 확인
aws sts get-caller-identity --profile pingvas-terraform

# 2. S3 버킷 존재 여부 확인
aws s3 ls s3://pingvas-terraform-state --profile pingvas-terraform

# 3. backend.tf에서 role_arn 확인
grep role_arn environments/dev/backend.tf
```

### 문제 3: EKS 클러스터 접근 불가

**증상:**
```
error: You must be logged in to the server (Unauthorized)
```

**해결:**
```bash
# 1. kubeconfig 재생성
aws eks update-kubeconfig \
  --name pingvas-dev-eks \
  --region us-east-1 \
  --profile pingvas-terraform \
  --role-arn arn:aws:iam::123456789012:role/TerraformExecutionRole

# 2. EKS 클러스터 상태 확인
aws eks describe-cluster \
  --name pingvas-dev-eks \
  --profile pingvas-terraform \
  --query 'cluster.status'

# 3. aws-auth ConfigMap 확인
kubectl get configmap aws-auth -n kube-system -o yaml
```

### 문제 4: OpenVPN 연결 후에도 AWS 접근 안 됨

**증상:**
- OpenVPN 연결은 성공
- AWS API 호출 시 "Network Error" 또는 타임아웃

**해결:**
```bash
# 1. VPC DNS 접근 확인
ping -c 3 10.0.0.2

# 2. AWS API 엔드포인트 접근 확인
curl -I https://sts.us-east-1.amazonaws.com

# 3. OpenVPN 서버 라우팅 확인
# OpenVPN 서버에 SSH 접속 후:
sudo iptables -t nat -L -n -v | grep MASQUERADE
# MASQUERADE rule이 있어야 함

# 없으면 재설정:
sudo iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
```

### 문제 5: Terraform apply 중 "Rate Limit Exceeded"

**증상:**
```
Error: error creating EC2 Instance: RequestLimitExceeded
```

**해결:**
```bash
# AWS API Rate Limit에 도달
# 잠시 대기 후 재시도

# 또는 병렬 처리 제한
terraform apply -parallelism=5
```

### 문제 6: MFA 세션 갱신 스크립트 오류

**증상:**
```
jq: command not found
```

**해결:**
```bash
# jq 설치
brew install jq  # MacOS
sudo apt install jq  # Ubuntu/Debian
```

---

## 영향받는 문서 수정사항

이 MSP/IAM/OpenVPN 설정은 기존 아키텍처 문서에 다음과 같은 업데이트가 필요합니다:

### 📄 01-aws-architecture-diagram.md

**추가 필요 섹션:**

#### "보안 아키텍처" 섹션에 추가:

```markdown
### IAM 및 접근 제어

#### MSP 환경 특화 설정

```mermaid
graph TB
    subgraph Developer[개발자 환경]
        DevMachine[개발자 로컬<br/>MacBook M2 Max]
    end

    subgraph VPN[OpenVPN Layer]
        VPNServer[OpenVPN Server<br/>10.8.0.0/24]
    end

    subgraph IAM[IAM Layer]
        IAMUser[IAM User<br/>dev-user-1]
        IAMRole[IAM Role<br/>TerraformExecutionRole]
    end

    subgraph AWS[AWS Resources]
        EKS[EKS Cluster]
        RDS[RDS Aurora]
        S3[S3 Buckets]
    end

    DevMachine -->|1. VPN 연결| VPNServer
    DevMachine -->|2. AWS CLI<br/>with MFA| IAMUser
    IAMUser -->|3. AssumeRole<br/>Source IP 확인| IAMRole
    IAMRole -->|4. Terraform<br/>Full Access| AWS

    style VPNServer fill:#FF9F43
    style IAMRole fill:#5F27CD
```

**IAM 정책 구조:**

| 컴포넌트 | 설명 | 필수 조건 |
|----------|------|-----------|
| **IAM User** | 개발자 개인 계정 | MFA 필수, AssumeRole만 허용 |
| **IAM Role** | 강력한 권한을 가진 역할 | VPN IP (10.8.0.0/24)에서만 Assume 가능 |
| **OpenVPN** | IP 기반 접근 제어 | 클라이언트 인증서 필수 |
| **MFA** | 다중 인증 | Google Authenticator |

**인프라 배포 흐름:**

1. 개발자가 OpenVPN 연결
2. MFA 토큰으로 IAM User 인증
3. TerraformExecutionRole로 권한 상승 (Assume Role)
4. Terraform으로 인프라 배포
5. 1시간 세션 유지 후 재인증

**관련 문서:** [07-msp-iam-openvpn-setup-guide.md](./07-msp-iam-openvpn-setup-guide.md)
```

### 📄 GitOps/DevOps 섹션 수정

**기존 내용에 추가:**

```markdown
### Terraform 실행 환경

**MSP 환경 특이사항:**

```bash
# 1. OpenVPN 연결 필수
# 2. MFA 세션 활성화
~/aws-mfa.sh

# 3. Terraform 명령 실행 시 프로파일 지정
export AWS_PROFILE=pingvas-terraform

# 4. 인프라 배포
cd environments/dev
terraform init
terraform plan
terraform apply
```

**GitHub Actions에서 Terraform 실행 (CI/CD):**

GitHub Actions Runner를 OpenVPN 네트워크 내부에 배치하거나, GitHub Actions용 별도 IAM Role 생성 필요.

```yaml
# .github/workflows/terraform.yml
name: Terraform Deploy

on:
  push:
    branches: [main]
    paths:
      - 'infrastructure/**'

jobs:
  terraform:
    runs-on: self-hosted  # OpenVPN 네트워크 내부 러너

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
          aws-region: us-east-1

      - name: Terraform Init
        run: terraform init
        working-directory: ./infrastructure/environments/dev

      - name: Terraform Plan
        run: terraform plan -out=tfplan
        working-directory: ./infrastructure/environments/dev

      - name: Terraform Apply
        if: github.ref == 'refs/heads/main'
        run: terraform apply -auto-approve tfplan
        working-directory: ./infrastructure/environments/dev
```

**주의사항:**
- GitHub Actions Runner는 반드시 OpenVPN 네트워크 내부에 위치해야 함
- 또는 GitHub Actions용 IAM Role에 다른 IP 조건 추가
```

### 📄 README.md 또는 시작 가이드

**새 개발자 온보딩 체크리스트 추가:**

```markdown
## 신규 개발자 온보딩

### 1일차: 접근 권한 설정

- [ ] 계정 오너에게 IAM User 생성 요청
  - [ ] Access Key 수령
  - [ ] OpenVPN 클라이언트 인증서 수령 (.ovpn 파일)
- [ ] MFA 디바이스 등록 (Google Authenticator)
- [ ] OpenVPN 연결 테스트
- [ ] AWS CLI 설정
  ```bash
  aws configure --profile pingvas-base
  ~/aws-mfa.sh
  aws sts get-caller-identity --profile pingvas-terraform
  ```

### 2일차: 개발 환경 설정

- [ ] Terraform 설치 및 버전 확인 (>= 1.5.0)
- [ ] kubectl 설치
- [ ] Docker Desktop 설치 (로컬 개발용)
- [ ] 저장소 클론
  ```bash
  git clone https://github.com/Pinksea-AI/InvokeAI.git
  cd InvokeAI/infrastructure
  ```

### 3일차: 인프라 이해

- [ ] 아키텍처 문서 읽기: `docs/final-architecture/01-aws-architecture-diagram.md`
- [ ] MSP/IAM 가이드 읽기: `docs/final-architecture/07-msp-iam-openvpn-setup-guide.md`
- [ ] Dev 환경 Terraform 코드 리뷰
- [ ] EKS 클러스터 접근 테스트
  ```bash
  aws eks update-kubeconfig --name pingvas-dev-eks --profile pingvas-terraform
  kubectl get nodes
  ```

### 참고 문서

- [MSP 환경 IAM 설정 가이드](./docs/final-architecture/07-msp-iam-openvpn-setup-guide.md)
- [AWS 아키텍처 다이어그램](./docs/final-architecture/01-aws-architecture-diagram.md)
- [GitOps 파이프라인](./docs/final-architecture/01-aws-architecture-diagram.md#gitopsdevops-파이프라인)
```

---

## 요약

### 핵심 구성

1. **OpenVPN**: IP 기반 접근 제어 (10.8.0.0/24)
2. **IAM User**: 개발자 개인 계정 (최소 권한)
3. **IAM Role**: Terraform 실행용 강력한 권한
4. **Assume Role**: MFA + VPN IP 조건으로 권한 상승
5. **Terraform Backend**: S3 + DynamoDB (State 잠금)

### 일일 워크플로우

```bash
# 1. OpenVPN 연결
# Tunnelblick → dev-user-1 → Connect

# 2. MFA 세션 갱신 (12시간 유효)
~/aws-mfa.sh
# MFA 코드 입력: 123456

# 3. Terraform 작업
cd ~/Projects/invokeai-infrastructure/environments/dev
terraform plan
terraform apply

# 4. EKS 클러스터 관리
kubectl get pods -n dev
```

### 보안 수준

- ✅ **네트워크 격리**: VPN 연결 필수
- ✅ **다중 인증**: MFA 강제
- ✅ **최소 권한**: IAM User는 AssumeRole만 가능
- ✅ **시간 제한**: Role 세션 1시간 제한
- ✅ **감사 추적**: CloudTrail로 모든 API 호출 기록

### 추가 개발자 추가 시

1. OpenVPN 서버에서 클라이언트 인증서 생성
2. IAM User 생성 (AssumeRoleOnlyPolicy 연결)
3. MFA 디바이스 등록
4. .ovpn 파일 및 Access Key 전달
5. 온보딩 가이드 제공

---

**문서 버전**: 1.0
**작성일**: 2025-11-25
**작성자**: Claude Code + Pinksea AI Team
**다음 리뷰**: 2025-12-25 (월 1회 업데이트 권장)
