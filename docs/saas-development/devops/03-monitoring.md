# 모니터링 및 로깅 가이드

## 개요

이 문서는 Pingvas Studio의 모니터링, 로깅, 알림 시스템 설정을 설명합니다. Prometheus + Grafana 스택과 CloudWatch를 함께 활용합니다.

---

## 모니터링 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Monitoring Architecture                            │
│                                                                             │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐              │
│  │   EKS Pods    │───▶│  Prometheus   │───▶│   Grafana     │              │
│  │  (metrics)    │    │   Server      │    │  Dashboards   │              │
│  └───────────────┘    └───────────────┘    └───────────────┘              │
│                              │                     │                       │
│  ┌───────────────┐           │                     │                       │
│  │ Node Exporter │───────────┤                     │                       │
│  │ GPU Exporter  │           │                     │                       │
│  └───────────────┘           │                     │                       │
│                              ▼                     │                       │
│                       ┌───────────────┐            │                       │
│                       │ AlertManager  │────────────┼───▶ Slack/PagerDuty  │
│                       └───────────────┘            │                       │
│                                                    │                       │
│  ┌───────────────┐    ┌───────────────┐           │                       │
│  │   EKS Pods    │───▶│  Fluent Bit   │───▶ CloudWatch Logs              │
│  │   (logs)      │    │               │                                   │
│  └───────────────┘    └───────────────┘                                   │
│                                                                             │
│  ┌───────────────┐                                                         │
│  │ AWS Services  │───▶ CloudWatch Metrics                                 │
│  │ (RDS, Redis)  │                                                         │
│  └───────────────┘                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Prometheus 설치

### Helm을 통한 설치

```bash
# Prometheus 스택 Helm 레포 추가
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# 네임스페이스 생성
kubectl create namespace monitoring

# values 파일 작성
cat << 'EOF' > prometheus-values.yaml
prometheus:
  prometheusSpec:
    retention: 15d
    retentionSize: "50GB"
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 100Gi

    # 서비스 모니터 셀렉터
    serviceMonitorSelector:
      matchLabels:
        release: prometheus

    # 리소스
    resources:
      requests:
        memory: 2Gi
        cpu: 500m
      limits:
        memory: 4Gi
        cpu: 2

alertmanager:
  alertmanagerSpec:
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 10Gi

grafana:
  enabled: true
  adminPassword: "changeme"  # 실제로는 Secret 사용
  persistence:
    enabled: true
    storageClassName: gp3
    size: 10Gi

  datasources:
    datasources.yaml:
      apiVersion: 1
      datasources:
        - name: Prometheus
          type: prometheus
          url: http://prometheus-server:9090
          isDefault: true
        - name: CloudWatch
          type: cloudwatch
          jsonData:
            authType: default
            defaultRegion: ap-northeast-2

# Node Exporter
nodeExporter:
  enabled: true

# Kube State Metrics
kubeStateMetrics:
  enabled: true
EOF

# 설치
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values prometheus-values.yaml \
  --wait
```

---

## GPU 모니터링 (DCGM Exporter)

```yaml
# dcgm-exporter.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: dcgm-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: dcgm-exporter
  template:
    metadata:
      labels:
        app: dcgm-exporter
    spec:
      nodeSelector:
        node-type: gpu
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: dcgm-exporter
          image: nvcr.io/nvidia/k8s/dcgm-exporter:3.3.5-3.4.0-ubuntu22.04
          ports:
            - containerPort: 9400
              name: metrics
          securityContext:
            runAsNonRoot: false
            runAsUser: 0
          volumeMounts:
            - name: pod-gpu-resources
              readOnly: true
              mountPath: /var/lib/kubelet/pod-resources
      volumes:
        - name: pod-gpu-resources
          hostPath:
            path: /var/lib/kubelet/pod-resources
---
apiVersion: v1
kind: Service
metadata:
  name: dcgm-exporter
  namespace: monitoring
  labels:
    app: dcgm-exporter
spec:
  selector:
    app: dcgm-exporter
  ports:
    - port: 9400
      targetPort: 9400
      name: metrics
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: dcgm-exporter
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: dcgm-exporter
  endpoints:
    - port: metrics
      interval: 15s
```

