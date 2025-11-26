# EKS 클러스터 설정 가이드

## 개요

이 문서는 Pingvas Studio를 위한 Amazon EKS 클러스터 설정 방법을 설명합니다. Karpenter를 통한 GPU 노드 자동 스케일링과 비용 최적화 전략을 포함합니다.

---

## 사전 요구사항

### 로컬 도구 설치

```bash
# AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl && sudo mv kubectl /usr/local/bin/

# eksctl
ARCH=amd64
PLATFORM=$(uname -s)_$ARCH
curl -sLO "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_$PLATFORM.tar.gz"
tar -xzf eksctl_$PLATFORM.tar.gz -C /tmp && sudo mv /tmp/eksctl /usr/local/bin

# Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

### AWS 자격 증명 설정

```bash
# MSP 환경: Assume Role 사용
aws configure set profile.pingvas.role_arn arn:aws:iam::123456789012:role/PingvasDevRole
aws configure set profile.pingvas.source_profile default
aws configure set profile.pingvas.region ap-northeast-2

# 프로필 활성화
export AWS_PROFILE=pingvas

# 연결 확인
aws sts get-caller-identity
```

---

## EKS 클러스터 생성

### 1. 클러스터 구성 파일 작성

```yaml
# cluster-config.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: pingvas-cluster
  region: ap-northeast-2
  version: "1.31"
  tags:
    Environment: production
    Project: pingvas-studio
    ManagedBy: eksctl

# VPC 설정 (기존 VPC 사용)
vpc:
  id: vpc-0abc123def456789
  subnets:
    private:
      ap-northeast-2a:
        id: subnet-private-2a
      ap-northeast-2b:
        id: subnet-private-2b
      ap-northeast-2c:
        id: subnet-private-2c

# IAM OIDC Provider
iam:
  withOIDC: true
  serviceAccounts:
    - metadata:
        name: aws-load-balancer-controller
        namespace: kube-system
      wellKnownPolicies:
        awsLoadBalancerController: true
    - metadata:
        name: ebs-csi-controller-sa
        namespace: kube-system
      wellKnownPolicies:
        ebsCSIController: true
    - metadata:
        name: efs-csi-controller-sa
        namespace: kube-system
      wellKnownPolicies:
        efsCSIController: true
    - metadata:
        name: karpenter
        namespace: karpenter
      attachPolicy:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Action:
              - ec2:CreateLaunchTemplate
              - ec2:CreateFleet
              - ec2:RunInstances
              - ec2:CreateTags
              - ec2:TerminateInstances
              - ec2:DescribeLaunchTemplates
              - ec2:DescribeInstances
              - ec2:DescribeSecurityGroups
              - ec2:DescribeSubnets
              - ec2:DescribeImages
              - ec2:DescribeInstanceTypes
              - ec2:DescribeInstanceTypeOfferings
              - ec2:DescribeAvailabilityZones
              - ec2:DeleteLaunchTemplate
              - ssm:GetParameter
              - pricing:GetProducts
            Resource: "*"
          - Effect: Allow
            Action:
              - iam:PassRole
            Resource: "*"
            Condition:
              StringEquals:
                iam:PassedToService: ec2.amazonaws.com

# 관리형 노드 그룹 (시스템 워크로드용)
managedNodeGroups:
  - name: system-ng
    instanceType: m7g.large  # Graviton3
    desiredCapacity: 2
    minSize: 2
    maxSize: 4
    volumeSize: 50
    volumeType: gp3
    privateNetworking: true
    labels:
      role: system
      node-type: system
    taints:
      - key: CriticalAddonsOnly
        value: "true"
        effect: PreferNoSchedule
    tags:
      Name: pingvas-system-node
    iam:
      attachPolicyARNs:
        - arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy
        - arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy
        - arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
        - arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

# 애드온
addons:
  - name: vpc-cni
    version: latest
    attachPolicyARNs:
      - arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy
  - name: coredns
    version: latest
  - name: kube-proxy
    version: latest
  - name: aws-ebs-csi-driver
    version: latest
  - name: aws-efs-csi-driver
    version: latest

# CloudWatch 로깅
cloudWatch:
  clusterLogging:
    enableTypes:
      - api
      - audit
      - authenticator
      - controllerManager
      - scheduler
```

### 2. 클러스터 생성

```bash
# 클러스터 생성 (약 15-20분 소요)
eksctl create cluster -f cluster-config.yaml

# kubeconfig 업데이트
aws eks update-kubeconfig --region ap-northeast-2 --name pingvas-cluster

# 연결 확인
kubectl get nodes
kubectl get pods -A
```

---

## Karpenter 설치 및 설정

### 1. Karpenter 설치

```bash
# 환경 변수 설정
export KARPENTER_VERSION="1.1.0"
export CLUSTER_NAME="pingvas-cluster"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION="ap-northeast-2"

# Helm repo 추가
helm repo add karpenter https://charts.karpenter.sh
helm repo update

