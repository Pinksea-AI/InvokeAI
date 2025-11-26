# WebSocket 이벤트 명세서

## 개요

Pingvas Studio는 Socket.IO를 사용하여 실시간 이미지 생성 진행률 및 시스템 이벤트를 클라이언트에 전달합니다.

---

## 연결 설정

### 엔드포인트
```
wss://api.pingvas.studio/ws
```

### 인증
WebSocket 연결 시 JWT 토큰을 handshake 파라미터로 전달합니다.

```typescript
import { io, Socket } from 'socket.io-client';

const socket: Socket = io('wss://api.pingvas.studio', {
  path: '/ws',
  auth: {
    token: 'eyJhbGciOiJIUzI1NiIs...'  // JWT Access Token
  },
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
```

### 네임스페이스

| 네임스페이스 | 용도 |
|-------------|------|
| `/` | 기본 네임스페이스 (생성 진행률, 시스템 알림) |
| `/admin` | 관리자 전용 (서버 상태, 큐 모니터링) |

---

## 이벤트 카테고리

### 1. 연결 이벤트

#### `connect`
연결 성공 시 발생

```typescript
socket.on('connect', () => {
  console.log('Connected:', socket.id);
});
```

#### `disconnect`
연결 해제 시 발생

```typescript
socket.on('disconnect', (reason: string) => {
  console.log('Disconnected:', reason);
  // reason: 'io server disconnect' | 'io client disconnect' | 'ping timeout' | 'transport close'
});
```

#### `connect_error`
연결 실패 시 발생

```typescript
socket.on('connect_error', (error: Error) => {
  if (error.message === 'invalid_token') {
    // 토큰 갱신 후 재연결
    refreshTokenAndReconnect();
  }
});
```

---

### 2. 생성 작업 이벤트

#### `job:queued`
작업이 큐에 추가됨

**Server → Client**
```typescript
interface JobQueuedEvent {
  jobId: string;
  userId: string;
  jobType: 'txt2img' | 'img2img' | 'inpaint' | 'upscale';
  position: number;        // 큐 내 위치
  estimatedWait: number;   // 예상 대기 시간 (초)
  estimatedCredits: number;
  queuedAt: string;        // ISO 8601
}

socket.on('job:queued', (data: JobQueuedEvent) => {
  console.log(`Job ${data.jobId} queued at position ${data.position}`);
});
```

#### `job:started`
작업 처리 시작

**Server → Client**
```typescript
interface JobStartedEvent {
  jobId: string;
  userId: string;
  workerId: string;        // AI Worker Pod ID
  modelName: string;
  totalSteps: number;
  startedAt: string;
}

socket.on('job:started', (data: JobStartedEvent) => {
  console.log(`Job ${data.jobId} started on worker ${data.workerId}`);
});
```

#### `job:progress`
생성 진행률 업데이트

**Server → Client**
```typescript
interface JobProgressEvent {
  jobId: string;
  userId: string;
  currentStep: number;
  totalSteps: number;
  progressPercent: number;  // 0.0 - 100.0
  stepName: string;         // 'Denoising' | 'VAE Decode' | 'Upscaling'
  previewUrl?: string;      // 중간 프리뷰 이미지 URL
  elapsedTime: number;      // 경과 시간 (초)
  estimatedRemaining: number; // 예상 남은 시간 (초)
}

socket.on('job:progress', (data: JobProgressEvent) => {
  updateProgressBar(data.progressPercent);
  if (data.previewUrl) {
    showPreviewImage(data.previewUrl);
  }
});
```

#### `job:completed`
작업 완료

**Server → Client**
```typescript
interface JobCompletedEvent {
  jobId: string;
  userId: string;
  images: Array<{
    id: string;
    url: string;
    thumbnailUrl: string;
    width: number;
    height: number;
  }>;
  actualCredits: number;
  totalTime: number;        // 총 소요 시간 (초)
  completedAt: string;
}

socket.on('job:completed', (data: JobCompletedEvent) => {
  showCompletedImages(data.images);
  updateCredits(data.actualCredits);
});
```