---

## 애플리케이션 메트릭

### FastAPI 메트릭 설정

```python
# app/core/metrics.py
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
from fastapi import APIRouter, Response

router = APIRouter(tags=["metrics"])

# 메트릭 정의
REQUEST_COUNT = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']
)

REQUEST_LATENCY = Histogram(
    'http_request_duration_seconds',
    'HTTP request latency',
    ['method', 'endpoint'],
    buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
)

ACTIVE_REQUESTS = Gauge(
    'http_requests_active',
    'Active HTTP requests',
    ['method', 'endpoint']
)

# 생성 관련 메트릭
GENERATION_QUEUE_SIZE = Gauge(
    'generation_queue_size',
    'Number of jobs in generation queue',
    ['priority']
)

GENERATION_DURATION = Histogram(
    'generation_duration_seconds',
    'Image generation duration',
    ['model', 'job_type'],
    buckets=[5, 10, 30, 60, 120, 300, 600]
)

CREDITS_CONSUMED = Counter(
    'credits_consumed_total',
    'Total credits consumed',
    ['user_tier', 'job_type']
)

GPU_UTILIZATION = Gauge(
    'gpu_utilization_percent',
    'GPU utilization percentage',
    ['gpu_id', 'worker_id']
)

@router.get("/metrics")
async def metrics():
    """Prometheus 메트릭 엔드포인트"""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )
```

### 메트릭 미들웨어

```python
# app/middleware/metrics.py
import time
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from app.core.metrics import REQUEST_COUNT, REQUEST_LATENCY, ACTIVE_REQUESTS

class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        method = request.method
        endpoint = request.url.path

        ACTIVE_REQUESTS.labels(method=method, endpoint=endpoint).inc()
        start_time = time.perf_counter()

        try:
            response = await call_next(request)
            status = response.status_code
        except Exception:
            status = 500
            raise
        finally:
            duration = time.perf_counter() - start_time
            REQUEST_COUNT.labels(method=method, endpoint=endpoint, status=status).inc()
            REQUEST_LATENCY.labels(method=method, endpoint=endpoint).observe(duration)
            ACTIVE_REQUESTS.labels(method=method, endpoint=endpoint).dec()

        return response
```

### ServiceMonitor 설정

```yaml
# servicemonitor-backend.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: pingvas-backend
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
      - pingvas-prod
      - pingvas-dev
  selector:
    matchLabels:
      app.kubernetes.io/part-of: pingvas-studio
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
```

---

## Grafana 대시보드

### 주요 대시보드

#### 1. 시스템 개요 대시보드

```json
{
  "title": "Pingvas Studio - System Overview",
  "panels": [
    {
      "title": "Request Rate",
      "type": "graph",
      "targets": [
        {
          "expr": "sum(rate(http_requests_total[5m])) by (endpoint)",
          "legendFormat": "{{endpoint}}"
        }
      ]
    },
    {
      "title": "Error Rate",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m])) * 100"
        }
      ]
    },
    {
      "title": "P99 Latency",
      "type": "graph",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, endpoint))",
          "legendFormat": "{{endpoint}}"
        }
      ]
    },
    {
      "title": "Active Users",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(websocket_connections_active)"
        }
      ]
    }
  ]
}
```

#### 2. 생성 큐 대시보드

```json
{
  "title": "Pingvas Studio - Generation Queue",
  "panels": [
    {
      "title": "Queue Size by Priority",
      "type": "graph",
      "targets": [
        {
          "expr": "generation_queue_size",
          "legendFormat": "{{priority}}"
        }
      ]
    },
    {
      "title": "Generation Duration",
      "type": "heatmap",
      "targets": [
        {
          "expr": "sum(rate(generation_duration_seconds_bucket[5m])) by (le, model)"
        }
      ]
    },
    {
      "title": "Jobs Completed/min",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(rate(generation_jobs_completed_total[1m])) * 60"
        }
      ]
    },
    {
      "title": "Average Wait Time",
      "type": "gauge",
      "targets": [
        {
          "expr": "avg(generation_wait_time_seconds)"
        }
      ]
    }
  ]
}
```

#### 3. GPU 모니터링 대시보드