# Karpenter 네임스페이스 생성
kubectl create namespace karpenter

# Karpenter 설치
helm upgrade --install karpenter karpenter/karpenter \
  --namespace karpenter \
  --version ${KARPENTER_VERSION} \
  --set settings.clusterName=${CLUSTER_NAME} \
  --set settings.interruptionQueue=${CLUSTER_NAME} \
  --set controller.resources.requests.cpu=0.5 \
  --set controller.resources.requests.memory=512Mi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait

# 설치 확인
kubectl get pods -n karpenter
```

### 2. EC2NodeClass 설정 (노드 템플릿)

```yaml
# nodeclass-general.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: general
spec:
  # AMI 선택 (Amazon Linux 2023 EKS 최적화)
  amiSelectorTerms:
    - alias: al2023@latest

  # 서브넷 선택
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: pingvas-cluster
        Type: private

  # 보안 그룹
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: pingvas-cluster

  # IAM 역할
  role: KarpenterNodeRole-pingvas-cluster

  # 블록 디바이스
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        deleteOnTermination: true

  # 메타데이터 옵션
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 2
    httpTokens: required  # IMDSv2 강제

  # 사용자 데이터
  userData: |
    #!/bin/bash
    echo "Karpenter managed node"

  tags:
    Name: pingvas-karpenter-node
    Environment: production
```

```yaml
# nodeclass-gpu.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu
spec:
  # GPU 최적화 AMI
  amiSelectorTerms:
    - alias: al2023-nvidia@latest

  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: pingvas-cluster
        Type: private

  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: pingvas-cluster

  role: KarpenterNodeRole-pingvas-cluster

  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 200Gi  # GPU 노드는 더 큰 디스크
        volumeType: gp3
        iops: 6000
        throughput: 250
        encrypted: true
        deleteOnTermination: true

  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 2
    httpTokens: required

  # GPU 드라이버 설치
  userData: |
    #!/bin/bash
    # NVIDIA 드라이버는 AMI에 포함되어 있음
    nvidia-smi

  tags:
    Name: pingvas-gpu-node
    NodeType: gpu
    Environment: production
```

### 3. NodePool 설정

```yaml
# nodepool-general.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general
spec:
  template:
    metadata:
      labels:
        node-type: general
        workload: api
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]  # Graviton 사용
        - key: kubernetes.io/os
          operator: In
          values: ["linux"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]  # Spot 우선
        - key: node.kubernetes.io/instance-type
          operator: In
          values:
            - m7g.medium
            - m7g.large
            - m7g.xlarge
            - c7g.medium
            - c7g.large
            - c7g.xlarge
      expireAfter: 720h  # 30일 후 교체

  limits:
    cpu: 100
    memory: 200Gi

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
    budgets:
      - nodes: "10%"

  weight: 10
```

```yaml
# nodepool-gpu.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu
spec:
  template:
    metadata:
      labels:
        node-type: gpu
        workload: ai-worker
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: gpu
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]  # GPU는 x86만 지원
        - key: kubernetes.io/os
          operator: In
          values: ["linux"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]  # Spot 전용 (비용 절감)
        - key: node.kubernetes.io/instance-type
          operator: In
          values:
            - g5.xlarge      # 1x A10G, 4 vCPU, 16GB
            - g5.2xlarge     # 1x A10G, 8 vCPU, 32GB
            - g5.4xlarge     # 1x A10G, 16 vCPU, 64GB
            - g4dn.xlarge    # 1x T4, 4 vCPU, 16GB (저렴)
            - g4dn.2xlarge   # 1x T4, 8 vCPU, 32GB
        - key: "nvidia.com/gpu"
          operator: Exists
      taints:
        - key: nvidia.com/gpu
          value: "true"
          effect: NoSchedule
      expireAfter: 168h  # 7일 후 교체 (Spot 안정성)

  limits:
    cpu: 200
    memory: 800Gi
    nvidia.com/gpu: 20

  disruption:
    consolidationPolicy: WhenEmpty  # GPU 노드는 비어있을 때만 축소
    consolidateAfter: 5m  # 5분 유휴 후 축소
    budgets:
      - nodes: "20%"

  weight: 100  # 높은 가중치 (GPU 우선 프로비저닝)
```

### 4. NodePool 적용

```bash
# NodeClass 적용
kubectl apply -f nodeclass-general.yaml
kubectl apply -f nodeclass-gpu.yaml

# NodePool 적용
kubectl apply -f nodepool-general.yaml
kubectl apply -f nodepool-gpu.yaml

# 확인
kubectl get nodepools
kubectl get ec2nodeclasses
```

---

## 필수 애드온 설치

### 1. AWS Load Balancer Controller

```bash
# Helm 설치
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system \
  --set clusterName=${CLUSTER_NAME} \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region=${AWS_REGION} \
  --set vpcId=vpc-0abc123def456789