#### `job:failed`
작업 실패

**Server → Client**
```typescript
interface JobFailedEvent {
  jobId: string;
  userId: string;
  errorCode: string;
  errorMessage: string;
  refundedCredits: number;
  failedAt: string;
}

// 에러 코드
type ErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'OUT_OF_MEMORY'
  | 'INVALID_PARAMETERS'
  | 'WORKER_TIMEOUT'
  | 'NSFW_DETECTED'
  | 'QUOTA_EXCEEDED';

socket.on('job:failed', (data: JobFailedEvent) => {
  showError(data.errorMessage);
  if (data.refundedCredits > 0) {
    showRefundNotification(data.refundedCredits);
  }
});
```

#### `job:canceled`
작업 취소됨

**Server → Client**
```typescript
interface JobCanceledEvent {
  jobId: string;
  userId: string;
  canceledBy: 'user' | 'system';
  reason: string;
  refundedCredits: number;
  canceledAt: string;
}

socket.on('job:canceled', (data: JobCanceledEvent) => {
  showCancelNotification(data.reason);
});
```

---

### 3. 큐 이벤트

#### `queue:position`
큐 위치 변경 알림

**Server → Client**
```typescript
interface QueuePositionEvent {
  jobId: string;
  previousPosition: number;
  currentPosition: number;
  estimatedWait: number;
}

socket.on('queue:position', (data: QueuePositionEvent) => {
  updateQueuePosition(data.currentPosition, data.estimatedWait);
});
```

#### `queue:status`
전체 큐 상태

**Server → Client**
```typescript
interface QueueStatusEvent {
  totalJobs: number;
  processingJobs: number;
  waitingJobs: number;
  averageWaitTime: number;  // 평균 대기 시간 (초)
  activeWorkers: number;
}

socket.on('queue:status', (data: QueueStatusEvent) => {
  updateQueueStats(data);
});
```

---

### 4. 크레딧 이벤트

#### `credits:updated`
크레딧 잔액 변경

**Server → Client**
```typescript
interface CreditsUpdatedEvent {
  userId: string;
  previousBalance: number;
  currentBalance: number;
  change: number;
  reason: 'consume' | 'grant' | 'refund' | 'bonus';
  description: string;
}

socket.on('credits:updated', (data: CreditsUpdatedEvent) => {
  animateCreditChange(data.previousBalance, data.currentBalance);
});
```

#### `credits:low`
크레딧 부족 경고

**Server → Client**
```typescript
interface CreditsLowEvent {
  userId: string;
  currentBalance: number;
  threshold: number;  // 경고 임계값 (예: 500)
}

socket.on('credits:low', (data: CreditsLowEvent) => {
  showLowCreditWarning(data.currentBalance);
});
```

#### `credits:exhausted`
크레딧 소진

**Server → Client**
```typescript
interface CreditsExhaustedEvent {
  userId: string;
  lastJobId?: string;
}

socket.on('credits:exhausted', (data: CreditsExhaustedEvent) => {
  showUpgradePrompt();
  disableGenerateButton();
});
```

---

### 5. 시스템 이벤트

#### `system:announcement`
시스템 공지

**Server → Client**
```typescript
interface SystemAnnouncementEvent {
  id: string;
  type: 'info' | 'warning' | 'maintenance';
  title: string;
  message: string;
  scheduledAt?: string;
  duration?: number;  // 유지보수 예상 시간 (분)
}

socket.on('system:announcement', (data: SystemAnnouncementEvent) => {
  showSystemBanner(data);
});
```

#### `system:maintenance`
유지보수 모드 진입/해제

**Server → Client**
```typescript
interface SystemMaintenanceEvent {
  status: 'starting' | 'in_progress' | 'completed';
  estimatedEnd?: string;
  message: string;
}

socket.on('system:maintenance', (data: SystemMaintenanceEvent) => {
  if (data.status === 'starting') {
    showMaintenanceWarning(data.estimatedEnd);
  } else if (data.status === 'completed') {
    hideMaintenanceWarning();
  }
});
```

