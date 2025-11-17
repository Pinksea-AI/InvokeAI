# InvokeAI 코드베이스 완전 분석 가이드

> 신입 개발자를 위한 InvokeAI 소스코드 완전 분석 문서

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [전체 디렉토리 구조](#2-전체-디렉토리-구조)
3. [기술 스택](#3-기술-스택)
4. [애플리케이션 시작 과정](#4-애플리케이션-시작-과정)
5. [백엔드 아키텍처](#5-백엔드-아키텍처)
6. [프론트엔드 아키텍처](#6-프론트엔드-아키텍처)
7. [핵심 개념과 용어](#7-핵심-개념과-용어)
8. [주요 기능별 상세 설명](#8-주요-기능별-상세-설명)
9. [데이터 흐름](#9-데이터-흐름)
10. [개발 시작하기](#10-개발-시작하기)

---

## 1. 프로젝트 개요

### InvokeAI란?

InvokeAI는 **AI 기반 이미지 생성 애플리케이션**입니다. Stable Diffusion, FLUX, SD3 등 다양한 AI 모델을 사용하여 텍스트로부터 이미지를 생성하거나, 기존 이미지를 변형할 수 있습니다.

### 주요 기능

- **텍스트-to-이미지 (Text-to-Image)**: 텍스트 프롬프트로 이미지 생성
- **이미지-to-이미지 (Image-to-Image)**: 기존 이미지를 변형
- **인페인팅 (Inpainting)**: 이미지의 특정 영역 수정
- **ControlNet**: 특정 조건(포즈, 엣지 등)을 기반으로 이미지 생성
- **LoRA 지원**: 커스텀 스타일 적용
- **노드 기반 워크플로우**: 복잡한 생성 파이프라인 구성
- **모델 관리**: 다양한 AI 모델 설치 및 관리
- **갤러리**: 생성된 이미지 관리 및 정리

### 프로젝트 유형

- **모노레포 (Monorepo)**: 백엔드(Python)와 프론트엔드(React)가 하나의 저장소에 있음
- **웹 애플리케이션**: 브라우저에서 사용하는 풀스택 웹앱
- **로컬 실행**: 사용자의 컴퓨터에서 실행되며, 사용자의 GPU를 활용

---

## 2. 전체 디렉토리 구조

```
InvokeAI/
│
├── invokeai/                    # 메인 소스코드 디렉토리
│   ├── app/                     # 애플리케이션 레이어
│   │   ├── api/                 # REST API 엔드포인트
│   │   ├── invocations/         # 노드(작업 단위) 정의 (80+ 파일)
│   │   ├── services/            # 비즈니스 로직 서비스 (30+ 모듈)
│   │   ├── util/                # 유틸리티 함수
│   │   ├── api_app.py           # FastAPI 앱 설정
│   │   └── run_app.py           # 앱 시작점 (메인 엔트리)
│   │
│   ├── backend/                 # 코어 AI/ML 백엔드
│   │   ├── flux/                # FLUX 모델 구현
│   │   ├── stable_diffusion/    # Stable Diffusion 구현
│   │   ├── model_manager/       # 모델 로딩 및 관리
│   │   ├── image_util/          # 이미지 처리 (depth, pose, 등)
│   │   ├── ip_adapter/          # IP Adapter 구현
│   │   ├── patches/             # LoRA 패칭 시스템
│   │   ├── quantization/        # 모델 양자화 (GGUF)
│   │   └── util/                # 백엔드 유틸리티
│   │
│   ├── frontend/                # 프론트엔드 코드
│   │   └── web/                 # React 웹 UI
│   │       ├── public/          # 정적 파일
│   │       └── src/             # 소스코드
│   │           ├── app/         # 앱 설정 (Redux store 등)
│   │           ├── common/      # 공통 컴포넌트/유틸
│   │           ├── features/    # 기능별 모듈 (22개)
│   │           ├── services/    # API 클라이언트
│   │           └── theme/       # 테마 설정
│   │
│   ├── configs/                 # 설정 파일
│   ├── assets/                  # 정적 에셋 (폰트, 샘플 이미지)
│   └── version/                 # 버전 정보
│
├── tests/                       # 테스트 코드
│   ├── nodes/                   # 노드 테스트
│   ├── backend/                 # 백엔드 테스트
│   └── ...
│
├── docs/                        # 문서 (MkDocs)
├── scripts/                     # 유틸리티 스크립트
├── docker/                      # Docker 설정
├── .github/                     # GitHub 워크플로우
│
├── pyproject.toml              # Python 프로젝트 설정
├── requirements.txt            # Python 의존성
└── package.json                # Node.js 프로젝트 설정 (루트)
```

### 디렉토리별 역할 요약

| 디렉토리 | 역할 | 주요 기술 |
|---------|------|---------|
| `invokeai/app` | 웹 애플리케이션 레이어 | FastAPI, Pydantic |
| `invokeai/backend` | AI 모델 및 이미지 처리 | PyTorch, Diffusers |
| `invokeai/frontend/web` | 사용자 인터페이스 | React, TypeScript, Redux |
| `tests` | 자동화된 테스트 | pytest, vitest |
| `docs` | 사용자 및 개발자 문서 | MkDocs |

---

## 3. 기술 스택

### 백엔드 (Python 3.11-3.12)

#### 핵심 AI/ML 라이브러리

```python
# 딥러닝 프레임워크
PyTorch 2.7.0              # GPU 가속 딥러닝 엔진
torchvision                # 이미지 처리
xformers                   # 메모리 효율적인 어텐션 (옵션)

# AI 모델 라이브러리
diffusers 0.33.0          # Hugging Face의 Diffusion 모델 라이브러리
transformers 4.56.0+      # NLP 모델 (텍스트 인코더)
compel 2.1.1              # 프롬프트 가중치 및 블렌딩
accelerate                # PyTorch 가속화
safetensors               # 안전한 텐서 직렬화
onnxruntime               # ONNX 모델 실행
spandrel                  # Image-to-Image 모델 라이브러리
```

#### 웹 프레임워크

```python
FastAPI 0.118.3           # 모던 비동기 웹 프레임워크
uvicorn                   # ASGI 서버
python-socketio           # 실시간 양방향 통신
fastapi-events            # 이벤트 처리
```

#### 이미지 처리

```python
opencv-contrib-python     # 컴퓨터 비전
Pillow                    # 이미지 조작
mediapipe 0.10.14        # 얼굴 검출 및 포즈 추정
PyWavelets               # 웨이블릿 변환
```

#### 데이터 및 검증

```python
pydantic                  # 데이터 검증 및 직렬화
pydantic-settings         # 설정 관리
```

#### 스토리지

```python
SQLite                    # 내장 데이터베이스
huggingface-hub          # 모델 다운로드
```

### 프론트엔드

#### 코어 프레임워크

```json
{
  "react": "18.3.1",           // UI 라이브러리
  "typescript": "5.8.3",        // 타입 안전 JavaScript
  "vite": "7.0.5"              // 빌드 도구 및 개발 서버
}
```

#### 상태 관리

```json
{
  "@reduxjs/toolkit": "2.8.2",    // Redux 상태 관리
  "react-redux": "9.2.0",         // React-Redux 바인딩
  "redux-remember": "...",        // 상태 지속성
  "redux-undo": "...",            // 실행 취소/다시 실행
  "nanostores": "...",            // 경량 상태 관리
  "@nanostores/react": "..."      // React 통합
}
```

#### UI 컴포넌트

```json
{
  "@invoke-ai/ui-library": "...",  // 커스텀 UI 컴포넌트
  "@chakra-ui/react": "...",       // UI 컴포넌트 프레임워크
  "framer-motion": "11.10.0",      // 애니메이션
  "dockview": "4.7.1",             // 도킹 레이아웃
  "overlayscrollbars": "..."       // 커스텀 스크롤바
}
```

#### 캔버스 및 시각화

```json
{
  "konva": "9.3.22",              // 캔버스 라이브러리
  "@xyflow/react": "12.8.2",      // 노드 기반 워크플로우 에디터
  "@dagrejs/dagre": "...",        // 그래프 레이아웃
  "perfect-freehand": "..."        // 드로잉
}
```

#### 네트워킹

```json
{
  "socket.io-client": "4.8.1",    // WebSocket 클라이언트
  "openapi-typescript": "..."      // OpenAPI에서 TypeScript 타입 생성
}
```

---

## 4. 애플리케이션 시작 과정

### 실행 명령어

사용자가 InvokeAI를 실행할 때 사용하는 명령어:

```bash
invokeai-web
```

이 명령어는 `pyproject.toml`에 정의되어 있으며, 실제로는 다음 Python 함수를 호출합니다:

```python
# pyproject.toml
[project.scripts]
invokeai-web = "invokeai.app.run_app:run_app"
```

### 시작 과정 상세 (Step by Step)

파일: `invokeai/app/run_app.py`

```
1. 프로그램 시작
   └─> run_app() 함수 호출

2. CLI 인자 파싱
   └─> InvokeAIArgs.parse_args()
   └─> 사용자가 입력한 --host, --port 등의 옵션 처리

3. 설정 로딩
   ├─> invokeai.yaml 파일 읽기
   ├─> 환경 변수 읽기
   ├─> CLI 인자 우선순위 적용
   └─> InvokeAIAppConfig 객체 생성

4. CUDA/GPU 설정
   ├─> CUDA 메모리 할당자 설정
   └─> torch 라이브러리 임포트 전에 설정

5. 디바이스 감지
   ├─> GPU 사용 가능 여부 확인 (NVIDIA, AMD, Apple Silicon)
   ├─> torch.device 설정 (cuda/mps/cpu)
   └─> 메모리 제한 설정

6. 유틸리티 초기화
   ├─> Monkeypatch 적용
   ├─> MIME 타입 등록
   └─> 로깅 설정

7. FastAPI 앱 생성
   └─> get_app() 호출 (api_app.py)
       ├─> FastAPI 인스턴스 생성
       ├─> CORS 미들웨어 추가
       ├─> GZip 압축 미들웨어 추가
       ├─> Socket.IO 설정
       ├─> 라이프사이클 이벤트 핸들러 등록
       │   ├─> startup: 서비스 초기화
       │   └─> shutdown: 리소스 정리
       ├─> API 라우터 등록
       │   ├─> /api/v1/utilities
       │   ├─> /api/v1/models
       │   ├─> /api/v1/images
       │   ├─> /api/v1/boards
       │   ├─> /api/v1/queue
       │   └─> ... (15+ 라우터)
       └─> 정적 파일 서빙 (프론트엔드)

8. 커스텀 노드 로딩
   ├─> 설정된 디렉토리에서 커스텀 노드 탐색
   ├─> Python 모듈 동적 임포트
   └─> Invocation 레지스트리에 등록

9. Invocation 검증
   ├─> 모든 등록된 Invocation 검증
   ├─> 입력/출력 타입 체크
   └─> 순환 참조 확인

10. 서버 시작
    └─> uvicorn.run()
        ├─> 기본: http://127.0.0.1:9090
        ├─> 워커 스레드: 세션 프로세서
        └─> WebSocket 연결 대기
```

### 주요 파일들

| 파일 | 역할 |
|-----|------|
| `run_app.py:27` | 메인 엔트리 포인트 |
| `api_app.py:134` | FastAPI 앱 생성 및 설정 |
| `services/__init__.py` | 모든 서비스 초기화 |
| `invocations/baseinvocation.py` | Invocation 베이스 클래스 |

---

## 5. 백엔드 아키텍처

### 5.1 아키텍처 패턴

InvokeAI 백엔드는 **서비스 지향 아키텍처 (Service-Oriented Architecture)**를 사용합니다.

```
┌─────────────────────────────────────────────────────┐
│                   FastAPI Layer                      │
│  (API Endpoints - REST & Socket.IO)                 │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│               Service Layer                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │  Images  │ │  Models  │ │  Queue   │  ... (30+) │
│  └──────────┘ └──────────┘ └──────────┘           │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│            Invocation Engine                        │
│  (Graph Execution, Node Processing)                 │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│              Backend Layer                          │
│  (AI Models, Image Processing, PyTorch)            │
└─────────────────────────────────────────────────────┘
```

### 5.2 서비스 레이어 (Services)

위치: `invokeai/app/services/`

각 서비스는 특정 도메인의 비즈니스 로직을 담당합니다.

#### 핵심 서비스들

| 서비스 | 디렉토리 | 역할 |
|--------|---------|------|
| **Session Queue** | `session_queue/` | 워크플로우 실행 대기열 관리 |
| **Session Processor** | `session_processor/` | 대기열에서 세션을 가져와 실행 |
| **Invoker** | `invoker/` | Invocation 실행 오케스트레이션 |
| **Images** | `images/` | 이미지 저장 및 검색 (파일 + DB) |
| **Image Records** | `image_records/` | 이미지 메타데이터 (SQLite) |
| **Image Files** | `image_files/` | 이미지 파일 디스크 저장 |
| **Boards** | `boards/` | 갤러리 보드 관리 |
| **Model Manager** | `model_manager/` | 모델 메타데이터 및 설정 |
| **Model Install** | `model_install/` | 모델 설치 및 다운로드 |
| **Model Load** | `model_load/` | 모델 로딩 및 캐싱 |
| **Download** | `download/` | 다운로드 큐 관리 |
| **Events** | `events/` | 이벤트 발행/구독 (Pub/Sub) |
| **Invocation Cache** | `invocation_cache/` | Invocation 결과 캐싱 |
| **Workflow Records** | `workflow_records/` | 워크플로우 저장 |
| **Config** | `config/` | 애플리케이션 설정 |

#### 서비스 초기화

파일: `invokeai/app/services/__init__.py`

모든 서비스는 `ApiDependencies` 클래스를 통해 초기화됩니다:

```python
class ApiDependencies:
    """의존성 주입 컨테이너"""

    def __init__(self):
        # 설정 로드
        self.config = get_config()

        # 이벤트 버스
        self.events = EventServiceBase()

        # 데이터베이스 초기화
        self.db = SqliteDatabase(self.config)

        # 각 서비스 초기화
        self.image_records = ImageRecordStorageService(self.db)
        self.image_files = DiskImageFileStorage(self.config.outputs_path)
        self.images = ImageService()
        self.boards = BoardService()

        # 모델 관련 서비스
        self.model_manager = ModelManagerService()
        self.model_load = ModelLoadService()

        # 워크플로우 실행
        self.queue = SessionQueueService()
        self.processor = SessionProcessorService()

        # ... 나머지 서비스들
```

#### 의존성 주입 예시

FastAPI 엔드포인트에서 서비스 사용:

```python
@router.get("/images/{image_name}")
async def get_image(
    image_name: str,
    images: ImageService = Depends(ApiDependencies.images),
):
    """이미지 조회 API"""
    image_dto = images.get(image_name)
    return image_dto
```

### 5.3 Invocation 시스템

위치: `invokeai/app/invocations/`

#### Invocation이란?

**Invocation**은 워크플로우에서 실행되는 **하나의 작업 단위(노드)**입니다.

예시:
- `텍스트 프롬프트를 컨디셔닝으로 변환`
- `노이즈 제거 (Denoise)`
- `이미지 크기 조정`
- `ControlNet 적용`

#### Invocation 구조

파일: `invokeai/app/invocations/baseinvocation.py`

```python
class BaseInvocation:
    """모든 Invocation의 베이스 클래스"""

    # 입력 필드들 (Pydantic 필드)
    # 예: prompt: str = Field(description="텍스트 프롬프트")

    def invoke(self, context: InvocationContext) -> BaseInvocationOutput:
        """
        실제 작업을 수행하는 메서드

        Args:
            context: 서비스 접근을 위한 컨텍스트

        Returns:
            작업 결과 (Output 객체)
        """
        pass
```

#### Invocation 예시: 이미지 크기 조정

파일: `invokeai/app/invocations/image_resize.py` (예시)

```python
class ImageResizeInvocation(BaseInvocation):
    """이미지 크기를 조정하는 노드"""

    # 입력 정의
    image: ImageField = Field(description="입력 이미지")
    width: int = Field(description="출력 너비")
    height: int = Field(description="출력 높이")

    def invoke(self, context: InvocationContext) -> ImageOutput:
        # 1. 이미지 가져오기
        image_pil = context.images.get_pil(self.image.image_name)

        # 2. 크기 조정
        resized = image_pil.resize((self.width, self.height))

        # 3. 결과 저장
        image_dto = context.images.save(resized)

        # 4. 결과 반환
        return ImageOutput(
            image=ImageField(image_name=image_dto.image_name)
        )
```

#### 주요 Invocation들

| Invocation | 파일 | 역할 |
|-----------|------|------|
| **DenoiseLatentsInvocation** | `denoise_latents.py:98` | Stable Diffusion 노이즈 제거 |
| **FluxDenoiseInvocation** | `flux_denoise.py:45` | FLUX 모델 노이즈 제거 |
| **CompelInvocation** | `compel.py:67` | 텍스트 프롬프트를 컨디셔닝으로 변환 |
| **ControlNetInvocation** | `controlnet.py:34` | ControlNet 적용 |
| **IPAdapterInvocation** | `ip_adapter.py:78` | IP Adapter 적용 |
| **ImageResizeInvocation** | `image_resize.py:23` | 이미지 크기 조정 |
| **ImageBlurInvocation** | `image_blur.py:15` | 이미지 흐림 효과 |
| **CannyEdgeDetectionInvocation** | `canny.py:18` | Canny 엣지 검출 |

### 5.4 워크플로우 실행 엔진

#### 워크플로우란?

워크플로우는 **Invocation들을 연결한 방향성 비순환 그래프 (DAG)**입니다.

예시 워크플로우:
```
[텍스트 입력] → [Compel] → [Denoise] → [VAE Decode] → [이미지 저장]
                              ↑
                      [ControlNet]
```

#### 그래프 실행 과정

파일: `invokeai/app/services/session_processor/session_processor_default.py`

```
1. 세션 큐에서 다음 항목 가져오기
   └─> Queue.get_next()

2. 그래프 유효성 검증
   ├─> 순환 참조 확인
   ├─> 노드 연결 검증
   └─> 타입 호환성 확인

3. 위상 정렬 (Topological Sort)
   └─> NetworkX 라이브러리 사용
   └─> 실행 순서 결정

4. 노드별 실행
   FOR EACH node IN sorted_order:
       ├─> 입력 데이터 준비
       │   └─> 이전 노드의 출력 수집
       │
       ├─> Invocation 인스턴스 생성
       │
       ├─> invoke() 메서드 호출
       │   ├─> InvocationContext 제공
       │   └─> 서비스 접근 허용
       │
       ├─> 결과 캐싱 (선택적)
       │   └─> invocation_cache.save()
       │
       ├─> 이벤트 발행
       │   ├─> invocation_started
       │   ├─> invocation_complete
       │   └─> invocation_error (실패 시)
       │
       └─> 다음 노드로 출력 전달

5. 세션 완료
   └─> session_complete 이벤트 발행
```

#### InvocationContext

Invocation이 서비스에 접근하기 위한 컨텍스트:

```python
class InvocationContext:
    """Invocation 실행 컨텍스트"""

    # 서비스 접근자
    images: ImageService           # 이미지 저장/로드
    models: ModelManagerService    # 모델 정보
    model_loader: ModelLoadService # 모델 로딩
    events: EventService          # 이벤트 발행
    boards: BoardService          # 보드 관리
    # ... 기타 서비스들

    # 유틸리티 메서드
    def progress_image(self, image: Image.Image):
        """중간 결과 이미지 표시"""
        pass
```

### 5.5 모델 관리

#### 모델 로딩 과정

파일: `invokeai/backend/model_manager/load/`

```
1. 모델 요청
   └─> Invocation에서 context.models.load("model_name")

2. 캐시 확인
   ├─> 이미 로드되어 있는지 확인
   └─> 있으면 즉시 반환

3. 캐시 공간 확보
   ├─> 메모리 부족 시 오래된 모델 언로드
   └─> VRAM/RAM 제한 고려

4. 모델 로드
   ├─> 디스크에서 읽기 (safetensors/ckpt)
   ├─> PyTorch 모델로 변환
   └─> GPU로 이동 (선택적)

5. 패치 적용
   ├─> LoRA 적용
   ├─> Textual Inversion 적용
   └─> 기타 커스터마이제이션

6. 모델 반환
   └─> Invocation에서 사용
```

#### 지원 모델 타입

| 모델 타입 | 디렉토리 | 설명 |
|----------|---------|------|
| **Stable Diffusion** | `backend/stable_diffusion/` | SD 1.5, SD 2.0, SDXL |
| **FLUX** | `backend/flux/` | FLUX.1 모델 |
| **SD3** | (통합됨) | Stable Diffusion 3 |
| **ControlNet** | (통합됨) | 조건부 생성 |
| **LoRA** | `backend/patches/` | 스타일 어댑터 |
| **Textual Inversion** | (통합됨) | 커스텀 토큰 |
| **IP Adapter** | `backend/ip_adapter/` | 이미지 기반 컨디셔닝 |
| **VAE** | (통합됨) | 오토인코더 |

### 5.6 데이터베이스

#### SQLite 스키마

InvokeAI는 SQLite를 사용하여 메타데이터를 저장합니다.

주요 테이블:

```sql
-- 이미지 메타데이터
CREATE TABLE images (
    image_name TEXT PRIMARY KEY,
    image_origin TEXT NOT NULL,
    image_category TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    -- ... 기타 필드
);

-- 보드 (갤러리 폴더)
CREATE TABLE boards (
    board_id TEXT PRIMARY KEY,
    board_name TEXT NOT NULL,
    created_at DATETIME NOT NULL,
    -- ... 기타 필드
);

-- 이미지-보드 연결
CREATE TABLE board_images (
    board_id TEXT NOT NULL,
    image_name TEXT NOT NULL,
    FOREIGN KEY (board_id) REFERENCES boards(board_id),
    FOREIGN KEY (image_name) REFERENCES images(image_name)
);

-- 모델 설정
CREATE TABLE model_config (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base TEXT NOT NULL,  -- SD1.5, SDXL, 등
    type TEXT NOT NULL,  -- main, lora, controlnet, 등
    path TEXT NOT NULL,
    -- ... 기타 필드
);

-- 워크플로우
CREATE TABLE workflows (
    workflow_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    graph JSON NOT NULL,  -- 워크플로우 JSON
    created_at DATETIME NOT NULL
);
```

#### 파일 저장 구조

```
outputs/
├── images/
│   ├── 2025-11/
│   │   ├── image-001.png
│   │   ├── image-002.png
│   │   └── ...
│   └── thumbnails/
│       ├── image-001.webp
│       └── image-002.webp
│
├── tensors/
│   └── (컨디셔닝 텐서 등)
│
└── workflows/
    └── (저장된 워크플로우)
```

---

## 6. 프론트엔드 아키텍처

### 6.1 프로젝트 구조

위치: `invokeai/frontend/web/src/`

```
src/
├── app/                        # 앱 초기화 및 설정
│   ├── store/                  # Redux store 설정
│   │   ├── store.ts            # Store 생성
│   │   ├── middleware/         # 미들웨어
│   │   └── enhancers/          # Redux enhancer
│   ├── components/             # 최상위 컴포넌트
│   └── App.tsx                 # 루트 컴포넌트
│
├── common/                     # 공통 유틸리티 및 컴포넌트
│   ├── components/             # 재사용 가능한 컴포넌트
│   ├── hooks/                  # 커스텀 React hooks
│   └── util/                   # 유틸리티 함수
│
├── features/                   # 기능별 모듈 (Feature-based 구조)
│   ├── controlLayers/          # 캔버스 및 컨트롤 레이어
│   ├── nodes/                  # 노드 에디터 (워크플로우)
│   ├── gallery/                # 이미지 갤러리
│   ├── parameters/             # 생성 파라미터
│   ├── queue/                  # 큐 관리
│   ├── modelManagerV2/         # 모델 관리
│   ├── workflowLibrary/        # 워크플로우 라이브러리
│   ├── stylePresets/           # 스타일 프리셋
│   ├── prompt/                 # 프롬프트 편집
│   ├── canvas/                 # 레거시 캔버스 (Unified Canvas)
│   └── ... (22개 feature)
│
├── services/                   # API 및 서비스
│   └── api/                    # OpenAPI 생성 API 클라이언트
│       ├── endpoints/          # API 엔드포인트
│       ├── schema.ts           # TypeScript 타입
│       └── index.ts            # API 클라이언트
│
└── theme/                      # Chakra UI 테마
    └── ...
```

### 6.2 상태 관리 (Redux)

#### Redux Store 구조

파일: `invokeai/frontend/web/src/app/store/store.ts`

```typescript
// Redux Store
{
  // 각 feature의 상태 슬라이스
  gallery: GalleryState,           // 갤러리 상태
  nodes: NodesState,               // 노드 에디터 상태
  canvas: CanvasState,             // 캔버스 상태
  controlLayers: ControlLayersState, // 컨트롤 레이어 상태
  generation: GenerationState,     // 생성 파라미터 상태
  queue: QueueState,               // 큐 상태
  models: ModelsState,             // 모델 상태
  workflows: WorkflowsState,       // 워크플로우 상태
  // ... 기타 슬라이스

  // RTK Query API 슬라이스
  api: ApiState,                   // API 캐시 및 상태
}
```

#### Feature Slice 예시

파일: `invokeai/frontend/web/src/features/gallery/store/gallerySlice.ts`

```typescript
const gallerySlice = createSlice({
  name: 'gallery',
  initialState: {
    selectedImageName: null,
    galleryView: 'images',
    selectedBoardId: null,
    // ... 기타 상태
  },
  reducers: {
    // 액션 정의
    imageSelected(state, action) {
      state.selectedImageName = action.payload;
    },
    boardSelected(state, action) {
      state.selectedBoardId = action.payload;
    },
    // ... 기타 리듀서
  },
});

export const { imageSelected, boardSelected } = gallerySlice.actions;
```

#### RTK Query API

파일: `invokeai/frontend/web/src/services/api/endpoints/*.ts`

```typescript
// API 엔드포인트 정의
const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: '/api/v1' }),
  endpoints: (builder) => ({
    // 이미지 목록 조회
    listImages: builder.query<ImageDTO[], void>({
      query: () => '/images',
    }),

    // 이미지 업로드
    uploadImage: builder.mutation<ImageDTO, FormData>({
      query: (formData) => ({
        url: '/images',
        method: 'POST',
        body: formData,
      }),
    }),

    // ... 기타 엔드포인트
  }),
});

export const { useListImagesQuery, useUploadImageMutation } = api;
```

### 6.3 주요 Feature 모듈

#### 1. Control Layers (캔버스)

위치: `invokeai/frontend/web/src/features/controlLayers/`

**역할**: 이미지 생성을 위한 시각적 캔버스

**주요 기능**:
- 레이어 관리 (이미지 레이어, 컨트롤 레이어, 마스크 레이어)
- 브러시 도구
- 선택 및 변형
- 레이어 블렌딩 및 불투명도

**기술 스택**:
- **Konva**: 고성능 캔버스 렌더링
- **Redux**: 레이어 상태 관리
- **redux-undo**: 실행 취소/다시 실행

**주요 파일**:
```
controlLayers/
├── components/
│   ├── ControlLayersCanvas.tsx    # 메인 캔버스 컴포넌트
│   ├── Tool/*.tsx                 # 도구 컴포넌트들
│   └── Layers/*.tsx               # 레이어 UI
├── store/
│   ├── controlLayersSlice.ts      # Redux 슬라이스
│   └── types.ts                   # 타입 정의
└── konva/
    ├── renderers.ts               # Konva 렌더링 로직
    └── util.ts                    # 유틸리티
```

#### 2. Nodes (노드 에디터)

위치: `invokeai/frontend/web/src/features/nodes/`

**역할**: 비주얼 프로그래밍 방식의 워크플로우 에디터

**주요 기능**:
- 노드 추가/삭제/연결
- 워크플로우 저장/로드
- 실시간 실행 상태 표시
- 노드 검색 및 필터링

**기술 스택**:
- **@xyflow/react** (React Flow): 노드 그래프 라이브러리
- **dagre**: 자동 레이아웃 알고리즘

**주요 파일**:
```
nodes/
├── components/
│   ├── Flow/
│   │   ├── Flow.tsx               # React Flow 컴포넌트
│   │   └── nodes/                 # 커스텀 노드 컴포넌트들
│   ├── AddNodeMenu.tsx            # 노드 추가 메뉴
│   └── ...
├── store/
│   ├── nodesSlice.ts              # 노드 상태 관리
│   ├── workflowSlice.ts           # 워크플로우 상태
│   └── util/                      # 그래프 유틸리티
└── hooks/
    └── useNodeData.ts             # 노드 데이터 훅
```

#### 3. Gallery (갤러리)

위치: `invokeai/frontend/web/src/features/gallery/`

**역할**: 생성된 이미지 관리 및 표시

**주요 기능**:
- 이미지 그리드 보기
- 보드(폴더) 관리
- 이미지 검색 및 필터링
- 무한 스크롤
- 이미지 메타데이터 표시

**주요 파일**:
```
gallery/
├── components/
│   ├── ImageGrid/
│   │   ├── GalleryImageGrid.tsx   # 이미지 그리드
│   │   └── ImageItem.tsx          # 개별 이미지
│   ├── Boards/
│   │   └── BoardsList.tsx         # 보드 목록
│   └── ImageViewer/
│       └── ImageViewer.tsx        # 이미지 상세 뷰
└── store/
    └── gallerySlice.ts            # 갤러리 상태
```

#### 4. Parameters (파라미터)

위치: `invokeai/frontend/web/src/features/parameters/`

**역할**: 이미지 생성 파라미터 설정

**주요 파라미터**:
- 프롬프트 (긍정/부정)
- 모델 선택
- 이미지 크기 (Width/Height)
- Steps (샘플링 스텝 수)
- CFG Scale (Classifier Free Guidance)
- Scheduler (샘플러)
- Seed (랜덤 시드)

#### 5. Queue (큐)

위치: `invokeai/frontend/web/src/features/queue/`

**역할**: 생성 작업 큐 관리 및 모니터링

**주요 기능**:
- 큐 항목 목록 표시
- 현재 진행 중인 작업 표시
- 작업 취소/일시정지/재개
- 큐 상태 실시간 업데이트 (Socket.IO)

### 6.4 Socket.IO 실시간 통신

#### 연결 설정

파일: `invokeai/frontend/web/src/services/events/socketio.ts`

```typescript
// Socket.IO 클라이언트 초기화
const socket = io(`${window.location.protocol}//${window.location.host}`, {
  path: '/ws/socket.io',
});

// 이벤트 리스너 등록
socket.on('invocation_complete', (data) => {
  // Invocation 완료 이벤트 처리
  dispatch(invocationComplete(data));
});

socket.on('generator_progress', (data) => {
  // 생성 진행률 업데이트
  dispatch(generatorProgress(data));
});
```

#### 백엔드 이벤트 종류

| 이벤트 | 설명 | 데이터 |
|-------|------|--------|
| `invocation_started` | Invocation 시작 | node_id, timestamp |
| `invocation_complete` | Invocation 완료 | result, output |
| `invocation_error` | Invocation 에러 | error_message |
| `generator_progress` | 생성 진행률 | step, total_steps, image |
| `session_started` | 세션 시작 | session_id |
| `session_complete` | 세션 완료 | session_id |
| `model_load_started` | 모델 로딩 시작 | model_name |
| `model_load_complete` | 모델 로딩 완료 | model_name |
| `queue_item_status_changed` | 큐 아이템 상태 변경 | item_id, status |

---

## 7. 핵심 개념과 용어

### AI/ML 용어

| 용어 | 설명 |
|-----|------|
| **Diffusion Model** | 노이즈에서 이미지를 생성하는 AI 모델 |
| **Latent Space** | 압축된 이미지 표현 공간 (VAE 인코딩) |
| **Denoise** | 노이즈를 제거하여 이미지를 생성하는 과정 |
| **VAE** | Variational Autoencoder - 이미지를 압축/복원 |
| **UNet** | Diffusion 모델의 핵심 네트워크 구조 |
| **Conditioning** | 생성을 가이드하는 조건 (프롬프트, 이미지 등) |
| **CFG Scale** | 프롬프트 가이던스 강도 |
| **Steps** | 노이즈 제거 반복 횟수 |
| **Scheduler** | 노이즈 제거 스케줄 알고리즘 |
| **LoRA** | Low-Rank Adaptation - 모델 스타일 조정 |
| **ControlNet** | 특정 조건(엣지, 포즈)으로 생성 제어 |
| **IP Adapter** | 이미지를 프롬프트로 사용 |

### InvokeAI 특정 용어

| 용어 | 설명 |
|-----|------|
| **Invocation** | 워크플로우의 하나의 작업 노드 |
| **Session** | 워크플로우 실행 인스턴스 |
| **Board** | 갤러리의 폴더/컬렉션 |
| **Control Layer** | 캔버스의 컨트롤 레이어 |
| **Workflow** | Invocation들의 연결 그래프 |
| **Model Config** | 모델 설정 정보 |

---

## 8. 주요 기능별 상세 설명

### 8.1 텍스트-to-이미지 생성 과정

사용자가 "고양이 그림"이라는 프롬프트로 이미지를 생성하는 전체 과정:

```
1. 프론트엔드: 사용자 입력
   ├─> 프롬프트: "고양이 그림"
   ├─> 모델: SDXL
   ├─> 크기: 1024x1024
   ├─> Steps: 30
   └─> CFG: 7.5

2. 프론트엔드: 워크플로우 생성
   └─> 자동으로 기본 워크플로우 구성
       ├─> [Noise] → 랜덤 노이즈 생성
       ├─> [Prompt] → 프롬프트 입력
       ├─> [Compel] → 프롬프트를 컨디셔닝으로 변환
       ├─> [Denoise] → 노이즈 제거
       └─> [VAE Decode] → 잠재 이미지를 실제 이미지로 변환

3. 프론트엔드: API 요청
   └─> POST /api/v1/queue/enqueue
       {
         "graph": { ... },  // 워크플로우 그래프
         "batch": { ... }
       }

4. 백엔드: Session Queue에 추가
   └─> SQLite에 세션 저장
   └─> 큐에 추가

5. 백엔드: Session Processor가 실행

   Step 1: NoiseInvocation
   ├─> 1024x1024 크기의 랜덤 노이즈 텐서 생성
   └─> 출력: LatentsOutput

   Step 2: PromptInvocation
   ├─> 프롬프트: "고양이 그림"
   └─> 출력: StringOutput

   Step 3: CompelInvocation
   ├─> CLIP 텍스트 인코더 로드
   ├─> 프롬프트를 토큰으로 변환
   ├─> 토큰을 임베딩으로 변환
   └─> 출력: ConditioningOutput

   Step 4: DenoiseLatentsInvocation
   ├─> UNet 모델 로드
   ├─> Scheduler 초기화 (예: DPM++ 2M Karras)
   ├─> 30번 반복:
   │   FOR step IN 0..29:
   │       ├─> 현재 노이즈 레벨 예측
   │       ├─> 컨디셔닝 적용
   │       ├─> 노이즈 제거
   │       ├─> 중간 결과 이미지 생성 (미리보기)
   │       └─> generator_progress 이벤트 발행
   └─> 출력: LatentsOutput (깨끗한 잠재 이미지)

   Step 5: VAEDecodeInvocation
   ├─> VAE 디코더 로드
   ├─> 잠재 이미지를 실제 이미지로 변환
   ├─> 1024x1024 RGB 이미지 생성
   ├─> 이미지 저장 (outputs/images/)
   ├─> 메타데이터 저장 (SQLite)
   └─> 출력: ImageOutput

6. 백엔드: 이벤트 발행
   └─> Socket.IO를 통해 session_complete 이벤트

7. 프론트엔드: 결과 수신
   ├─> Socket.IO 이벤트 수신
   ├─> Redux 상태 업데이트
   ├─> 갤러리에 이미지 추가
   └─> 사용자에게 결과 표시
```

### 8.2 ControlNet 사용 과정

Canny Edge를 사용하여 이미지 구조를 유지하면서 스타일 변경:

```
1. 사용자가 원본 이미지 업로드
   └─> cat-photo.jpg

2. 프론트엔드: ControlNet 설정
   ├─> 프로세서: Canny Edge
   ├─> 컨트롤웨이트: 0.8
   └─> 모델: control_sd15_canny

3. 워크플로우 구성
   [원본 이미지]
       ↓
   [Canny Edge Detection] ← Invocation: CannyEdgeDetectionInvocation
       ↓
   [ControlNet] ← Invocation: ControlNetInvocation
       ↓
   [Denoise] ← 프롬프트: "수채화 스타일 고양이"
       ↓
   [VAE Decode]
       ↓
   [결과 이미지]

4. 실행
   Step 1: CannyEdgeDetectionInvocation
   ├─> OpenCV Canny 알고리즘 적용
   ├─> 엣지 이미지 생성 (흑백)
   └─> 출력: ImageOutput

   Step 2: ControlNetInvocation
   ├─> ControlNet 모델 로드
   ├─> 엣지 이미지를 컨디셔닝으로 변환
   └─> 출력: ControlOutput

   Step 3: DenoiseLatentsInvocation
   ├─> UNet에 ControlNet 출력 주입
   ├─> 텍스트 컨디셔닝 + Control 컨디셔닝
   ├─> 엣지 구조를 유지하면서 노이즈 제거
   └─> 출력: LatentsOutput

   Step 4: VAEDecodeInvocation
   └─> 최종 이미지 생성 (엣지 구조 유지 + 수채화 스타일)
```

### 8.3 커스텀 노드 개발

개발자가 새로운 Invocation을 만드는 방법:

#### 1. 커스텀 노드 디렉토리 생성

```bash
# 설정에서 지정한 디렉토리
mkdir -p ~/invokeai/nodes/my_custom_nodes
```

#### 2. Invocation 파일 작성

파일: `~/invokeai/nodes/my_custom_nodes/my_node.py`

```python
from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    BaseInvocationOutput,
    invocation,
    invocation_output,
)
from invokeai.app.invocations.fields import InputField, OutputField
from invokeai.app.services.shared.invocation_context import InvocationContext


# 출력 정의
@invocation_output("my_output")
class MyOutput(BaseInvocationOutput):
    """커스텀 출력"""
    result: str = OutputField(description="결과 문자열")


# Invocation 정의
@invocation(
    "my_invocation",
    title="내 커스텀 노드",
    tags=["custom", "text"],
    category="custom",
    version="1.0.0",
)
class MyInvocation(BaseInvocation):
    """텍스트를 대문자로 변환하는 커스텀 노드"""

    # 입력 필드
    input_text: str = InputField(
        description="입력 텍스트",
        default="hello"
    )

    def invoke(self, context: InvocationContext) -> MyOutput:
        """실행 로직"""
        # 간단한 처리
        result = self.input_text.upper()

        # 결과 반환
        return MyOutput(result=result)
```

#### 3. 노드 로딩

InvokeAI 시작 시 자동으로 로드됩니다:
```
[2025-11-17 10:00:00] INFO: Loading custom nodes from ~/invokeai/nodes/my_custom_nodes
[2025-11-17 10:00:01] INFO: Registered invocation: my_invocation
```

#### 4. 프론트엔드에서 사용

노드 에디터에서 "내 커스텀 노드"가 자동으로 나타나며, 다른 노드처럼 사용할 수 있습니다.

---

## 9. 데이터 흐름

### 9.1 이미지 생성 요청 흐름

```
[사용자 입력]
    │
    ├─> 프롬프트 입력
    ├─> 파라미터 설정
    └─> "생성" 버튼 클릭
    │
    ▼
[React 컴포넌트]
    │
    └─> dispatch(enqueueBatch(...))
    │
    ▼
[Redux Action]
    │
    └─> RTK Query Mutation
    │
    ▼
[HTTP POST /api/v1/queue/enqueue]
    │
    ▼
[FastAPI Router] (api/routers/session_queue.py)
    │
    └─> SessionQueueService.enqueue()
    │
    ▼
[SessionQueueService]
    │
    ├─> 그래프 검증
    ├─> SQLite에 저장
    └─> 큐에 추가
    │
    ▼
[SessionProcessor] (백그라운드 스레드)
    │
    ├─> 큐에서 항목 가져오기
    ├─> 위상 정렬
    └─> 노드별 실행
    │   │
    │   ├─> Invocation.invoke()
    │   ├─> 결과 캐싱
    │   └─> 이벤트 발행
    │
    ▼
[Socket.IO Event]
    │
    └─> invocation_complete
    │
    ▼
[프론트엔드 Socket.IO Client]
    │
    └─> Redux 리스너 미들웨어
    │
    ▼
[Redux State 업데이트]
    │
    ├─> 갤러리 상태 업데이트
    └─> 큐 상태 업데이트
    │
    ▼
[React 리렌더링]
    │
    └─> 갤러리에 새 이미지 표시
```

### 9.2 모델 로딩 흐름

```
[Invocation 실행]
    │
    └─> context.models.load("SDXL_model")
    │
    ▼
[ModelLoadService]
    │
    ├─> 캐시 확인
    │   └─> 있으면 즉시 반환 ✓
    │
    ├─> 캐시 공간 확보
    │   ├─> 메모리 사용량 체크
    │   └─> 필요 시 오래된 모델 언로드
    │
    ├─> model_load_started 이벤트 발행
    │
    ├─> 디스크에서 모델 로드
    │   ├─> safetensors 파일 읽기
    │   └─> PyTorch state_dict 생성
    │
    ├─> GPU로 이동 (선택적)
    │   └─> model.to("cuda")
    │
    ├─> 패치 적용
    │   ├─> LoRA 패치
    │   └─> Textual Inversion
    │
    ├─> 캐시에 저장
    │
    ├─> model_load_complete 이벤트 발행
    │
    └─> 모델 반환
```

### 9.3 캔버스 → 이미지 생성 흐름

```
[사용자가 캔버스에 그림]
    │
    ├─> 브러시 도구 사용
    ├─> 마스크 영역 지정
    └─> "생성" 클릭
    │
    ▼
[Konva Canvas]
    │
    └─> toDataURL() → Base64 이미지
    │
    ▼
[Redux Action]
    │
    └─> 캔버스 이미지를 Blob으로 변환
    │
    ▼
[이미지 업로드 API]
    │
    └─> POST /api/v1/images/upload
    │
    ▼
[ImageService]
    │
    ├─> 디스크에 저장
    ├─> 썸네일 생성
    └─> DB에 메타데이터 저장
    │
    ▼
[워크플로우 생성]
    │
    ├─> LoadImage Invocation (업로드된 이미지)
    ├─> MaskFromAlpha Invocation (마스크 추출)
    ├─> InpaintingInvocation (마스크 영역만 생성)
    └─> 큐에 추가
    │
    ▼
[Session 실행]
    │
    └─> (일반 생성 과정과 동일)
```

---

## 10. 개발 시작하기

### 10.1 개발 환경 설정

#### 백엔드 개발

```bash
# 1. 가상 환경 생성
python -m venv venv
source venv/bin/activate  # Linux/Mac
# 또는
venv\Scripts\activate  # Windows

# 2. 의존성 설치
pip install -e ".[dev]"  # editable 모드로 설치

# 3. 개발 서버 실행
invokeai-web --dev --log-level debug

# 4. 테스트 실행
pytest tests/
```

#### 프론트엔드 개발

```bash
# 1. 프론트엔드 디렉토리로 이동
cd invokeai/frontend/web

# 2. 의존성 설치 (pnpm 사용)
pnpm install

# 3. 개발 서버 실행
pnpm dev
# Vite 서버가 http://localhost:5173 에서 시작됨

# 4. 타입 체크
pnpm type-check

# 5. 린트
pnpm lint

# 6. 테스트
pnpm test
```

### 10.2 주요 개발 작업

#### 새로운 Invocation 추가

1. **파일 생성**: `invokeai/app/invocations/my_new_node.py`

2. **Invocation 작성**:
```python
from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    invocation,
)
from invokeai.app.invocations.fields import InputField


@invocation("my_new_node", title="My New Node", ...)
class MyNewNodeInvocation(BaseInvocation):
    input_field: str = InputField(description="...")

    def invoke(self, context):
        # 로직 구현
        pass
```

3. **테스트 작성**: `tests/nodes/test_my_new_node.py`

4. **문서 추가**: `docs/nodes/my_new_node.md`

#### 새로운 API 엔드포인트 추가

1. **라우터 파일 수정**: `invokeai/app/api/routers/my_router.py`

```python
@router.get("/my-endpoint")
async def my_endpoint(
    param: str,
    services: ApiDependencies = Depends(ApiDependencies),
):
    result = services.my_service.do_something(param)
    return result
```

2. **OpenAPI 스키마 재생성**:
```bash
# 백엔드 실행 시 자동으로 /openapi.json 생성됨
```

3. **프론트엔드 타입 생성**:
```bash
cd invokeai/frontend/web
pnpm typegen
# services/api/schema.ts 파일 자동 생성
```

#### 새로운 프론트엔드 Feature 추가

1. **Feature 디렉토리 생성**:
```
src/features/myFeature/
├── components/
│   └── MyFeaturePanel.tsx
├── store/
│   └── myFeatureSlice.ts
└── hooks/
    └── useMyFeature.ts
```

2. **Redux Slice 작성**:
```typescript
const myFeatureSlice = createSlice({
  name: 'myFeature',
  initialState: { ... },
  reducers: { ... },
});
```

3. **Store에 등록**:
```typescript
// app/store/store.ts
import myFeatureSlice from '@/features/myFeature/store/myFeatureSlice';

export const store = configureStore({
  reducer: {
    myFeature: myFeatureSlice.reducer,
    // ...
  },
});
```

### 10.3 디버깅 팁

#### 백엔드 디버깅

```python
# 로깅 사용
import logging
logger = logging.getLogger(__name__)

logger.debug("디버그 메시지")
logger.info("정보 메시지")
logger.warning("경고 메시지")
logger.error("에러 메시지")

# VS Code에서 디버거 사용
# .vscode/launch.json 설정
{
  "configurations": [
    {
      "name": "InvokeAI",
      "type": "python",
      "request": "launch",
      "module": "invokeai.app.run_app",
      "args": ["--dev"]
    }
  ]
}
```

#### 프론트엔드 디버깅

```typescript
// Redux DevTools 사용 (브라우저 확장 프로그램)
// 상태 변화를 실시간으로 확인 가능

// 콘솔 로깅
console.log('상태:', state);

// React DevTools (브라우저 확장 프로그램)
// 컴포넌트 트리 및 props 확인
```

### 10.4 코드 품질

#### 코드 포매팅

```bash
# Python (ruff)
ruff format .
ruff check .

# TypeScript (prettier)
pnpm format
```

#### 타입 체크

```bash
# Python (mypy)
mypy invokeai/

# TypeScript
pnpm type-check
```

#### 테스트

```bash
# Python
pytest tests/nodes/  # 특정 디렉토리만
pytest -k "test_name"  # 특정 테스트만
pytest --cov  # 커버리지

# TypeScript
pnpm test
pnpm test:watch  # watch 모드
```

---

## 11. 추가 리소스

### 공식 문서

- **사용자 가이드**: `docs/` 디렉토리
- **API 문서**: http://127.0.0.1:9090/docs (서버 실행 후)
- **개발자 가이드**: `docs/contributing/` 디렉토리

### 주요 외부 라이브러리 문서

- **PyTorch**: https://pytorch.org/docs/
- **Diffusers**: https://huggingface.co/docs/diffusers/
- **FastAPI**: https://fastapi.tiangolo.com/
- **React**: https://react.dev/
- **Redux Toolkit**: https://redux-toolkit.js.org/
- **React Flow**: https://reactflow.dev/

### 커뮤니티

- **GitHub**: https://github.com/invoke-ai/InvokeAI
- **Discord**: https://discord.gg/ZmtBAhwWhy
- **Issues**: https://github.com/invoke-ai/InvokeAI/issues

---

## 요약

InvokeAI는 다음과 같은 특징을 가진 전문적인 AI 이미지 생성 애플리케이션입니다:

### 아키텍처 특징
- **백엔드**: FastAPI 기반 서비스 지향 아키텍처, PyTorch 딥러닝
- **프론트엔드**: React + Redux Toolkit, TypeScript로 타입 안전성 확보
- **통신**: REST API + Socket.IO 실시간 양방향 통신
- **데이터**: SQLite 메타데이터 + 파일 시스템 스토리지

### 핵심 시스템
- **Invocation 시스템**: 노드 기반 워크플로우, 확장 가능한 플러그인 아키텍처
- **모델 관리**: 지능적 캐싱, 다양한 모델 포맷 지원
- **실시간 업데이트**: Socket.IO를 통한 즉각적인 피드백
- **캔버스 시스템**: Konva 기반 고성능 이미지 편집

### 개발 특징
- **모던 기술 스택**: 최신 버전의 검증된 라이브러리들
- **타입 안전성**: Python Pydantic + TypeScript
- **테스트**: pytest + vitest 자동화 테스트
- **확장성**: 커스텀 노드 및 플러그인 지원

이 문서가 InvokeAI 코드베이스를 이해하고 기여하는 데 도움이 되기를 바랍니다!