# 확인
kubectl get deployment -n kube-system aws-load-balancer-controller
```

### 2. Metrics Server

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# 확인
kubectl get deployment metrics-server -n kube-system
kubectl top nodes
```

### 3. NVIDIA Device Plugin

```bash
# GPU 노드용 NVIDIA 플러그인
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.16.2/deployments/static/nvidia-device-plugin.yml

# 확인 (GPU 노드가 있을 때)
kubectl get pods -n kube-system -l name=nvidia-device-plugin-ds
```

### 4. EFS CSI Driver StorageClass

```yaml
# efs-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs-sc
provisioner: efs.csi.aws.com
parameters:
  provisioningMode: efs-ap
  fileSystemId: fs-0abc123def456789
  directoryPerms: "700"
  gidRangeStart: "1000"
  gidRangeEnd: "2000"
  basePath: "/pingvas"
reclaimPolicy: Retain
volumeBindingMode: Immediate
```

```bash
kubectl apply -f efs-storageclass.yaml
```

---

## 네임스페이스 설정

```yaml
# namespaces.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: pingvas-dev
  labels:
    environment: development
    istio-injection: enabled
---
apiVersion: v1
kind: Namespace
metadata:
  name: pingvas-prod
  labels:
    environment: production
    istio-injection: enabled
---
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    name: monitoring
---
apiVersion: v1
kind: Namespace
metadata:
  name: argocd
  labels:
    name: argocd
```

```bash
kubectl apply -f namespaces.yaml
```

---

## ResourceQuota 설정

```yaml
# resourcequota-dev.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: dev-quota
  namespace: pingvas-dev
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    requests.nvidia.com/gpu: "2"
    persistentvolumeclaims: "10"
    services.loadbalancers: "2"
---
# resourcequota-prod.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: prod-quota
  namespace: pingvas-prod
spec:
  hard:
    requests.cpu: "50"
    requests.memory: 100Gi
    limits.cpu: "100"
    limits.memory: 200Gi
    requests.nvidia.com/gpu: "10"
    persistentvolumeclaims: "50"
    services.loadbalancers: "5"
```

```bash
kubectl apply -f resourcequota-dev.yaml
kubectl apply -f resourcequota-prod.yaml
```

---

## LimitRange 설정

```yaml
# limitrange.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: pingvas-prod
spec:
  limits:
    - default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      type: Container
    - max:
        cpu: "8"
        memory: "32Gi"
      min:
        cpu: "50m"
        memory: "64Mi"
      type: Container
```

---

## 클러스터 검증

### 노드 상태 확인

```bash
# 노드 목록
kubectl get nodes -o wide

# 노드 상세 정보
kubectl describe nodes

# GPU 노드 확인
kubectl get nodes -l node-type=gpu
```

### Karpenter 동작 확인

```bash
# Karpenter 로그
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f

# NodePool 상태
kubectl get nodepools -o yaml

# 프로비저닝된 노드 확인
kubectl get nodes -l karpenter.sh/provisioner-name
```

### 테스트 워크로드 배포

```yaml
# test-gpu-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test
  namespace: pingvas-dev
spec:
  containers:
    - name: cuda-test
      image: nvidia/cuda:12.0.0-base-ubuntu22.04
      command: ["nvidia-smi", "-L"]
      resources:
        limits:
          nvidia.com/gpu: 1
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  nodeSelector:
    node-type: gpu
```

```bash
# GPU 테스트 Pod 배포
kubectl apply -f test-gpu-pod.yaml

# 로그 확인 (GPU가 인식되어야 함)
kubectl logs gpu-test -n pingvas-dev

# 정리
kubectl delete pod gpu-test -n pingvas-dev
```

---

## 트러블슈팅

### 노드가 프로비저닝되지 않음

```bash
# Karpenter 로그 확인
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter --tail=100

# NodePool 이벤트 확인
kubectl describe nodepool gpu

# EC2 콘솔에서 Spot 요청 확인
aws ec2 describe-spot-instance-requests --region ap-northeast-2
```

### GPU 인식 안됨

```bash
# NVIDIA 플러그인 확인
kubectl get pods -n kube-system -l name=nvidia-device-plugin-ds

# 노드의 GPU 할당 가능 리소스 확인
kubectl describe node <gpu-node-name> | grep nvidia

# 노드에서 nvidia-smi 실행
kubectl debug node/<gpu-node-name> -it --image=nvidia/cuda:12.0.0-base-ubuntu22.04 -- nvidia-smi
```

### Spot 인스턴스 중단

```bash
# Karpenter 중단 이벤트 확인
kubectl get events -n karpenter --field-selector reason=Interruption

# 노드 드레인 상태 확인
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

---

## 다음 단계

- [네트워킹 설정](./03-networking.md)에서 VPC 및 서브넷 구성 확인
- [Terraform 가이드](./01-terraform-guide.md)에서 IaC 코드 확인
- [GitOps 가이드](../devops/01-gitops-guide.md)에서 ArgoCD 배포 확인