---

### 6. 클라이언트 → 서버 이벤트

#### `job:subscribe`
특정 작업 구독 (다른 디바이스에서 시작한 작업 추적)

**Client → Server**
```typescript
interface JobSubscribeRequest {
  jobId: string;
}

socket.emit('job:subscribe', { jobId: 'job_123' });
```

#### `job:unsubscribe`
작업 구독 해제

**Client → Server**
```typescript
socket.emit('job:unsubscribe', { jobId: 'job_123' });
```

#### `job:cancel`
작업 취소 요청

**Client → Server**
```typescript
interface JobCancelRequest {
  jobId: string;
  reason?: string;
}

socket.emit('job:cancel', { jobId: 'job_123', reason: 'User requested' });

// 응답
socket.on('job:cancel:response', (response: { success: boolean; message: string }) => {
  if (response.success) {
    console.log('Job canceled');
  }
});
```

#### `heartbeat`
연결 유지 핑

**Client → Server**
```typescript
// 30초마다 heartbeat 전송
setInterval(() => {
  socket.emit('heartbeat', { timestamp: Date.now() });
}, 30000);

socket.on('heartbeat:ack', (data: { serverTime: number }) => {
  // 서버 시간과 동기화
});
```

---

## Room 구조

### 자동 참여 Room
연결 시 자동으로 사용자 전용 room에 참여

```typescript
// 서버 사이드 (Python/FastAPI)
@sio.on('connect')
async def handle_connect(sid, environ, auth):
    user_id = verify_token(auth['token'])
    await sio.enter_room(sid, f'user:{user_id}')
```

### Room 목록

| Room 이름 | 용도 | 참여 조건 |
|-----------|------|----------|
| `user:{userId}` | 개인 이벤트 | 인증된 사용자 자동 참여 |
| `job:{jobId}` | 특정 작업 이벤트 | `job:subscribe` 요청 시 |
| `admin` | 관리자 대시보드 | 관리자 권한 |
| `broadcast` | 전체 공지 | 모든 연결된 클라이언트 |

---

## 에러 처리

### 인증 에러

```typescript
interface AuthError {
  code: 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'TOKEN_MISSING';
  message: string;
}

socket.on('error', (error: AuthError) => {
  if (error.code === 'TOKEN_EXPIRED') {
    const newToken = await refreshAccessToken();
    socket.auth = { token: newToken };
    socket.connect();
  }
});
```

### Rate Limiting

```typescript
interface RateLimitError {
  code: 'RATE_LIMIT_EXCEEDED';
  retryAfter: number;  // 초
}

socket.on('error', (error: RateLimitError) => {
  if (error.code === 'RATE_LIMIT_EXCEEDED') {
    setTimeout(() => {
      socket.connect();
    }, error.retryAfter * 1000);
  }
});
```

---

## 클라이언트 구현 예시 (React Hook)

```typescript
// hooks/useWebSocket.ts
import { useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import {
  jobQueued,
  jobStarted,
  jobProgress,
  jobCompleted,
  jobFailed
} from '../store/slices/generationSlice';
import { updateCredits } from '../store/slices/userSlice';

export function useWebSocket() {
  const dispatch = useAppDispatch();
  const accessToken = useAppSelector((state) => state.auth.accessToken);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!accessToken) return;

    const socket = io(import.meta.env.VITE_WS_URL, {
      path: '/ws',
      auth: { token: accessToken },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
    });

    socketRef.current = socket;

    // 생성 이벤트 핸들러
    socket.on('job:queued', (data) => dispatch(jobQueued(data)));
    socket.on('job:started', (data) => dispatch(jobStarted(data)));
    socket.on('job:progress', (data) => dispatch(jobProgress(data)));
    socket.on('job:completed', (data) => dispatch(jobCompleted(data)));
    socket.on('job:failed', (data) => dispatch(jobFailed(data)));

    // 크레딧 이벤트 핸들러
    socket.on('credits:updated', (data) => dispatch(updateCredits(data)));

    // 연결 이벤트 핸들러
    socket.on('connect', () => {
      console.log('WebSocket connected');
    });

    socket.on('disconnect', (reason) => {
      console.log('WebSocket disconnected:', reason);
    });

    return () => {
      socket.disconnect();
    };
  }, [accessToken, dispatch]);

  const cancelJob = useCallback((jobId: string) => {
    socketRef.current?.emit('job:cancel', { jobId });
  }, []);

  const subscribeToJob = useCallback((jobId: string) => {
    socketRef.current?.emit('job:subscribe', { jobId });
  }, []);

  return { cancelJob, subscribeToJob };
}
```

