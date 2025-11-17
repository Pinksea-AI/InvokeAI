# InvokeAI 데이터 흐름 완전 가이드

> 사용자 요청부터 최종 결과까지 전체 데이터 흐름 추적

## 목차

1. [전체 시스템 개요](#1-전체-시스템-개요)
2. [이미지 생성 전체 흐름](#2-이미지-생성-전체-흐름)
3. [워크플로우 실행 상세](#3-워크플로우-실행-상세)
4. [모델 로딩 흐름](#4-모델-로딩-흐름)
5. [실시간 업데이트 흐름](#5-실시간-업데이트-흐름)
6. [이미지 업로드 및 처리](#6-이미지-업로드-및-처리)
7. [ControlNet 처리 흐름](#7-controlnet-처리-흐름)
8. [에러 처리 흐름](#8-에러-처리-흐름)

---

## 1. 전체 시스템 개요

### 1.1 시스템 레이어

```
┌─────────────────────────────────────────────────────────────┐
│                      사용자 인터페이스                          │
│                    (React Components)                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ├─ 사용자 액션 (클릭, 입력 등)
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                     상태 관리 레이어                            │
│              (Redux Store + RTK Query)                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ├─ HTTP Request / WebSocket
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                     네트워크 레이어                             │
│           (REST API + Socket.IO Client)                     │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓ Internet
┌─────────────────────────────────────────────────────────────┐
│                    백엔드 API 레이어                            │
│              (FastAPI + Socket.IO Server)                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ├─ 서비스 호출
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                     서비스 레이어                              │
│    (Images, Models, Queue, Session Processor, ...)         │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ├─ 비즈니스 로직 실행
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                  Invocation 실행 레이어                        │
│         (Graph Executor + Individual Invocations)           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ├─ 모델 호출
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                   AI/ML 백엔드 레이어                          │
│        (PyTorch, Diffusers, Image Processing)               │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ├─ GPU 연산
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                    하드웨어 레이어                             │
│                   (GPU, CPU, Memory)                        │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 데이터 저장소

```
┌─────────────────────────────────────────┐
│          메모리 (RAM/VRAM)                │
│  - 모델 캐시                              │
│  - 텐서 (latents, conditioning)         │
│  - Redux 상태                            │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│         디스크 (SSD/HDD)                  │
│  ├─ SQLite 데이터베이스                   │
│  │  ├─ images (메타데이터)                │
│  │  ├─ boards                           │
│  │  ├─ model_config                     │
│  │  └─ workflows                        │
│  │                                      │
│  ├─ 파일 시스템                           │
│  │  ├─ outputs/images/ (생성 이미지)      │
│  │  ├─ outputs/thumbnails/ (썸네일)      │
│  │  ├─ outputs/tensors/ (텐서 파일)       │
│  │  └─ models/ (AI 모델 파일)            │
│  │                                      │
│  └─ IndexedDB (브라우저)                  │
│     └─ redux-remember (상태 영속화)       │
└─────────────────────────────────────────┘
```

---

## 2. 이미지 생성 전체 흐름

### 2.1 텍스트-to-이미지 생성 (간단 모드)

사용자가 "a cat in space"라는 프롬프트로 이미지를 생성하는 과정:

```
=== 1. 프론트엔드: 사용자 입력 ===

사용자
  ↓ (프롬프트 입력)
PromptInput 컴포넌트
  ↓ (onChange 이벤트)
Redux Action: positivePromptChanged("a cat in space")
  ↓ (dispatch)
Redux Store
  └─ state.params.positivePrompt = "a cat in space"

사용자
  ↓ (생성 버튼 클릭)
GenerateButton 컴포넌트
  ↓ (onClick 이벤트)


=== 2. 프론트엔드: 워크플로우 생성 ===

buildLinearWorkflow(state.params)
  ↓
워크플로우 그래프 생성:
  {
    nodes: {
      "noise": {
        type: "noise",
        width: 1024,
        height: 1024,
        seed: 123456
      },
      "positive_prompt": {
        type: "compel",
        prompt: "a cat in space"
      },
      "negative_prompt": {
        type: "compel",
        prompt: "ugly, blurry"
      },
      "denoise": {
        type: "denoise_latents",
        steps: 30,
        cfg_scale: 7.5,
        scheduler: "euler"
      },
      "vae_decode": {
        type: "l2i",
      }
    },
    edges: [
      { source: "noise", field: "latents" → destination: "denoise", field: "noise" },
      { source: "positive_prompt", field: "conditioning" → "denoise", field: "positive_conditioning" },
      { source: "negative_prompt", field: "conditioning" → "denoise", field: "negative_conditioning" },
      { source: "denoise", field: "latents" → "vae_decode", field: "latents" }
    ]
  }


=== 3. 프론트엔드: API 요청 ===

dispatch(enqueueBatch({ graph, batch_params }))
  ↓ (RTK Query Mutation)
POST /api/v1/queue/enqueue_batch
  Headers: { Content-Type: application/json }
  Body: {
    graph: { ... },
    batch: {
      batch_size: 1,
      data: [{ ... }]
    }
  }


=== 4. 백엔드: API 수신 ===

FastAPI Router
  └─ session_queue.enqueue_batch()
      ↓
SessionQueueService
  ├─ 그래프 검증
  │  ├─ 노드 타입 유효성
  │  ├─ 엣지 연결 검증
  │  └─ 순환 참조 체크
  │
  ├─ SessionQueueItem 생성
  │  └─ item_id: "abc-123-def-456"
  │
  ├─ SQLite에 저장
  │
  └─ Queue에 추가
      └─ queue.put(queue_item)


=== 5. 백엔드: Session Processor (백그라운드 스레드) ===

SessionProcessor (루프 실행 중)
  ↓ (큐 모니터링)
큐에서 항목 가져오기
  └─ queue_item = queue.get()

SessionRunner.run(queue_item)
  ↓
그래프 위상 정렬
  └─ execution_order = ["noise", "positive_prompt", "negative_prompt", "denoise", "vae_decode"]

Socket.IO 이벤트 발행
  └─ emit("session_started", { session_id: "..." })


=== 6. 노드별 실행 ===

┌──────────────────────────────────────────────────────────┐
│ Node 1: NoiseInvocation                                  │
└──────────────────────────────────────────────────────────┘
  ↓
emit("invocation_started", { node_id: "noise" })
  ↓
NoiseInvocation.invoke(context)
  ├─ torch.randn([1, 4, 128, 128], generator=generator)
  └─ latents_name = context.tensors.save(noise_tensor)
  ↓
emit("invocation_complete", {
  node_id: "noise",
  result: { latents: { latents_name: "lat_xyz123" } }
})

┌──────────────────────────────────────────────────────────┐
│ Node 2: CompelInvocation (긍정 프롬프트)                   │
└──────────────────────────────────────────────────────────┘
  ↓
emit("invocation_started", { node_id: "positive_prompt" })
  ↓
CompelInvocation.invoke(context)
  ├─ 1. CLIP 텍스트 인코더 로드
  │    └─ text_encoder = context.models.load("clip-vit-large")
  │
  ├─ 2. 토크나이제이션
  │    └─ tokens = tokenizer.encode("a cat in space")
  │    └─ [49406, 320, 2368, 530, 2062, 49407]
  │
  ├─ 3. 임베딩 생성
  │    └─ embeddings = text_encoder(tokens)
  │    └─ shape: [1, 77, 768]
  │
  └─ 4. 컨디셔닝 저장
       └─ cond_name = context.conditioning.save(embeddings)
  ↓
emit("invocation_complete", {
  node_id: "positive_prompt",
  result: { conditioning: { conditioning_name: "cond_abc123" } }
})

┌──────────────────────────────────────────────────────────┐
│ Node 3: CompelInvocation (부정 프롬프트)                   │
└──────────────────────────────────────────────────────────┘
  (동일한 과정 반복)

┌──────────────────────────────────────────────────────────┐
│ Node 4: DenoiseLatentsInvocation ⭐ (핵심)                │
└──────────────────────────────────────────────────────────┘
  ↓
emit("invocation_started", { node_id: "denoise" })
  ↓
DenoiseLatentsInvocation.invoke(context)
  │
  ├─ 1. 입력 로드
  │    ├─ noise = context.tensors.load("lat_xyz123")
  │    ├─ positive_cond = context.conditioning.load("cond_abc123")
  │    └─ negative_cond = context.conditioning.load("cond_def456")
  │
  ├─ 2. 모델 로드
  │    ├─ unet = context.models.load("sdxl_base_unet")
  │    │   └─ (모델 캐시 체크 → 디스크에서 로드 → GPU로 이동)
  │    │
  │    └─ scheduler = get_scheduler("euler", steps=30)
  │
  ├─ 3. 노이즈 제거 루프 (30 스텝)
  │    │
  │    FOR step in 0..29:
  │      │
  │      ├─ Timestep 계산
  │      │  └─ t = scheduler.timesteps[step]
  │      │
  │      ├─ UNet Forward Pass
  │      │  ├─ 조건부 예측 (with positive prompt)
  │      │  │  └─ noise_pred_cond = unet(latents, t, positive_cond)
  │      │  │
  │      │  ├─ 비조건부 예측 (with negative prompt)
  │      │  │  └─ noise_pred_uncond = unet(latents, t, negative_cond)
  │      │  │
  │      │  └─ Classifier-Free Guidance
  │      │     └─ noise_pred = noise_pred_uncond +
  │      │                    cfg_scale * (noise_pred_cond - noise_pred_uncond)
  │      │
  │      ├─ Scheduler Step
  │      │  └─ latents = scheduler.step(noise_pred, t, latents)
  │      │
  │      ├─ 중간 결과 미리보기 (5 스텝마다)
  │      │  IF step % 5 == 0:
  │      │    ├─ predicted_image = vae.decode(latents)
  │      │    ├─ preview_base64 = encode_base64(predicted_image)
  │      │    └─ emit("generator_progress", {
  │      │         step: step,
  │      │         total_steps: 30,
  │      │         progress_image: preview_base64
  │      │       })
  │      │
  │      └─ 취소 체크
  │         IF context.is_canceled():
  │           RAISE CanceledException
  │
  └─ 4. 결과 저장
       └─ result_name = context.tensors.save(latents)
  ↓
emit("invocation_complete", {
  node_id: "denoise",
  result: { latents: { latents_name: "lat_final123" } }
})

┌──────────────────────────────────────────────────────────┐
│ Node 5: VAEDecodeInvocation                              │
└──────────────────────────────────────────────────────────┘
  ↓
emit("invocation_started", { node_id: "vae_decode" })
  ↓
VAEDecodeInvocation.invoke(context)
  ├─ 1. Latents 로드
  │    └─ latents = context.tensors.load("lat_final123")
  │
  ├─ 2. VAE 디코더 로드
  │    └─ vae = context.models.load("sdxl_vae")
  │
  ├─ 3. 디코딩
  │    └─ image_tensor = vae.decode(latents)
  │    └─ shape: [1, 3, 1024, 1024]
  │
  ├─ 4. 텐서 → PIL Image
  │    └─ pil_image = tensor_to_pil(image_tensor)
  │
  └─ 5. 이미지 저장
       ├─ image_dto = context.images.save(pil_image)
       │   ├─ 파일 저장: outputs/images/2025-11/img_abc123.png
       │   ├─ 썸네일 생성: outputs/thumbnails/2025-11/img_abc123.webp
       │   └─ DB 저장: INSERT INTO images (...)
       │
       └─ emit("image_saved", { image_name: "img_abc123" })
  ↓
emit("invocation_complete", {
  node_id: "vae_decode",
  result: { image: { image_name: "img_abc123" } }
})


=== 7. 백엔드: Session 완료 ===

SessionRunner
  └─ session.is_complete() == True

emit("session_complete", {
  session_id: "...",
  status: "completed"
})


=== 8. 프론트엔드: 실시간 업데이트 수신 ===

Socket.IO Client
  │
  ├─ on("session_started")
  │  └─ dispatch(sessionStarted(...))
  │
  ├─ on("invocation_started")
  │  └─ dispatch(invocationStarted(...))
  │      └─ UI: 노드에 "실행 중" 표시
  │
  ├─ on("generator_progress")  (5번 수신, step 5, 10, 15, 20, 25)
  │  └─ dispatch(generatorProgress(...))
  │      └─ UI: 진행률 바 업데이트 + 미리보기 이미지 표시
  │
  ├─ on("invocation_complete")  (5번 수신)
  │  └─ dispatch(invocationComplete(...))
  │      └─ UI: 노드에 "완료" 체크 표시
  │
  ├─ on("image_saved")
  │  └─ dispatch(imageAdded(...))
  │      └─ UI: 갤러리에 이미지 추가 (썸네일)
  │
  └─ on("session_complete")
     └─ dispatch(sessionComplete(...))
         └─ UI: "생성 완료!" 토스트 알림


=== 9. 프론트엔드: 이미지 표시 ===

Gallery 컴포넌트
  ↓ (Redux 상태 변화 감지)
리렌더링
  ↓
useListImagesQuery() 자동 재실행
  ↓
GET /api/v1/images/?board_id=none&offset=0&limit=20
  ↓
새 이미지 포함된 목록 반환
  ↓
ImageGrid 업데이트
  └─ <img src="/api/v1/images/img_abc123/thumbnail" />
```

**전체 소요 시간 예시:**
- API 요청: ~10ms
- 큐 대기: ~100ms (다른 작업이 없는 경우)
- 노이즈 제거 (30 스텝): ~15초 (GPU 성능에 따라 다름)
- VAE 디코딩: ~0.5초
- 이미지 저장: ~50ms
- **총 약 15-20초**

---

## 3. 워크플로우 실행 상세

### 3.1 그래프 검증 과정

```python
def validate_graph(graph: Graph) -> List[str]:
    """워크플로우 그래프 검증"""
    errors = []

    # 1. 노드 타입 검증
    for node_id, node in graph.nodes.items():
        if node.type not in REGISTERED_INVOCATIONS:
            errors.append(f"Unknown node type: {node.type}")

    # 2. 필수 입력 확인
    for node_id, node in graph.nodes.items():
        invocation_class = get_invocation_class(node.type)

        for field_name, field_info in invocation_class.__fields__.items():
            # 필수 필드인가?
            if field_info.required:
                # 값이 제공되었는가?
                has_value = field_name in node and node[field_name] is not None

                # 연결되어 있는가?
                has_connection = any(
                    edge.destination.node_id == node_id and
                    edge.destination.field == field_name
                    for edge in graph.edges
                )

                if not has_value and not has_connection:
                    errors.append(
                        f"Node {node_id}: Required field '{field_name}' "
                        f"has no value and no connection"
                    )

    # 3. 타입 호환성 확인
    for edge in graph.edges:
        source_node = graph.nodes[edge.source.node_id]
        dest_node = graph.nodes[edge.destination.node_id]

        source_type = get_output_type(source_node, edge.source.field)
        dest_type = get_input_type(dest_node, edge.destination.field)

        if not are_types_compatible(source_type, dest_type):
            errors.append(
                f"Type mismatch: {edge.source} ({source_type}) → "
                f"{edge.destination} ({dest_type})"
            )

    # 4. 순환 참조 확인
    if has_cycle(graph):
        errors.append("Graph contains cycle")

    return errors
```

### 3.2 위상 정렬 알고리즘

```python
def topological_sort(graph: Graph) -> List[str]:
    """
    Kahn's Algorithm을 사용한 위상 정렬

    예시 그래프:
        A → B → D
        A → C → D

    진입 차수 (In-degree):
        A: 0
        B: 1 (A에서 들어옴)
        C: 1 (A에서 들어옴)
        D: 2 (B, C에서 들어옴)
    """

    # 1. 진입 차수 계산
    in_degree = {node_id: 0 for node_id in graph.nodes}

    for edge in graph.edges:
        in_degree[edge.destination.node_id] += 1

    # 2. 진입 차수가 0인 노드를 큐에 추가
    queue = [node_id for node_id, degree in in_degree.items() if degree == 0]
    result = []

    # 3. 큐에서 노드를 하나씩 처리
    while queue:
        # 큐에서 노드 꺼내기
        node_id = queue.pop(0)
        result.append(node_id)

        # 이 노드에서 나가는 엣지 찾기
        outgoing_edges = [
            edge for edge in graph.edges
            if edge.source.node_id == node_id
        ]

        # 연결된 노드의 진입 차수 감소
        for edge in outgoing_edges:
            dest_id = edge.destination.node_id
            in_degree[dest_id] -= 1

            # 진입 차수가 0이 되면 큐에 추가
            if in_degree[dest_id] == 0:
                queue.append(dest_id)

    # 4. 모든 노드를 방문했는지 확인
    if len(result) != len(graph.nodes):
        raise GraphHasCyclesError("Graph contains cycle")

    return result

# 위 예시의 실행 결과: ["A", "B", "C", "D"] 또는 ["A", "C", "B", "D"]
```

### 3.3 노드 간 데이터 전달

```python
class Session:
    """워크플로우 세션"""

    def __init__(self, graph: Graph):
        self.graph = graph
        self.execution_order = topological_sort(graph)
        self.current_index = 0

        # 각 노드의 출력을 저장
        self.results: Dict[str, BaseInvocationOutput] = {}

    def next(self) -> Optional[BaseInvocation]:
        """다음 실행할 Invocation 반환"""

        if self.current_index >= len(self.execution_order):
            return None  # 완료

        node_id = self.execution_order[self.current_index]
        node_dict = self.graph.nodes[node_id]

        # Invocation 인스턴스 생성
        invocation = create_invocation(node_dict)

        # 입력 필드에 연결된 값 주입
        for edge in self.graph.edges:
            if edge.destination.node_id == node_id:
                # 소스 노드의 출력 가져오기
                source_output = self.results[edge.source.node_id]
                source_value = getattr(source_output, edge.source.field)

                # 대상 노드의 입력에 설정
                setattr(invocation, edge.destination.field, source_value)

        self.current_index += 1
        return invocation

    def complete(self, node_id: str, output: BaseInvocationOutput):
        """노드 실행 완료 및 결과 저장"""
        self.results[node_id] = output
```

---

## 4. 모델 로딩 흐름

### 4.1 모델 로딩 상세

```
Invocation.invoke(context)
  │
  ├─ context.models.load("sdxl_base")
  │   │
  │   ├─ ModelLoadService.load()
  │   │   │
  │   │   ├─ 1. 캐시 확인
  │   │   │    └─ cache.get("sdxl_base")
  │   │   │        ├─ HIT: return cached_model ✓
  │   │   │        └─ MISS: continue
  │   │   │
  │   │   ├─ 2. 모델 메타데이터 조회
  │   │   │    └─ SELECT * FROM model_config WHERE id = 'sdxl_base'
  │   │   │        └─ {
  │   │   │             id: "sdxl_base",
  │   │   │             path: "/models/sdxl/base.safetensors",
  │   │   │             type: "main",
  │   │   │             base: "sdxl",
  │   │   │             variant: "fp16"
  │   │   │           }
  │   │   │
  │   │   ├─ 3. 메모리 체크
  │   │   │    ├─ 모델 크기: 6.9GB
  │   │   │    ├─ VRAM 사용량: 8GB / 12GB
  │   │   │    └─ 공간 부족!
  │   │   │        └─ cache.evict_lru()
  │   │   │            └─ 가장 오래된 모델 언로드
  │   │   │                └─ "sd15_model" 제거
  │   │   │                    └─ VRAM: 4GB / 12GB (여유 확보)
  │   │   │
  │   │   ├─ 4. 디스크에서 모델 로드
  │   │   │    └─ load_safetensors("/models/sdxl/base.safetensors")
  │   │   │        ├─ 파일 읽기 (메모리 매핑)
  │   │   │        └─ state_dict 생성
  │   │   │            └─ {
  │   │   │                 "model.diffusion_model.input_blocks.0.0.weight": Tensor([...]),
  │   │   │                 "model.diffusion_model.input_blocks.0.0.bias": Tensor([...]),
  │   │   │                 ...
  │   │   │               }
  │   │   │
  │   │   ├─ 5. PyTorch 모델 생성
  │   │   │    └─ unet = UNet2DConditionModel(config)
  │   │   │        └─ unet.load_state_dict(state_dict)
  │   │   │
  │   │   ├─ 6. GPU로 이동
  │   │   │    └─ unet.to("cuda")
  │   │   │        └─ emit("model_load_started", { model: "sdxl_base" })
  │   │   │            └─ (GPU 메모리 복사: ~5초 소요)
  │   │   │                └─ emit("model_load_complete", { model: "sdxl_base" })
  │   │   │
  │   │   ├─ 7. 캐시에 저장
  │   │   │    └─ cache.put("sdxl_base", unet)
  │   │   │
  │   │   └─ 8. Context Manager 반환
  │   │        └─ return LoadedModel(unet, cache_key="sdxl_base")
  │   │
  │   └─ with loaded_model as unet:
  │        └─ unet.forward(...)  # 모델 사용
  │
  └─ (with 블록 종료 시 자동으로 캐시에 유지, 언로드하지 않음)
```

### 4.2 LoRA 패칭

```
DenoiseLatentsInvocation.invoke(context)
  │
  ├─ LoRA 목록: ["style_lora_1", "character_lora_2"]
  │
  ├─ Extension Manager에 LoRA Extension 추가
  │   └─ ext_manager.add_extension(LoRAExt([lora1, lora2]))
  │
  ├─ pre_denoise_loop 콜백
  │   └─ LoRAExt.pre_denoise_loop(ctx)
  │       │
  │       FOR EACH lora IN loras:
  │         │
  │         ├─ 1. LoRA 로드
  │         │    └─ lora_state_dict = load_safetensors(lora.path)
  │         │        └─ {
  │         │             "lora_unet_down_blocks_0_attentions_0_proj_in.lora_up.weight": Tensor([...]),
  │         │             "lora_unet_down_blocks_0_attentions_0_proj_in.lora_down.weight": Tensor([...]),
  │         │             ...
  │         │           }
  │         │
  │         ├─ 2. UNet 레이어 순회
  │         │    FOR EACH layer IN unet.layers:
  │         │      │
  │         │      ├─ LoRA 키 찾기
  │         │      │  └─ lora_key = f"lora_unet_{layer.name}"
  │         │      │
  │         │      IF lora_key IN lora_state_dict:
  │         │        │
  │         │        ├─ LoRA 행렬 가져오기
  │         │        │  ├─ lora_up = lora_state_dict[f"{lora_key}.lora_up.weight"]
  │         │        │  └─ lora_down = lora_state_dict[f"{lora_key}.lora_down.weight"]
  │         │        │
  │         │        ├─ LoRA 계산
  │         │        │  └─ delta = lora.weight * (lora_up @ lora_down)
  │         │        │      └─ shape: [out_features, in_features]
  │         │        │
  │         │        ├─ 원래 가중치 백업
  │         │        │  └─ original_weights[layer.name] = layer.weight.clone()
  │         │        │
  │         │        └─ 가중치에 LoRA 적용
  │         │           └─ layer.weight.data += delta
  │         │
  │         └─ 3. Text Encoder에도 적용 (있는 경우)
  │              └─ (동일한 과정 반복)
  │
  ├─ 노이즈 제거 실행 (LoRA가 적용된 UNet 사용)
  │
  └─ post_denoise_loop 콜백
      └─ LoRAExt.post_denoise_loop(ctx)
          └─ FOR EACH layer IN original_weights:
               └─ layer.weight.data = original_weights[layer.name]  # 복원
```

---

## 5. 실시간 업데이트 흐름

### 5.1 Socket.IO 이벤트 흐름

```
=== 백엔드 ===

SessionProcessor (Thread)
  │
  ├─ 노드 실행 시작
  │   └─ events.emit_invocation_started(node_id)
  │       └─ EventService.emit()
  │           └─ SocketIOService.emit("invocation_started", data)
  │               │
  │               ├─ JSON 직렬화
  │               │  └─ json.dumps({
  │               │       "node_id": "denoise_abc123",
  │               │       "invocation_type": "denoise_latents",
  │               │       "timestamp": "2025-11-17T10:30:00"
  │               │     })
  │               │
  │               └─ WebSocket 전송
  │                   └─ socket_io.emit("invocation_started", json_data)
  │
  ├─ 노이즈 제거 중 (스텝마다)
  │   └─ step_callback()
  │       └─ IF step % 5 == 0:
  │            └─ events.emit_generator_progress(step, total, image)
  │                └─ SocketIOService.emit("generator_progress", {
  │                     "step": 15,
  │                     "total_steps": 30,
  │                     "progress_image": "iVBORw0KGgoAAAANS..."  # Base64
  │                   })
  │
  └─ 노드 실행 완료
      └─ events.emit_invocation_complete(node_id, output)
          └─ SocketIOService.emit("invocation_complete", data)


=== 네트워크 ===

WebSocket Protocol
  ├─ 양방향 연결 유지
  └─ 서버 → 클라이언트 푸시


=== 프론트엔드 ===

Socket.IO Client (services/events/socketio.ts)
  │
  ├─ WebSocket 수신
  │   └─ on("invocation_started", (data) => { ... })
  │       │
  │       ├─ JSON 파싱
  │       │  └─ {
  │       │       node_id: "denoise_abc123",
  │       │       invocation_type: "denoise_latents",
  │       │       timestamp: "2025-11-17T10:30:00"
  │       │     }
  │       │
  │       └─ Redux Dispatch
  │           └─ store.dispatch(invocationStarted(data))
  │
  ├─ Redux Reducer 실행
  │   └─ nodesSlice (features/nodes/store/nodesSlice.ts)
  │       │
  │       ├─ case invocationStarted:
  │       │   └─ state.nodeExecutionStates[action.payload.node_id] = {
  │       │        status: "in_progress",
  │       │        progress: 0
  │       │      }
  │       │
  │       └─ case generatorProgress:
  │            └─ state.nodeExecutionStates[node_id].progress =
  │                 (step / total_steps) * 100
  │
  └─ React 컴포넌트 리렌더링
      └─ NodeEditor (features/nodes/components/Flow/Flow.tsx)
          │
          ├─ useAppSelector((s) => s.nodes.nodeExecutionStates)
          │
          └─ 노드 UI 업데이트
              ├─ 실행 중인 노드에 스피너 아이콘 표시
              ├─ 진행률 바 표시 (15 / 30 = 50%)
              └─ 미리보기 이미지 표시
                  └─ <img src={`data:image/png;base64,${progressImage}`} />
```

---

## 6. 이미지 업로드 및 처리

### 6.1 이미지 업로드 흐름

```
=== 1. 프론트엔드: 파일 선택 ===

사용자
  ↓ (파일 선택)
<input type="file" onChange={handleFileChange} />
  ↓
handleFileChange(event)
  ├─ file = event.target.files[0]
  │   └─ File {
  │        name: "my-image.jpg",
  │        size: 2048000,  # 2MB
  │        type: "image/jpeg"
  │      }
  │
  ├─ FormData 생성
  │   └─ formData = new FormData()
  │       └─ formData.append("file", file)
  │
  └─ dispatch(uploadImage(formData))


=== 2. RTK Query Mutation ===

uploadImage.initiate(formData)
  ↓
POST /api/v1/images/upload
  Headers: {
    Content-Type: multipart/form-data;
                  boundary=----WebKitFormBoundary...
  }
  Body:
    ------WebKitFormBoundary...
    Content-Disposition: form-data; name="file"; filename="my-image.jpg"
    Content-Type: image/jpeg

    <binary image data>
    ------WebKitFormBoundary...--


=== 3. 백엔드: 이미지 수신 및 처리 ===

FastAPI Router
  └─ @router.post("/upload")
      async def upload_image(file: UploadFile):
          │
          ├─ 1. 이미지 검증
          │    ├─ 파일 크기 체크 (< 100MB)
          │    ├─ MIME 타입 체크 (image/*)
          │    └─ 이미지 형식 검증 (PIL로 열기 시도)
          │
          ├─ 2. PIL Image로 변환
          │    └─ image = Image.open(file.file)
          │        └─ mode: RGB
          │        └─ size: (2048, 1536)
          │
          ├─ 3. EXIF 제거 (프라이버시)
          │    └─ image = remove_exif(image)
          │
          ├─ 4. 이미지 저장 (ImageService)
          │    └─ image_dto = images.save(
          │         image=image,
          │         image_origin=ResourceOrigin.EXTERNAL,
          │         image_category=ImageCategory.GENERAL,
          │       )
          │       │
          │       ├─ 4.1. UUID 생성
          │       │    └─ image_name = str(uuid.uuid4())
          │       │        └─ "a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6"
          │       │
          │       ├─ 4.2. 디렉토리 생성
          │       │    └─ outputs/images/2025-11/
          │       │
          │       ├─ 4.3. 원본 이미지 저장
          │       │    └─ image.save(
          │       │         "outputs/images/2025-11/a1b2c3d4...png",
          │       │         format="PNG",
          │       │         compress_level=6
          │       │       )
          │       │
          │       ├─ 4.4. 썸네일 생성 및 저장
          │       │    ├─ thumbnail = image.copy()
          │       │    ├─ thumbnail.thumbnail((256, 256))
          │       │    └─ thumbnail.save(
          │       │         "outputs/thumbnails/2025-11/a1b2c3d4...webp",
          │       │         format="WEBP",
          │       │         quality=80
          │       │       )
          │       │
          │       ├─ 4.5. DB 레코드 생성
          │       │    └─ INSERT INTO images (
          │       │         image_name,
          │       │         image_origin,
          │       │         image_category,
          │       │         width,
          │       │         height,
          │       │         created_at
          │       │       ) VALUES (
          │       │         'a1b2c3d4...',
          │       │         'external',
          │       │         'general',
          │       │         2048,
          │       │         1536,
          │       │         '2025-11-17 10:30:00'
          │       │       )
          │       │
          │       └─ 4.6. 이벤트 발행
          │            └─ emit("image_saved", {
          │                 image_name: "a1b2c3d4...",
          │                 image_origin: "external"
          │               })
          │
          └─ 5. 응답 반환
               └─ return ImageDTO(
                    image_name="a1b2c3d4...",
                    image_url="/api/v1/images/a1b2c3d4.../full",
                    thumbnail_url="/api/v1/images/a1b2c3d4.../thumbnail",
                    width=2048,
                    height=1536,
                    created_at="2025-11-17T10:30:00"
                  )


=== 4. 프론트엔드: 응답 처리 ===

RTK Query
  ├─ Mutation 완료
  │   └─> onQueryStarted lifecycle
  │
  ├─ Listener Middleware 트리거
  │   └─ addImageUploadedFulfilledListener
  │       │
  │       ├─ 갤러리에 이미지 추가
  │       │  └─ dispatch(imageAdded(image_dto))
  │       │
  │       ├─ 토스트 알림
  │       │  └─ toast({ title: "이미지 업로드 완료!" })
  │       │
  │       └─ 관련 쿼리 무효화
  │            └─ invalidateTags: [{ type: 'Image', id: 'LIST' }]
  │                └─ 갤러리 쿼리 자동 재실행
  │
  └─ UI 업데이트
      └─ Gallery 컴포넌트 리렌더링
          └─ 새 이미지 표시
```

---

## 7. ControlNet 처리 흐름

### 7.1 Canny Edge ControlNet 전체 과정

```
=== 사용자 목표 ===
원본 이미지의 엣지 구조를 유지하면서 스타일 변경


=== 1. 워크플로우 구성 ===

{
  nodes: {
    "load_image": {
      type: "image",
      image_name: "original_cat.png"
    },
    "canny": {
      type: "canny_edge_detection",
      low_threshold: 100,
      high_threshold: 200
    },
    "controlnet": {
      type: "controlnet",
      control_model: "control_sd15_canny",
      control_weight: 0.8
    },
    "positive_prompt": {
      type: "compel",
      prompt: "watercolor painting of a cat"
    },
    "denoise": {
      type: "denoise_latents",
      steps: 30
    },
    "vae_decode": {
      type: "l2i"
    }
  },
  edges: [
    { "load_image" → "canny" },
    { "canny" → "controlnet" },
    { "controlnet" → "denoise" },
    { "positive_prompt" → "denoise" },
    { "denoise" → "vae_decode" }
  ]
}


=== 2. 노드 실행 ===

┌────────────────────────────────────────────┐
│ Node 1: LoadImageInvocation                │
└────────────────────────────────────────────┘
  ↓
ImageService.get_pil("original_cat.png")
  ├─ 파일 로드: outputs/images/.../original_cat.png
  └─ PIL Image 반환
      └─ size: (512, 512), mode: RGB

┌────────────────────────────────────────────┐
│ Node 2: CannyEdgeDetectionInvocation       │
└────────────────────────────────────────────┘
  ↓
invoke(context)
  ├─ 1. 이미지 로드
  │    └─ image = context.images.get_pil(input_image)
  │
  ├─ 2. NumPy 변환
  │    └─ image_np = np.array(image)
  │        └─ shape: (512, 512, 3)
  │
  ├─ 3. 그레이스케일 변환
  │    └─ gray = cv2.cvtColor(image_np, cv2.COLOR_RGB2GRAY)
  │        └─ shape: (512, 512)
  │
  ├─ 4. Canny Edge Detection
  │    └─ edges = cv2.Canny(
  │         gray,
  │         threshold1=100,  # low_threshold
  │         threshold2=200   # high_threshold
  │       )
  │       └─ shape: (512, 512)
  │       └─ 엣지는 흰색(255), 배경은 검은색(0)
  │
  ├─ 5. PIL Image로 변환
  │    └─ edge_image = Image.fromarray(edges)
  │
  └─ 6. 이미지 저장
       └─ image_dto = context.images.save(edge_image)
           └─ outputs/images/.../canny_edges.png

┌────────────────────────────────────────────┐
│ Node 3: ControlNetInvocation               │
└────────────────────────────────────────────┘
  ↓
invoke(context)
  ├─ 입력 수집
  │   ├─ control_image = canny_edges.png
  │   ├─ control_model = "control_sd15_canny"
  │   └─ control_weight = 0.8
  │
  └─ ControlField 생성 및 반환
       └─ ControlOutput(
            control=ControlField(
              image=control_image,
              control_model=control_model,
              control_weight=0.8,
              begin_step_percent=0.0,
              end_step_percent=1.0
            )
          )

┌────────────────────────────────────────────┐
│ Node 4: DenoiseLatentsInvocation           │
│ (ControlNet 적용됨)                         │
└────────────────────────────────────────────┘
  ↓
invoke(context)
  ├─ Extension 추가
  │   └─ ext_manager.add_extension(
  │        ControlNetExt(control_field)
  │      )
  │
  ├─ pre_denoise_loop
  │   └─ ControlNetExt.pre_denoise_loop(ctx)
  │       │
  │       ├─ 1. ControlNet 모델 로드
  │       │    └─ controlnet = context.models.load("control_sd15_canny")
  │       │        └─ ControlNetModel (diffusers)
  │       │
  │       ├─ 2. 컨트롤 이미지 준비
  │       │    ├─ control_image = context.images.get_pil(...)
  │       │    ├─ 크기 조정 (512x512 → latent 크기의 8배)
  │       │    └─ 텐서 변환 및 정규화
  │       │        └─ control_tensor = pil_to_tensor(control_image)
  │       │            └─ shape: [1, 3, 512, 512]
  │       │            └─ range: [0, 1]
  │       │
  │       └─ 3. ControlNet 텐서 GPU로 이동
  │            └─ control_tensor = control_tensor.to("cuda")
  │
  ├─ 노이즈 제거 루프
  │   │
  │   FOR step in 0..29:
  │     │
  │     ├─ pre_step
  │     │   └─ ControlNetExt.pre_step(ctx)
  │     │       │
  │     │       ├─ ControlNet Forward Pass
  │     │       │  └─ down_samples, mid_sample = controlnet(
  │     │       │       sample=latents,
  │     │       │       timestep=timestep,
  │     │       │       encoder_hidden_states=conditioning,
  │     │       │       controlnet_cond=control_tensor,  # 엣지 이미지
  │     │       │       conditioning_scale=0.8           # 가중치
  │     │       │     )
  │     │       │     └─ down_samples: 각 레벨의 특성맵
  │     │       │     └─ mid_sample: 중간 레벨 특성맵
  │     │       │
  │     │       └─ UNet에 주입
  │     │            └─ ctx.unet_kwargs["down_block_additional_residuals"] = down_samples
  │     │            └─ ctx.unet_kwargs["mid_block_additional_residual"] = mid_sample
  │     │
  │     ├─ UNet Forward Pass (ControlNet 출력 포함)
  │     │   └─ noise_pred = unet(
  │     │        latents,
  │     │        timestep,
  │     │        encoder_hidden_states=conditioning,
  │     │        down_block_additional_residuals=down_samples,  # ControlNet
  │     │        mid_block_additional_residual=mid_sample        # ControlNet
  │     │      )
  │     │      └─ ControlNet이 UNet의 각 블록에 추가 정보 제공
  │     │         └─ 엣지 구조를 유지하도록 가이드
  │     │
  │     └─ Scheduler Step
  │          └─ latents = scheduler.step(noise_pred, timestep, latents)
  │
  └─ 결과: 엣지 구조를 유지한 잠재 이미지

┌────────────────────────────────────────────┐
│ Node 5: VAEDecodeInvocation                │
└────────────────────────────────────────────┘
  └─ 최종 이미지: 고양이의 윤곽은 유지하되 수채화 스타일로 변환
```

---

## 8. 에러 처리 흐름

### 8.1 Invocation 에러 처리

```
SessionRunner.run_node(invocation, queue_item)
  │
  TRY:
    │
    ├─ invocation.invoke(context)
    │   │
    │   TRY:
    │     │
    │     ├─ 실행 로직
    │     │
    │     └─ 에러 발생!
    │          └─ raise ValueError("Invalid input")
    │
    │   EXCEPT Exception as e:
    │     │
    │     └─ InvocationError로 래핑
    │          └─ raise InvocationError(
    │               invocation_id=invocation.id,
    │               message=str(e),
    │               traceback=traceback.format_exc()
    │             )
    │
  EXCEPT InvocationError as e:
    │
    ├─ 에러 정보 수집
    │   ├─ error_type = "ValueError"
    │   ├─ error_message = "Invalid input"
    │   └─ error_traceback = "Traceback (most recent call last):\n..."
    │
    ├─ 세션 실패 처리
    │   ├─ queue_item.status = "failed"
    │   └─ queue_item.error = error_message
    │
    ├─ DB 업데이트
    │   └─ UPDATE session_queue
    │        SET status = 'failed',
    │            error = 'Invalid input'
    │        WHERE item_id = '...'
    │
    ├─ 이벤트 발행
    │   └─ emit("invocation_error", {
    │        node_id: invocation.id,
    │        session_id: queue_item.session_id,
    │        error_type: "ValueError",
    │        error: "Invalid input",
    │        traceback: "..."
    │      })
    │
    └─ 세션 중단
         └─ break  # 다음 노드 실행하지 않음


=== 프론트엔드 ===

Socket.IO Client
  └─ on("invocation_error", (data) => {
       │
       ├─ Redux Dispatch
       │   └─ dispatch(invocationError(data))
       │       └─ state.nodes.nodeExecutionStates[node_id] = {
       │            status: "error",
       │            error: data.error
       │          }
       │
       └─ UI 업데이트
            ├─ 노드에 빨간색 에러 아이콘 표시
            ├─ 에러 메시지 툴팁 표시
            └─ 에러 모달 표시 (선택적)
                └─ Modal {
                     title: "Invocation Error",
                     message: "Invalid input",
                     traceback: "..." (접을 수 있음)
                   }
     })
```

### 8.2 네트워크 에러 처리

```
RTK Query
  │
  ├─ API 요청
  │   └─ POST /api/v1/queue/enqueue_batch
  │
  CATCH NetworkError:
    │
    ├─ 자동 재시도 (최대 3회)
    │   │
    │   FOR attempt in 1..3:
    │     │
    │     ├─ 지수 백오프
    │     │   └─ wait(2^attempt 초)
    │     │
    │     └─ 재시도
    │          └─ IF success: break
    │
    └─ 모두 실패 시
         │
         ├─ 에러 상태 저장
         │   └─ mutation.error = {
         │        status: "FETCH_ERROR",
         │        error: "Network request failed"
         │      }
         │
         └─ UI에 에러 표시
              └─ toast({
                   title: "Network Error",
                   description: "Failed to connect to server",
                   status: "error",
                   action: <Button>Retry</Button>
                 })
```

---

## 요약

InvokeAI의 데이터 흐름 핵심 특징:

1. **계층화된 아키텍처**
   - 명확한 책임 분리
   - 각 레이어 간 표준화된 인터페이스

2. **비동기 처리**
   - 백그라운드에서 워크플로우 실행
   - 프론트엔드는 응답성 유지

3. **실시간 피드백**
   - Socket.IO로 진행률 실시간 업데이트
   - 사용자 경험 향상

4. **효율적인 리소스 관리**
   - 모델 캐싱으로 로딩 시간 단축
   - 텐서/이미지 파일 시스템 저장

5. **강력한 에러 처리**
   - 각 레이어에서 에러 처리
   - 사용자에게 명확한 피드백

이 문서가 InvokeAI의 전체 데이터 흐름을 이해하는 데 도움이 되기를 바랍니다!