```json
{
  "title": "Pingvas Studio - GPU Metrics",
  "panels": [
    {
      "title": "GPU Utilization",
      "type": "graph",
      "targets": [
        {
          "expr": "DCGM_FI_DEV_GPU_UTIL",
          "legendFormat": "{{gpu}} - {{Hostname}}"
        }
      ]
    },
    {
      "title": "GPU Memory Usage",
      "type": "graph",
      "targets": [
        {
          "expr": "DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL * 100",
          "legendFormat": "{{gpu}} - {{Hostname}}"
        }
      ]
    },
    {
      "title": "GPU Temperature",
      "type": "gauge",
      "targets": [
        {
          "expr": "avg(DCGM_FI_DEV_GPU_TEMP)"
        }
      ]
    },
    {
      "title": "GPU Power Usage",
      "type": "graph",
      "targets": [
        {
          "expr": "DCGM_FI_DEV_POWER_USAGE",
          "legendFormat": "{{gpu}}"
        }
      ]
    }
  ]
}
```

---

## 로깅 설정

### Fluent Bit 설치

```yaml
# fluent-bit-values.yaml
config:
  inputs: |
    [INPUT]
        Name tail
        Path /var/log/containers/*.log
        multiline.parser docker, cri
        Tag kube.*
        Mem_Buf_Limit 5MB
        Skip_Long_Lines On

  filters: |
    [FILTER]
        Name kubernetes
        Match kube.*
        Merge_Log On
        Keep_Log Off
        K8S-Logging.Parser On
        K8S-Logging.Exclude On

    [FILTER]
        Name grep
        Match kube.*
        Exclude $kubernetes['namespace_name'] kube-system

  outputs: |
    [OUTPUT]
        Name cloudwatch_logs
        Match kube.*
        region ap-northeast-2
        log_group_name /eks/pingvas-cluster/containers
        log_stream_prefix eks-
        auto_create_group true
        log_retention_days 30

serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/FluentBitRole
```

```bash
# Fluent Bit 설치
helm repo add fluent https://fluent.github.io/helm-charts
helm upgrade --install fluent-bit fluent/fluent-bit \
  --namespace logging \
  --create-namespace \
  --values fluent-bit-values.yaml
```

### 애플리케이션 로그 포맷

```python
# app/core/logging.py
import logging
import json
from datetime import datetime

class JSONFormatter(logging.Formatter):
    def format(self, record):
        log_data = {
            "timestamp": datetime.utcnow().isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }

        # 추가 컨텍스트
        if hasattr(record, 'user_id'):
            log_data['user_id'] = record.user_id
        if hasattr(record, 'job_id'):
            log_data['job_id'] = record.job_id
        if hasattr(record, 'request_id'):
            log_data['request_id'] = record.request_id

        # 예외 정보
        if record.exc_info:
            log_data['exception'] = self.formatException(record.exc_info)

        return json.dumps(log_data)

def setup_logging():
    handler = logging.StreamHandler()
    handler.setFormatter(JSONFormatter())

    root_logger = logging.getLogger()
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)
```

---

## 알림 설정

### AlertManager 규칙

```yaml
# alertmanager-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pingvas-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: pingvas.rules
      rules:
        # 높은 에러율
        - alert: HighErrorRate
          expr: |
            sum(rate(http_requests_total{status=~"5.."}[5m]))
            / sum(rate(http_requests_total[5m])) > 0.05
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "High error rate detected"
            description: "Error rate is {{ $value | humanizePercentage }}"

        # 느린 응답 시간
        - alert: HighLatency
          expr: |
            histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High latency detected"
            description: "P99 latency is {{ $value }}s"

        # 큐 백로그
        - alert: GenerationQueueBacklog
          expr: sum(generation_queue_size) > 100
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Generation queue backlog"
            description: "{{ $value }} jobs waiting in queue"

        # GPU 고온
        - alert: GPUHighTemperature
          expr: DCGM_FI_DEV_GPU_TEMP > 85
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "GPU temperature critical"
            description: "GPU {{ $labels.gpu }} temperature is {{ $value }}°C"

        # GPU 메모리 부족
        - alert: GPUMemoryLow
          expr: |
            DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL * 100 > 95
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU memory almost full"
            description: "GPU {{ $labels.gpu }} memory usage is {{ $value }}%"

        # 크레딧 소진 사용자 급증
        - alert: CreditExhaustedSpike
          expr: |
            increase(credits_exhausted_total[1h]) > 10
          for: 0m
          labels:
            severity: info
          annotations:
            summary: "Multiple users exhausted credits"
            description: "{{ $value }} users exhausted credits in the last hour"

        # 노드 다운
        - alert: NodeDown
          expr: up{job="node-exporter"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Node is down"
            description: "Node {{ $labels.instance }} is unreachable"

        # 디스크 용량 부족
        - alert: DiskSpaceLow
          expr: |
            (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100 < 15
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Disk space low"
            description: "Node {{ $labels.instance }} has {{ $value }}% disk space remaining"
```

