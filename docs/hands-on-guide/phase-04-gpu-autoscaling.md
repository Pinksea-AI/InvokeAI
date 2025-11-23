# Phase 4: GPU 오토스케일링

이 가이드는 Karpenter를 사용한 GPU 노드 동적 프로비저닝을 구현하는 과정을 다룹니다.

## 목차
1. [Karpenter 설치](#karpenter-설치)
2. [GPU NodePool 구성](#gpu-nodepool-구성)
3. [AI Worker Pod 배포](#ai-worker-pod-배포)
4. [Spot Interruption Handling](#spot-interruption-handling)
5. [HPA 설정](#hpa-설정)
6. [테스트 및 검증](#테스트-및-검증)

---

## Karpenter 설치

### 1. IAM 역할 생성

`infra/terraform/modules/karpenter/main.tf`:
```hcl
# Karpenter Controller IAM Role
resource "aws_iam_role" "karpenter_controller" {
  name = "${var.cluster_name}-karpenter-controller"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRoleWithWebIdentity"
      Effect = "Allow"
      Principal = {
        Federated = var.oidc_provider_arn
      }
      Condition = {
        StringEquals = {
          "${var.oidc_provider}:sub" = "system:serviceaccount:karpenter:karpenter"
          "${var.oidc_provider}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_policy" "karpenter_controller" {
  name = "${var.cluster_name}-karpenter-controller-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:CreateLaunchTemplate",
          "ec2:CreateFleet",
          "ec2:RunInstances",
          "ec2:CreateTags",
          "ec2:TerminateInstances",
          "ec2:DescribeInstances",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeInstanceTypeOfferings",
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribeSpotPriceHistory",
          "pricing:GetProducts",
          "ssm:GetParameter"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "karpenter_controller" {
  role       = aws_iam_role.karpenter_controller.name
  policy_arn = aws_iam_policy.karpenter_controller.arn
}

# Node Instance Profile
resource "aws_iam_role" "karpenter_node" {
  name = "${var.cluster_name}-karpenter-node"

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

resource "aws_iam_role_policy_attachment" "karpenter_node_policies" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  ])

  role       = aws_iam_role.karpenter_node.name
  policy_arn = each.value
}

resource "aws_iam_instance_profile" "karpenter_node" {
  name = "${var.cluster_name}-karpenter-node-profile"
  role = aws_iam_role.karpenter_node.name
}
```

**Terraform 적용**:
```bash
cd infra/terraform/environments/dev
terraform apply
```

---

### 2. Helm으로 Karpenter 설치

```bash
# Helm repo 추가
helm repo add karpenter https://charts.karpenter.sh
helm repo update

# 네임스페이스 생성
kubectl create namespace karpenter

# Karpenter 설치
export CLUSTER_NAME=dev-pingvas-eks
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export KARPENTER_VERSION=v0.32.0

helm install karpenter karpenter/karpenter \
  --namespace karpenter \
  --version ${KARPENTER_VERSION} \
  --set settings.clusterName=${CLUSTER_NAME} \
  --set settings.interruptionQueueName=${CLUSTER_NAME} \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::${AWS_ACCOUNT_ID}:role/${CLUSTER_NAME}-karpenter-controller \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --wait

# 확인
kubectl get pods -n karpenter
```

---

## GPU NodePool 구성

### 1. EC2NodeClass

`k8s/karpenter/ec2nodeclass.yaml`:
```yaml
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: gpu-spot
spec:
  amiFamily: AL2  # Amazon Linux 2
  role: dev-pingvas-eks-karpenter-node  # IAM Role

  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: dev-pingvas-eks

  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: dev-pingvas-eks

  # User Data (GPU 드라이버 설치)
  userData: |
    #!/bin/bash
    set -e

    # NVIDIA Driver 설치
    sudo yum install -y gcc kernel-devel-$(uname -r)

    distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
    curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.repo | \
      sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo

    sudo yum install -y nvidia-driver-latest-dkms
    sudo yum install -y nvidia-container-toolkit

    # NVIDIA Device Plugin 자동 발견을 위한 레이블
    echo "nvidia.com/gpu=true" >> /etc/eks/bootstrap.sh

    # Docker 재시작
    sudo systemctl restart docker

  tags:
    Name: karpenter-gpu-node
    Environment: dev
    ManagedBy: karpenter

  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        encrypted: true
        deleteOnTermination: true
```

---

### 2. NodePool (GPU Spot)

`k8s/karpenter/nodepool-gpu-spot.yaml`:
```yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: gpu-spot
spec:
  template:
    metadata:
      labels:
        workload-type: gpu
        instance-lifecycle: spot

    spec:
      nodeClassRef:
        name: gpu-spot

      requirements:
        # Instance Types (GPU)
        - key: node.kubernetes.io/instance-type
          operator: In
          values:
            - g4dn.xlarge    # 1x T4, 4 vCPUs, 16GB RAM
            - g4dn.2xlarge   # 1x T4, 8 vCPUs, 32GB RAM
            - g5.xlarge      # 1x A10G, 4 vCPUs, 16GB RAM
            - g5.2xlarge     # 1x A10G, 8 vCPUs, 32GB RAM

        # Capacity Type (Spot)
        - key: karpenter.sh/capacity-type
          operator: In
          values:
            - spot

        # Architecture
        - key: kubernetes.io/arch
          operator: In
          values:
            - amd64

        # Availability Zones
        - key: topology.kubernetes.io/zone
          operator: In
          values:
            - us-east-1a
            - us-east-1b
            - us-east-1c

      # Taints (GPU 전용)
      taints:
        - key: nvidia.com/gpu
          effect: NoSchedule

  # Limits
  limits:
    nvidia.com/gpu: "20"  # 최대 20개 GPU

  # Disruption (Scale Down)
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s  # 30초 후 스케일 다운

    # Budgets (스케일 다운 제한)
    budgets:
      - nodes: "10%"  # 한 번에 10%만 제거
        reasons:
          - Drifted
          - Empty
```

---

### 3. NodePool (On-Demand - Enterprise Tier)

`k8s/karpenter/nodepool-gpu-ondemand.yaml`:
```yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: gpu-ondemand-enterprise
spec:
  template:
    metadata:
      labels:
        workload-type: gpu
        instance-lifecycle: on-demand
        tier: enterprise

    spec:
      nodeClassRef:
        name: gpu-spot

      requirements:
        - key: node.kubernetes.io/instance-type
          operator: In
          values:
            - g5.4xlarge   # 1x A10G, 16 vCPUs, 64GB RAM
            - g5.8xlarge   # 1x A10G, 32 vCPUs, 128GB RAM

        - key: karpenter.sh/capacity-type
          operator: In
          values:
            - on-demand

      taints:
        - key: tier
          value: enterprise
          effect: NoSchedule

  limits:
    nvidia.com/gpu: "5"

  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 5m
```

**적용**:
```bash
kubectl apply -f k8s/karpenter/
```

---

## AI Worker Pod 배포

### 1. Worker Deployment

`k8s/workers/invokeai-worker.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: invokeai-worker
  namespace: dev
spec:
  replicas: 0  # Karpenter가 자동으로 스케일링
  selector:
    matchLabels:
      app: invokeai-worker
  template:
    metadata:
      labels:
        app: invokeai-worker
        workload-type: gpu
    spec:
      # GPU 노드 타겟팅
      nodeSelector:
        workload-type: gpu

      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule

      # Pod Anti-Affinity (같은 노드에 중복 배치 방지)
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values:
                        - invokeai-worker
                topologyKey: kubernetes.io/hostname

      containers:
        - name: worker
          image: YOUR_ECR_REPO/invokeai-worker:latest

          resources:
            requests:
              nvidia.com/gpu: 1
              memory: 16Gi
              cpu: 4
            limits:
              nvidia.com/gpu: 1
              memory: 16Gi

          env:
            - name: REDIS_URL
              value: "redis://redis-primary:6379/0"

            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url

            - name: AWS_REGION
              value: "us-east-1"

          volumeMounts:
            - name: models-efs
              mountPath: /models
              readOnly: true

            - name: shm
              mountPath: /dev/shm

      volumes:
        - name: models-efs
          persistentVolumeClaim:
            claimName: efs-models-pvc

        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 8Gi
```

---

### 2. Celery Worker 코드

`services/worker/worker.py`:
```python
from celery import Celery
from datetime import datetime
import torch
from diffusers import StableDiffusionPipeline

# Celery 앱
celery_app = Celery(
    "invokeai-worker",
    broker="redis://redis-primary:6379/0",
    backend="redis://redis-primary:6379/0"
)

# GPU 확인
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Using device: {device}")

# 모델 로드 (EFS에서)
pipeline = StableDiffusionPipeline.from_pretrained(
    "/models/stable-diffusion-v1-5",
    torch_dtype=torch.float16
).to(device)

@celery_app.task(bind=True, name="tasks.generate_image")
def generate_image(self, job_id: str):
    """
    이미지 생성 태스크
    """
    from sqlalchemy.orm import Session
    from app.database import SessionLocal
    from app.models import GenerationJob

    db = SessionLocal()

    try:
        # 작업 조회
        job = db.query(GenerationJob).filter(GenerationJob.id == job_id).first()

        if not job:
            raise ValueError(f"Job {job_id} not found")

        # 작업 시작
        job.status = "in_progress"
        job.started_at = datetime.utcnow()
        db.commit()

        # 이미지 생성
        with torch.inference_mode():
            output = pipeline(
                prompt=job.prompt,
                negative_prompt=job.negative_prompt,
                width=job.width,
                height=job.height,
                num_inference_steps=job.steps,
                guidance_scale=job.cfg_scale,
                generator=torch.Generator(device).manual_seed(job.seed) if job.seed else None
            )

        image = output.images[0]

        # S3 업로드
        s3_key = upload_to_s3(image, job_id)

        # 작업 완료
        job.status = "completed"
        job.completed_at = datetime.utcnow()
        job.image_url = f"https://cdn.pingvas.studio/{s3_key}"

        # 크레딧 차감
        duration_seconds = int((job.completed_at - job.started_at).total_seconds())
        deduct_credits(job.user_id, duration_seconds, job_id)

        db.commit()

        return {"success": True, "image_url": job.image_url}

    except Exception as e:
        job.status = "failed"
        job.error_message = str(e)
        job.completed_at = datetime.utcnow()
        db.commit()
        raise

    finally:
        db.close()

if __name__ == "__main__":
    celery_app.worker_main([
        "worker",
        "--loglevel=info",
        "--concurrency=1",  # GPU 메모리 제약
        "--pool=solo"  # Single process
    ])
```

**Dockerfile**:
```dockerfile
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

# Python 설치
RUN apt-get update && apt-get install -y python3.11 python3-pip

# 의존성 설치
COPY requirements.txt .
RUN pip3 install -r requirements.txt

# 앱 코드
COPY . /app
WORKDIR /app

CMD ["python3", "worker.py"]
```

---

## Spot Interruption Handling

### 1. AWS Node Termination Handler

```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-node-termination-handler \
  eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableRebalanceMonitoring=true \
  --set enableScheduledEventDraining=true \
  --set nodeSelector.lifecycle=spot
```

---

### 2. Pod Disruption Budget

`k8s/workers/pdb.yaml`:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: invokeai-worker-pdb
  namespace: dev
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: invokeai-worker
```

---

## HPA 설정

### 1. Metrics Server 설치

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

---

### 2. KEDA (Kubernetes Event Driven Autoscaling)

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda --namespace keda --create-namespace
```

**ScaledObject (Redis Queue 기반)**:

`k8s/workers/scaledobject.yaml`:
```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: invokeai-worker-scaler
  namespace: dev
spec:
  scaleTargetRef:
    name: invokeai-worker

  minReplicaCount: 0   # Scale to Zero
  maxReplicaCount: 20  # 최대 20개 Pod

  triggers:
    # Redis Queue Length
    - type: redis
      metadata:
        address: redis-primary:6379
        listName: celery  # Celery 기본 큐
        listLength: "5"   # 큐에 5개 이상 작업이 있으면 스케일 업
        databaseIndex: "0"
```

**적용**:
```bash
kubectl apply -f k8s/workers/scaledobject.yaml
```

---

## 테스트 및 검증

### 1. Scale-to-Zero 테스트

```bash
# 큐에 작업 추가
python test_enqueue.py

# Pod 자동 생성 확인
watch kubectl get pods -n dev

# GPU 노드 자동 생성 확인
watch kubectl get nodes --selector=workload-type=gpu

# Karpenter 로그 확인
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f
```

---

### 2. Spot Interruption 시뮬레이션

```bash
# 노드 drain 시뮬레이션
kubectl drain <NODE_NAME> --ignore-daemonsets --delete-emptydir-data

# Pod 재스케줄링 확인
kubectl get pods -n dev -w
```

---

### 3. 부하 테스트

`test_load.py`:
```python
import requests
import concurrent.futures

API_URL = "http://api.pingvas.studio"
TOKEN = "your_jwt_token"

def create_job(i):
    response = requests.post(
        f"{API_URL}/api/v1/generation/create",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={
            "prompt": f"Test image {i}",
            "model": "sd15",
            "width": 512,
            "height": 512,
            "steps": 20
        }
    )
    return response.json()

# 100개 작업 동시 생성
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
    futures = [executor.submit(create_job, i) for i in range(100)]
    results = [f.result() for f in futures]

print(f"Created {len(results)} jobs")
```

---

### 4. 비용 모니터링

```bash
# Spot 인스턴스 비용 확인
aws ce get-cost-and-usage \
  --time-period Start=2025-01-01,End=2025-01-31 \
  --granularity DAILY \
  --metrics UnblendedCost \
  --filter file://spot-filter.json

# Karpenter 노드 정보
kubectl get nodes -l karpenter.sh/capacity-type=spot -o wide
```

---

## 다음 단계

GPU 오토스케일링 구축이 완료되었습니다! 이제 GitOps/CI/CD 파이프라인으로 넘어갑니다:

**👉 [Phase 5 - GitOps/CI/CD 파이프라인](./phase-05-gitops-cicd.md)**

---

## 체크리스트

- [ ] Karpenter 설치
- [ ] GPU NodePool 구성
- [ ] AI Worker Pod 배포
- [ ] Spot Interruption Handler 설치
- [ ] KEDA 설정
- [ ] Scale-to-Zero 테스트 통과
- [ ] 부하 테스트 통과
- [ ] 비용 최적화 확인
