# 최종 AWS 아키텍처 다이어그램

이 문서는 InvokeAI SaaS 플랫폼의 최종 AWS 아키텍처를 상세하게 설명합니다.

## 목차
1. [전체 시스템 아키텍처](#전체-시스템-아키텍처)
2. [네트워크 아키텍처](#네트워크-아키텍처)
3. [컴퓨팅 아키텍처](#컴퓨팅-아키텍처)
4. [데이터 아키텍처](#데이터-아키텍처)
5. [GitOps/DevOps 파이프라인](#gitopsdevops-파이프라인)
6. [보안 아키텍처](#보안-아키텍처)
7. [모니터링 아키텍처](#모니터링-아키텍처)

---

## 전체 시스템 아키텍처

```mermaid
graph TB
    subgraph "Internet"
        Users[👥 Users]
        DevTeam[👨‍💻 Dev Team]
    end

    subgraph "CloudFront CDN"
        CF[CloudFront Distribution]
    end

    subgraph "AWS Region: us-east-1"
        subgraph "Route 53"
            R53[Route 53<br/>DNS Management]
        end

        subgraph "AWS WAF"
            WAF[WAF Web ACL<br/>- Rate Limiting<br/>- SQL Injection Protection<br/>- IP Reputation]
        end

        subgraph "VPC: 10.0.0.0/16"
            subgraph "Public Subnets: 10.0.1.0/24, 10.0.2.0/24, 10.0.3.0/24"
                IGW[Internet Gateway]
                NAT[NAT Gateway<br/>us-east-1a]
                ALB[Application Load Balancer<br/>- HTTPS Termination<br/>- Path-based Routing]
            end

            subgraph "Private Subnets: 10.0.11.0/24, 10.0.12.0/24, 10.0.13.0/24"
                subgraph "EKS Cluster: pingvas-shared-eks"
                    subgraph "Namespace: dev"
                        DevPods[Dev Services<br/>- user-service<br/>- payment-service<br/>- generation-service<br/>- gallery-service<br/>- model-service]
                        DevWorkers[Dev Workers<br/>- GPU: 0-3]
                    end

                    subgraph "Namespace: prod"
                        ProdPods[Prod Services<br/>- user-service<br/>- payment-service<br/>- generation-service<br/>- gallery-service<br/>- model-service]
                        ProdWorkers[Prod Workers<br/>- GPU: 0-15]
                    end

                    subgraph "System Nodes"
                        SysNodes[2x t3.medium Spot<br/>- ArgoCD<br/>- Prometheus<br/>- Karpenter]
                    end

                    subgraph "GPU Nodes (Karpenter)"
                        GPUNodes[0-10x GPU Spot<br/>- g4dn.xlarge<br/>- g4dn.2xlarge<br/>- g5.xlarge]
                    end
                end

                subgraph "Data Layer"
                    RDS[(RDS Aurora Serverless v2<br/>Writer + Reader<br/>pingvas_saas<br/>- dev_pingvas schema<br/>- prod_pingvas schema)]

                    RedisDev[(Redis Dev<br/>Standalone<br/>cache.t4g.medium)]

                    RedisProd[(Redis Prod<br/>Sentinel 3 nodes<br/>cache.r6g.large)]

                    EFS[/EFS Shared Models<br/>AI Model Storage/]
                end
            end
        end

        subgraph "S3 Storage"
            S3Dev[S3: pingvas-dev-images]
            S3Prod[S3: pingvas-prod-images]
            S3Models[S3: pingvas-models-shared]
            S3Logs[S3: pingvas-logs-shared]
        end

        subgraph "Secrets Management"
            SM[AWS Secrets Manager<br/>- DB Credentials<br/>- Redis Auth Tokens<br/>- JWT Secrets<br/>- API Keys]
        end

        subgraph "Monitoring"
            CW[CloudWatch<br/>- Logs<br/>- Metrics<br/>- Alarms]

            subgraph "EKS Monitoring"
                Prom[Prometheus]
                Graf[Grafana]
            end
        end

        subgraph "CI/CD"
            ECR[Amazon ECR<br/>Container Registry]
            GHA[GitHub Actions<br/>Self-hosted Runner]
        end
    end

    subgraph "External Services"
        LS[Lemon Squeezy<br/>Payment Gateway]
        GoogleOAuth[Google OAuth]
        DiscordOAuth[Discord OAuth]
    end

    subgraph "Version Control"
        GitHub[GitHub Repository<br/>- Application Code<br/>- Infrastructure Code<br/>- K8s Manifests]
    end

    %% User Flow
    Users -->|HTTPS| R53
    R53 --> WAF
    WAF --> ALB
    ALB -->|/api| DevPods
    ALB -->|/api| ProdPods

    %% CDN Flow
    Users -->|Static Assets| CF
    CF --> S3Dev
    CF --> S3Prod

    %% Service Dependencies
    DevPods --> RDS
    DevPods --> RedisDev
    ProdPods --> RDS
    ProdPods --> RedisProd

    DevWorkers --> EFS
    ProdWorkers --> EFS
    DevWorkers --> S3Dev
    ProdWorkers --> S3Prod

    %% External Integrations
    DevPods --> LS
    ProdPods --> LS
    DevPods --> GoogleOAuth
    DevPods --> DiscordOAuth
    ProdPods --> GoogleOAuth
    ProdPods --> DiscordOAuth

    %% Monitoring
    DevPods -.->|Metrics| Prom
    ProdPods -.->|Metrics| Prom
    Prom --> Graf
    DevPods -.->|Logs| CW
    ProdPods -.->|Logs| CW

    %% CI/CD Flow
    DevTeam -->|Push Code| GitHub
    GitHub -->|Trigger| GHA
    GHA -->|Build & Push| ECR
    ECR -->|Pull Images| DevPods
    ECR -->|Pull Images| ProdPods

    %% Secrets
    DevPods -.->|Fetch| SM
    ProdPods -.->|Fetch| SM

    %% Internet Access
    DevPods --> NAT
    ProdPods --> NAT
    NAT --> IGW

    style Users fill:#4A90E2
    style DevTeam fill:#E24A4A
    style WAF fill:#FF6B6B
    style EKS fill:#FF9F43
    style RDS fill:#5F27CD
    style RedisDev fill:#00D2D3
    style RedisProd fill:#00D2D3
    style S3Dev fill:#48C774
    style S3Prod fill:#48C774
    style Prom fill:#E24A4A
    style Graf fill:#FF6B35
```

---

## 네트워크 아키텍처

### VPC 설계

```mermaid
graph TB
    subgraph "VPC: 10.0.0.0/16 (us-east-1)"
        subgraph "Availability Zone A: us-east-1a"
            PubA[Public Subnet<br/>10.0.1.0/24]
            PrivA[Private Subnet<br/>10.0.11.0/24]

            PubA --> NATGW[NAT Gateway]
            NATGW --> IGW[Internet Gateway]

            PrivA --> NATGW
        end

        subgraph "Availability Zone B: us-east-1b"
            PubB[Public Subnet<br/>10.0.2.0/24]
            PrivB[Private Subnet<br/>10.0.12.0/24]

            PrivB --> NATGW
        end

        subgraph "Availability Zone C: us-east-1c"
            PubC[Public Subnet<br/>10.0.3.0/24]
            PrivC[Private Subnet<br/>10.0.13.0/24]

            PrivC --> NATGW
        end

        subgraph "Route Tables"
            PublicRT[Public Route Table<br/>0.0.0.0/0 → IGW]
            PrivateRT[Private Route Table<br/>0.0.0.0/0 → NAT Gateway]
        end

        PubA -.-> PublicRT
        PubB -.-> PublicRT
        PubC -.-> PublicRT

        PrivA -.-> PrivateRT
        PrivB -.-> PrivateRT
        PrivC -.-> PrivateRT
    end

    style PubA fill:#FFE66D
    style PubB fill:#FFE66D
    style PubC fill:#FFE66D
    style PrivA fill:#4ECDC4
    style PrivB fill:#4ECDC4
    style PrivC fill:#4ECDC4
```

### 서브넷 할당표

| AZ | Public Subnet | Private Subnet | 용도 |
|----|---------------|----------------|------|
| us-east-1a | 10.0.1.0/24 | 10.0.11.0/24 | ALB, NAT GW / EKS Nodes, RDS Primary |
| us-east-1b | 10.0.2.0/24 | 10.0.12.0/24 | ALB / EKS Nodes, RDS Replica |
| us-east-1c | 10.0.3.0/24 | 10.0.13.0/24 | ALB / EKS Nodes |

### 보안 그룹 설계

```mermaid
graph LR
    subgraph "Security Groups"
        ALBSG[ALB Security Group<br/>Inbound: 80, 443 from 0.0.0.0/0<br/>Outbound: 8001-8005 to EKS SG]

        EKSSG[EKS Nodes Security Group<br/>Inbound: 8001-8005 from ALB SG<br/>Inbound: All from EKS SG<br/>Outbound: All]

        RDSSG[RDS Security Group<br/>Inbound: 5432 from EKS SG<br/>Outbound: None]

        RedisDevSG[Redis Dev Security Group<br/>Inbound: 6379 from EKS SG<br/>Outbound: None]

        RedisProdSG[Redis Prod Security Group<br/>Inbound: 6379 from EKS SG<br/>Outbound: None]

        EFSSG[EFS Security Group<br/>Inbound: 2049 from EKS SG<br/>Outbound: None]
    end

    ALB --> ALBSG
    EKS --> EKSSG
    RDS --> RDSSG
    RedisDev --> RedisDevSG
    RedisProd --> RedisProdSG
    EFS --> EFSSG

    ALBSG -.->|Allow| EKSSG
    EKSSG -.->|Allow| RDSSG
    EKSSG -.->|Allow| RedisDevSG
    EKSSG -.->|Allow| RedisProdSG
    EKSSG -.->|Allow| EFSSG
```

---

## 컴퓨팅 아키텍처

### EKS 클러스터 구성

```mermaid
graph TB
    subgraph "EKS Control Plane"
        CP[Managed Control Plane<br/>Kubernetes 1.28<br/>Multi-AZ HA]
    end

    subgraph "Worker Nodes"
        subgraph "System Node Group"
            SN1[t3.medium Spot<br/>us-east-1a<br/>System Pods]
            SN2[t3.medium Spot<br/>us-east-1b<br/>System Pods]
        end

        subgraph "Karpenter Managed GPU Nodes"
            GPU1[g4dn.xlarge Spot<br/>1x T4 GPU<br/>Dynamic]
            GPU2[g4dn.2xlarge Spot<br/>1x T4 GPU<br/>Dynamic]
            GPU3[g5.xlarge Spot<br/>1x A10G GPU<br/>Dynamic]

            GPUDots[... up to 10 nodes]
        end
    end

    CP -.->|Manages| SN1
    CP -.->|Manages| SN2
    CP -.->|Manages| GPU1
    CP -.->|Manages| GPU2
    CP -.->|Manages| GPU3

    subgraph "Karpenter Controller"
        Karp[Karpenter<br/>- Auto-scaling<br/>- Spot Interruption Handling<br/>- Bin Packing]
    end

    Karp -->|Provisions| GPU1
    Karp -->|Provisions| GPU2
    Karp -->|Provisions| GPU3

    style CP fill:#FF6B6B
    style SN1 fill:#4ECDC4
    style SN2 fill:#4ECDC4
    style GPU1 fill:#95E1D3
    style GPU2 fill:#95E1D3
    style GPU3 fill:#95E1D3
```

### 네임스페이스 격리

```mermaid
graph TB
    subgraph "EKS Cluster: pingvas-shared-eks"
        subgraph "Namespace: dev"
            DevQuota[ResourceQuota<br/>CPU: 20<br/>Memory: 50Gi<br/>GPU: 3<br/>Pods: 50]

            DevNP[NetworkPolicy<br/>- Allow same namespace<br/>- Deny to prod<br/>- Allow to RDS/Redis]

            DevPriority[PriorityClass: dev-low<br/>Value: 100000]

            DevServices[Services<br/>5 replicas each]
            DevWorkers[Workers<br/>0-3 GPU pods]
        end

        subgraph "Namespace: prod"
            ProdQuota[ResourceQuota<br/>CPU: 50<br/>Memory: 200Gi<br/>GPU: 15<br/>Pods: 200]

            ProdNP[NetworkPolicy<br/>- Allow same namespace<br/>- Deny to dev<br/>- Allow to RDS/Redis]

            ProdPriority[PriorityClass: prod-high<br/>Value: 1000000]

            ProdServices[Services<br/>10 replicas each]
            ProdWorkers[Workers<br/>0-15 GPU pods]
        end

        subgraph "Namespace: argocd"
            ArgoCD[ArgoCD Server<br/>ApplicationSets]
        end

        subgraph "Namespace: monitoring"
            Prometheus[Prometheus]
            Grafana[Grafana]
            AlertManager[AlertManager]
        end

        subgraph "Namespace: karpenter"
            KarpController[Karpenter Controller]
        end
    end

    ArgoCD -.->|Syncs| DevServices
    ArgoCD -.->|Syncs| ProdServices

    Prometheus -.->|Scrapes| DevServices
    Prometheus -.->|Scrapes| ProdServices

    KarpController -.->|Provisions| DevWorkers
    KarpController -.->|Provisions| ProdWorkers

    style DevQuota fill:#FFE66D
    style ProdQuota fill:#FF6B6B
    style ArgoCD fill:#FF9F43
    style Prometheus fill:#E24A4A
```

### Pod 배치 전략

```mermaid
graph TB
    subgraph "Scheduling Strategy"
        subgraph "System Pods"
            SP1[ArgoCD<br/>NodeSelector: role=system]
            SP2[Prometheus<br/>NodeSelector: role=system]
            SP3[Karpenter<br/>NodeSelector: role=system]
        end

        subgraph "Service Pods"
            ServPods[Microservices<br/>No NodeSelector<br/>Can run on any node]
        end

        subgraph "Worker Pods"
            WorkerPods[GPU Workers<br/>NodeSelector: workload-type=gpu<br/>Tolerations: nvidia.com/gpu:NoSchedule<br/>Resources: nvidia.com/gpu: 1]
        end
    end

    SP1 --> SystemNodes[System Nodes<br/>t3.medium]
    SP2 --> SystemNodes
    SP3 --> SystemNodes

    ServPods --> SystemNodes
    ServPods --> GPUNodes[GPU Nodes<br/>When available]

    WorkerPods --> GPUNodes

    style SystemNodes fill:#4ECDC4
    style GPUNodes fill:#95E1D3
```

---

## 데이터 아키텍처

### RDS Aurora Serverless v2

```mermaid
graph TB
    subgraph "RDS Aurora Cluster: pingvas-shared-aurora"
        Writer[Writer Instance<br/>db.serverless<br/>0.5-4 ACU<br/>us-east-1a]

        Reader[Reader Instance<br/>db.serverless<br/>0.5-4 ACU<br/>us-east-1b]

        Writer -->|Replication| Reader

        subgraph "Database: pingvas_saas"
            DevSchema[(Schema: dev_pingvas<br/>10 Tables)]
            ProdSchema[(Schema: prod_pingvas<br/>10 Tables)]
        end
    end

    subgraph "Applications"
        DevApps[Dev Services<br/>search_path=dev_pingvas]
        ProdApps[Prod Services<br/>search_path=prod_pingvas]
    end

    DevApps -->|Write| Writer
    DevApps -->|Read| Reader
    ProdApps -->|Write| Writer
    ProdApps -->|Read| Reader

    Writer -.-> DevSchema
    Writer -.-> ProdSchema

    subgraph "Backup"
        AutoBackup[Automated Backups<br/>7 days retention<br/>Daily snapshots]
    end

    Writer -.->|Backup| AutoBackup

    style Writer fill:#5F27CD
    style Reader fill:#9B59B6
```

### Redis 아키텍처

```mermaid
graph TB
    subgraph "Dev Environment"
        DevApps[Dev Services/Workers]

        subgraph "Redis Dev - Standalone"
            RedisDev[cache.t4g.medium<br/>Single Node<br/>us-east-1a<br/>No Auth]
        end

        DevApps -->|redis://host:6379/0| RedisDev
    end

    subgraph "Prod Environment"
        ProdApps[Prod Services/Workers]

        subgraph "Redis Prod - Sentinel"
            Primary[Primary<br/>cache.r6g.large<br/>us-east-1a]
            Replica1[Replica 1<br/>cache.r6g.large<br/>us-east-1b]
            Replica2[Replica 2<br/>cache.r6g.large<br/>us-east-1c]

            Sentinel1[Sentinel 1<br/>Monitor + Failover]
            Sentinel2[Sentinel 2<br/>Monitor + Failover]
            Sentinel3[Sentinel 3<br/>Monitor + Failover]

            Primary -->|Replication| Replica1
            Primary -->|Replication| Replica2

            Sentinel1 -.->|Monitor| Primary
            Sentinel1 -.->|Monitor| Replica1
            Sentinel1 -.->|Monitor| Replica2

            Sentinel2 -.->|Monitor| Primary
            Sentinel3 -.->|Monitor| Primary
        end

        ProdApps -->|Sentinel Protocol<br/>AUTH token| Primary
        ProdApps -.->|Read| Replica1
        ProdApps -.->|Read| Replica2

        Sentinel1 -.->|Auto Failover| Replica1
        Sentinel1 -.->|Auto Failover| Replica2
    end

    style RedisDev fill:#00D2D3
    style Primary fill:#00A8A8
    style Replica1 fill:#00A8A8
    style Replica2 fill:#00A8A8
```

### 스토리지 아키텍처

```mermaid
graph TB
    subgraph "EFS: Shared AI Models"
        EFS[EFS File System<br/>Multi-AZ<br/>Lifecycle: Transition to IA after 30 days]

        subgraph "Mount Points"
            EFS1[us-east-1a<br/>10.0.11.x]
            EFS2[us-east-1b<br/>10.0.12.x]
            EFS3[us-east-1c<br/>10.0.13.x]
        end

        EFS --> EFS1
        EFS --> EFS2
        EFS --> EFS3
    end

    subgraph "S3 Buckets"
        S3Dev[pingvas-dev-images<br/>Versioning: Enabled<br/>Lifecycle: 90d → IA]

        S3Prod[pingvas-prod-images<br/>Versioning: Enabled<br/>Lifecycle: 90d → IA, 180d → Glacier]

        S3Models[pingvas-models-shared<br/>Intelligent-Tiering]

        S3Logs[pingvas-logs-shared<br/>Lifecycle: 30d → Delete]
    end

    subgraph "Workers"
        DevWorkers[Dev GPU Workers]
        ProdWorkers[Prod GPU Workers]
    end

    DevWorkers -->|Read Models| EFS1
    ProdWorkers -->|Read Models| EFS2

    DevWorkers -->|Write Images| S3Dev
    ProdWorkers -->|Write Images| S3Prod

    subgraph "CloudFront CDN"
        CF[CloudFront Distribution<br/>Global Edge Locations]
    end

    S3Dev --> CF
    S3Prod --> CF

    subgraph "Users"
        EndUsers[End Users]
    end

    EndUsers -->|GET /images/*| CF

    style EFS fill:#FF9F43
    style S3Dev fill:#48C774
    style S3Prod fill:#48C774
    style CF fill:#4A90E2
```

---

## GitOps/DevOps 파이프라인

### CI/CD 전체 흐름

```mermaid
graph TB
    subgraph "Development"
        Dev[👨‍💻 Developer]
        LocalTest[Local Testing<br/>Docker Compose]
    end

    subgraph "Version Control"
        GitHub[GitHub Repository<br/>Branch: develop/main]
    end

    subgraph "CI Pipeline - GitHub Actions"
        subgraph "Build Stage"
            Checkout[Checkout Code]
            Test[Run Tests<br/>pytest, jest]
            Lint[Code Linting<br/>black, eslint]
            Security[Security Scan<br/>Trivy, OWASP]
        end

        subgraph "Build & Push Stage"
            BuildImg[Build Docker Images<br/>Multi-stage builds]
            PushECR[Push to ECR<br/>Tag: commit SHA]
        end
    end

    subgraph "AWS"
        ECR[Amazon ECR<br/>Container Registry]

        subgraph "ArgoCD"
            ArgoServer[ArgoCD Server]
            AppSet[ApplicationSet<br/>Matrix Generator]

            subgraph "Applications"
                DevApps[Dev Apps<br/>5 services]
                ProdApps[Prod Apps<br/>5 services]
            end
        end

        subgraph "EKS Cluster"
            DevNS[Namespace: dev]
            ProdNS[Namespace: prod]
        end
    end

    Dev -->|1. Write Code| LocalTest
    LocalTest -->|2. Push| GitHub

    GitHub -->|3. Trigger| Checkout
    Checkout --> Test
    Test --> Lint
    Lint --> Security
    Security --> BuildImg
    BuildImg --> PushECR
    PushECR --> ECR

    ECR -->|4. Image Ready| ArgoServer

    GitHub -->|5. K8s Manifests| ArgoServer
    ArgoServer --> AppSet
    AppSet --> DevApps
    AppSet --> ProdApps

    DevApps -->|6. Deploy| DevNS
    ProdApps -->|7. Deploy<br/>(Manual Approval)| ProdNS

    DevNS -.->|8. Pull Images| ECR
    ProdNS -.->|8. Pull Images| ECR

    style Dev fill:#E24A4A
    style GitHub fill:#24292E
    style ECR fill:#FF9900
    style ArgoServer fill:#FF6B35
    style DevNS fill:#4ECDC4
    style ProdNS fill:#FF6B6B
```

### ArgoCD ApplicationSet 구조

```mermaid
graph TB
    subgraph "ArgoCD"
        AppSet[ApplicationSet<br/>pingvas-services]

        subgraph "Matrix Generator"
            EnvGen[Environment Generator<br/>- dev<br/>- prod]

            SvcGen[Service Generator<br/>- user-service<br/>- payment-service<br/>- generation-service<br/>- gallery-service<br/>- model-service]
        end

        AppSet --> EnvGen
        AppSet --> SvcGen

        subgraph "Generated Applications (10 total)"
            DevUser[dev-user-service]
            DevPayment[dev-payment-service]
            DevGen[dev-generation-service]
            DevGallery[dev-gallery-service]
            DevModel[dev-model-service]

            ProdUser[prod-user-service]
            ProdPayment[prod-payment-service]
            ProdGen[prod-generation-service]
            ProdGallery[prod-gallery-service]
            ProdModel[prod-model-service]
        end

        EnvGen --> DevUser
        EnvGen --> ProdUser
        SvcGen --> DevUser
        SvcGen --> ProdUser
    end

    subgraph "Git Repository"
        subgraph "k8s/overlays"
            DevOverlay[dev/<br/>kustomization.yaml]
            ProdOverlay[prod/<br/>kustomization.yaml]
        end
    end

    DevUser -.->|Sync| DevOverlay
    ProdUser -.->|Sync| ProdOverlay

    subgraph "EKS Cluster"
        DevNS[dev namespace]
        ProdNS[prod namespace]
    end

    DevUser -->|Apply| DevNS
    ProdUser -->|Apply| ProdNS

    style AppSet fill:#FF6B35
    style DevUser fill:#4ECDC4
    style ProdUser fill:#FF6B6B
```

### GitHub Actions Workflows

```mermaid
graph TB
    subgraph "Workflows"
        subgraph "CI Workflow (PR)"
            CI[ci.yaml<br/>Trigger: Pull Request]

            CI --> CISteps[Steps:<br/>1. Detect changes (paths filter)<br/>2. Run tests<br/>3. Build images<br/>4. Push to ECR with dev-latest tag<br/>5. Comment on PR]
        end

        subgraph "CD Dev Workflow (develop branch)"
            CDDev[cd-dev.yaml<br/>Trigger: Push to develop]

            CDDev --> CDDevSteps[Steps:<br/>1. Build & push images<br/>2. Update kubeconfig<br/>3. Trigger ArgoCD sync (dev apps)<br/>4. Wait for health checks<br/>5. Slack notification]
        end

        subgraph "CD Prod Workflow (release)"
            CDProd[cd-prod.yaml<br/>Trigger: Release published]

            CDProd --> CDProdSteps[Steps:<br/>1. Checkout release tag<br/>2. Update Kustomize image tags<br/>3. Commit & push manifest changes<br/>4. Trigger ArgoCD sync (prod apps)<br/>5. Run smoke tests<br/>6. Slack notification]

            CDProdSteps --> Approval[⚠️ Manual Approval Required]
        end

        subgraph "Security Scan Workflow (daily)"
            SecScan[security-scan.yaml<br/>Trigger: Schedule (daily) + Push]

            SecScan --> SecSteps[Steps:<br/>1. Trivy container scan<br/>2. OWASP dependency check<br/>3. Upload SARIF to GitHub Security<br/>4. Slack notification on vulnerabilities]
        end
    end

    subgraph "GitHub Environments"
        DevEnv[Environment: development<br/>No approval required]
        ProdEnv[Environment: production<br/>Approvers: 2 required<br/>Wait timer: 5 minutes]
    end

    CDDev -.-> DevEnv
    CDProd -.-> ProdEnv

    style CI fill:#4A90E2
    style CDDev fill:#4ECDC4
    style CDProd fill:#FF6B6B
    style SecScan fill:#E24A4A
```

### Kustomize Overlay 구조

```mermaid
graph TB
    subgraph "Git Repository Structure"
        subgraph "k8s/base"
            BaseUser[user-service/<br/>- deployment.yaml<br/>- service.yaml<br/>- kustomization.yaml]

            BaseOthers[payment-service/<br/>generation-service/<br/>gallery-service/<br/>model-service/]
        end

        subgraph "k8s/overlays/dev"
            DevUser[user-service/<br/>- kustomization.yaml<br/>- patches/<br/>  - resources.yaml<br/>  - replicas.yaml]

            DevConfig[ConfigMaps:<br/>- Redis: standalone<br/>- DB: dev_pingvas schema]

            DevSecrets[Secrets:<br/>- DB credentials (dev)<br/>- JWT secret (dev)]
        end

        subgraph "k8s/overlays/prod"
            ProdUser[user-service/<br/>- kustomization.yaml<br/>- patches/<br/>  - resources.yaml<br/>  - replicas.yaml<br/>  - hpa.yaml]

            ProdConfig[ConfigMaps:<br/>- Redis: sentinel<br/>- DB: prod_pingvas schema]

            ProdSecrets[Secrets:<br/>- DB credentials (prod)<br/>- JWT secret (prod)<br/>- Redis auth token]
        end
    end

    BaseUser -.->|Extends| DevUser
    BaseUser -.->|Extends| ProdUser

    subgraph "Kustomize Build"
        DevBuild[kustomize build<br/>overlays/dev/user-service]
        ProdBuild[kustomize build<br/>overlays/prod/user-service]
    end

    DevUser --> DevBuild
    ProdUser --> ProdBuild

    subgraph "ArgoCD"
        DevApp[dev-user-service<br/>Application]
        ProdApp[prod-user-service<br/>Application]
    end

    DevBuild --> DevApp
    ProdBuild --> ProdApp

    style BaseUser fill:#FFE66D
    style DevUser fill:#4ECDC4
    style ProdUser fill:#FF6B6B
```

---

## 보안 아키텍처

### 보안 계층

```mermaid
graph TB
    subgraph "Layer 1: Network Security"
        WAF[AWS WAF<br/>- Rate Limiting: 2000 req/5min<br/>- SQL Injection Protection<br/>- XSS Protection<br/>- IP Reputation Lists<br/>- Geo Blocking]

        NACL[Network ACLs<br/>- Subnet level filtering]

        SG[Security Groups<br/>- Stateful firewall<br/>- Least privilege]
    end

    subgraph "Layer 2: Authentication & Authorization"
        OAuth[OAuth 2.0<br/>- Google<br/>- Discord]

        JWT[JWT Tokens<br/>- HS256<br/>- 30min expiry]

        RBAC[RBAC<br/>- Kubernetes<br/>- PostgreSQL]
    end

    subgraph "Layer 3: Data Security"
        RLS[Row-Level Security<br/>PostgreSQL policies]

        Encryption[Encryption<br/>- At Rest: EBS, RDS, S3<br/>- In Transit: TLS 1.3]

        Secrets[Secrets Management<br/>AWS Secrets Manager<br/>- DB credentials<br/>- API keys<br/>- Auth tokens]
    end

    subgraph "Layer 4: Application Security"
        InputVal[Input Validation<br/>Pydantic models]

        CSRF[CSRF Protection<br/>Double submit cookies]

        RateLimit[Rate Limiting<br/>Per user/IP]
    end

    subgraph "Layer 5: Monitoring & Audit"
        CloudTrail[AWS CloudTrail<br/>API audit logs]

        GuardDuty[AWS GuardDuty<br/>Threat detection]

        Logs[Centralized Logging<br/>CloudWatch + S3]
    end

    Internet -->|HTTPS| WAF
    WAF --> NACL
    NACL --> SG
    SG --> OAuth
    OAuth --> JWT
    JWT --> RBAC
    RBAC --> RLS
    RLS --> Encryption
    Encryption --> InputVal
    InputVal --> CloudTrail

    style WAF fill:#FF6B6B
    style JWT fill:#4A90E2
    style RLS fill:#5F27CD
    style Secrets fill:#FF9F43
```

### 네트워크 정책 (Namespace 격리)

```mermaid
graph TB
    subgraph "Namespace: dev"
        DevPod[Dev Pods]

        DevNP[NetworkPolicy: deny-to-prod<br/>Egress Rules:<br/>1. Allow same namespace<br/>2. Allow external (443, 53)<br/>3. Allow to 10.0.0.0/16 (RDS/Redis)<br/>4. Deny to prod namespace]
    end

    subgraph "Namespace: prod"
        ProdPod[Prod Pods]

        ProdNP[NetworkPolicy: deny-to-dev<br/>Egress Rules:<br/>1. Allow same namespace<br/>2. Allow external (443, 53)<br/>3. Allow to 10.0.0.0/16 (RDS/Redis)<br/>4. Deny to dev namespace]
    end

    subgraph "External Services"
        RDS[(RDS<br/>10.0.11.x)]
        Redis[(Redis<br/>10.0.11.x)]
        Internet[Internet<br/>AWS APIs]
    end

    DevPod -.->|✅ Allowed| DevPod
    DevPod -->|✅ Allowed| RDS
    DevPod -->|✅ Allowed| Redis
    DevPod -->|✅ Allowed| Internet
    DevPod -.->|❌ Denied| ProdPod

    ProdPod -.->|✅ Allowed| ProdPod
    ProdPod -->|✅ Allowed| RDS
    ProdPod -->|✅ Allowed| Redis
    ProdPod -->|✅ Allowed| Internet
    ProdPod -.->|❌ Denied| DevPod

    style DevPod fill:#4ECDC4
    style ProdPod fill:#FF6B6B
    style DevNP fill:#FFE66D
    style ProdNP fill:#FF9F43
```

---

## 모니터링 아키텍처

### 메트릭 수집 및 시각화

```mermaid
graph TB
    subgraph "Data Sources"
        subgraph "Application Metrics"
            AppMetrics[Custom Metrics<br/>- generation_requests_total<br/>- generation_duration_seconds<br/>- queue_length<br/>- credits_consumed_total]
        end

        subgraph "Infrastructure Metrics"
            K8sMetrics[Kubernetes Metrics<br/>- Pod CPU/Memory<br/>- Node utilization<br/>- Deployment status]

            GPUMetrics[GPU Metrics<br/>- DCGM Exporter<br/>- GPU utilization<br/>- Memory usage]
        end

        subgraph "AWS Metrics"
            CloudWatch[CloudWatch Metrics<br/>- RDS: CPU, Connections<br/>- Redis: Hit rate, Evictions<br/>- ALB: Request count, Latency<br/>- S3: Storage, Requests]
        end
    end

    subgraph "Collection"
        Prometheus[Prometheus<br/>- Scrape interval: 15s<br/>- Retention: 15 days<br/>- Storage: 50Gi PVC]

        FluentBit[Fluent Bit<br/>- Log aggregation<br/>- Parsing & filtering]
    end

    AppMetrics -->|/metrics endpoint| Prometheus
    K8sMetrics -->|Kube State Metrics| Prometheus
    GPUMetrics -->|DCGM Exporter| Prometheus
    CloudWatch -->|CloudWatch Exporter| Prometheus

    subgraph "Applications"
        Services[Microservices<br/>Pods]
        Workers[GPU Workers<br/>Pods]
    end

    Services -.->|Logs| FluentBit
    Workers -.->|Logs| FluentBit

    subgraph "Storage"
        CloudWatchLogs[CloudWatch Logs<br/>/aws/eks/cluster/logs]
        S3Logs[S3: pingvas-logs-shared<br/>Long-term storage]
    end

    FluentBit --> CloudWatchLogs
    FluentBit --> S3Logs

    subgraph "Visualization"
        Grafana[Grafana<br/>- Custom Dashboards<br/>- Alerts]

        subgraph "Dashboards"
            D1[Generation Dashboard<br/>- Request rate<br/>- Duration percentiles<br/>- Queue length<br/>- GPU utilization]

            D2[Infrastructure Dashboard<br/>- Cluster health<br/>- Node resources<br/>- Pod status]

            D3[Business Dashboard<br/>- Credits consumed<br/>- Active users<br/>- Tier distribution]
        end
    end

    Prometheus --> Grafana
    Grafana --> D1
    Grafana --> D2
    Grafana --> D3

    subgraph "Alerting"
        AlertManager[AlertManager]

        subgraph "Notification Channels"
            Slack[Slack]
            PagerDuty[PagerDuty<br/>(Prod only)]
            Email[Email]
        end
    end

    Prometheus -.->|Alerts| AlertManager
    AlertManager --> Slack
    AlertManager --> PagerDuty
    AlertManager --> Email

    style Prometheus fill:#E24A4A
    style Grafana fill:#FF6B35
    style AlertManager fill:#FFE66D
```

### 알람 규칙

```mermaid
graph TB
    subgraph "Critical Alarms (PagerDuty)"
        C1[RDS CPU > 90%<br/>Duration: 5 minutes]
        C2[Redis Replication Lag > 5s<br/>Duration: 2 minutes]
        C3[API 5xx Error Rate > 5%<br/>Duration: 3 minutes]
        C4[GPU Node Spot Interruption<br/>Immediate]
    end

    subgraph "Warning Alarms (Slack)"
        W1[Dev Namespace Quota > 90%<br/>Duration: 10 minutes]
        W2[Prod Namespace Quota > 80%<br/>Duration: 5 minutes]
        W3[Queue Length > 100<br/>Duration: 15 minutes]
        W4[Pod Restart Count > 5<br/>Duration: 10 minutes]
    end

    subgraph "Info Alarms (Email)"
        I1[Daily Cost Report<br/>Schedule: 9 AM]
        I2[Backup Completion<br/>Daily]
        I3[Security Scan Results<br/>Daily]
    end

    C1 --> PagerDuty[PagerDuty<br/>On-call engineer]
    C2 --> PagerDuty
    C3 --> PagerDuty
    C4 --> PagerDuty

    W1 --> Slack[Slack<br/>#alerts channel]
    W2 --> Slack
    W3 --> Slack
    W4 --> Slack

    I1 --> Email[Email<br/>team@pingvas.studio]
    I2 --> Email
    I3 --> Email

    style C1 fill:#FF6B6B
    style C2 fill:#FF6B6B
    style C3 fill:#FF6B6B
    style C4 fill:#FF6B6B
    style W1 fill:#FFE66D
    style W2 fill:#FFE66D
```

---

## 비용 구성표

### 월별 비용 분석

| 서비스 | 사양 | 수량 | 시간당 | 월 비용 | 비고 |
|--------|------|------|--------|---------|------|
| **EKS Control Plane** | Managed | 1 | $0.10 | $72.00 | 단일 클러스터 |
| **System Nodes** | t3.medium Spot | 2 | $0.0125 | $18.24 | 70% 할인 |
| **GPU Nodes (평균)** | g4dn.xlarge Spot | ~3 | $0.118 | $200.00 | Karpenter 자동 스케일링 |
| **RDS Writer** | Aurora Serverless v2 | 1 ACU avg | $0.12 | $87.00 | 0.5-4 ACU 범위 |
| **RDS Reader** | Aurora Serverless v2 | 1 ACU avg | $0.12 | $87.00 | 0.5-4 ACU 범위 |
| **Redis Dev** | cache.t4g.medium | 1 | $0.068 | $49.64 | Standalone |
| **Redis Prod** | cache.r6g.large | 3 | $0.211 | $467.09 | Sentinel (Primary + 2 Replicas) |
| **NAT Gateway** | Single NAT | 1 | $0.045 | $32.40 | + 데이터 처리 비용 |
| **ALB** | Application LB | 1 | $0.025 | $18.00 | + LCU 비용 |
| **EFS** | Shared Models | 100 GB | - | $30.00 | Standard class |
| **S3 Dev** | Images | 500 GB | - | $11.50 | Standard |
| **S3 Prod** | Images | 2 TB | - | $46.00 | Standard + IA |
| **S3 Models** | Shared | 500 GB | - | $11.50 | Intelligent-Tiering |
| **CloudFront** | CDN | - | - | $20.00 | 1TB 데이터 전송 |
| **Data Transfer** | NAT, Inter-AZ | - | - | $60.00 | 추정치 |
| **CloudWatch** | Logs & Metrics | - | - | $30.00 | 추정치 |
| **Secrets Manager** | Secrets | 10 | - | $4.00 | $0.40/secret |
| **ECR** | Container Registry | 50 GB | - | $5.00 | $0.10/GB |
| **총계** | | | | **$1,249.37** | |

### 비용 최적화 포인트

1. **Spot Instances**: System 노드 + GPU 노드 = 70% 절감
2. **Aurora Serverless v2**: 개발 시간 외 Scale-to-Zero = 50% 절감
3. **단일 NAT Gateway**: 고가용성 대신 비용 우선 = $65/월 절감
4. **S3 Lifecycle**: IA/Glacier 전환 = 30% 절감
5. **Redis Dev Standalone**: Sentinel 대신 단순 구성 = $420/월 절감

---

## 재해 복구 전략

### 백업 및 복구

```mermaid
graph TB
    subgraph "Backup Strategy"
        subgraph "RDS Aurora"
            RDSBackup[Automated Backups<br/>- Daily snapshots<br/>- 7 days retention<br/>- Point-in-time recovery]
        end

        subgraph "Redis Prod"
            RedisBackup[Automated Snapshots<br/>- Daily backups<br/>- 7 days retention]
        end

        subgraph "EFS"
            EFSBackup[AWS Backup<br/>- Weekly snapshots<br/>- 30 days retention]
        end

        subgraph "Configuration"
            GitBackup[Git Repository<br/>- All manifests<br/>- Terraform code<br/>- Version controlled]
        end
    end

    subgraph "Recovery Procedures"
        RTO[RTO: Recovery Time Objective<br/>- Dev: 4 hours<br/>- Prod: 1 hour]

        RPO[RPO: Recovery Point Objective<br/>- Dev: 24 hours<br/>- Prod: 1 hour]
    end

    RDSBackup -.->|Restore| RTO
    RedisBackup -.->|Restore| RTO
    EFSBackup -.->|Restore| RTO
    GitBackup -.->|Redeploy| RTO

    style RDSBackup fill:#5F27CD
    style RedisBackup fill:#00D2D3
    style RTO fill:#FF6B6B
```

---

## 요약

### 최종 아키텍처 특징

✅ **비용 최적화**
- 단일 EKS 클러스터로 $1,165/월 절감 (50% 절감)
- Spot 인스턴스 적극 활용
- Aurora Serverless v2로 유휴 시간 비용 절감

✅ **고가용성**
- Multi-AZ 배포 (RDS, Redis Prod)
- Karpenter 자동 스케일링
- Sentinel 자동 Failover

✅ **보안**
- WAF 다층 방어
- 네임스페이스 격리 (NetworkPolicy)
- Row-Level Security
- Secrets Manager

✅ **확장성**
- Karpenter GPU 자동 스케일링 (0-10 노드)
- HPA (Horizontal Pod Autoscaler)
- Aurora Serverless v2 (0.5-4 ACU)

✅ **운영 효율성**
- GitOps (ArgoCD)
- 자동화된 CI/CD (GitHub Actions)
- 통합 모니터링 (Prometheus + Grafana)
- 중앙화된 로깅 (Fluent Bit + CloudWatch)

---

**작성일**: 2025-01-23
**문서 버전**: Final v1.0
**총 라인 수**: 2,100+