### Slack 알림 설정

```yaml
# alertmanager-config.yaml
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-config
  namespace: monitoring
stringData:
  alertmanager.yaml: |
    global:
      slack_api_url: 'https://hooks.slack.com/services/xxx/yyy/zzz'

    route:
      receiver: 'slack-notifications'
      group_by: ['alertname', 'severity']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        - match:
            severity: critical
          receiver: 'slack-critical'
        - match:
            severity: warning
          receiver: 'slack-notifications'

    receivers:
      - name: 'slack-critical'
        slack_configs:
          - channel: '#pingvas-alerts-critical'
            send_resolved: true
            title: '{{ .Status | toUpper }}: {{ .CommonLabels.alertname }}'
            text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
            color: '{{ if eq .Status "firing" }}danger{{ else }}good{{ end }}'

      - name: 'slack-notifications'
        slack_configs:
          - channel: '#pingvas-alerts'
            send_resolved: true
            title: '{{ .Status | toUpper }}: {{ .CommonLabels.alertname }}'
            text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
```

---

## CloudWatch 통합

### CloudWatch Container Insights

```bash
# Container Insights 활성화
aws eks update-cluster-config \
  --region ap-northeast-2 \
  --name pingvas-cluster \
  --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'

# CloudWatch Agent 설치
kubectl apply -f https://raw.githubusercontent.com/aws-samples/amazon-cloudwatch-container-insights/latest/k8s-deployment-manifest-templates/deployment-mode/daemonset/container-insights-monitoring/quickstart/cwagent-fluent-bit-quickstart.yaml
```

### CloudWatch 대시보드

```json
{
  "widgets": [
    {
      "type": "metric",
      "properties": {
        "title": "EKS CPU Utilization",
        "metrics": [
          ["ContainerInsights", "node_cpu_utilization", "ClusterName", "pingvas-cluster"]
        ],
        "period": 300
      }
    },
    {
      "type": "metric",
      "properties": {
        "title": "RDS Connections",
        "metrics": [
          ["AWS/RDS", "DatabaseConnections", "DBClusterIdentifier", "pingvas-aurora"]
        ],
        "period": 60
      }
    },
    {
      "type": "metric",
      "properties": {
        "title": "ElastiCache Memory",
        "metrics": [
          ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "CacheClusterId", "pingvas-redis"]
        ],
        "period": 60
      }
    }
  ]
}
```

---

## 비용 모니터링

### Kubecost 설치

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer/

helm upgrade --install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set kubecostToken="xxx" \
  --set prometheus.server.global.external_labels.cluster_id=pingvas-cluster
```

### 비용 알림 설정

```yaml
# kubecost-alerts.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubecost-alerts
  namespace: kubecost
data:
  alerts.yaml: |
    alerts:
      - type: budget
        threshold: 1000  # $1000/월
        window: monthly
        aggregation: cluster

      - type: spendChange
        threshold: 0.3  # 30% 증가
        window: 7d
        baselineWindow: 30d
```

---

## 다음 단계

- [CI/CD 파이프라인](./02-ci-cd-pipeline.md)에서 배포 자동화 확인
- [GitOps 가이드](./01-gitops-guide.md)에서 ArgoCD 설정 확인
- [EKS 설정](../infrastructure/02-eks-setup.md)에서 클러스터 구성 확인