---

## 서버 구현 예시 (Python/FastAPI)

```python
# websocket/manager.py
import socketio
from typing import Dict, Set
from app.core.security import verify_access_token
from app.services.redis import redis_client

sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins='*',
    logger=True,
)

# 사용자별 연결 관리
user_connections: Dict[str, Set[str]] = {}  # user_id -> set of sid

@sio.event
async def connect(sid, environ, auth):
    """WebSocket 연결 핸들러"""
    try:
        token = auth.get('token')
        if not token:
            raise ConnectionRefusedError('TOKEN_MISSING')

        payload = verify_access_token(token)
        user_id = payload['sub']

        # 사용자 room 참여
        await sio.enter_room(sid, f'user:{user_id}')

        # 연결 추적
        if user_id not in user_connections:
            user_connections[user_id] = set()
        user_connections[user_id].add(sid)

        # 세션 저장
        await sio.save_session(sid, {'user_id': user_id})

        print(f'User {user_id} connected: {sid}')

    except Exception as e:
        raise ConnectionRefusedError(str(e))

@sio.event
async def disconnect(sid):
    """연결 해제 핸들러"""
    session = await sio.get_session(sid)
    user_id = session.get('user_id')

    if user_id and user_id in user_connections:
        user_connections[user_id].discard(sid)
        if not user_connections[user_id]:
            del user_connections[user_id]

    print(f'Client disconnected: {sid}')

@sio.event
async def job_cancel(sid, data):
    """작업 취소 요청"""
    session = await sio.get_session(sid)
    user_id = session.get('user_id')
    job_id = data.get('jobId')

    # 권한 확인 및 취소 처리
    success = await cancel_generation_job(user_id, job_id)

    await sio.emit('job:cancel:response', {
        'success': success,
        'message': 'Job canceled' if success else 'Cannot cancel job'
    }, to=sid)

# 이벤트 발행 함수들
async def emit_job_progress(user_id: str, job_id: str, progress_data: dict):
    """작업 진행률 브로드캐스트"""
    await sio.emit('job:progress', progress_data, room=f'user:{user_id}')
    await sio.emit('job:progress', progress_data, room=f'job:{job_id}')

async def emit_job_completed(user_id: str, job_id: str, result_data: dict):
    """작업 완료 브로드캐스트"""
    await sio.emit('job:completed', result_data, room=f'user:{user_id}')
    await sio.emit('job:completed', result_data, room=f'job:{job_id}')

async def emit_credits_updated(user_id: str, credits_data: dict):
    """크레딧 변경 알림"""
    await sio.emit('credits:updated', credits_data, room=f'user:{user_id}')

async def emit_system_announcement(announcement: dict):
    """전체 공지"""
    await sio.emit('system:announcement', announcement, room='broadcast')
```

---

## 다음 단계

- [API 명세서](./01-api-specification.md)에서 REST API 확인
- [데이터 흐름](../architecture/03-data-flow.md)에서 전체 시퀀스 확인
- [프론트엔드 가이드](../frontend/01-storybook-guide.md)에서 UI 컴포넌트 확인
