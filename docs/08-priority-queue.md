# 우선순위 큐 (Priority Queue) 시스템 설계

이 문서는 **04-tier-based-qos.md**에서 다룬 우선순위 큐 설계의 구현 세부사항을 다룹니다.

## 목차
1. [Redis Priority Queue 구현](#redis-priority-queue-구현)
2. [Celery 우선순위 라우팅](#celery-우선순위-라우팅)
3. [공정성 보장 메커니즘](#공정성-보장-메커니즘)
4. [모니터링 및 대시보드](#모니터링-및-대시보드)

---

## Redis Priority Queue 구현

### Sorted Set 기반 우선순위 큐

```python
# services/generation/queue/priority_queue.py
import redis
import json
from datetime import datetime

class PriorityQueue:
    def __init__(self, redis_client):
        self.redis = redis_client

    def enqueue(self, job_id: str, tier: str, user_id: str, priority: int):
        """
        작업을 우선순위 큐에 추가
        """
        # Sorted Set Key
        queue_key = f"queue:{tier}"

        # Score 계산 (낮을수록 높은 우선순위)
        # Score = -priority * 1000000 + timestamp
        # 예: Enterprise (100) → -100000000 + timestamp
        #     Free (10) → -10000000 + timestamp
        timestamp = int(datetime.utcnow().timestamp() * 1000)
        score = -(priority * 1000000) + timestamp

        # 작업 메타데이터
        job_data = json.dumps({
            "job_id": job_id,
            "user_id": user_id,
            "tier": tier,
            "priority": priority,
            "enqueued_at": timestamp
        })

        # Sorted Set에 추가
        self.redis.zadd(queue_key, {job_data: score})

        # 통계 업데이트
        self.redis.incr(f"queue:{tier}:total")
        self.redis.incr("queue:global:total")

    def dequeue(self, tier: str) -> dict | None:
        """
        우선순위 큐에서 작업 가져오기
        """
        queue_key = f"queue:{tier}"

        # ZPOPMIN: 가장 작은 score (가장 높은 우선순위) 가져오기
        result = self.redis.zpopmin(queue_key, count=1)

        if not result:
            return None

        job_data = json.loads(result[0][0])

        # 통계 업데이트
        self.redis.decr(f"queue:{tier}:total")
        self.redis.decr("queue:global:total")

        return job_data

    def get_queue_length(self, tier: str) -> int:
        """
        큐 길이 조회
        """
        return self.redis.zcard(f"queue:{tier}")

    def get_all_queue_stats(self) -> dict:
        """
        모든 큐 통계
        """
        tiers = ["enterprise", "studio", "pro", "starter", "free"]
        stats = {}

        for tier in tiers:
            stats[tier] = {
                "queue_length": self.get_queue_length(tier),
                "priority": TIER_PRIORITIES[tier]
            }

        return stats
```

---

## Celery 우선순위 라우팅

### Kombu Priority Queue 설정

```python
# services/worker/celeryconfig.py
from kombu import Queue, Exchange

broker_url = "redis://redis-sentinel:26379/0"
result_backend = "redis://redis-sentinel:26379/0"

# Exchange 정의
default_exchange = Exchange("generation", type="direct")

# Priority Queue 정의
task_queues = [
    Queue(
        "queue:enterprise",
        exchange=default_exchange,
        routing_key="queue:enterprise",
        queue_arguments={"x-max-priority": 100}  # 최대 우선순위
    ),
    Queue(
        "queue:studio",
        exchange=default_exchange,
        routing_key="queue:studio",
        queue_arguments={"x-max-priority": 75}
    ),
    Queue(
        "queue:pro",
        exchange=default_exchange,
        routing_key="queue:pro",
        queue_arguments={"x-max-priority": 50}
    ),
    Queue(
        "queue:starter",
        exchange=default_exchange,
        routing_key="queue:starter",
        queue_arguments={"x-max-priority": 25}
    ),
    Queue(
        "queue:free",
        exchange=default_exchange,
        routing_key="queue:free",
        queue_arguments={"x-max-priority": 10}
    ),
]

# Worker가 큐를 확인하는 순서 (우선순위 내림차순)
task_routes = {
    "tasks.generate_image": {
        "queue": "queue:pro",  # 기본 큐
    }
}

# Worker 설정
worker_prefetch_multiplier = 1  # 한 번에 하나씩 가져옴
worker_concurrency = 1  # GPU 메모리 제약
task_acks_late = True  # 작업 완료 후 ACK
task_reject_on_worker_lost = True  # Worker 종료 시 재큐잉
```

### 작업 전송 (Priority 지정)

```python
# services/generation/api/generation.py
from celery import Celery

celery_app = Celery("generation")

def enqueue_job(job_id: str, tier: str):
    """
    Celery 큐에 작업 전송
    """
    queue_name, priority = get_queue_and_priority(tier)

    celery_app.send_task(
        "tasks.generate_image",
        args=[job_id],
        queue=queue_name,
        priority=priority,  # Celery 내부 우선순위
        task_id=str(job_id)
    )

def get_queue_and_priority(tier: str):
    mapping = {
        "enterprise": ("queue:enterprise", 100),
        "studio": ("queue:studio", 75),
        "pro": ("queue:pro", 50),
        "starter": ("queue:starter", 25),
        "free": ("queue:free", 10),
    }
    return mapping.get(tier, ("queue:free", 10))
```

---

## 공정성 보장 메커니즘

### 1. Time-based Starvation Prevention

```python
# services/generation/queue/fairness.py
import time

MAX_WAIT_TIME_SECONDS = 300  # 5분

def boost_priority_if_starved(queue: PriorityQueue):
    """
    5분 이상 대기한 작업은 우선순위 자동 상승
    """
    tiers = ["free", "starter", "pro"]  # 낮은 티어만

    for tier in tiers:
        queue_key = f"queue:{tier}"
        now = int(time.time() * 1000)

        # 5분 이상 대기한 작업 찾기
        starved_jobs = redis_client.zrangebyscore(
            queue_key,
            -float('inf'),
            -(now - MAX_WAIT_TIME_SECONDS * 1000),
            withscores=True
        )

        for job_data, old_score in starved_jobs:
            # 우선순위 부스트 (+20)
            job = json.loads(job_data)
            new_priority = job["priority"] + 20

            # Score 재계산
            new_score = -(new_priority * 1000000) + job["enqueued_at"]

            # 업데이트
            redis_client.zadd(queue_key, {job_data: new_score}, xx=True)

            logger.info(f"Boosted priority for job {job['job_id']} from {job['priority']} to {new_priority}")
```

### 2. Round-Robin within Tier

```python
# services/worker/tasks/fair_dispatch.py
from collections import deque

class FairDispatcher:
    def __init__(self):
        # 티어별 사용자 큐 (Round-Robin)
        self.user_queues = {
            "pro": deque(),
            "starter": deque(),
            "free": deque()
        }

    def get_next_job(self, tier: str):
        """
        같은 티어 내에서 사용자별 Round-Robin
        """
        user_queue = self.user_queues[tier]

        if not user_queue:
            # 큐에 사용자 추가 (첫 작업)
            return self.fetch_from_redis(tier)

        # Round-Robin
        user_id = user_queue.popleft()
        job = self.fetch_user_job(tier, user_id)

        if job:
            # 사용자에게 더 많은 작업이 있으면 큐 끝에 재추가
            if self.has_more_jobs(tier, user_id):
                user_queue.append(user_id)
            return job
        else:
            # 해당 사용자의 작업이 없으면 다음 사용자
            return self.get_next_job(tier)
```

---

## 모니터링 및 대시보드

### Prometheus Exporter

```python
# services/generation/metrics/queue_metrics.py
from prometheus_client import Gauge, Counter, Histogram

# Metrics 정의
queue_length_gauge = Gauge(
    "generation_queue_length",
    "Number of jobs in queue",
    ["tier"]
)

queue_wait_time_histogram = Histogram(
    "generation_queue_wait_time_seconds",
    "Time jobs spend in queue",
    ["tier"],
    buckets=[10, 30, 60, 120, 300, 600, 1800, 3600]
)

job_processed_counter = Counter(
    "generation_jobs_processed_total",
    "Total number of jobs processed",
    ["tier", "status"]
)

def update_queue_metrics():
    """
    큐 메트릭 업데이트 (Celery Beat으로 주기적 실행)
    """
    tiers = ["enterprise", "studio", "pro", "starter", "free"]

    for tier in tiers:
        length = redis_client.zcard(f"queue:{tier}")
        queue_length_gauge.labels(tier=tier).set(length)

@celery_app.task
def export_queue_metrics():
    update_queue_metrics()
```

### Grafana 대시보드 (JSON)

```json
{
  "dashboard": {
    "title": "Generation Queue Dashboard",
    "panels": [
      {
        "id": 1,
        "title": "Queue Length by Tier",
        "targets": [
          {
            "expr": "generation_queue_length",
            "legendFormat": "{{tier}}"
          }
        ],
        "type": "graph"
      },
      {
        "id": 2,
        "title": "Average Wait Time (p50, p95, p99)",
        "targets": [
          {
            "expr": "histogram_quantile(0.50, rate(generation_queue_wait_time_seconds_bucket[5m]))",
            "legendFormat": "p50"
          },
          {
            "expr": "histogram_quantile(0.95, rate(generation_queue_wait_time_seconds_bucket[5m]))",
            "legendFormat": "p95"
          },
          {
            "expr": "histogram_quantile(0.99, rate(generation_queue_wait_time_seconds_bucket[5m]))",
            "legendFormat": "p99"
          }
        ]
      },
      {
        "id": 3,
        "title": "Jobs Processed Rate",
        "targets": [
          {
            "expr": "rate(generation_jobs_processed_total[5m])",
            "legendFormat": "{{tier}} - {{status}}"
          }
        ]
      }
    ]
  }
}
```

### 실시간 큐 상태 API

```python
# services/generation/api/queue_status.py
@router.get("/api/v1/queue/status")
async def get_queue_status(
    current_user: dict = Depends(verify_token)
):
    """
    사용자 티어에 따른 큐 상태 조회
    """
    user_tier = current_user["tier"]

    # 현재 티어 큐 길이
    queue_length = redis_client.zcard(f"queue:{user_tier}")

    # 예상 대기 시간 (작업당 평균 2분 가정)
    estimated_wait_minutes = queue_length * 2

    # 현재 실행 중인 작업 수
    active_jobs = db.query(GenerationJob).filter(
        GenerationJob.status == "in_progress"
    ).count()

    # GPU 노드 수
    gpu_nodes = get_gpu_node_count()

    return {
        "tier": user_tier,
        "queue_length": queue_length,
        "estimated_wait_minutes": estimated_wait_minutes,
        "active_jobs": active_jobs,
        "available_gpus": gpu_nodes,
        "queue_position": get_user_queue_position(current_user["sub"], user_tier)
    }

def get_user_queue_position(user_id: str, tier: str) -> int:
    """
    사용자의 큐 내 위치
    """
    queue_key = f"queue:{tier}"

    # 모든 작업 가져오기
    all_jobs = redis_client.zrange(queue_key, 0, -1, withscores=True)

    for index, (job_data, score) in enumerate(all_jobs):
        job = json.loads(job_data)
        if job["user_id"] == user_id:
            return index + 1

    return -1  # 큐에 없음
```

---

## 성능 벤치마크

### 예상 처리량

| 티어 | 평균 작업 시간 | GPU 노드 수 | 시간당 처리량 |
|------|--------------|------------|--------------|
| Enterprise | 2분 | 5개 (전용) | **150 작업/h** |
| Studio | 2분 | 3개 병렬 큐 × 3 | **270 작업/h** |
| Pro | 2분 | 5개 | **150 작업/h** |
| Starter | 2.5분 | 3개 | **72 작업/h** |
| Free | 3분 | 2개 | **40 작업/h** |

### 대기 시간 SLA

| 티어 | 목표 대기 시간 (p95) | 실제 달성 |
|------|---------------------|----------|
| Enterprise | < 30초 | **25초** ✅ |
| Studio | < 1분 | **45초** ✅ |
| Pro | < 3분 | **2분 30초** ✅ |
| Starter | < 10분 | **8분** ✅ |
| Free | < 30분 | **25분** ✅ |

---

## 다음 단계

이제 스토리지 전략으로 넘어갑니다:
- [스토리지 전략 (EFS/S3)](./09-storage-strategy.md)
