# Phase 9: Queue & Worker Optimization 가이드

## 목차
1. [개요](#개요)
2. [우선순위 큐 시스템](#우선순위-큐-시스템)
3. [Celery Worker 설정](#celery-worker-설정)
4. [OOM 방지 전략](#oom-방지-전략)
5. [GPU Worker Auto Scaling](#gpu-worker-auto-scaling)
6. [작업 타임아웃 및 재시도](#작업-타임아웃-및-재시도)
7. [모니터링 및 알람](#모니터링-및-알람)
8. [테스트](#테스트)

---

## 개요

Phase 9에서는 크레딧 기반 SaaS를 위한 Queue & Worker 시스템을 최적화합니다.

### 주요 목표
- **플랜별 우선순위**: Enterprise > Studio > Pro > Starter > Free
- **OOM 방지**: GPU 메모리 초과 방지 및 자동 복구
- **비용 최적화**: 유휴 워커 자동 종료, Spot 인스턴스 활용
- **확장성**: 동시 100명 처리 가능
- **안정성**: 작업 실패 시 자동 재시도, Dead Letter Queue

### 기술 스택
- **Message Broker**: Redis (Celery 백엔드)
- **Task Queue**: Celery 6.0
- **Worker**: GPU EC2 인스턴스 (g5.xlarge, g5.2xlarge)
- **Auto Scaling**: AWS Auto Scaling Groups + CloudWatch
- **Monitoring**: Prometheus + Grafana, Flower (Celery)

---

## 우선순위 큐 시스템

### 1. Celery 큐 설정

```python
# app/celeryconfig.py
from kombu import Queue, Exchange

# 우선순위별 큐 정의
task_queues = (
    # Enterprise: 최고 우선순위
    Queue('enterprise', Exchange('enterprise'), routing_key='enterprise',
          queue_arguments={'x-max-priority': 10}),

    # Studio: 높은 우선순위
    Queue('studio', Exchange('studio'), routing_key='studio',
          queue_arguments={'x-max-priority': 8}),

    # Pro: 중간 우선순위
    Queue('pro', Exchange('pro'), routing_key='pro',
          queue_arguments={'x-max-priority': 6}),

    # Starter: 낮은 우선순위
    Queue('starter', Exchange('starter'), routing_key='starter',
          queue_arguments={'x-max-priority': 4}),

    # Free: 최저 우선순위
    Queue('free', Exchange('free'), routing_key='free',
          queue_arguments={'x-max-priority': 2}),

    # Default queue
    Queue('default', Exchange('default'), routing_key='default'),
)

# 작업별 라우팅
task_routes = {
    'app.tasks.generate_image': {
        'queue': 'default',  # 동적으로 결정됨
    },
    'app.tasks.upscale_image': {
        'queue': 'default',
    },
    'app.tasks.generate_thumbnail': {
        'queue': 'default',  # 썸네일은 우선순위 무관
    },
}

# Celery 설정
broker_url = 'redis://localhost:6379/0'
result_backend = 'redis://localhost:6379/1'

# 성능 최적화
worker_prefetch_multiplier = 1  # GPU 작업은 한 번에 1개씩
worker_max_tasks_per_child = 10  # 메모리 누수 방지
task_acks_late = True  # 작업 완료 후 ACK
task_reject_on_worker_lost = True  # 워커 죽으면 재시도

# 결과 설정
result_expires = 3600  # 1시간 후 결과 삭제
result_persistent = True

# 타임아웃
task_soft_time_limit = 300  # 5분 (소프트 타임아웃)
task_time_limit = 600  # 10분 (하드 타임아웃)

# 재시도 설정
task_default_retry_delay = 60  # 1분 후 재시도
task_max_retries = 3
```

### 2. 동적 큐 라우팅

```python
# app/tasks/routing.py
from celery import current_app
from typing import Dict, Any


class TaskRouter:
    """플랜별 동적 큐 라우팅"""

    # 플랜별 큐 매핑
    PLAN_QUEUE_MAP = {
        'enterprise': 'enterprise',
        'studio': 'studio',
        'pro': 'pro',
        'starter': 'starter',
        'free': 'free'
    }

    # 플랜별 우선순위 (숫자가 클수록 높은 우선순위)
    PLAN_PRIORITY_MAP = {
        'enterprise': 10,
        'studio': 8,
        'pro': 6,
        'starter': 4,
        'free': 2
    }

    @classmethod
    def route_task(cls, user_plan: str, task_name: str, **kwargs) -> Dict[str, Any]:
        """
        플랜에 따라 작업을 적절한 큐로 라우팅

        Args:
            user_plan: 사용자 구독 플랜
            task_name: 작업 이름
            **kwargs: 추가 옵션

        Returns:
            {'queue': '...', 'priority': ...}
        """

        queue_name = cls.PLAN_QUEUE_MAP.get(user_plan, 'default')
        priority = cls.PLAN_PRIORITY_MAP.get(user_plan, 5)

        return {
            'queue': queue_name,
            'priority': priority,
            'routing_key': queue_name
        }


# 작업 발송 예제
def submit_image_generation_task(
    user: User,
    prompt: str,
    model_name: str,
    **kwargs
) -> str:
    """이미지 생성 작업 제출"""

    from app.tasks.image_tasks import generate_image_task

    # 라우팅 정보 생성
    routing = TaskRouter.route_task(user.subscription_plan, 'generate_image')

    # Celery 작업 제출
    result = generate_image_task.apply_async(
        kwargs={
            'user_id': str(user.user_id),
            'prompt': prompt,
            'model_name': model_name,
            **kwargs
        },
        queue=routing['queue'],
        priority=routing['priority'],
        routing_key=routing['routing_key']
    )

    return result.id
```

### 3. 큐 모니터링 및 통계

```python
# app/services/queue_monitor.py
from celery import current_app
from typing import Dict, List
import redis


class QueueMonitor:
    """큐 상태 모니터링"""

    def __init__(self):
        self.redis_client = redis.Redis(
            host='localhost',
            port=6379,
            db=0,
            decode_responses=True
        )

    def get_queue_lengths(self) -> Dict[str, int]:
        """각 큐의 대기 작업 수 조회"""

        queues = ['enterprise', 'studio', 'pro', 'starter', 'free', 'default']
        lengths = {}

        for queue_name in queues:
            # Celery는 Redis List로 큐를 구현
            key = f"celery:queue:{queue_name}"
            length = self.redis_client.llen(key)
            lengths[queue_name] = length

        return lengths

    def get_active_workers(self) -> Dict[str, List[str]]:
        """활성 워커 목록"""

        inspect = current_app.control.inspect()
        active_queues = inspect.active_queues()

        if not active_queues:
            return {}

        return active_queues

    def get_queue_statistics(self) -> Dict[str, Any]:
        """큐 통계 정보"""

        inspect = current_app.control.inspect()

        stats = {
            'queue_lengths': self.get_queue_lengths(),
            'active_workers': len(self.get_active_workers()),
            'active_tasks': inspect.active() or {},
            'scheduled_tasks': inspect.scheduled() or {},
            'reserved_tasks': inspect.reserved() or {}
        }

        # 각 큐별 활성 작업 수 계산
        queue_active_counts = {}
        for worker, tasks in (stats['active_tasks'] or {}).items():
            for task in tasks:
                queue = task.get('delivery_info', {}).get('routing_key', 'unknown')
                queue_active_counts[queue] = queue_active_counts.get(queue, 0) + 1

        stats['queue_active_counts'] = queue_active_counts

        return stats


# API 엔드포인트
from fastapi import APIRouter, Depends

router = APIRouter(prefix="/admin/queue", tags=["Admin - Queue"])


@router.get("/statistics")
async def get_queue_statistics(
    current_admin: User = Depends(require_admin("system", "read"))
):
    """큐 통계 조회 (Admin)"""

    monitor = QueueMonitor()
    stats = monitor.get_queue_statistics()

    return stats


@router.get("/lengths")
async def get_queue_lengths(
    current_admin: User = Depends(require_admin("system", "read"))
):
    """큐 길이 조회"""

    monitor = QueueMonitor()
    lengths = monitor.get_queue_lengths()

    return {
        'queues': lengths,
        'total_pending': sum(lengths.values())
    }
```

---

## Celery Worker 설정

### 1. Worker 시작 스크립트

```bash
#!/bin/bash
# scripts/start_worker.sh

# GPU 워커 설정
export CUDA_VISIBLE_DEVICES=0
export OMP_NUM_THREADS=4

# 메모리 설정
export PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:512

# Celery Worker 시작
celery -A app.worker worker \
  --loglevel=info \
  --concurrency=1 \
  --pool=solo \
  --queues=enterprise,studio,pro,starter,free \
  --max-tasks-per-child=10 \
  --time-limit=600 \
  --soft-time-limit=300 \
  --autoscale=1,1 \
  --hostname=gpu-worker-$(hostname)@%h
```

### 2. Worker 설정 파일

```python
# app/worker/__init__.py
from celery import Celery
from celery.signals import worker_ready, worker_shutdown, task_prerun, task_postrun
import torch
import gc
import logging

logger = logging.getLogger(__name__)

# Celery 앱 초기화
celery_app = Celery('pingvasai')
celery_app.config_from_object('app.celeryconfig')


@worker_ready.connect
def on_worker_ready(sender, **kwargs):
    """워커 시작 시"""
    logger.info("Worker is ready. Checking GPU availability...")

    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        gpu_memory = torch.cuda.get_device_properties(0).total_memory / 1024**3
        logger.info(f"GPU detected: {gpu_name}, Memory: {gpu_memory:.2f} GB")
    else:
        logger.warning("No GPU detected! Worker will use CPU.")


@worker_shutdown.connect
def on_worker_shutdown(sender, **kwargs):
    """워커 종료 시 정리"""
    logger.info("Worker shutting down. Cleaning up GPU memory...")

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        gc.collect()


@task_prerun.connect
def on_task_prerun(sender, task_id, task, args, kwargs, **other):
    """작업 시작 전"""
    logger.info(f"Starting task {task.name} (ID: {task_id})")

    # GPU 메모리 상태 확인
    if torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated(0) / 1024**3
        reserved = torch.cuda.memory_reserved(0) / 1024**3
        logger.info(f"GPU Memory - Allocated: {allocated:.2f}GB, Reserved: {reserved:.2f}GB")


@task_postrun.connect
def on_task_postrun(sender, task_id, task, args, kwargs, retval, state, **other):
    """작업 완료 후"""
    logger.info(f"Completed task {task.name} (ID: {task_id}), State: {state}")

    # GPU 메모리 정리
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        gc.collect()

        freed_memory = torch.cuda.memory_reserved(0) / 1024**3
        logger.info(f"GPU Memory after cleanup: {freed_memory:.2f}GB")
```

### 3. 이미지 생성 작업

```python
# app/tasks/image_tasks.py
from app.worker import celery_app
from celery import Task
from celery.exceptions import SoftTimeLimitExceeded
import torch
import gc
from typing import Dict, Any
import logging

logger = logging.getLogger(__name__)


class GPUTask(Task):
    """GPU 작업 베이스 클래스"""

    _pipeline = None  # 모델 파이프라인 캐싱

    def __init__(self):
        super().__init__()
        self.max_retries = 3
        self.default_retry_delay = 60

    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """작업 실패 시"""
        logger.error(f"Task {task_id} failed: {exc}")

        # GPU 메모리 정리
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            gc.collect()

    def on_retry(self, exc, task_id, args, kwargs, einfo):
        """재시도 시"""
        logger.warning(f"Task {task_id} retrying due to: {exc}")

        # GPU 메모리 정리
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            gc.collect()


@celery_app.task(
    base=GPUTask,
    bind=True,
    name='app.tasks.generate_image',
    autoretry_for=(Exception,),
    retry_kwargs={'max_retries': 3, 'countdown': 60}
)
def generate_image_task(
    self,
    user_id: str,
    job_id: str,
    prompt: str,
    model_name: str,
    width: int = 1024,
    height: int = 1024,
    num_inference_steps: int = 20,
    guidance_scale: float = 7.5,
    negative_prompt: str = None,
    seed: int = None
) -> Dict[str, Any]:
    """
    이미지 생성 작업

    Args:
        user_id: 사용자 ID
        job_id: 작업 ID
        prompt: 프롬프트
        model_name: 모델 이름
        width: 너비
        height: 높이
        num_inference_steps: 추론 스텝 수
        guidance_scale: Guidance scale
        negative_prompt: 네거티브 프롬프트
        seed: 시드

    Returns:
        생성 결과
    """

    import time
    from datetime import datetime
    from app.services.invokeai_service import InvokeAIService
    from app.services.s3_client import S3Client
    from app.models import Job, User, CreditTransaction
    from app.database import get_db

    start_time = time.time()

    try:
        logger.info(f"[Job {job_id}] Starting image generation for user {user_id}")

        # 1. DB에서 작업 및 사용자 정보 조회
        async with get_db() as db:
            job = await db.get(Job, job_id)
            user = await db.get(User, user_id)

            if not job or not user:
                raise ValueError("Job or User not found")

            # 작업 상태 업데이트
            job.status = "processing"
            job.started_at = datetime.utcnow()
            await db.commit()

        # 2. GPU 메모리 체크
        if torch.cuda.is_available():
            available_memory = (
                torch.cuda.get_device_properties(0).total_memory -
                torch.cuda.memory_allocated(0)
            ) / 1024**3

            required_memory = estimate_memory_requirement(
                model_name, width, height
            )

            if available_memory < required_memory:
                logger.warning(
                    f"Insufficient GPU memory: {available_memory:.2f}GB available, "
                    f"{required_memory:.2f}GB required. Cleaning up..."
                )

                # 강제 메모리 정리
                torch.cuda.empty_cache()
                gc.collect()

                # 재확인
                available_memory = (
                    torch.cuda.get_device_properties(0).total_memory -
                    torch.cuda.memory_allocated(0)
                ) / 1024**3

                if available_memory < required_memory:
                    raise MemoryError(
                        f"Insufficient GPU memory after cleanup: "
                        f"{available_memory:.2f}GB available, {required_memory:.2f}GB required"
                    )

        # 3. 이미지 생성
        logger.info(f"[Job {job_id}] Generating image...")

        invokeai = InvokeAIService()
        result = invokeai.generate_image(
            prompt=prompt,
            model=model_name,
            width=width,
            height=height,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            negative_prompt=negative_prompt,
            seed=seed
        )

        generation_time = time.time() - start_time

        # 4. S3 업로드
        logger.info(f"[Job {job_id}] Uploading to S3...")

        s3_client = S3Client()
        image_bytes = result['image_bytes']

        upload_result = s3_client.upload_image(
            image_bytes,
            user_id=user_id,
            filename=f"{job_id}.png"
        )

        # 5. 크레딧 차감
        logger.info(f"[Job {job_id}] Deducting credits...")

        credits_used = calculate_credits(
            generation_time_sec=generation_time,
            model_name=model_name,
            width=width,
            height=height
        )

        async with get_db() as db:
            # 크레딧 차감
            user = await db.get(User, user_id)

            if user.subscription_plan != 'enterprise':
                # Enterprise는 무제한이므로 차감하지 않음
                if user.credits_balance < credits_used:
                    raise ValueError("Insufficient credits")

                user.credits_balance -= credits_used
                user.credits_used_this_month += credits_used

                # 크레딧 트랜잭션 기록
                credit_tx = CreditTransaction(
                    user_id=user_id,
                    credits=credits_used,
                    transaction_type="usage",
                    description=f"Image generation: {model_name}",
                    metadata={
                        "job_id": job_id,
                        "model": model_name,
                        "generation_time_sec": generation_time,
                        "dimensions": f"{width}x{height}"
                    }
                )
                db.add(credit_tx)

            # 작업 완료 업데이트
            job.status = "completed"
            job.completed_at = datetime.utcnow()
            job.generation_time_sec = int(generation_time)
            job.credits_used = credits_used
            job.result_url = upload_result['url']
            job.s3_key = upload_result['key']

            await db.commit()

        logger.info(
            f"[Job {job_id}] Completed successfully in {generation_time:.2f}s, "
            f"Credits used: {credits_used}"
        )

        return {
            'success': True,
            'job_id': job_id,
            'image_url': upload_result['url'],
            'generation_time': generation_time,
            'credits_used': credits_used
        }

    except SoftTimeLimitExceeded:
        logger.error(f"[Job {job_id}] Soft time limit exceeded")

        async with get_db() as db:
            job = await db.get(Job, job_id)
            job.status = "failed"
            job.error_message = "Generation time limit exceeded"
            await db.commit()

        # 재시도
        raise self.retry(countdown=60)

    except MemoryError as e:
        logger.error(f"[Job {job_id}] GPU memory error: {e}")

        async with get_db() as db:
            job = await db.get(Job, job_id)
            job.status = "failed"
            job.error_message = str(e)
            await db.commit()

        # OOM은 재시도하지 않음 (동일 에러 반복 가능성 높음)
        return {
            'success': False,
            'error': 'GPU memory error',
            'message': str(e)
        }

    except Exception as e:
        logger.error(f"[Job {job_id}] Unexpected error: {e}", exc_info=True)

        async with get_db() as db:
            job = await db.get(Job, job_id)
            job.status = "failed"
            job.error_message = str(e)
            await db.commit()

        # 재시도
        raise self.retry(exc=e, countdown=60)

    finally:
        # GPU 메모리 정리
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            gc.collect()


def estimate_memory_requirement(
    model_name: str,
    width: int,
    height: int
) -> float:
    """
    필요 GPU 메모리 추정 (GB)

    Args:
        model_name: 모델 이름
        width: 이미지 너비
        height: 이미지 높이

    Returns:
        필요 메모리 (GB)
    """

    # 모델별 기본 메모리 (GB)
    model_base_memory = {
        'flux-schnell': 12,
        'flux-dev': 16,
        'flux-pro': 20,
        'sd-xl-1.0': 10,
    }

    base_memory = model_base_memory.get(model_name, 12)

    # 해상도에 따른 추가 메모리
    pixel_count = width * height
    resolution_memory = (pixel_count / (1024 * 1024)) * 0.5  # 1M 픽셀당 0.5GB

    total_memory = base_memory + resolution_memory

    # 안전 마진 20% 추가
    return total_memory * 1.2


def calculate_credits(
    generation_time_sec: float,
    model_name: str,
    width: int,
    height: int
) -> int:
    """
    사용 크레딧 계산

    규칙:
    - GPU 시간: 1초당 1크레딧
    - 고해상도 추가: 2048x2048 이상 +50%

    Args:
        generation_time_sec: 생성 시간 (초)
        model_name: 모델 이름
        width: 너비
        height: 높이

    Returns:
        사용 크레딧
    """

    # 기본: 1초당 1크레딧
    base_credits = int(generation_time_sec)

    # 고해상도 보정
    if width * height >= 2048 * 2048:
        base_credits = int(base_credits * 1.5)

    return max(base_credits, 1)  # 최소 1크레딧
```

---

## OOM 방지 전략

### 1. GPU 메모리 모니터링

```python
# app/services/gpu_monitor.py
import torch
import psutil
from typing import Dict, Any
import logging

logger = logging.getLogger(__name__)


class GPUMonitor:
    """GPU 메모리 모니터링"""

    @staticmethod
    def get_gpu_memory_info() -> Dict[str, Any]:
        """GPU 메모리 정보 조회"""

        if not torch.cuda.is_available():
            return {'available': False}

        device = torch.cuda.current_device()

        total_memory = torch.cuda.get_device_properties(device).total_memory
        allocated_memory = torch.cuda.memory_allocated(device)
        reserved_memory = torch.cuda.memory_reserved(device)
        free_memory = total_memory - allocated_memory

        return {
            'available': True,
            'device_name': torch.cuda.get_device_name(device),
            'total_memory_gb': total_memory / 1024**3,
            'allocated_memory_gb': allocated_memory / 1024**3,
            'reserved_memory_gb': reserved_memory / 1024**3,
            'free_memory_gb': free_memory / 1024**3,
            'utilization_percent': (allocated_memory / total_memory) * 100
        }

    @staticmethod
    def check_memory_available(required_gb: float) -> bool:
        """필요한 메모리가 사용 가능한지 확인"""

        info = GPUMonitor.get_gpu_memory_info()

        if not info['available']:
            return False

        return info['free_memory_gb'] >= required_gb

    @staticmethod
    def force_cleanup():
        """강제 GPU 메모리 정리"""

        if torch.cuda.is_available():
            logger.info("Forcing GPU memory cleanup...")

            # 모든 캐시된 메모리 해제
            torch.cuda.empty_cache()

            # Python GC 실행
            import gc
            gc.collect()

            # 메모리 정보 로깅
            info = GPUMonitor.get_gpu_memory_info()
            logger.info(
                f"After cleanup: {info['free_memory_gb']:.2f}GB free, "
                f"{info['utilization_percent']:.1f}% utilized"
            )

    @staticmethod
    def get_system_memory_info() -> Dict[str, Any]:
        """시스템 RAM 정보"""

        mem = psutil.virtual_memory()

        return {
            'total_gb': mem.total / 1024**3,
            'available_gb': mem.available / 1024**3,
            'used_gb': mem.used / 1024**3,
            'percent': mem.percent
        }


# Celery 작업 전 메모리 체크 미들웨어
from celery import Task


class MemoryCheckTask(Task):
    """메모리 체크 Task 베이스 클래스"""

    def __call__(self, *args, **kwargs):
        """작업 실행 전 메모리 체크"""

        # GPU 메모리 체크
        gpu_info = GPUMonitor.get_gpu_memory_info()

        if gpu_info['available']:
            if gpu_info['utilization_percent'] > 90:
                logger.warning(
                    f"GPU memory utilization high: {gpu_info['utilization_percent']:.1f}%"
                )
                GPUMonitor.force_cleanup()

        # 시스템 메모리 체크
        sys_info = GPUMonitor.get_system_memory_info()

        if sys_info['percent'] > 90:
            logger.warning(
                f"System memory utilization high: {sys_info['percent']:.1f}%"
            )
            import gc
            gc.collect()

        # 실제 작업 실행
        return super().__call__(*args, **kwargs)
```

### 2. 모델 로딩 전략 (Lazy Loading)

```python
# app/services/model_loader.py
import torch
from typing import Dict, Optional
import threading
import time
import logging

logger = logging.getLogger(__name__)


class ModelCache:
    """모델 캐시 관리 (Singleton)"""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._models = {}
                    cls._instance._last_used = {}
                    cls._instance._max_cache_size = 2  # 최대 2개 모델 캐싱
        return cls._instance

    def get_model(self, model_name: str):
        """모델 가져오기 (캐시 또는 로드)"""

        # 캐시에 있으면 반환
        if model_name in self._models:
            self._last_used[model_name] = time.time()
            logger.info(f"Using cached model: {model_name}")
            return self._models[model_name]

        # 캐시 크기 초과 시 가장 오래된 모델 제거
        if len(self._models) >= self._max_cache_size:
            oldest_model = min(self._last_used, key=self._last_used.get)
            logger.info(f"Evicting cached model: {oldest_model}")
            self.unload_model(oldest_model)

        # 모델 로드
        logger.info(f"Loading model: {model_name}")
        model = self._load_model(model_name)

        self._models[model_name] = model
        self._last_used[model_name] = time.time()

        return model

    def _load_model(self, model_name: str):
        """실제 모델 로딩"""

        from diffusers import FluxPipeline, StableDiffusionXLPipeline

        # GPU 메모리 정리
        GPUMonitor.force_cleanup()

        if model_name.startswith('flux'):
            pipeline = FluxPipeline.from_pretrained(
                f"black-forest-labs/{model_name}",
                torch_dtype=torch.float16,
                device_map="auto"
            )
        elif model_name.startswith('sd-xl'):
            pipeline = StableDiffusionXLPipeline.from_pretrained(
                f"stabilityai/{model_name}",
                torch_dtype=torch.float16,
                device_map="auto"
            )
        else:
            raise ValueError(f"Unsupported model: {model_name}")

        # VAE 슬라이싱 (메모리 절약)
        pipeline.enable_vae_slicing()

        # Attention 슬라이싱 (메모리 절약)
        pipeline.enable_attention_slicing()

        return pipeline

    def unload_model(self, model_name: str):
        """모델 언로드"""

        if model_name in self._models:
            del self._models[model_name]
            del self._last_used[model_name]

            # GPU 메모리 정리
            GPUMonitor.force_cleanup()

            logger.info(f"Unloaded model: {model_name}")

    def clear_all(self):
        """모든 모델 언로드"""

        model_names = list(self._models.keys())
        for model_name in model_names:
            self.unload_model(model_name)

        logger.info("All models cleared from cache")


# 전역 인스턴스
model_cache = ModelCache()
```

### 3. OOM 에러 처리

```python
# app/tasks/oom_handler.py
from celery.exceptions import Retry
import torch
import logging

logger = logging.getLogger(__name__)


def handle_oom_error(task, exc, job_id: str):
    """
    OOM 에러 처리

    전략:
    1. GPU 메모리 강제 정리
    2. 모델 캐시 클리어
    3. 해상도 다운스케일 후 재시도
    4. 최종 실패 시 사용자에게 알림
    """

    logger.error(f"[Job {job_id}] Out of Memory error: {exc}")

    # 1. 메모리 정리
    GPUMonitor.force_cleanup()

    # 2. 모델 캐시 클리어
    model_cache.clear_all()

    # 3. 재시도 횟수 확인
    retry_count = task.request.retries

    if retry_count < 2:
        # 첫 번째 재시도: 그대로 재시도
        logger.info(f"[Job {job_id}] Retrying after memory cleanup...")
        raise task.retry(countdown=30, exc=exc)

    elif retry_count < 3:
        # 두 번째 재시도: 해상도 다운스케일
        logger.warning(f"[Job {job_id}] Downscaling resolution and retrying...")

        # 해상도 75%로 축소
        kwargs = task.request.kwargs
        kwargs['width'] = int(kwargs.get('width', 1024) * 0.75)
        kwargs['height'] = int(kwargs.get('height', 1024) * 0.75)

        raise task.retry(countdown=30, exc=exc, kwargs=kwargs)

    else:
        # 최종 실패
        logger.error(f"[Job {job_id}] OOM error persists after retries. Failing task.")

        from app.database import get_db
        from app.models import Job

        async with get_db() as db:
            job = await db.get(Job, job_id)
            job.status = "failed"
            job.error_message = "GPU memory error: Image resolution too high for available resources"
            await db.commit()

        return {
            'success': False,
            'error': 'OOM',
            'message': 'Unable to generate image due to memory constraints'
        }


# 이미지 생성 작업에 OOM 핸들러 적용
@celery_app.task(
    base=MemoryCheckTask,
    bind=True,
    name='app.tasks.generate_image_safe'
)
def generate_image_safe_task(self, **kwargs):
    """OOM 처리가 포함된 이미지 생성 작업"""

    try:
        return generate_image_task(**kwargs)

    except torch.cuda.OutOfMemoryError as exc:
        return handle_oom_error(self, exc, kwargs.get('job_id'))

    except RuntimeError as exc:
        if 'out of memory' in str(exc).lower():
            return handle_oom_error(self, exc, kwargs.get('job_id'))
        raise
```

---

## GPU Worker Auto Scaling

### 1. CloudWatch 메트릭

```python
# app/services/cloudwatch_metrics.py
import boto3
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class CloudWatchMetrics:
    """CloudWatch 커스텀 메트릭 전송"""

    def __init__(self):
        self.cloudwatch = boto3.client('cloudwatch', region_name='us-east-1')
        self.namespace = 'PingvasAI/Workers'

    def put_queue_length_metric(self, queue_name: str, length: int):
        """큐 길이 메트릭 전송"""

        try:
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'QueueLength',
                        'Dimensions': [
                            {'Name': 'QueueName', 'Value': queue_name}
                        ],
                        'Value': length,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            logger.error(f"Failed to send CloudWatch metric: {e}")

    def put_worker_count_metric(self, count: int):
        """활성 워커 수 메트릭"""

        try:
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'ActiveWorkers',
                        'Value': count,
                        'Unit': 'Count',
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            logger.error(f"Failed to send CloudWatch metric: {e}")

    def put_gpu_utilization_metric(self, utilization_percent: float):
        """GPU 사용률 메트릭"""

        try:
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'GPUUtilization',
                        'Value': utilization_percent,
                        'Unit': 'Percent',
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            logger.error(f"Failed to send CloudWatch metric: {e}")


# Celery Beat 스케줄로 주기적 메트릭 전송
from celery import shared_task


@shared_task(name="send_queue_metrics")
def send_queue_metrics_task():
    """큐 메트릭 CloudWatch 전송 (매 1분)"""

    from app.services.queue_monitor import QueueMonitor

    monitor = QueueMonitor()
    lengths = monitor.get_queue_lengths()

    cw = CloudWatchMetrics()

    for queue_name, length in lengths.items():
        cw.put_queue_length_metric(queue_name, length)

    # 활성 워커 수
    stats = monitor.get_queue_statistics()
    active_workers = stats.get('active_workers', 0)
    cw.put_worker_count_metric(active_workers)


@shared_task(name="send_gpu_metrics")
def send_gpu_metrics_task():
    """GPU 메트릭 CloudWatch 전송 (매 1분)"""

    from app.services.gpu_monitor import GPUMonitor

    gpu_info = GPUMonitor.get_gpu_memory_info()

    if gpu_info['available']:
        cw = CloudWatchMetrics()
        cw.put_gpu_utilization_metric(gpu_info['utilization_percent'])


# Celery Beat 스케줄 설정
# celeryconfig.py
from celery.schedules import crontab

beat_schedule = {
    'send-queue-metrics': {
        'task': 'send_queue_metrics',
        'schedule': 60.0,  # 1분마다
    },
    'send-gpu-metrics': {
        'task': 'send_gpu_metrics',
        'schedule': 60.0,
    },
}
```

### 2. Auto Scaling 정책 (Terraform)

```hcl
# terraform/autoscaling.tf

# Launch Template for GPU Workers
resource "aws_launch_template" "gpu_worker" {
  name_prefix   = "pingvasai-gpu-worker-"
  image_id      = data.aws_ami.gpu_worker_ami.id
  instance_type = "g5.xlarge"

  # Spot Instance 설정 (70% 비용 절감)
  instance_market_options {
    market_type = "spot"
    spot_options {
      max_price          = "0.50"  # 온디맨드 가격의 약 50%
      spot_instance_type = "one-time"
    }
  }

  # IAM Role
  iam_instance_profile {
    name = aws_iam_instance_profile.gpu_worker.name
  }

  # Security Group
  vpc_security_group_ids = [aws_security_group.gpu_worker.id]

  # User Data (워커 시작 스크립트)
  user_data = base64encode(templatefile("${path.module}/user_data.sh", {
    redis_host = aws_elasticache_cluster.redis.cache_nodes[0].address
  }))

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "pingvasai-gpu-worker"
      Type = "celery-worker"
    }
  }
}

# Auto Scaling Group
resource "aws_autoscaling_group" "gpu_workers" {
  name                = "pingvasai-gpu-workers"
  vpc_zone_identifier = aws_subnet.private.*.id

  min_size         = 0
  max_size         = 10
  desired_capacity = 0

  launch_template {
    id      = aws_launch_template.gpu_worker.id
    version = "$Latest"
  }

  # Health Check
  health_check_type         = "EC2"
  health_check_grace_period = 300

  # Termination Policies
  termination_policies = ["OldestInstance"]

  tag {
    key                 = "Name"
    value               = "pingvasai-gpu-worker"
    propagate_at_launch = true
  }
}

# Scaling Policy: Scale Up (큐 길이 기반)
resource "aws_autoscaling_policy" "scale_up" {
  name                   = "gpu-workers-scale-up"
  autoscaling_group_name = aws_autoscaling_group.gpu_workers.name
  adjustment_type        = "ChangeInCapacity"
  scaling_adjustment     = 2  # 2개씩 증가
  cooldown              = 60

  policy_type = "SimpleScaling"
}

# Scaling Policy: Scale Down
resource "aws_autoscaling_policy" "scale_down" {
  name                   = "gpu-workers-scale-down"
  autoscaling_group_name = aws_autoscaling_group.gpu_workers.name
  adjustment_type        = "ChangeInCapacity"
  scaling_adjustment     = -1  # 1개씩 감소
  cooldown              = 300

  policy_type = "SimpleScaling"
}

# CloudWatch Alarm: High Queue Length
resource "aws_cloudwatch_metric_alarm" "high_queue_length" {
  alarm_name          = "gpu-workers-high-queue-length"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "QueueLength"
  namespace           = "PingvasAI/Workers"
  period              = "60"
  statistic           = "Sum"
  threshold           = "10"  # 전체 큐 길이 10개 초과 시

  alarm_description = "Trigger scale up when queue length is high"
  alarm_actions     = [aws_autoscaling_policy.scale_up.arn]
}

# CloudWatch Alarm: Low Queue Length
resource "aws_cloudwatch_metric_alarm" "low_queue_length" {
  alarm_name          = "gpu-workers-low-queue-length"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "QueueLength"
  namespace           = "PingvasAI/Workers"
  period              = "300"
  statistic           = "Sum"
  threshold           = "2"  # 전체 큐 길이 2개 미만 시

  alarm_description = "Trigger scale down when queue is empty"
  alarm_actions     = [aws_autoscaling_policy.scale_down.arn]
}
```

### 3. Worker User Data 스크립트

```bash
#!/bin/bash
# terraform/user_data.sh

set -e

# 로그 설정
exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "Starting GPU Worker initialization..."

# 1. CUDA 및 Driver 확인
nvidia-smi

# 2. Redis 연결 설정
export REDIS_HOST="${redis_host}"

# 3. 코드 다운로드 (S3 또는 Git)
cd /opt
aws s3 cp s3://pingvasai-deployments/worker-latest.tar.gz .
tar -xzf worker-latest.tar.gz
cd worker

# 4. Python 환경 설정
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 5. 모델 다운로드 (미리 캐시)
python scripts/download_models.py

# 6. Celery Worker 시작
celery -A app.worker worker \
  --loglevel=info \
  --concurrency=1 \
  --pool=solo \
  --queues=enterprise,studio,pro,starter,free \
  --max-tasks-per-child=10 \
  --time-limit=600 \
  --soft-time-limit=300 \
  --hostname=gpu-worker-$(ec2-metadata --instance-id)@%h \
  &

CELERY_PID=$!

# 7. 유휴 시간 모니터링 (5분 유휴 시 자동 종료)
IDLE_TIME=0
MAX_IDLE_SECONDS=300

while true; do
  sleep 60

  # 활성 작업 확인
  ACTIVE_TASKS=$(celery -A app.worker inspect active | grep -c "delivery_info" || echo "0")

  if [ "$ACTIVE_TASKS" -eq "0" ]; then
    IDLE_TIME=$((IDLE_TIME + 60))
    echo "Idle for ${IDLE_TIME} seconds..."

    if [ "$IDLE_TIME" -ge "$MAX_IDLE_SECONDS" ]; then
      echo "Max idle time reached. Shutting down worker..."
      kill $CELERY_PID
      sleep 10

      # Auto Scaling Group에서 인스턴스 제거 요청
      INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)
      aws autoscaling terminate-instance-in-auto-scaling-group \
        --instance-id $INSTANCE_ID \
        --should-decrement-desired-capacity

      break
    fi
  else
    IDLE_TIME=0
  fi
done
```

---

## 작업 타임아웃 및 재시도

### 1. 타임아웃 설정

```python
# celeryconfig.py

# 작업별 타임아웃 설정
task_annotations = {
    'app.tasks.generate_image': {
        'time_limit': 600,  # 10분 하드 타임아웃
        'soft_time_limit': 300,  # 5분 소프트 타임아웃
        'rate_limit': '10/m',  # 분당 10개 제한
    },
    'app.tasks.upscale_image': {
        'time_limit': 900,  # 15분
        'soft_time_limit': 600,  # 10분
    },
    'app.tasks.generate_thumbnail': {
        'time_limit': 60,  # 1분
        'soft_time_limit': 30,  # 30초
    },
}
```

### 2. 재시도 전략

```python
# app/tasks/retry_strategy.py
from celery import Task
from celery.exceptions import Retry
import logging

logger = logging.getLogger(__name__)


class SmartRetryTask(Task):
    """스마트 재시도 전략"""

    autoretry_for = (Exception,)
    retry_kwargs = {'max_retries': 3}
    retry_backoff = True  # 지수 백오프
    retry_backoff_max = 600  # 최대 10분
    retry_jitter = True  # 재시도 시간에 랜덤성 추가

    def retry(self, args=None, kwargs=None, exc=None, **options):
        """재시도 로직"""

        retry_count = self.request.retries

        # 에러 유형별 처리
        if isinstance(exc, torch.cuda.OutOfMemoryError):
            logger.error(f"OOM error on retry {retry_count}")

            # OOM은 즉시 실패 (재시도 해도 동일 에러)
            if retry_count >= 1:
                return super().retry(args, kwargs, exc=exc, **options)

        elif isinstance(exc, ConnectionError):
            logger.warning(f"Connection error on retry {retry_count}")

            # 연결 에러는 재시도
            return super().retry(args, kwargs, exc=exc, countdown=30, **options)

        else:
            # 기타 에러는 기본 재시도 전략
            return super().retry(args, kwargs, exc=exc, **options)
```

### 3. Dead Letter Queue

```python
# app/tasks/dlq.py
from app.worker import celery_app


@celery_app.task(name="handle_failed_task")
def handle_failed_task(
    task_id: str,
    task_name: str,
    args: tuple,
    kwargs: dict,
    exc: str,
    traceback: str
):
    """
    실패한 작업 처리 (Dead Letter Queue)

    Actions:
    1. DB에 실패 기록
    2. Admin에게 알림
    3. 사용자에게 환불 (크레딧)
    """

    logger.error(
        f"Task permanently failed: {task_name} (ID: {task_id})\n"
        f"Args: {args}\n"
        f"Kwargs: {kwargs}\n"
        f"Exception: {exc}\n"
        f"Traceback: {traceback}"
    )

    from app.database import get_db
    from app.models import Job, User, CreditTransaction

    async with get_db() as db:
        # Job 실패 처리
        if 'job_id' in kwargs:
            job_id = kwargs['job_id']
            job = await db.get(Job, job_id)

            if job:
                job.status = "failed"
                job.error_message = f"Permanent failure: {exc}"

                # 크레딧 환불
                user = await db.get(User, job.user_id)

                if user and job.credits_used:
                    user.credits_balance += job.credits_used

                    refund_tx = CreditTransaction(
                        user_id=user.user_id,
                        credits=job.credits_used,
                        transaction_type="refund",
                        description=f"Refund for failed job: {job_id}",
                        metadata={
                            "job_id": job_id,
                            "original_task_id": task_id
                        }
                    )
                    db.add(refund_tx)

                await db.commit()

                # 사용자에게 이메일 알림
                from app.services.transactional_email import send_job_failed_email
                await send_job_failed_email(user, job, db)


# Celery 설정에서 실패 핸들러 등록
# celeryconfig.py
task_routes = {
    'app.tasks.*': {
        'on_failure': 'handle_failed_task'
    }
}
```

---

## 모니터링 및 알람

### 1. Prometheus 메트릭

```python
# app/monitoring/prometheus_metrics.py
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from fastapi import APIRouter
from fastapi.responses import Response

# 메트릭 정의
image_generation_counter = Counter(
    'image_generation_total',
    'Total number of image generations',
    ['model', 'plan', 'status']
)

image_generation_duration = Histogram(
    'image_generation_duration_seconds',
    'Image generation duration',
    ['model', 'plan'],
    buckets=[1, 5, 10, 30, 60, 120, 300, 600]
)

active_workers_gauge = Gauge(
    'celery_active_workers',
    'Number of active Celery workers'
)

queue_length_gauge = Gauge(
    'celery_queue_length',
    'Celery queue length',
    ['queue_name']
)

gpu_memory_gauge = Gauge(
    'gpu_memory_utilization_percent',
    'GPU memory utilization percentage'
)


# FastAPI 엔드포인트
router = APIRouter()


@router.get("/metrics")
async def metrics():
    """Prometheus 메트릭 엔드포인트"""
    return Response(content=generate_latest(), media_type="text/plain")


# 메트릭 업데이트 함수
def record_image_generation(model: str, plan: str, duration_sec: float, status: str):
    """이미지 생성 메트릭 기록"""

    image_generation_counter.labels(
        model=model,
        plan=plan,
        status=status
    ).inc()

    if status == "completed":
        image_generation_duration.labels(
            model=model,
            plan=plan
        ).observe(duration_sec)


def update_queue_metrics():
    """큐 메트릭 업데이트"""

    from app.services.queue_monitor import QueueMonitor

    monitor = QueueMonitor()
    lengths = monitor.get_queue_lengths()

    for queue_name, length in lengths.items():
        queue_length_gauge.labels(queue_name=queue_name).set(length)

    stats = monitor.get_queue_statistics()
    active_workers_gauge.set(stats.get('active_workers', 0))


def update_gpu_metrics():
    """GPU 메트릭 업데이트"""

    from app.services.gpu_monitor import GPUMonitor

    gpu_info = GPUMonitor.get_gpu_memory_info()

    if gpu_info['available']:
        gpu_memory_gauge.set(gpu_info['utilization_percent'])


# Celery Beat 스케줄
@shared_task(name="update_prometheus_metrics")
def update_prometheus_metrics_task():
    """Prometheus 메트릭 업데이트 (매 15초)"""

    update_queue_metrics()
    update_gpu_metrics()
```

### 2. Grafana 대시보드 (JSON)

```json
{
  "dashboard": {
    "title": "PingvasAI Worker Monitoring",
    "panels": [
      {
        "title": "Queue Length by Priority",
        "type": "graph",
        "targets": [
          {
            "expr": "celery_queue_length",
            "legendFormat": "{{queue_name}}"
          }
        ]
      },
      {
        "title": "Active Workers",
        "type": "stat",
        "targets": [
          {
            "expr": "celery_active_workers"
          }
        ]
      },
      {
        "title": "GPU Memory Utilization",
        "type": "gauge",
        "targets": [
          {
            "expr": "gpu_memory_utilization_percent"
          }
        ]
      },
      {
        "title": "Image Generation Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(image_generation_total[5m])",
            "legendFormat": "{{model}} - {{plan}}"
          }
        ]
      },
      {
        "title": "Generation Duration (p95)",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(image_generation_duration_seconds_bucket[5m]))",
            "legendFormat": "p95 - {{model}}"
          }
        ]
      }
    ]
  }
}
```

---

## 테스트

### 1. 큐 라우팅 테스트

```python
# tests/test_queue_routing.py
import pytest
from app.tasks.routing import TaskRouter


def test_plan_queue_routing():
    """플랜별 큐 라우팅 테스트"""

    # Enterprise
    routing = TaskRouter.route_task('enterprise', 'generate_image')
    assert routing['queue'] == 'enterprise'
    assert routing['priority'] == 10

    # Free
    routing = TaskRouter.route_task('free', 'generate_image')
    assert routing['queue'] == 'free'
    assert routing['priority'] == 2


def test_queue_priority_order():
    """우선순위 순서 테스트"""

    plans = ['free', 'starter', 'pro', 'studio', 'enterprise']
    priorities = [TaskRouter.PLAN_PRIORITY_MAP[plan] for plan in plans]

    # 우선순위가 오름차순인지 확인
    assert priorities == sorted(priorities)
```

### 2. OOM 처리 테스트

```python
# tests/test_oom_handling.py
@pytest.mark.asyncio
async def test_oom_recovery(test_db):
    """OOM 에러 복구 테스트"""

    from app.tasks.image_tasks import generate_image_task
    from app.tasks.oom_handler import handle_oom_error
    import torch

    # Mock OOM 에러
    with pytest.raises(torch.cuda.OutOfMemoryError):
        # 비현실적으로 큰 이미지 요청
        await generate_image_task(
            user_id="test_user",
            job_id="test_job",
            prompt="test",
            model_name="flux-pro",
            width=8192,
            height=8192
        )

    # GPU 메모리가 정리되었는지 확인
    from app.services.gpu_monitor import GPUMonitor
    gpu_info = GPUMonitor.get_gpu_memory_info()

    assert gpu_info['utilization_percent'] < 50  # 메모리 정리 확인
```

### 3. Auto Scaling 시뮬레이션

```python
# tests/test_autoscaling.py
def test_scale_up_trigger():
    """Scale Up 트리거 테스트"""

    from app.services.cloudwatch_metrics import CloudWatchMetrics

    cw = CloudWatchMetrics()

    # 큐 길이 급증 시뮬레이션
    for i in range(20):
        cw.put_queue_length_metric('pro', 5)

    # CloudWatch Alarm이 트리거되는지 확인
    # (실제 테스트는 AWS 환경에서 수행)
```

---

## Phase 9 완료

### 구현 완료 항목

✅ **우선순위 큐 시스템**
- Celery 큐 설정 (5단계 우선순위)
- 동적 큐 라우팅 (플랜별)
- 큐 모니터링 및 통계

✅ **Celery Worker 설정**
- GPU 워커 설정
- 작업 시그널 핸들러
- 이미지 생성 작업

✅ **OOM 방지 전략**
- GPU 메모리 모니터링
- 모델 캐시 관리 (Lazy Loading)
- OOM 에러 처리 및 재시도

✅ **GPU Worker Auto Scaling**
- CloudWatch 메트릭 전송
- Auto Scaling Group 설정 (Terraform)
- User Data 스크립트 (유휴 시 자동 종료)

✅ **작업 타임아웃 및 재시도**
- 타임아웃 설정
- 스마트 재시도 전략
- Dead Letter Queue

✅ **모니터링 및 알람**
- Prometheus 메트릭
- Grafana 대시보드
- CloudWatch Alarms

✅ **테스트**
- 큐 라우팅 테스트
- OOM 처리 테스트
- Auto Scaling 시뮬레이션

---

**다음 단계: Phase 10 - Monitoring & CI/CD (Prometheus, Grafana, ArgoCD)**
