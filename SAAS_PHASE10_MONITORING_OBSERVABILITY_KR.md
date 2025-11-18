# Phase 10: Monitoring & Observability 가이드

## 목차
1. [개요](#개요)
2. [Prometheus 설정](#prometheus-설정)
3. [Grafana 대시보드](#grafana-대시보드)
4. [Loki 로그 수집](#loki-로그-수집)
5. [Alertmanager 알림](#alertmanager-알림)
6. [분산 추적 (Jaeger)](#분산-추적-jaeger)
7. [비즈니스 메트릭](#비즈니스-메트릭)
8. [SLI/SLO 설정](#slislo-설정)
9. [테스트](#테스트)

---

## 개요

Phase 10에서는 시스템 전체에 대한 Observability를 구축합니다.

### Observability의 3가지 기둥
- **Metrics**: Prometheus (시계열 데이터)
- **Logs**: Loki (로그 수집 및 검색)
- **Traces**: Jaeger (분산 추적)

### 주요 목표
- **실시간 모니터링**: 시스템 상태 실시간 파악
- **장애 감지**: 문제 발생 시 즉시 알림
- **성능 분석**: 병목 지점 식별
- **비즈니스 인사이트**: 매출, 사용자 행동 분석
- **SLA 준수**: 99.9% 가용성 보장

### 기술 스택
- **Prometheus**: 메트릭 수집 및 저장
- **Grafana**: 시각화 및 대시보드
- **Loki**: 로그 수집 (Prometheus for logs)
- **Alertmanager**: 알림 라우팅 (Slack, PagerDuty, Email)
- **Jaeger**: 분산 추적
- **Node Exporter**: 시스템 메트릭
- **cAdvisor**: 컨테이너 메트릭

---

## Prometheus 설정

### 1. Prometheus 설치 (Docker Compose)

```yaml
# docker-compose.monitoring.yml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:v2.45.0
    container_name: prometheus
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
      - ./prometheus/rules:/etc/prometheus/rules
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
      - '--web.enable-lifecycle'
      - '--web.enable-admin-api'
    ports:
      - "9090:9090"
    restart: unless-stopped
    networks:
      - monitoring

  node-exporter:
    image: prom/node-exporter:v1.6.0
    container_name: node-exporter
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
      - '--path.rootfs=/rootfs'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    ports:
      - "9100:9100"
    restart: unless-stopped
    networks:
      - monitoring

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.47.0
    container_name: cadvisor
    privileged: true
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
      - /dev/disk/:/dev/disk:ro
    ports:
      - "8080:8080"
    restart: unless-stopped
    networks:
      - monitoring

  redis-exporter:
    image: oliver006/redis_exporter:v1.50.0
    container_name: redis-exporter
    environment:
      - REDIS_ADDR=redis:6379
    ports:
      - "9121:9121"
    restart: unless-stopped
    networks:
      - monitoring

  postgres-exporter:
    image: prometheuscommunity/postgres-exporter:v0.12.0
    container_name: postgres-exporter
    environment:
      - DATA_SOURCE_NAME=postgresql://user:password@postgres:5432/pingvasai?sslmode=disable
    ports:
      - "9187:9187"
    restart: unless-stopped
    networks:
      - monitoring

volumes:
  prometheus_data:

networks:
  monitoring:
    external: true
```

### 2. Prometheus 설정 파일

```yaml
# prometheus/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: 'pingvasai-production'
    environment: 'production'

# Alertmanager 설정
alerting:
  alertmanagers:
    - static_configs:
        - targets:
            - alertmanager:9093

# Rule 파일
rule_files:
  - '/etc/prometheus/rules/*.yml'

# Scrape 설정
scrape_configs:
  # Prometheus 자체 모니터링
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  # Node Exporter (시스템 메트릭)
  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']
        labels:
          instance: 'api-server-1'

  # cAdvisor (컨테이너 메트릭)
  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']

  # FastAPI 애플리케이션
  - job_name: 'fastapi-app'
    static_configs:
      - targets: ['api:8000']
    metrics_path: '/metrics'

  # Celery Workers
  - job_name: 'celery-workers'
    ec2_sd_configs:
      - region: us-east-1
        port: 9808
        filters:
          - name: tag:Type
            values: ['celery-worker']
    relabel_configs:
      - source_labels: [__meta_ec2_instance_id]
        target_label: instance_id
      - source_labels: [__meta_ec2_private_ip]
        target_label: private_ip

  # Redis
  - job_name: 'redis'
    static_configs:
      - targets: ['redis-exporter:9121']

  # PostgreSQL
  - job_name: 'postgres'
    static_configs:
      - targets: ['postgres-exporter:9187']

  # GPU 워커 (커스텀 exporter)
  - job_name: 'gpu-workers'
    ec2_sd_configs:
      - region: us-east-1
        port: 9400
        filters:
          - name: tag:Type
            values: ['gpu-worker']

  # Elasticsearch
  - job_name: 'elasticsearch'
    static_configs:
      - targets: ['elasticsearch-exporter:9114']
```

### 3. FastAPI Prometheus 통합

```python
# app/monitoring/metrics.py
from prometheus_client import (
    Counter, Histogram, Gauge, Info,
    generate_latest, CONTENT_TYPE_LATEST
)
from fastapi import Request, Response
from time import time
import psutil
import logging

logger = logging.getLogger(__name__)

# HTTP 메트릭
http_requests_total = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']
)

http_request_duration_seconds = Histogram(
    'http_request_duration_seconds',
    'HTTP request duration',
    ['method', 'endpoint'],
    buckets=[0.01, 0.05, 0.1, 0.5, 1.0, 2.0, 5.0, 10.0]
)

# 이미지 생성 메트릭
image_generation_total = Counter(
    'image_generation_total',
    'Total image generations',
    ['model', 'plan', 'status']
)

image_generation_duration_seconds = Histogram(
    'image_generation_duration_seconds',
    'Image generation duration',
    ['model', 'plan'],
    buckets=[1, 5, 10, 30, 60, 120, 300, 600]
)

image_generation_credits_used = Counter(
    'image_generation_credits_used_total',
    'Total credits used for image generation',
    ['model', 'plan']
)

# 사용자 메트릭
active_users_gauge = Gauge(
    'active_users',
    'Number of active users',
    ['plan']
)

user_credits_balance = Gauge(
    'user_credits_balance_total',
    'Total user credits balance',
    ['plan']
)

# 큐 메트릭
celery_queue_length = Gauge(
    'celery_queue_length',
    'Celery queue length',
    ['queue_name']
)

celery_active_workers = Gauge(
    'celery_active_workers',
    'Number of active Celery workers'
)

# 시스템 메트릭
system_cpu_usage_percent = Gauge(
    'system_cpu_usage_percent',
    'System CPU usage percentage'
)

system_memory_usage_percent = Gauge(
    'system_memory_usage_percent',
    'System memory usage percentage'
)

# 비즈니스 메트릭
revenue_total_usd = Counter(
    'revenue_total_usd',
    'Total revenue in USD',
    ['plan', 'billing_cycle']
)

subscription_changes_total = Counter(
    'subscription_changes_total',
    'Total subscription changes',
    ['from_plan', 'to_plan']
)

# 애플리케이션 정보
app_info = Info('app', 'Application information')
app_info.info({
    'version': '1.0.0',
    'environment': 'production',
    'service': 'pingvasai-api'
})


# FastAPI 미들웨어
from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware


class PrometheusMiddleware(BaseHTTPMiddleware):
    """Prometheus 메트릭 수집 미들웨어"""

    async def dispatch(self, request: Request, call_next):
        # 메트릭 엔드포인트는 측정하지 않음
        if request.url.path == "/metrics":
            return await call_next(request)

        method = request.method
        path = request.url.path

        # 시작 시간
        start_time = time()

        # 요청 처리
        response = await call_next(request)

        # 소요 시간
        duration = time() - start_time

        # 메트릭 기록
        http_requests_total.labels(
            method=method,
            endpoint=path,
            status=response.status_code
        ).inc()

        http_request_duration_seconds.labels(
            method=method,
            endpoint=path
        ).observe(duration)

        return response


# 메트릭 엔드포인트
from fastapi import APIRouter

router = APIRouter()


@router.get("/metrics")
async def metrics():
    """Prometheus 메트릭 엔드포인트"""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )


# FastAPI 앱에 미들웨어 추가
def setup_metrics(app: FastAPI):
    """메트릭 설정"""
    app.add_middleware(PrometheusMiddleware)
    app.include_router(router)
```

### 4. 시스템 메트릭 업데이트 (Celery Beat)

```python
# app/tasks/metrics_tasks.py
from celery import shared_task
from app.monitoring.metrics import (
    active_users_gauge, user_credits_balance,
    celery_queue_length, celery_active_workers,
    system_cpu_usage_percent, system_memory_usage_percent
)
from app.services.queue_monitor import QueueMonitor
from app.database import get_db
from app.models import User
from sqlalchemy import select, func
import psutil


@shared_task(name="update_system_metrics")
def update_system_metrics_task():
    """시스템 메트릭 업데이트 (매 15초)"""

    # CPU 사용률
    cpu_percent = psutil.cpu_percent(interval=1)
    system_cpu_usage_percent.set(cpu_percent)

    # 메모리 사용률
    memory = psutil.virtual_memory()
    system_memory_usage_percent.set(memory.percent)


@shared_task(name="update_user_metrics")
def update_user_metrics_task():
    """사용자 메트릭 업데이트 (매 1분)"""

    async def _update():
        async with get_db() as db:
            # 플랜별 활성 사용자 수
            stmt = select(
                User.subscription_plan,
                func.count(User.user_id)
            ).where(
                User.is_active == True
            ).group_by(User.subscription_plan)

            result = await db.execute(stmt)
            for plan, count in result:
                active_users_gauge.labels(plan=plan).set(count)

            # 플랜별 총 크레딧 잔액
            stmt = select(
                User.subscription_plan,
                func.sum(User.credits_balance)
            ).group_by(User.subscription_plan)

            result = await db.execute(stmt)
            for plan, total_credits in result:
                user_credits_balance.labels(plan=plan).set(total_credits or 0)

    import asyncio
    asyncio.run(_update())


@shared_task(name="update_queue_metrics")
def update_queue_metrics_task():
    """큐 메트릭 업데이트 (매 15초)"""

    monitor = QueueMonitor()

    # 큐 길이
    lengths = monitor.get_queue_lengths()
    for queue_name, length in lengths.items():
        celery_queue_length.labels(queue_name=queue_name).set(length)

    # 활성 워커 수
    stats = monitor.get_queue_statistics()
    celery_active_workers.set(stats.get('active_workers', 0))


# Celery Beat 스케줄
# celeryconfig.py
from celery.schedules import crontab

beat_schedule = {
    'update-system-metrics': {
        'task': 'update_system_metrics',
        'schedule': 15.0,  # 15초마다
    },
    'update-user-metrics': {
        'task': 'update_user_metrics',
        'schedule': 60.0,  # 1분마다
    },
    'update-queue-metrics': {
        'task': 'update_queue_metrics',
        'schedule': 15.0,
    },
}
```

### 5. GPU 메트릭 Exporter

```python
# app/monitoring/gpu_exporter.py
"""
GPU 메트릭을 Prometheus에 노출하는 Exporter

실행: python -m app.monitoring.gpu_exporter
"""

from prometheus_client import start_http_server, Gauge
import torch
import time
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# GPU 메트릭
gpu_memory_total_bytes = Gauge(
    'gpu_memory_total_bytes',
    'Total GPU memory in bytes',
    ['gpu_id', 'gpu_name']
)

gpu_memory_allocated_bytes = Gauge(
    'gpu_memory_allocated_bytes',
    'Allocated GPU memory in bytes',
    ['gpu_id', 'gpu_name']
)

gpu_memory_reserved_bytes = Gauge(
    'gpu_memory_reserved_bytes',
    'Reserved GPU memory in bytes',
    ['gpu_id', 'gpu_name']
)

gpu_utilization_percent = Gauge(
    'gpu_utilization_percent',
    'GPU utilization percentage',
    ['gpu_id', 'gpu_name']
)

gpu_temperature_celsius = Gauge(
    'gpu_temperature_celsius',
    'GPU temperature in Celsius',
    ['gpu_id', 'gpu_name']
)


def collect_gpu_metrics():
    """GPU 메트릭 수집"""

    if not torch.cuda.is_available():
        logger.warning("No GPU available")
        return

    try:
        import pynvml
        pynvml.nvmlInit()

        device_count = torch.cuda.device_count()

        for gpu_id in range(device_count):
            # GPU 정보
            gpu_name = torch.cuda.get_device_name(gpu_id)

            # 메모리 정보 (PyTorch)
            total_memory = torch.cuda.get_device_properties(gpu_id).total_memory
            allocated_memory = torch.cuda.memory_allocated(gpu_id)
            reserved_memory = torch.cuda.memory_reserved(gpu_id)

            gpu_memory_total_bytes.labels(
                gpu_id=str(gpu_id),
                gpu_name=gpu_name
            ).set(total_memory)

            gpu_memory_allocated_bytes.labels(
                gpu_id=str(gpu_id),
                gpu_name=gpu_name
            ).set(allocated_memory)

            gpu_memory_reserved_bytes.labels(
                gpu_id=str(gpu_id),
                gpu_name=gpu_name
            ).set(reserved_memory)

            # 사용률 및 온도 (NVML)
            handle = pynvml.nvmlDeviceGetHandleByIndex(gpu_id)

            utilization = pynvml.nvmlDeviceGetUtilizationRates(handle)
            gpu_utilization_percent.labels(
                gpu_id=str(gpu_id),
                gpu_name=gpu_name
            ).set(utilization.gpu)

            temperature = pynvml.nvmlDeviceGetTemperature(
                handle,
                pynvml.NVML_TEMPERATURE_GPU
            )
            gpu_temperature_celsius.labels(
                gpu_id=str(gpu_id),
                gpu_name=gpu_name
            ).set(temperature)

    except Exception as e:
        logger.error(f"Failed to collect GPU metrics: {e}")


if __name__ == '__main__':
    # Prometheus HTTP 서버 시작 (포트 9400)
    start_http_server(9400)
    logger.info("GPU Exporter started on port 9400")

    # 메트릭 수집 루프
    while True:
        collect_gpu_metrics()
        time.sleep(10)  # 10초마다 수집
```

### 6. Alert Rules

```yaml
# prometheus/rules/alerts.yml
groups:
  - name: api_alerts
    interval: 30s
    rules:
      # API 응답 시간
      - alert: HighAPILatency
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
          component: api
        annotations:
          summary: "High API latency detected"
          description: "95th percentile latency is {{ $value }}s (threshold: 2s)"

      # API 에러율
      - alert: HighAPIErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
          component: api
        annotations:
          summary: "High API error rate"
          description: "Error rate is {{ $value | humanizePercentage }} (threshold: 5%)"

      # API 가용성
      - alert: APIDown
        expr: up{job="fastapi-app"} == 0
        for: 1m
        labels:
          severity: critical
          component: api
        annotations:
          summary: "API is down"
          description: "FastAPI application is not responding"

  - name: worker_alerts
    interval: 30s
    rules:
      # 큐 길이 급증
      - alert: HighQueueLength
        expr: sum(celery_queue_length) > 50
        for: 5m
        labels:
          severity: warning
          component: worker
        annotations:
          summary: "High queue length detected"
          description: "Total queue length is {{ $value }} (threshold: 50)"

      # 워커 부족
      - alert: InsufficientWorkers
        expr: celery_active_workers < 1 and sum(celery_queue_length) > 10
        for: 3m
        labels:
          severity: critical
          component: worker
        annotations:
          summary: "Insufficient workers"
          description: "Only {{ $value }} workers active with queue length > 10"

      # GPU OOM
      - alert: GPUMemoryHigh
        expr: gpu_memory_allocated_bytes / gpu_memory_total_bytes > 0.95
        for: 2m
        labels:
          severity: warning
          component: gpu
        annotations:
          summary: "GPU memory usage is high"
          description: "GPU {{ $labels.gpu_id }} memory usage: {{ $value | humanizePercentage }}"

      # GPU 온도
      - alert: GPUTemperatureHigh
        expr: gpu_temperature_celsius > 85
        for: 5m
        labels:
          severity: warning
          component: gpu
        annotations:
          summary: "GPU temperature is high"
          description: "GPU {{ $labels.gpu_id }} temperature: {{ $value }}°C"

  - name: system_alerts
    interval: 30s
    rules:
      # CPU 사용률
      - alert: HighCPUUsage
        expr: system_cpu_usage_percent > 90
        for: 10m
        labels:
          severity: warning
          component: system
        annotations:
          summary: "High CPU usage"
          description: "CPU usage is {{ $value }}% (threshold: 90%)"

      # 메모리 사용률
      - alert: HighMemoryUsage
        expr: system_memory_usage_percent > 90
        for: 10m
        labels:
          severity: warning
          component: system
        annotations:
          summary: "High memory usage"
          description: "Memory usage is {{ $value }}% (threshold: 90%)"

      # 디스크 사용률
      - alert: HighDiskUsage
        expr: (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.1
        for: 10m
        labels:
          severity: critical
          component: system
        annotations:
          summary: "Low disk space"
          description: "Only {{ $value | humanizePercentage }} disk space available"

  - name: database_alerts
    interval: 30s
    rules:
      # PostgreSQL 연결 수
      - alert: HighDatabaseConnections
        expr: pg_stat_database_numbackends > 80
        for: 5m
        labels:
          severity: warning
          component: database
        annotations:
          summary: "High number of database connections"
          description: "{{ $value }} connections (max: 100)"

      # PostgreSQL 응답 시간
      - alert: SlowDatabaseQueries
        expr: rate(pg_stat_database_blks_read[5m]) > 1000
        for: 5m
        labels:
          severity: warning
          component: database
        annotations:
          summary: "Slow database queries detected"
          description: "High disk read rate: {{ $value }} blocks/sec"

      # Redis 메모리
      - alert: RedisMemoryHigh
        expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.9
        for: 5m
        labels:
          severity: warning
          component: redis
        annotations:
          summary: "Redis memory usage is high"
          description: "Memory usage: {{ $value | humanizePercentage }}"

  - name: business_alerts
    interval: 1m
    rules:
      # 이미지 생성 실패율
      - alert: HighGenerationFailureRate
        expr: rate(image_generation_total{status="failed"}[10m]) / rate(image_generation_total[10m]) > 0.1
        for: 5m
        labels:
          severity: warning
          component: business
        annotations:
          summary: "High image generation failure rate"
          description: "Failure rate: {{ $value | humanizePercentage }} (threshold: 10%)"

      # 크레딧 소진율 급증
      - alert: HighCreditConsumptionRate
        expr: rate(image_generation_credits_used_total[10m]) > 1000
        for: 5m
        labels:
          severity: info
          component: business
        annotations:
          summary: "High credit consumption rate"
          description: "Credits consumed: {{ $value }}/min"
```

---

## Grafana 대시보드

### 1. Grafana 설치

```yaml
# docker-compose.monitoring.yml에 추가

  grafana:
    image: grafana/grafana:10.0.0
    container_name: grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_INSTALL_PLUGINS=grafana-piechart-panel
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning
      - ./grafana/dashboards:/var/lib/grafana/dashboards
    restart: unless-stopped
    networks:
      - monitoring

volumes:
  grafana_data:
```

### 2. 데이터 소스 자동 설정

```yaml
# grafana/provisioning/datasources/prometheus.yml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false

  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: false
```

### 3. 대시보드 자동 로드

```yaml
# grafana/provisioning/dashboards/default.yml
apiVersion: 1

providers:
  - name: 'Default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
```

### 4. API 대시보드 (JSON)

```json
{
  "dashboard": {
    "title": "PingvasAI API Metrics",
    "tags": ["api", "fastapi"],
    "timezone": "browser",
    "panels": [
      {
        "id": 1,
        "title": "Request Rate",
        "type": "graph",
        "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "rate(http_requests_total[5m])",
            "legendFormat": "{{method}} {{endpoint}}",
            "refId": "A"
          }
        ],
        "yaxes": [
          {"format": "reqps", "label": "Requests/sec"}
        ]
      },
      {
        "id": 2,
        "title": "Response Time (p95)",
        "type": "graph",
        "gridPos": {"x": 12, "y": 0, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))",
            "legendFormat": "{{endpoint}}",
            "refId": "A"
          }
        ],
        "yaxes": [
          {"format": "s", "label": "Duration"}
        ]
      },
      {
        "id": 3,
        "title": "Error Rate",
        "type": "graph",
        "gridPos": {"x": 0, "y": 8, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "rate(http_requests_total{status=~\"5..\"}[5m]) / rate(http_requests_total[5m])",
            "legendFormat": "Error Rate",
            "refId": "A"
          }
        ],
        "yaxes": [
          {"format": "percentunit", "label": "Error Rate"}
        ],
        "alert": {
          "conditions": [
            {
              "evaluator": {"params": [0.05], "type": "gt"},
              "operator": {"type": "and"},
              "query": {"params": ["A", "5m", "now"]},
              "reducer": {"params": [], "type": "avg"},
              "type": "query"
            }
          ],
          "executionErrorState": "alerting",
          "frequency": "1m",
          "handler": 1,
          "name": "High Error Rate",
          "noDataState": "no_data"
        }
      },
      {
        "id": 4,
        "title": "Active Users by Plan",
        "type": "stat",
        "gridPos": {"x": 12, "y": 8, "w": 6, "h": 4},
        "targets": [
          {
            "expr": "active_users",
            "legendFormat": "{{plan}}",
            "refId": "A"
          }
        ],
        "options": {
          "colorMode": "value",
          "graphMode": "area",
          "orientation": "auto"
        }
      },
      {
        "id": 5,
        "title": "Queue Length",
        "type": "graph",
        "gridPos": {"x": 0, "y": 16, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "celery_queue_length",
            "legendFormat": "{{queue_name}}",
            "refId": "A"
          }
        ],
        "yaxes": [
          {"format": "short", "label": "Queue Length"}
        ]
      },
      {
        "id": 6,
        "title": "Image Generation Rate",
        "type": "graph",
        "gridPos": {"x": 12, "y": 16, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "rate(image_generation_total[5m])",
            "legendFormat": "{{model}} - {{plan}} - {{status}}",
            "refId": "A"
          }
        ],
        "yaxes": [
          {"format": "ops", "label": "Generations/sec"}
        ]
      }
    ],
    "refresh": "10s",
    "time": {"from": "now-1h", "to": "now"}
  }
}
```

### 5. GPU 대시보드

```json
{
  "dashboard": {
    "title": "GPU Metrics",
    "tags": ["gpu", "worker"],
    "panels": [
      {
        "id": 1,
        "title": "GPU Memory Usage",
        "type": "graph",
        "targets": [
          {
            "expr": "gpu_memory_allocated_bytes / gpu_memory_total_bytes",
            "legendFormat": "GPU {{gpu_id}} - {{gpu_name}}",
            "refId": "A"
          }
        ],
        "yaxes": [
          {"format": "percentunit", "max": 1, "min": 0}
        ]
      },
      {
        "id": 2,
        "title": "GPU Utilization",
        "type": "graph",
        "targets": [
          {
            "expr": "gpu_utilization_percent",
            "legendFormat": "GPU {{gpu_id}}",
            "refId": "A"
          }
        ],
        "yaxes": [
          {"format": "percent", "max": 100, "min": 0}
        ]
      },
      {
        "id": 3,
        "title": "GPU Temperature",
        "type": "graph",
        "targets": [
          {
            "expr": "gpu_temperature_celsius",
            "legendFormat": "GPU {{gpu_id}}",
            "refId": "A"
          }
        ],
        "yaxes": [
          {"format": "celsius"}
        ],
        "thresholds": [
          {"value": 80, "color": "yellow"},
          {"value": 85, "color": "red"}
        ]
      }
    ]
  }
}
```

---

## Loki 로그 수집

### 1. Loki 설치

```yaml
# docker-compose.monitoring.yml에 추가

  loki:
    image: grafana/loki:2.8.0
    container_name: loki
    ports:
      - "3100:3100"
    command: -config.file=/etc/loki/local-config.yaml
    volumes:
      - ./loki/loki-config.yaml:/etc/loki/local-config.yaml
      - loki_data:/loki
    restart: unless-stopped
    networks:
      - monitoring

  promtail:
    image: grafana/promtail:2.8.0
    container_name: promtail
    volumes:
      - ./promtail/promtail-config.yaml:/etc/promtail/promtail-config.yaml
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
    command: -config.file=/etc/promtail/promtail-config.yaml
    restart: unless-stopped
    networks:
      - monitoring

volumes:
  loki_data:
```

### 2. Loki 설정

```yaml
# loki/loki-config.yaml
auth_enabled: false

server:
  http_listen_port: 3100

ingester:
  lifecycler:
    address: 127.0.0.1
    ring:
      kvstore:
        store: inmemory
      replication_factor: 1
  chunk_idle_period: 5m
  chunk_retain_period: 30s

schema_config:
  configs:
    - from: 2023-01-01
      store: boltdb-shipper
      object_store: filesystem
      schema: v11
      index:
        prefix: index_
        period: 24h

storage_config:
  boltdb_shipper:
    active_index_directory: /loki/boltdb-shipper-active
    cache_location: /loki/boltdb-shipper-cache
    shared_store: filesystem
  filesystem:
    directory: /loki/chunks

limits_config:
  enforce_metric_name: false
  reject_old_samples: true
  reject_old_samples_max_age: 168h
  ingestion_rate_mb: 10
  ingestion_burst_size_mb: 20

chunk_store_config:
  max_look_back_period: 720h

table_manager:
  retention_deletes_enabled: true
  retention_period: 720h
```

### 3. Promtail 설정

```yaml
# promtail/promtail-config.yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  # Docker 컨테이너 로그
  - job_name: docker
    static_configs:
      - targets:
          - localhost
        labels:
          job: docker
          __path__: /var/lib/docker/containers/*/*.log

    pipeline_stages:
      - json:
          expressions:
            log: log
            stream: stream
            time: time
      - labels:
          stream:
      - timestamp:
          source: time
          format: RFC3339Nano

  # 시스템 로그
  - job_name: system
    static_configs:
      - targets:
          - localhost
        labels:
          job: syslog
          __path__: /var/log/syslog

  # FastAPI 로그
  - job_name: fastapi
    static_configs:
      - targets:
          - localhost
        labels:
          job: fastapi
          __path__: /var/log/pingvasai/api.log

    pipeline_stages:
      - regex:
          expression: '^(?P<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - (?P<level>\w+) - (?P<message>.*)$'
      - labels:
          level:
      - timestamp:
          source: time
          format: '2006-01-02 15:04:05'
```

### 4. 구조화된 로깅 (Python)

```python
# app/logging_config.py
import logging
import json
from datetime import datetime


class JSONFormatter(logging.Formatter):
    """JSON 형식 로그 포매터"""

    def format(self, record):
        log_data = {
            'timestamp': datetime.utcnow().isoformat(),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno,
        }

        # 예외 정보
        if record.exc_info:
            log_data['exception'] = self.formatException(record.exc_info)

        # 추가 필드
        if hasattr(record, 'user_id'):
            log_data['user_id'] = record.user_id

        if hasattr(record, 'job_id'):
            log_data['job_id'] = record.job_id

        if hasattr(record, 'request_id'):
            log_data['request_id'] = record.request_id

        return json.dumps(log_data)


def setup_logging():
    """로깅 설정"""

    # 루트 로거
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)

    # 콘솔 핸들러 (JSON)
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(JSONFormatter())
    root_logger.addHandler(console_handler)

    # 파일 핸들러
    file_handler = logging.FileHandler('/var/log/pingvasai/api.log')
    file_handler.setFormatter(JSONFormatter())
    root_logger.addHandler(file_handler)


# FastAPI 미들웨어: Request ID 추가
import uuid
from fastapi import Request


class RequestIDMiddleware:
    """Request ID를 로그에 추가"""

    async def __call__(self, request: Request, call_next):
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id

        # 로그 컨텍스트에 request_id 추가
        old_factory = logging.getLogRecordFactory()

        def record_factory(*args, **kwargs):
            record = old_factory(*args, **kwargs)
            record.request_id = request_id
            return record

        logging.setLogRecordFactory(record_factory)

        response = await call_next(request)

        # 복원
        logging.setLogRecordFactory(old_factory)

        return response
```

---

## Alertmanager 알림

### 1. Alertmanager 설치

```yaml
# docker-compose.monitoring.yml에 추가

  alertmanager:
    image: prom/alertmanager:v0.25.0
    container_name: alertmanager
    ports:
      - "9093:9093"
    volumes:
      - ./alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml
      - alertmanager_data:/alertmanager
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
      - '--storage.path=/alertmanager'
    restart: unless-stopped
    networks:
      - monitoring

volumes:
  alertmanager_data:
```

### 2. Alertmanager 설정

```yaml
# alertmanager/alertmanager.yml
global:
  resolve_timeout: 5m
  slack_api_url: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK'

# 알림 템플릿
templates:
  - '/etc/alertmanager/templates/*.tmpl'

# 알림 라우팅
route:
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h
  receiver: 'default'

  routes:
    # Critical 알림 -> PagerDuty + Slack
    - match:
        severity: critical
      receiver: 'pagerduty-critical'
      continue: true

    - match:
        severity: critical
      receiver: 'slack-critical'

    # Warning 알림 -> Slack
    - match:
        severity: warning
      receiver: 'slack-warning'

    # Business 알림 -> Email
    - match:
        component: business
      receiver: 'email-team'

# 수신자
receivers:
  - name: 'default'
    slack_configs:
      - channel: '#alerts'
        title: 'Alert: {{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'

  - name: 'slack-critical'
    slack_configs:
      - channel: '#critical-alerts'
        color: 'danger'
        title: '🚨 CRITICAL: {{ .GroupLabels.alertname }}'
        text: |-
          *Summary:* {{ .CommonAnnotations.summary }}
          *Description:* {{ .CommonAnnotations.description }}
          *Severity:* {{ .CommonLabels.severity }}
        send_resolved: true

  - name: 'slack-warning'
    slack_configs:
      - channel: '#warnings'
        color: 'warning'
        title: '⚠️ WARNING: {{ .GroupLabels.alertname }}'
        text: '{{ .CommonAnnotations.description }}'

  - name: 'pagerduty-critical'
    pagerduty_configs:
      - service_key: 'YOUR_PAGERDUTY_SERVICE_KEY'
        description: '{{ .CommonAnnotations.summary }}'

  - name: 'email-team'
    email_configs:
      - to: 'team@pingvasai.com'
        from: 'alerts@pingvasai.com'
        smarthost: 'smtp.gmail.com:587'
        auth_username: 'alerts@pingvasai.com'
        auth_password: 'YOUR_PASSWORD'
        headers:
          Subject: 'PingvasAI Alert: {{ .GroupLabels.alertname }}'

# 알림 억제 (inhibition)
inhibit_rules:
  # API Down이 발생하면 다른 API 관련 알림 억제
  - source_match:
      alertname: 'APIDown'
    target_match:
      component: 'api'
    equal: ['instance']
```

---

## 분산 추적 (Jaeger)

### 1. Jaeger 설치

```yaml
# docker-compose.monitoring.yml에 추가

  jaeger:
    image: jaegertracing/all-in-one:1.47
    container_name: jaeger
    ports:
      - "5775:5775/udp"
      - "6831:6831/udp"
      - "6832:6832/udp"
      - "5778:5778"
      - "16686:16686"  # UI
      - "14268:14268"
      - "14250:14250"
      - "9411:9411"
    environment:
      - COLLECTOR_ZIPKIN_HOST_PORT=:9411
    restart: unless-stopped
    networks:
      - monitoring
```

### 2. OpenTelemetry 통합

```python
# app/tracing.py
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.jaeger.thrift import JaegerExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor


def setup_tracing(app):
    """분산 추적 설정"""

    # Tracer Provider 설정
    trace.set_tracer_provider(TracerProvider())

    # Jaeger Exporter
    jaeger_exporter = JaegerExporter(
        agent_host_name="jaeger",
        agent_port=6831,
    )

    # Span Processor
    trace.get_tracer_provider().add_span_processor(
        BatchSpanProcessor(jaeger_exporter)
    )

    # FastAPI 자동 계측
    FastAPIInstrumentor.instrument_app(app)

    # SQLAlchemy 자동 계측
    SQLAlchemyInstrumentor().instrument()

    # Redis 자동 계측
    RedisInstrumentor().instrument()

    # Requests 자동 계측
    RequestsInstrumentor().instrument()


# 커스텀 Span 추가
from opentelemetry import trace

tracer = trace.get_tracer(__name__)


async def generate_image_traced(user_id: str, prompt: str, **kwargs):
    """추적이 포함된 이미지 생성"""

    with tracer.start_as_current_span("generate_image") as span:
        # Span 속성 추가
        span.set_attribute("user_id", user_id)
        span.set_attribute("prompt", prompt)
        span.set_attribute("model", kwargs.get("model_name"))

        # 실제 작업
        result = await generate_image(user_id, prompt, **kwargs)

        span.set_attribute("generation_time", result['generation_time'])
        span.set_attribute("credits_used", result['credits_used'])

        return result
```

---

## 비즈니스 메트릭

### 1. 비즈니스 메트릭 정의

```python
# app/monitoring/business_metrics.py
from prometheus_client import Counter, Histogram, Gauge


# 매출 메트릭
revenue_total_usd = Counter(
    'revenue_total_usd',
    'Total revenue in USD',
    ['plan', 'billing_cycle']
)

subscription_mrr_usd = Gauge(
    'subscription_mrr_usd',
    'Monthly Recurring Revenue in USD'
)

# 사용자 전환율
user_conversion_total = Counter(
    'user_conversion_total',
    'User conversions',
    ['from_plan', 'to_plan']
)

user_churn_total = Counter(
    'user_churn_total',
    'User churns',
    ['plan']
)

# 크레딧 메트릭
credits_purchased_total = Counter(
    'credits_purchased_total',
    'Total credits purchased',
    ['plan']
)

credits_consumed_total = Counter(
    'credits_consumed_total',
    'Total credits consumed',
    ['plan', 'usage_type']
)

# 이미지 생성 품질
image_generation_success_rate = Gauge(
    'image_generation_success_rate',
    'Image generation success rate',
    ['model']
)

# 사용자 활동
daily_active_users = Gauge(
    'daily_active_users',
    'Daily active users',
    ['plan']
)

monthly_active_users = Gauge(
    'monthly_active_users',
    'Monthly active users',
    ['plan']
)


# 메트릭 업데이트 함수
async def record_subscription_purchase(
    user: User,
    plan: str,
    billing_cycle: str,
    amount_usd: float
):
    """구독 구매 기록"""

    revenue_total_usd.labels(
        plan=plan,
        billing_cycle=billing_cycle
    ).inc(amount_usd)

    # 플랜 변경 추적
    if user.subscription_plan != plan:
        user_conversion_total.labels(
            from_plan=user.subscription_plan,
            to_plan=plan
        ).inc()


async def record_user_churn(user: User):
    """사용자 이탈 기록"""

    user_churn_total.labels(plan=user.subscription_plan).inc()


# Celery Beat 작업으로 주기적 업데이트
@shared_task(name="update_business_metrics")
def update_business_metrics_task():
    """비즈니스 메트릭 업데이트 (매 1시간)"""

    async def _update():
        from datetime import datetime, timedelta

        async with get_db() as db:
            now = datetime.utcnow()
            today = now.replace(hour=0, minute=0, second=0, microsecond=0)
            month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

            # MRR 계산
            stmt = select(
                func.sum(
                    case(
                        (User.subscription_billing_cycle == "monthly", User.subscription_amount),
                        (User.subscription_billing_cycle == "yearly", User.subscription_amount / 12),
                        else_=0
                    )
                )
            ).where(User.subscription_status == "active")

            mrr = (await db.execute(stmt)).scalar() or 0
            subscription_mrr_usd.set(mrr / 100)  # cents to dollars

            # DAU
            stmt = select(
                User.subscription_plan,
                func.count(func.distinct(Image.user_id))
            ).join(
                Image, Image.user_id == User.user_id
            ).where(
                Image.created_at >= today
            ).group_by(User.subscription_plan)

            result = await db.execute(stmt)
            for plan, dau in result:
                daily_active_users.labels(plan=plan).set(dau)

            # MAU
            stmt = select(
                User.subscription_plan,
                func.count(func.distinct(Image.user_id))
            ).join(
                Image, Image.user_id == User.user_id
            ).where(
                Image.created_at >= month_start
            ).group_by(User.subscription_plan)

            result = await db.execute(stmt)
            for plan, mau in result:
                monthly_active_users.labels(plan=plan).set(mau)

    import asyncio
    asyncio.run(_update())
```

---

## SLI/SLO 설정

### 1. SLI (Service Level Indicators) 정의

```yaml
# prometheus/sli.yml

# API 가용성 SLI
- record: sli:api:availability:5m
  expr: |
    sum(rate(http_requests_total{status!~"5.."}[5m])) /
    sum(rate(http_requests_total[5m]))

# API 응답 시간 SLI (95th percentile < 500ms)
- record: sli:api:latency:5m
  expr: |
    histogram_quantile(0.95,
      rate(http_request_duration_seconds_bucket[5m])
    ) < 0.5

# 이미지 생성 성공률 SLI
- record: sli:generation:success_rate:5m
  expr: |
    sum(rate(image_generation_total{status="completed"}[5m])) /
    sum(rate(image_generation_total[5m]))
```

### 2. SLO (Service Level Objectives) 설정

```python
# SLO 정의
SLO_TARGETS = {
    'api_availability': {
        'target': 0.999,  # 99.9% 가용성
        'window': '30d',
        'error_budget': 0.001  # 0.1%
    },
    'api_latency_p95': {
        'target': 0.5,  # 500ms 이하
        'window': '30d'
    },
    'generation_success_rate': {
        'target': 0.95,  # 95% 성공률
        'window': '7d'
    }
}
```

### 3. Error Budget 모니터링

```yaml
# prometheus/rules/slo.yml
groups:
  - name: slo_recording
    interval: 1m
    rules:
      # Error Budget 계산
      - record: slo:error_budget:api_availability:30d
        expr: |
          1 - (
            (1 - sli:api:availability:5m) /
            (1 - 0.999)
          )

      # Error Budget 소진율
      - record: slo:error_budget_burn_rate:api_availability:1h
        expr: |
          (1 - sli:api:availability:5m) /
          (1 - 0.999) *
          (30 * 24)  # 30일을 시간으로 변환

  - name: slo_alerts
    interval: 1m
    rules:
      # Error Budget 빠르게 소진 중 (1시간에 5% 소진)
      - alert: ErrorBudgetBurnRateTooHigh
        expr: slo:error_budget_burn_rate:api_availability:1h > 14.4
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error budget burning too fast"
          description: "At current rate, error budget will be exhausted in {{ $value | humanizeDuration }}"

      # Error Budget 50% 소진
      - alert: ErrorBudgetHalfConsumed
        expr: slo:error_budget:api_availability:30d < 0.5
        labels:
          severity: warning
        annotations:
          summary: "50% of error budget consumed"
          description: "{{ $value | humanizePercentage }} error budget remaining"
```

---

## 테스트

### 1. 메트릭 테스트

```python
# tests/test_monitoring.py
import pytest
from prometheus_client import REGISTRY


def test_metrics_registered():
    """메트릭이 올바르게 등록되었는지 확인"""

    metric_names = [m.name for m in REGISTRY.collect()]

    assert 'http_requests_total' in metric_names
    assert 'image_generation_total' in metric_names
    assert 'celery_queue_length' in metric_names


@pytest.mark.asyncio
async def test_image_generation_metric(test_client):
    """이미지 생성 메트릭 기록 테스트"""

    from app.monitoring.metrics import image_generation_total

    # 초기 값
    before = image_generation_total.labels(
        model='flux-dev',
        plan='pro',
        status='completed'
    )._value.get()

    # 이미지 생성 요청
    response = test_client.post('/api/v1/generate', json={
        'prompt': 'test',
        'model': 'flux-dev'
    })

    assert response.status_code == 200

    # 메트릭 증가 확인
    after = image_generation_total.labels(
        model='flux-dev',
        plan='pro',
        status='completed'
    )._value.get()

    assert after == before + 1
```

### 2. 알림 테스트

```python
# tests/test_alerts.py
def test_high_api_latency_alert():
    """High API Latency 알림 테스트"""

    from prometheus_api_client import PrometheusConnect

    prom = PrometheusConnect(url="http://localhost:9090")

    # 알림 규칙 확인
    rules = prom.get_rules()

    high_latency_rule = next(
        (r for r in rules['data']['groups'][0]['rules']
         if r['name'] == 'HighAPILatency'),
        None
    )

    assert high_latency_rule is not None
    assert high_latency_rule['query'] == 'histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2'
```

---

## Phase 10 완료

### 구현 완료 항목

✅ **Prometheus 설정**
- Prometheus 설치 및 설정
- Node Exporter, cAdvisor
- Redis, PostgreSQL Exporter
- FastAPI 메트릭 통합
- GPU 메트릭 Exporter

✅ **Grafana 대시보드**
- Grafana 설치
- 데이터 소스 자동 설정
- API 대시보드
- GPU 대시보드
- 비즈니스 대시보드

✅ **Loki 로그 수집**
- Loki + Promtail 설치
- 구조화된 로깅 (JSON)
- Docker 컨테이너 로그 수집
- Request ID 추적

✅ **Alertmanager 알림**
- Alertmanager 설치 및 설정
- Alert Rules (API, Worker, System, Database, Business)
- Slack, PagerDuty, Email 통합
- 알림 억제 (Inhibition)

✅ **분산 추적**
- Jaeger 설치
- OpenTelemetry 통합
- 자동 계측 (FastAPI, SQLAlchemy, Redis)

✅ **비즈니스 메트릭**
- 매출 메트릭 (MRR, Revenue)
- 사용자 메트릭 (DAU, MAU, Churn)
- 크레딧 메트릭

✅ **SLI/SLO**
- SLI 정의 (가용성, 응답 시간, 성공률)
- SLO 목표 설정
- Error Budget 모니터링

✅ **테스트**
- 메트릭 테스트
- 알림 테스트

---

**다음 단계: Phase 11 - CI/CD & Deployment (ArgoCD, GitHub Actions)**
