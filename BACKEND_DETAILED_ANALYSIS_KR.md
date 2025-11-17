# InvokeAI 백엔드 상세 분석

> 백엔드 핵심 컴포넌트 및 실제 코드 기반 설명

## 목차

1. [FastAPI 애플리케이션 구조](#1-fastapi-애플리케이션-구조)
2. [Invocation 시스템 심층 분석](#2-invocation-시스템-심층-분석)
3. [Session Processor 작동 원리](#3-session-processor-작동-원리)
4. [모델 관리 시스템](#4-모델-관리-시스템)
5. [이미지 처리 파이프라인](#5-이미지-처리-파이프라인)
6. [Extension 시스템](#6-extension-시스템)
7. [데이터베이스 및 스토리지](#7-데이터베이스-및-스토리지)

---

## 1. FastAPI 애플리케이션 구조

### 1.1 애플리케이션 초기화

파일: `invokeai/app/api_app.py`

#### 앱 생성 (라인 71-77)

```python
app = FastAPI(
    title="Invoke - Community Edition",
    docs_url=None,                      # 커스텀 docs 엔드포인트 사용
    redoc_url=None,                     # 커스텀 redoc 엔드포인트 사용
    separate_input_output_schemas=False, # OpenAPI 스키마 간소화
    lifespan=lifespan,                  # 시작/종료 이벤트 핸들러
)
```

#### 라이프사이클 관리 (라인 43-66)

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 시작/종료 시 실행되는 이벤트 핸들러"""

    # === 시작 시 (STARTUP) ===
    # 모든 서비스 초기화
    ApiDependencies.initialize(
        config=app_config,
        event_handler_id=event_handler_id,
        loop=loop,
        logger=logger
    )

    # 서버 주소 로깅
    proto = "https" if app_config.ssl_certfile else "http"
    msg = f"Invoke running on {proto}://{app_config.host}:{app_config.port}"
    logger.info(msg)

    yield  # 앱 실행 (여기서 FastAPI가 요청을 처리함)

    # === 종료 시 (SHUTDOWN) ===
    # 모든 스레드 종료 및 리소스 정리
    ApiDependencies.shutdown()
```

**핵심 포인트**:
- `ApiDependencies.initialize()`: 모든 서비스(이미지, 모델, 큐 등) 초기화
- `yield`: Python의 context manager 패턴, 이전은 시작, 이후는 종료
- `ApiDependencies.shutdown()`: 백그라운드 스레드 종료, DB 연결 닫기 등

### 1.2 미들웨어 스택

미들웨어는 요청/응답을 처리하기 전/후에 실행되는 레이어입니다.

#### 미들웨어 순서 (추가된 역순으로 실행)

```
요청 흐름:
클라이언트
  ↓
1. RedirectRootWithQueryStringMiddleware (라인 80-95)
  ↓
2. EventHandlerASGIMiddleware (라인 104-108)
  ↓
3. CORSMiddleware (라인 112-118)
  ↓
4. GZipMiddleware (라인 120)
  ↓
라우터 (실제 엔드포인트)
```

#### 1) 루트 리다이렉트 미들웨어

```python
class RedirectRootWithQueryStringMiddleware(BaseHTTPMiddleware):
    """쿼리 스트링이 있는 루트 경로를 쿼리 스트링 없이 리다이렉트

    예: http://127.0.0.1:9090/?__theme=dark
        → http://127.0.0.1:9090/

    이유: Gradio 앱의 쿼리 스트링이 정적 파일 서빙을 방해함
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint):
        if request.url.path == "/" and request.url.query:
            return RedirectResponse(url="/")

        response = await call_next(request)
        return response
```

#### 2) 이벤트 핸들러 미들웨어

```python
app.add_middleware(
    EventHandlerASGIMiddleware,
    handlers=[local_handler],  # 로컬 이벤트 핸들러
    middleware_id=event_handler_id,
)
```

**역할**: FastAPI Events 라이브러리를 사용한 이벤트 발행/구독 시스템
- 서비스 간 느슨한 결합 (Loose Coupling)
- 예: 이미지 저장 완료 → 썸네일 생성 트리거

#### 3) CORS 미들웨어

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=app_config.allow_origins,      # 허용할 오리진
    allow_credentials=app_config.allow_credentials,
    allow_methods=app_config.allow_methods,
    allow_headers=app_config.allow_headers,
)
```

**역할**: Cross-Origin Resource Sharing 설정
- 다른 도메인에서의 API 접근 제어
- 개발 시 localhost:5173 (Vite) → localhost:9090 (API) 허용

#### 4) GZip 압축 미들웨어

```python
app.add_middleware(GZipMiddleware, minimum_size=1000)
```

**역할**: 1000바이트 이상의 응답을 자동 압축
- 네트워크 대역폭 절약
- 특히 큰 JSON 응답(워크플로우 등)에 효과적

### 1.3 라우터 구조

파일: `invokeai/app/api/routers/`

#### 라우터 등록 (라인 124-135)

```python
# 각 도메인별로 라우터 분리
app.include_router(utilities.utilities_router, prefix="/api")
app.include_router(model_manager.model_manager_router, prefix="/api")
app.include_router(download_queue.download_queue_router, prefix="/api")
app.include_router(images.images_router, prefix="/api")
app.include_router(boards.boards_router, prefix="/api")
app.include_router(board_images.board_images_router, prefix="/api")
app.include_router(model_relationships.model_relationships_router, prefix="/api")
app.include_router(app_info.app_router, prefix="/api")
app.include_router(session_queue.session_queue_router, prefix="/api")
app.include_router(workflows.workflows_router, prefix="/api")
app.include_router(style_presets.style_presets_router, prefix="/api")
app.include_router(client_state.client_state_router, prefix="/api")
```

#### 라우터별 주요 엔드포인트

| 라우터 | 경로 | 주요 엔드포인트 |
|--------|------|----------------|
| **session_queue** | `/api/v*/queue` | `POST /enqueue`, `GET /`, `DELETE /{item_id}` |
| **images** | `/api/v*/images` | `POST /upload`, `GET /{name}`, `DELETE /{name}` |
| **boards** | `/api/v*/boards` | `POST /`, `GET /`, `PATCH /{board_id}` |
| **model_manager** | `/api/v*/models` | `GET /`, `POST /install`, `DELETE /{key}` |
| **workflows** | `/api/v*/workflows` | `POST /`, `GET /i/{workflow_id}`, `PATCH /` |

#### 라우터 예시: Session Queue

파일: `invokeai/app/api/routers/session_queue.py`

```python
from fastapi import APIRouter, Depends, Path
from invokeai.app.api.dependencies import ApiDependencies

router = APIRouter(prefix="/v1/queue", tags=["queue"])


@router.post("/enqueue_batch")
async def enqueue_batch(
    queue_batch: EnqueueBatchParams,
    queue: SessionQueueService = Depends(ApiDependencies.queue),
) -> EnqueueBatchResult:
    """배치(워크플로우)를 큐에 추가"""

    # 서비스 레이어 호출
    enqueue_result = queue.enqueue_batch(queue_batch)

    return enqueue_result


@router.get("/")
async def get_queue_status(
    queue: SessionQueueService = Depends(ApiDependencies.queue),
) -> SessionQueueStatus:
    """현재 큐 상태 조회"""

    return queue.get_status()
```

**의존성 주입 패턴**:
- `Depends(ApiDependencies.queue)`: FastAPI가 자동으로 서비스 주입
- 라우터는 서비스 로직을 직접 구현하지 않고, 서비스 레이어에 위임
- 테스트 시 Mock 서비스로 쉽게 교체 가능

### 1.4 Socket.IO 통합

파일: `invokeai/app/api/sockets.py`

```python
class SocketIO:
    """FastAPI와 Socket.IO 통합"""

    def __init__(self, app: FastAPI):
        self.sio = socketio.AsyncServer(
            async_mode="asgi",
            cors_allowed_origins="*",  # 모든 오리진 허용 (개발용)
        )

        # ASGI 앱으로 마운트
        self.app = socketio.ASGIApp(self.sio, app)

        # 이벤트 핸들러 등록
        self.sio.on("connect", self.on_connect)
        self.sio.on("disconnect", self.on_disconnect)

    async def on_connect(self, sid, environ):
        """클라이언트 연결 시"""
        logger.info(f"Client connected: {sid}")

    async def on_disconnect(self, sid):
        """클라이언트 연결 해제 시"""
        logger.info(f"Client disconnected: {sid}")

    async def emit(self, event: str, data: dict):
        """모든 클라이언트에게 이벤트 브로드캐스트"""
        await self.sio.emit(event, data)
```

**실시간 이벤트 예시**:
```python
# Session Processor에서 이벤트 발행
await socket_io.emit("invocation_started", {
    "node_id": "abc123",
    "invocation_type": "denoise_latents"
})

await socket_io.emit("generator_progress", {
    "step": 15,
    "total_steps": 30,
    "progress_image": "base64_encoded_image..."
})
```

---

## 2. Invocation 시스템 심층 분석

### 2.1 Invocation 생명주기

```
1. 정의 (Definition)
   └─> @invocation 데코레이터로 등록

2. 등록 (Registration)
   └─> InvocationRegistry에 추가

3. 직렬화 (Serialization)
   └─> Pydantic 모델로 JSON 변환

4. 큐잉 (Queueing)
   └─> SessionQueue에 저장

5. 실행 (Execution)
   └─> SessionRunner가 invoke() 호출

6. 결과 저장 (Result Storage)
   └─> Session에 출력 저장

7. 캐싱 (Caching) - 선택적
   └─> InvocationCache에 저장
```

### 2.2 DenoiseLatentsInvocation 상세 분석

파일: `invokeai/app/invocations/denoise_latents.py:98`

이것은 Stable Diffusion의 핵심 노드입니다.

#### 입력 필드 정의

```python
@invocation(
    "denoise_latents",
    title="Denoise Latents",
    tags=["latents", "denoise", "txt2img", "t2i", "img2img", "i2i"],
    category="latents",
    version="1.5.3",
)
class DenoiseLatentsInvocation(BaseInvocation):
    """Stable Diffusion 노이즈 제거"""

    # === 필수 입력 ===
    positive_conditioning: ConditioningField = InputField(
        description="긍정 프롬프트 컨디셔닝",
    )
    negative_conditioning: ConditioningField = InputField(
        description="부정 프롬프트 컨디셔닝",
    )
    noise: LatentsField = InputField(
        description="초기 노이즈",
    )
    steps: int = InputField(
        default=30,
        gt=0,
        description="샘플링 스텝 수",
    )
    cfg_scale: float = InputField(
        default=7.5,
        ge=1,
        description="Classifier Free Guidance 스케일",
    )
    denoising_start: float = InputField(
        default=0.0,
        ge=0,
        le=1,
        description="노이즈 제거 시작점 (0.0 = 처음부터)",
    )
    denoising_end: float = InputField(
        default=1.0,
        ge=0,
        le=1,
        description="노이즈 제거 종료점 (1.0 = 끝까지)",
    )
    scheduler: SCHEDULER_NAME_VALUES = InputField(
        default="euler",
        description="사용할 스케줄러",
    )
    unet: UNetField = InputField(
        description="UNet 모델",
    )

    # === 선택적 입력 ===
    control: Optional[ControlField] = InputField(
        default=None,
        description="ControlNet",
    )
    ip_adapter: Optional[IPAdapterField] = InputField(
        default=None,
        description="IP Adapter",
    )
    latents: Optional[LatentsField] = InputField(
        default=None,
        description="초기 잠재 이미지 (img2img용)",
    )
    denoise_mask: Optional[DenoiseMaskField] = InputField(
        default=None,
        description="인페인팅 마스크",
    )
```

#### invoke() 메서드 구조

```python
def invoke(self, context: InvocationContext) -> LatentsOutput:
    """노이즈 제거 실행"""

    # === 1. 초기 잠재 이미지 준비 ===
    if self.latents is not None:
        # img2img: 기존 이미지에서 시작
        latents = context.tensors.load(self.latents.latents_name)
    else:
        # txt2img: 순수 노이즈에서 시작
        latents = context.tensors.load(self.noise.latents_name)

    # === 2. 모델 로딩 ===
    # UNet 모델
    unet_config = context.models.get_config(self.unet.unet.key)

    # 스케줄러
    scheduler = get_scheduler(
        context=context,
        scheduler_info=self.unet.scheduler,
        scheduler_name=self.scheduler,
        seed=self.seed,
    )

    # === 3. 컨디셔닝 데이터 준비 ===
    conditioning_data = self._prepare_conditioning(context)

    # === 4. Extension 준비 ===
    ext_manager = ExtensionsManager()

    # ControlNet Extension
    if self.control is not None:
        ext_manager.add_extension(ControlNetExt(self.control))

    # IP Adapter Extension
    if self.ip_adapter is not None:
        ext_manager.add_extension(IPAdapterExt(self.ip_adapter))

    # LoRA Extension
    if self.unet.loras:
        ext_manager.add_extension(LoRAExt(self.unet.loras))

    # Inpainting Extension
    if self.denoise_mask is not None:
        ext_manager.add_extension(InpaintExt(self.denoise_mask))

    # Preview Extension (중간 이미지 미리보기)
    ext_manager.add_extension(PreviewExt(context))

    # === 5. UNet 로딩 및 패칭 ===
    with context.models.load(self.unet.unet) as unet:
        # === 6. 노이즈 제거 실행 ===
        pipeline = StableDiffusionGeneratorPipeline(
            unet=unet,
            scheduler=scheduler,
        )

        # DenoiseInputs 준비
        inputs = DenoiseInputs(
            latents=latents,
            conditioning_data=conditioning_data,
            num_steps=self.steps,
            cfg_scale=self.cfg_scale,
            denoising_start=self.denoising_start,
            denoising_end=self.denoising_end,
        )

        # Extension Manager와 함께 실행
        result_latents = pipeline.denoise(
            inputs=inputs,
            extensions=ext_manager,
            callback=self._step_callback,  # 진행률 콜백
        )

    # === 7. 결과 저장 ===
    result_latents_name = context.tensors.save(result_latents)

    # === 8. 출력 반환 ===
    return LatentsOutput(
        latents=LatentsField(latents_name=result_latents_name),
        width=result_latents.shape[3] * 8,  # VAE 스케일 팩터
        height=result_latents.shape[2] * 8,
    )
```

#### 핵심 포인트 설명

**1) 컨텍스트를 통한 서비스 접근**:
```python
# 모델 로딩
context.models.load(model_key)

# 텐서 저장/로드
context.tensors.save(tensor)
context.tensors.load(name)

# 이미지 저장/로드
context.images.save(pil_image)
context.images.get_pil(image_name)

# 이벤트 발행
context.events.emit(event)
```

**2) Extension 시스템**:
- 각 기능(ControlNet, LoRA 등)이 독립적인 Extension
- Extension Manager가 실행 시점에 Extension 호출
- 새로운 기능 추가 시 Extension만 추가하면 됨 (확장성)

**3) 콜백을 통한 진행률 업데이트**:
```python
def _step_callback(
    self,
    context: InvocationContext,
    intermediate_state: PipelineIntermediateState,
):
    """각 스텝마다 호출되는 콜백"""

    # 중간 이미지 생성
    preview_image = intermediate_state.predicted_original

    # Socket.IO로 프론트엔드에 전송
    context.events.emit_generator_progress(
        step=intermediate_state.step,
        total_steps=intermediate_state.total_steps,
        progress_image=preview_image,
    )

    # 취소 요청 확인
    if context.is_canceled():
        raise CanceledException()
```

### 2.3 Invocation 입력/출력 타입 시스템

#### Field 타입들

파일: `invokeai/app/invocations/fields.py`

```python
# 이미지 참조
class ImageField(BaseModel):
    image_name: str  # 실제 이미지 파일 이름

# 잠재 이미지 참조
class LatentsField(BaseModel):
    latents_name: str  # 텐서 파일 이름
    seed: Optional[int] = None

# 컨디셔닝 참조
class ConditioningField(BaseModel):
    conditioning_name: str  # 컨디셔닝 파일 이름

# 모델 식별자
class ModelIdentifierField(BaseModel):
    key: str         # 모델 고유 키
    hash: str        # 모델 해시
    name: str        # 모델 이름
    base: str        # 베이스 모델 (sd-1, sdxl, 등)
    type: str        # 모델 타입 (main, lora, 등)
```

**왜 직접 데이터를 전달하지 않고 참조를 사용할까?**

```python
# ❌ 직접 전달 (메모리 낭비)
class BadInvocation(BaseInvocation):
    image: Image.Image  # PIL Image 객체 직접 전달
    # 문제: 큰 이미지를 JSON으로 직렬화하면 매우 비효율적
    # 워크플로우 저장 시 이미지가 포함되어 파일 크기 폭증

# ✅ 참조 전달 (효율적)
class GoodInvocation(BaseInvocation):
    image: ImageField  # 이미지 이름만 전달

    def invoke(self, context):
        # 필요할 때만 로드
        pil_image = context.images.get_pil(self.image.image_name)
```

---

## 3. Session Processor 작동 원리

### 3.1 아키텍처 개요

파일: `invokeai/app/services/session_processor/session_processor_default.py`

```
SessionProcessor (메인 스레드)
  │
  ├─> SessionQueue 모니터링
  │
  ├─> 새 항목 발견 시
  │   └─> SessionRunner 스레드 생성
  │
SessionRunner (워커 스레드)
  │
  ├─> 그래프 위상 정렬
  │
  ├─> 각 노드 순차 실행
  │   └─> invocation.invoke(context)
  │
  └─> 완료/실패 이벤트 발행
```

### 3.2 SessionRunner 상세 분석

#### run() 메서드 (라인 72-110)

```python
def run(self, queue_item: SessionQueueItem):
    """세션의 모든 Invocation 실행"""

    # === 세션 시작 콜백 ===
    self._on_before_run_session(queue_item=queue_item)

    # === 메인 실행 루프 ===
    while True:
        try:
            # 다음 실행할 Invocation 가져오기
            invocation = queue_item.session.next()
        except NodeInputError as e:
            # 입력 에러 (예: 필수 입력 누락)
            self._on_node_error(
                invocation=e.node,
                queue_item=queue_item,
                error_type=e.__class__.__name__,
                error_message=str(e),
                error_traceback=traceback.format_exc(),
            )
            break

        # 더 이상 실행할 노드가 없거나 취소됨
        if invocation is None or self._is_canceled():
            break

        # 노드 실행
        self.run_node(invocation, queue_item)

        # 세션 완료 확인
        if (
            queue_item.session.is_complete()
            or self._is_canceled()
            or queue_item.status in ["failed", "canceled", "completed"]
        ):
            break

    # === 세션 완료 콜백 ===
    self._on_after_run_session(queue_item=queue_item)
```

#### run_node() 메서드 (라인 112-165)

```python
def run_node(self, invocation: BaseInvocation, queue_item: SessionQueueItem):
    """단일 Invocation 실행"""

    try:
        # === 성능 통계 수집 시작 ===
        with self._services.performance_statistics.collect_stats(
            invocation, queue_item.session_id
        ):
            # === 노드 시작 콜백 ===
            self._on_before_run_node(invocation, queue_item)

            # === InvocationContext 생성 ===
            data = InvocationContextData(
                invocation=invocation,
                source_invocation_id=queue_item.session.prepared_source_mapping[invocation.id],
                queue_item=queue_item,
            )
            context = build_invocation_context(
                data=data,
                services=self._services,
                is_canceled=self._is_canceled,  # 취소 체크 함수
            )

            # === Invocation 실행 ===
            output = invocation.invoke_internal(context=context, services=self._services)

            # === 결과 저장 ===
            queue_item.session.complete(invocation.id, output)

            # === 노드 완료 콜백 ===
            self._on_after_run_node(invocation, queue_item, output)

    except KeyboardInterrupt:
        # Ctrl+C - 메인 스레드에서 처리됨
        pass

    except CanceledException:
        # 취소 요청 - 에러가 아니므로 조용히 종료
        pass

    except Exception as e:
        # 예상치 못한 에러
        error_type = e.__class__.__name__
        error_message = str(e)
        error_traceback = traceback.format_exc()

        self._on_node_error(
            invocation,
            queue_item,
            error_type,
            error_message,
            error_traceback,
        )
```

### 3.3 그래프 위상 정렬

**위상 정렬이란?**

방향성 비순환 그래프(DAG)의 노드를 선형 순서로 정렬하는 알고리즘입니다.

**예시 그래프**:
```
A → B → D
A → C → D
```

**위상 정렬 결과**: `[A, B, C, D]` 또는 `[A, C, B, D]`

**왜 필요한가?**
- 의존성 순서대로 실행 보장
- 노드 B는 노드 A의 출력이 필요하므로 A 이후 실행

파일: `invokeai/app/services/shared/graph.py`

```python
import networkx as nx

def topological_sort(graph: Graph) -> List[str]:
    """그래프의 노드를 위상 정렬"""

    # NetworkX 그래프 생성
    nx_graph = nx.DiGraph()

    # 노드 추가
    for node_id, node in graph.nodes.items():
        nx_graph.add_node(node_id)

    # 엣지 추가
    for edge in graph.edges:
        nx_graph.add_edge(edge.source.node_id, edge.destination.node_id)

    # 순환 참조 확인
    if not nx.is_directed_acyclic_graph(nx_graph):
        raise GraphHasCyclesError("그래프에 순환 참조가 있습니다")

    # 위상 정렬
    return list(nx.topological_sort(nx_graph))
```

### 3.4 콜백 시스템

Session Processor는 여러 시점에 콜백을 호출합니다:

```python
# 세션 시작 전
def _on_before_run_session(self, queue_item):
    # 이벤트 발행: session_started
    events.emit_session_started(queue_item.session_id)

# 노드 시작 전
def _on_before_run_node(self, invocation, queue_item):
    # 이벤트 발행: invocation_started
    events.emit_invocation_started(
        invocation_id=invocation.id,
        invocation_type=invocation.type,
    )

# 노드 완료 후
def _on_after_run_node(self, invocation, queue_item, output):
    # 이벤트 발행: invocation_complete
    events.emit_invocation_complete(
        invocation_id=invocation.id,
        result=output,
    )

    # 결과 캐싱 (설정된 경우)
    if should_cache(invocation):
        cache.save(invocation, output)

# 노드 에러 시
def _on_node_error(self, invocation, queue_item, error_type, error_message, traceback):
    # 세션 실패 처리
    queue_item.status = "failed"
    queue_item.error = error_message

    # 이벤트 발행: invocation_error
    events.emit_invocation_error(
        invocation_id=invocation.id,
        error_type=error_type,
        error_message=error_message,
        traceback=traceback,
    )

# 세션 완료 후
def _on_after_run_session(self, queue_item):
    # 이벤트 발행: session_complete
    events.emit_session_complete(
        queue_item.session_id,
        status=queue_item.status,
    )

    # 메모리 정리
    gc.collect()
    torch.cuda.empty_cache()  # GPU 메모리 정리
```

---

## 4. 모델 관리 시스템

### 4.1 모델 로딩 파이프라인

```
1. 모델 요청
   context.models.load("model_key")

2. ModelLoadService
   ├─> 캐시 확인
   │   └─> 히트: 즉시 반환
   │   └─> 미스: 계속
   │
   ├─> 메모리 체크
   │   └─> 부족 시: 오래된 모델 언로드
   │
   ├─> 모델 로더 선택
   │   ├─> StableDiffusionLoader
   │   ├─> LoRALoader
   │   ├─> VAELoader
   │   └─> ...
   │
   ├─> 디스크에서 로드
   │   ├─> safetensors 읽기
   │   └─> state_dict 생성
   │
   ├─> 모델 생성
   │   └─> PyTorch 모델 초기화
   │
   ├─> 디바이스 이동
   │   └─> model.to(device)
   │
   ├─> 캐시에 저장
   │
   └─> 모델 반환
```

### 4.2 모델 캐시 관리

파일: `invokeai/backend/model_manager/load/model_cache/`

```python
class ModelCache:
    """모델 메모리 캐시"""

    def __init__(self, max_vram_gb: float, max_ram_gb: float):
        self.max_vram = max_vram_gb * 1024**3  # GB → 바이트
        self.max_ram = max_ram_gb * 1024**3

        self.cache: Dict[str, CachedModel] = {}
        self.lru_order: List[str] = []  # Least Recently Used

    def get(self, key: str) -> Optional[torch.nn.Module]:
        """캐시에서 모델 가져오기"""
        if key in self.cache:
            # LRU 업데이트 (맨 뒤로 이동 = 최근 사용)
            self.lru_order.remove(key)
            self.lru_order.append(key)

            cached = self.cache[key]

            # GPU로 이동 (필요 시)
            if cached.device == "cpu":
                self._move_to_gpu(cached)

            return cached.model

        return None

    def put(self, key: str, model: torch.nn.Module):
        """모델을 캐시에 추가"""
        model_size = self._get_model_size(model)

        # 공간 확보
        while not self._has_space(model_size):
            self._evict_oldest()

        # 캐시에 추가
        self.cache[key] = CachedModel(
            model=model,
            size=model_size,
            device=str(model.device),
        )
        self.lru_order.append(key)

    def _evict_oldest(self):
        """가장 오래된 모델 제거 (LRU)"""
        if not self.lru_order:
            return

        oldest_key = self.lru_order.pop(0)
        cached = self.cache.pop(oldest_key)

        # 메모리 해제
        del cached.model
        gc.collect()
        torch.cuda.empty_cache()

    def _has_space(self, size: int) -> bool:
        """요청 크기만큼 공간이 있는지 확인"""
        current_usage = sum(c.size for c in self.cache.values())
        return current_usage + size <= self.max_vram
```

### 4.3 모델 패칭 시스템

**패칭이란?**

기존 모델에 LoRA, Textual Inversion 등을 적용하는 과정입니다.

파일: `invokeai/backend/model_patcher.py`

```python
class ModelPatcher:
    """모델 패칭 관리"""

    @staticmethod
    def apply_lora(
        model: torch.nn.Module,
        lora_path: str,
        weight: float = 1.0,
    ) -> torch.nn.Module:
        """LoRA 패치 적용"""

        # 1. LoRA weights 로드
        lora_state_dict = load_safetensors(lora_path)

        # 2. 각 레이어에 LoRA 적용
        for name, module in model.named_modules():
            if hasattr(module, 'weight'):
                # LoRA 키 생성
                lora_up_key = f"{name}.lora_up.weight"
                lora_down_key = f"{name}.lora_down.weight"

                if lora_up_key in lora_state_dict:
                    # LoRA 계산: W' = W + weight * (up @ down)
                    lora_up = lora_state_dict[lora_up_key]
                    lora_down = lora_state_dict[lora_down_key]

                    delta = weight * (lora_up @ lora_down)
                    module.weight.data += delta

        return model

    @staticmethod
    def apply_textual_inversion(
        text_encoder: CLIPTextModel,
        embedding_path: str,
        token: str,
    ):
        """Textual Inversion 적용"""

        # 1. 임베딩 로드
        embedding = torch.load(embedding_path)

        # 2. 토크나이저에 토큰 추가
        tokenizer = text_encoder.tokenizer
        tokenizer.add_tokens([token])

        # 3. 임베딩 레이어 확장
        text_encoder.resize_token_embeddings(len(tokenizer))

        # 4. 새 토큰의 임베딩 설정
        token_id = tokenizer.convert_tokens_to_ids(token)
        text_encoder.get_input_embeddings().weight.data[token_id] = embedding
```

---

## 5. 이미지 처리 파이프라인

### 5.1 이미지 저장 흐름

```
1. Invocation에서 이미지 생성
   pil_image = Image.fromarray(...)

2. Context를 통해 저장 요청
   image_dto = context.images.save(pil_image)

3. ImageService
   ├─> UUID 생성 (이미지 이름)
   ├─> 메타데이터 추출
   │   ├─> 크기 (width, height)
   │   ├─> 생성 시간
   │   └─> 워크플로우 정보
   │
   ├─> ImageFilesService
   │   ├─> outputs/images/2025-11/ 디렉토리 생성
   │   ├─> PNG로 저장
   │   └─> WebP 썸네일 생성
   │
   └─> ImageRecordsService
       └─> SQLite에 메타데이터 저장

4. 이벤트 발행
   events.emit_image_saved(image_dto)

5. 반환
   return ImageDTO(image_name="...")
```

### 5.2 이미지 변환 유틸리티

파일: `invokeai/backend/image_util/`

#### 1) ControlNet 이미지 전처리

```python
# Canny Edge Detection
def canny_edge_detection(
    image: Image.Image,
    low_threshold: int = 100,
    high_threshold: int = 200,
) -> Image.Image:
    """Canny 엣지 검출"""
    import cv2
    import numpy as np

    # PIL → NumPy
    image_np = np.array(image)

    # 그레이스케일 변환
    gray = cv2.cvtColor(image_np, cv2.COLOR_RGB2GRAY)

    # Canny 알고리즘
    edges = cv2.Canny(gray, low_threshold, high_threshold)

    # NumPy → PIL
    return Image.fromarray(edges)
```

#### 2) Depth 추정

```python
def depth_anything(image: Image.Image) -> Image.Image:
    """Depth Anything 모델로 깊이 추정"""

    # 모델 로드 (캐시됨)
    model = load_depth_anything_model()

    # 추론
    depth_map = model.infer_image(image)

    # 정규화 (0-255)
    depth_normalized = (depth_map - depth_map.min()) / (depth_map.max() - depth_map.min())
    depth_uint8 = (depth_normalized * 255).astype(np.uint8)

    return Image.fromarray(depth_uint8)
```

#### 3) 포즈 추정

```python
def dw_openpose(image: Image.Image) -> Image.Image:
    """DWPose 모델로 포즈 추정"""
    import mediapipe as mp

    # MediaPipe 초기화
    mp_pose = mp.solutions.pose
    pose = mp_pose.Pose()

    # 포즈 검출
    results = pose.process(np.array(image))

    # 스켈레톤 그리기
    skeleton_image = draw_pose_skeleton(results, image.size)

    return skeleton_image
```

---

## 6. Extension 시스템

### 6.1 Extension 아키텍처

Extension은 노이즈 제거 과정에 기능을 추가하는 플러그인입니다.

**Extension의 장점**:
- **모듈화**: 각 기능이 독립적
- **재사용성**: 여러 Invocation에서 공통 사용
- **확장성**: 새로운 Extension 쉽게 추가

파일: `invokeai/backend/stable_diffusion/extensions/`

#### Base Extension

```python
class ExtensionBase:
    """모든 Extension의 베이스 클래스"""

    def pre_denoise_loop(self, ctx: DenoiseContext):
        """노이즈 제거 루프 시작 전"""
        pass

    def pre_step(self, ctx: DenoiseContext):
        """각 스텝 시작 전"""
        pass

    def post_step(self, ctx: DenoiseContext):
        """각 스텝 완료 후"""
        pass

    def post_denoise_loop(self, ctx: DenoiseContext):
        """노이즈 제거 루프 완료 후"""
        pass
```

### 6.2 주요 Extension들

#### 1) ControlNetExt

파일: `invokeai/backend/stable_diffusion/extensions/controlnet.py`

```python
class ControlNetExt(ExtensionBase):
    """ControlNet Extension"""

    def __init__(self, control_data: ControlField):
        self.control_data = control_data
        self.controlnet_model = None

    def pre_denoise_loop(self, ctx: DenoiseContext):
        """ControlNet 모델 로드 및 전처리"""

        # 1. ControlNet 모델 로드
        self.controlnet_model = ctx.models.load(
            self.control_data.control_model
        )

        # 2. 컨트롤 이미지 준비
        control_image = ctx.images.get(self.control_data.image)

        # 3. 리사이즈 및 정규화
        control_image = prepare_control_image(
            control_image,
            size=(ctx.latents.shape[2] * 8, ctx.latents.shape[3] * 8),
        )

        # 4. 텐서로 변환
        self.control_tensor = pil_to_tensor(control_image).to(ctx.device)

    def pre_step(self, ctx: DenoiseContext):
        """각 스텝마다 ControlNet 출력 계산"""

        # ControlNet forward pass
        down_samples, mid_sample = self.controlnet_model(
            ctx.latents,
            ctx.timestep,
            encoder_hidden_states=ctx.conditioning,
            controlnet_cond=self.control_tensor,
            conditioning_scale=self.control_data.control_weight,
        )

        # UNet에 주입
        ctx.unet_kwargs["down_block_additional_residuals"] = down_samples
        ctx.unet_kwargs["mid_block_additional_residual"] = mid_sample
```

#### 2) LoRAExt

파일: `invokeai/backend/stable_diffusion/extensions/lora.py`

```python
class LoRAExt(ExtensionBase):
    """LoRA Extension"""

    def __init__(self, loras: List[LoRAField]):
        self.loras = loras
        self.original_weights = {}

    def pre_denoise_loop(self, ctx: DenoiseContext):
        """LoRA 패치 적용"""

        for lora in self.loras:
            # 1. LoRA 로드
            lora_state_dict = ctx.models.load_lora(lora.lora_model)

            # 2. UNet에 적용
            self._apply_lora_to_model(
                ctx.unet,
                lora_state_dict,
                weight=lora.weight,
            )

            # 3. Text Encoder에도 적용 (있는 경우)
            if lora.has_text_encoder_lora:
                self._apply_lora_to_model(
                    ctx.text_encoder,
                    lora_state_dict,
                    weight=lora.weight,
                )

    def post_denoise_loop(self, ctx: DenoiseContext):
        """LoRA 패치 제거 (원래 가중치 복원)"""

        for name, original_weight in self.original_weights.items():
            # 원래 가중치로 복원
            set_module_weight(ctx.unet, name, original_weight)
```

#### 3) InpaintExt

파일: `invokeai/backend/stable_diffusion/extensions/inpaint.py`

```python
class InpaintExt(ExtensionBase):
    """인페인팅 Extension"""

    def __init__(self, mask: DenoiseMaskField):
        self.mask = mask

    def pre_denoise_loop(self, ctx: DenoiseContext):
        """마스크 및 초기 이미지 준비"""

        # 1. 마스크 로드
        mask_pil = ctx.images.get(self.mask.mask_name)
        self.mask_tensor = pil_to_tensor(mask_pil).to(ctx.device)

        # 2. 원본 이미지 인코딩 (잠재 공간으로)
        original_image = ctx.images.get(self.mask.image_name)
        self.original_latents = ctx.vae.encode(original_image)

    def post_step(self, ctx: DenoiseContext):
        """각 스텝 후 마스크 영역만 유지"""

        # 마스크 영역: 생성된 latents
        # 비마스크 영역: 원본 latents
        ctx.latents = (
            self.mask_tensor * ctx.latents +
            (1 - self.mask_tensor) * self.original_latents
        )
```

#### 4) PreviewExt

파일: `invokeai/backend/stable_diffusion/extensions/preview.py`

```python
class PreviewExt(ExtensionBase):
    """중간 결과 미리보기 Extension"""

    def __init__(self, context: InvocationContext):
        self.context = context

    def post_step(self, ctx: DenoiseContext):
        """각 스텝 후 미리보기 이미지 생성"""

        # 5 스텝마다만 미리보기 생성 (성능)
        if ctx.step % 5 != 0:
            return

        # 1. 예측된 원본 이미지 가져오기
        predicted_latents = ctx.predicted_original

        # 2. VAE 디코딩
        with torch.no_grad():
            image = ctx.vae.decode(predicted_latents)

        # 3. 텐서 → PIL
        pil_image = tensor_to_pil(image)

        # 4. 리사이즈 (작게)
        thumbnail = pil_image.resize((512, 512))

        # 5. Base64 인코딩
        preview_base64 = pil_to_base64(thumbnail)

        # 6. Socket.IO로 전송
        self.context.events.emit_generator_progress(
            step=ctx.step,
            total_steps=ctx.total_steps,
            progress_image=preview_base64,
        )
```

### 6.3 Extension Manager

파일: `invokeai/backend/stable_diffusion/extensions_manager.py`

```python
class ExtensionsManager:
    """Extension 실행 오케스트레이터"""

    def __init__(self):
        self.extensions: List[ExtensionBase] = []

    def add_extension(self, ext: ExtensionBase):
        """Extension 추가"""
        self.extensions.append(ext)

    def run_callback(
        self,
        callback_type: ExtensionCallbackType,
        ctx: DenoiseContext,
    ):
        """특정 시점의 모든 Extension 콜백 실행"""

        for ext in self.extensions:
            if callback_type == ExtensionCallbackType.PRE_DENOISE_LOOP:
                ext.pre_denoise_loop(ctx)

            elif callback_type == ExtensionCallbackType.PRE_STEP:
                ext.pre_step(ctx)

            elif callback_type == ExtensionCallbackType.POST_STEP:
                ext.post_step(ctx)

            elif callback_type == ExtensionCallbackType.POST_DENOISE_LOOP:
                ext.post_denoise_loop(ctx)
```

**노이즈 제거 루프에서 Extension 호출**:

```python
def denoise(inputs: DenoiseInputs, extensions: ExtensionsManager):
    """노이즈 제거 메인 루프"""

    ctx = DenoiseContext(...)

    # === 루프 시작 전 ===
    extensions.run_callback(ExtensionCallbackType.PRE_DENOISE_LOOP, ctx)

    # === 메인 루프 ===
    for step in range(num_steps):
        ctx.step = step

        # 스텝 시작 전
        extensions.run_callback(ExtensionCallbackType.PRE_STEP, ctx)

        # UNet forward pass
        noise_pred = unet(
            ctx.latents,
            ctx.timestep,
            encoder_hidden_states=ctx.conditioning,
            **ctx.unet_kwargs  # Extension이 추가한 kwargs
        )

        # Scheduler step
        ctx.latents = scheduler.step(noise_pred, ctx.timestep, ctx.latents)

        # 스텝 완료 후
        extensions.run_callback(ExtensionCallbackType.POST_STEP, ctx)

    # === 루프 완료 후 ===
    extensions.run_callback(ExtensionCallbackType.POST_DENOISE_LOOP, ctx)

    return ctx.latents
```

---

## 7. 데이터베이스 및 스토리지

### 7.1 SQLite 스키마 상세

파일: `invokeai/app/services/shared/sqlite/`

#### Images 테이블

```sql
CREATE TABLE images (
    image_name TEXT PRIMARY KEY,              -- UUID
    image_origin TEXT NOT NULL,               -- 'internal' | 'external'
    image_category TEXT NOT NULL,             -- 'general' | 'control' | 'mask'
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    session_id TEXT,                          -- 생성한 세션 ID
    node_id TEXT,                             -- 생성한 노드 ID
    created_at DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    updated_at DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    deleted_at DATETIME,                      -- Soft delete
    is_intermediate BOOLEAN NOT NULL DEFAULT FALSE,  -- 중간 결과 이미지 여부
    starred BOOLEAN NOT NULL DEFAULT FALSE,   -- 즐겨찾기
    -- 메타데이터 (JSON)
    metadata TEXT,                            -- 생성 파라미터 등
    -- 워크플로우
    graph TEXT,                               -- 워크플로우 JSON

    INDEX idx_created_at ON images(created_at),
    INDEX idx_starred ON images(starred),
    INDEX idx_session_id ON images(session_id)
);
```

#### Boards 테이블

```sql
CREATE TABLE boards (
    board_id TEXT PRIMARY KEY,                -- UUID
    board_name TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    updated_at DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    deleted_at DATETIME,
    cover_image_name TEXT,                    -- 커버 이미지
    archived BOOLEAN NOT NULL DEFAULT FALSE,  -- 아카이브 여부

    FOREIGN KEY (cover_image_name) REFERENCES images(image_name)
);
```

#### Board_Images 테이블 (다대다 관계)

```sql
CREATE TABLE board_images (
    board_id TEXT NOT NULL,
    image_name TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

    PRIMARY KEY (board_id, image_name),
    FOREIGN KEY (board_id) REFERENCES boards(board_id) ON DELETE CASCADE,
    FOREIGN KEY (image_name) REFERENCES images(image_name) ON DELETE CASCADE
);
```

#### Model_Config 테이블

```sql
CREATE TABLE model_config (
    id TEXT PRIMARY KEY,                      -- 모델 키
    name TEXT NOT NULL,
    description TEXT,
    source TEXT NOT NULL,                     -- 모델 출처 (URL 등)
    base TEXT NOT NULL,                       -- 'sd-1' | 'sd-2' | 'sdxl' | 'flux'
    type TEXT NOT NULL,                       -- 'main' | 'lora' | 'controlnet' | 'vae'
    path TEXT NOT NULL,                       -- 파일 경로
    format TEXT NOT NULL,                     -- 'safetensors' | 'diffusers' | 'ckpt'
    variant TEXT,                             -- 'fp16' | 'fp32'
    config_path TEXT,                         -- 설정 파일 경로

    -- 메타데이터
    created_at DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    updated_at DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

    INDEX idx_base ON model_config(base),
    INDEX idx_type ON model_config(type)
);
```

### 7.2 파일 시스템 구조

```
<outputs_dir>/
├── images/
│   ├── 2025-11/
│   │   ├── a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6.png
│   │   ├── b2c3d4e5-f6g7-h8i9-j0k1-l2m3n4o5p6q7.png
│   │   └── ...
│   ├── 2025-12/
│   └── ...
│
├── thumbnails/
│   ├── 2025-11/
│   │   ├── a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6.webp  (256x256)
│   │   └── ...
│
├── tensors/
│   ├── latents/
│   │   ├── lat_a1b2c3d4.pt
│   │   └── ...
│   ├── conditioning/
│   │   ├── cond_x1y2z3.pt
│   │   └── ...
│
├── workflows/
│   ├── workflow_001.json
│   └── ...
│
└── database/
    └── invokeai.db  (SQLite 데이터베이스)
```

### 7.3 이미지 저장 서비스

파일: `invokeai/app/services/images/images_default.py`

```python
class ImageService:
    """통합 이미지 서비스"""

    def __init__(
        self,
        image_files: ImageFilesService,
        image_records: ImageRecordsService,
        events: EventService,
    ):
        self._files = image_files
        self._records = image_records
        self._events = events

    def save(
        self,
        image: Image.Image,
        image_origin: ImageOrigin,
        image_category: ImageCategory,
        session_id: Optional[str] = None,
        node_id: Optional[str] = None,
        metadata: Optional[dict] = None,
        graph: Optional[dict] = None,
    ) -> ImageDTO:
        """이미지 저장 (파일 + DB)"""

        # 1. UUID 생성
        image_name = str(uuid.uuid4())

        # 2. 파일 저장
        self._files.save(
            image_name=image_name,
            image=image,
        )

        # 3. 썸네일 생성 및 저장
        thumbnail = image.copy()
        thumbnail.thumbnail((256, 256))
        self._files.save_thumbnail(image_name, thumbnail)

        # 4. DB 레코드 생성
        record = ImageRecord(
            image_name=image_name,
            image_origin=image_origin,
            image_category=image_category,
            width=image.width,
            height=image.height,
            session_id=session_id,
            node_id=node_id,
            metadata=json.dumps(metadata) if metadata else None,
            graph=json.dumps(graph) if graph else None,
        )
        self._records.save(record)

        # 5. 이벤트 발행
        self._events.emit_image_saved(
            image_name=image_name,
            image_origin=image_origin,
        )

        # 6. DTO 반환
        return ImageDTO.from_record(record)

    def get(self, image_name: str) -> ImageDTO:
        """이미지 메타데이터 조회"""
        record = self._records.get(image_name)
        return ImageDTO.from_record(record)

    def get_pil(self, image_name: str) -> Image.Image:
        """PIL 이미지 로드"""
        return self._files.get(image_name)

    def delete(self, image_name: str):
        """이미지 삭제 (파일 + DB)"""

        # 1. 파일 삭제
        self._files.delete(image_name)
        self._files.delete_thumbnail(image_name)

        # 2. DB 레코드 soft delete
        self._records.soft_delete(image_name)

        # 3. 이벤트 발행
        self._events.emit_image_deleted(image_name)
```

### 7.4 텐서 저장 서비스

파일: `invokeai/app/services/tensors/tensors_disk.py`

```python
class TensorsService:
    """텐서 저장/로드 서비스"""

    def save(self, tensor: torch.Tensor) -> str:
        """텐서를 디스크에 저장"""

        # 1. UUID 생성
        tensor_name = f"tensor_{uuid.uuid4()}.pt"

        # 2. CPU로 이동
        tensor_cpu = tensor.cpu()

        # 3. 파일 저장
        filepath = self.tensors_dir / tensor_name
        torch.save(tensor_cpu, filepath)

        return tensor_name

    def load(self, tensor_name: str) -> torch.Tensor:
        """디스크에서 텐서 로드"""

        filepath = self.tensors_dir / tensor_name
        tensor = torch.load(filepath, map_location="cpu")

        return tensor

    def delete(self, tensor_name: str):
        """텐서 파일 삭제"""
        filepath = self.tensors_dir / tensor_name
        filepath.unlink(missing_ok=True)
```

**왜 텐서를 별도로 저장할까?**

- **메모리 효율성**: 워크플로우 실행 중 중간 결과를 메모리에 계속 보관하면 OOM 발생
- **캐싱**: 동일한 노드 재실행 시 디스크에서 로드
- **직렬화**: Session을 JSON으로 저장할 때 텐서는 파일명만 저장

---

## 요약

InvokeAI 백엔드의 핵심 특징:

1. **FastAPI 기반 모던 웹 프레임워크**
   - 비동기 처리
   - 자동 API 문서 생성
   - 의존성 주입 패턴

2. **Invocation 시스템**
   - 노드 기반 워크플로우
   - Pydantic을 통한 강력한 타입 검증
   - 컨텍스트를 통한 서비스 접근

3. **Session Processor**
   - 백그라운드 스레드에서 비동기 실행
   - 위상 정렬 기반 의존성 해결
   - 콜백 시스템으로 확장 가능

4. **Extension 시스템**
   - 모듈화된 기능 추가
   - ControlNet, LoRA, Inpainting 등 플러그인 방식
   - 새 기능 추가 시 기존 코드 수정 불필요

5. **효율적인 리소스 관리**
   - 모델 캐싱 (LRU)
   - GPU 메모리 관리
   - 텐서/이미지 파일 시스템 저장

이 문서가 InvokeAI 백엔드 코드를 깊이 이해하는 데 도움이 되기를 바랍니다!
