# InvokeAI v6.11.1.post1 - 코드베이스 종합 분석 보고서

> **문서 버전:** v1.2
> **최초 작성:** 2026-02-07 14:13 UTC
> **최종 수정:** 2026-02-08 12:00 UTC (Aurora PostgreSQL 전환 반영)
> **대상 코드:** InvokeAI v6.11.1.post1 (Pinksea-AI fork)

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|------|------|
| **프로젝트명** | InvokeAI |
| **버전** | 6.11.1.post1 |
| **라이선스** | Apache License 2.0 |
| **Python 버전** | >= 3.11, < 3.13 |
| **Node.js** | .nvmrc 기반 |
| **패키지 관리** | Python: uv/pip, Frontend: pnpm 10 |
| **프레임워크** | Backend: FastAPI + Uvicorn, Frontend: React 18 + Vite 7 |
| **데이터베이스** | SQLite (자체 마이그레이션 시스템) |
| **AI 프레임워크** | PyTorch 2.7, Diffusers 0.36.0, Transformers >= 4.56.0 |

## 2. 코드베이스 규모

### 2.1 전체 파일 통계

| 지표 | 수치 |
|------|------|
| **총 파일 수** | 2,959 개 |
| **총 소스 코드 라인** | ~183,906 라인 (설정/데이터 포함) |
| **Python (.py)** | 737 파일 / ~113,353 라인 |
| **TypeScript (.ts, .tsx)** | 1,355 파일 / ~164,482 라인 |
| **JavaScript (.js)** | 1 파일 / 74 라인 |
| **CSS** | 2 파일 / 124 라인 |
| **JSON** | 296 파일 / ~96,265 라인 (번역 파일 포함) |
| **YAML** | 24+21 파일 / ~12,842 라인 |
| **Markdown (.md)** | 76 파일 |
| **이미지 (PNG/SVG/WebP/JPG)** | 255 파일 |
| **모델 파일 (safetensors/bin/gguf 등)** | 119 파일 (테스트용) |

### 2.2 파일 타입별 분포

```
TSX (React 컴포넌트)    : 850 파일  (28.7%)
Python                  : 737 파일  (24.9%)
TypeScript              : 505 파일  (17.1%)
JSON (설정/번역)        : 296 파일  (10.0%)
PNG (이미지 에셋)       : 210 파일  (7.1%)
Safetensors (모델)      : 106 파일  (3.6%)
Markdown (문서)         : 76 파일   (2.6%)
기타                    : 179 파일  (6.0%)
```

## 3. 최상위 디렉토리 구조

```
InvokeAI/
├── .dev_scripts/           # 개발 스크립트 (프롬프트 도구)
├── .github/                # GitHub Actions CI/CD, CODEOWNERS
├── coverage/               # 테스트 커버리지 리포트
├── docker/                 # Docker 설정
├── docs/                   # MkDocs 문서
├── invokeai/               # ★ 메인 소스 코드
│   ├── app/                # ★ FastAPI 앱, API, 서비스 계층
│   ├── assets/             # 폰트, 앱 아이콘 에셋
│   ├── backend/            # ★ AI/ML 백엔드 (모델, 추론, 이미지 처리)
│   ├── configs/            # 모델 설정 YAML (SD, SDXL)
│   ├── frontend/           # ★ React 프론트엔드 + CLI
│   ├── invocation_api/     # 커스텀 노드 개발자 API
│   └── version/            # 버전 정보
├── scripts/                # 유틸리티 스크립트
├── tests/                  # 테스트 코드
├── pyproject.toml          # Python 프로젝트 설정
├── uv.lock                 # 의존성 락 파일
├── Makefile                # 빌드 자동화
├── flake.nix               # Nix 설정
└── mkdocs.yml              # 문서 사이트 설정
```

## 4. 백엔드 상세 구조 (`invokeai/app/`)

### 4.1 API 계층 (`invokeai/app/api/`)

```
invokeai/app/api/
├── dependencies.py         # ApiDependencies - 전체 서비스 초기화 및 DI 컨테이너
├── api_app.py              # ★ FastAPI 앱 생성, 미들웨어, 라우터 등록
├── no_cache_staticfiles.py # 정적 파일 서빙 (캐시 방지)
├── sockets.py              # Socket.IO WebSocket 설정
├── extract_metadata_from_image.py # 이미지 메타데이터 추출
├── routers/                # ★ API 라우터 (엔드포인트)
│   ├── app_info.py         # GET /api/v1/app/version, /config, /invocation_cache 등
│   ├── board_images.py     # 보드-이미지 관계 관리
│   ├── boards.py           # 이미지 보드(앨범) CRUD
│   ├── client_state.py     # 클라이언트 상태 저장/복원
│   ├── download_queue.py   # 모델 다운로드 큐 관리
│   ├── images.py           # ★ 이미지 업로드/조회/삭제/스타/다운로드
│   ├── model_manager.py    # ★ 모델 관리 (목록/설치/삭제/스캔)
│   ├── model_relationships.py # 모델 간 관계 관리
│   ├── session_queue.py    # ★ 세션 큐 (작업 대기열) 관리
│   ├── style_presets.py    # 스타일 프리셋 CRUD
│   ├── utilities.py        # 유틸리티 API
│   └── workflows.py        # 워크플로우 CRUD
└── util/
    ├── custom_openapi.py   # OpenAPI 스키마 커스터마이징
    └── startup_utils.py    # 시작 시 유틸리티 (포트 탐색, 모니키패치)
```

### 4.2 서비스 계층 (`invokeai/app/services/`)

InvokeAI는 **서비스 지향 아키텍처(SOA)**를 사용합니다. 각 서비스는 추상 기반 클래스 + 구현 클래스 패턴입니다.

```
invokeai/app/services/
├── invocation_services.py  # ★ InvocationServices - 모든 서비스를 모은 데이터 클래스
├── invoker.py              # ★ Invoker - 메인 오케스트레이터
│
├── board_image_records/    # 보드-이미지 매핑 레코드 (SQLite)
│   ├── board_image_records_base.py
│   └── board_image_records_sqlite.py
├── board_images/           # 보드-이미지 비즈니스 로직
│   ├── board_images_base.py
│   └── board_images_default.py
├── board_records/          # 보드 레코드 (SQLite)
│   ├── board_records_base.py
│   └── board_records_sqlite.py
├── boards/                 # 보드 비즈니스 로직
│   ├── boards_base.py
│   └── boards_default.py
├── bulk_download/          # 대량 이미지 다운로드 (ZIP)
│   ├── bulk_download_base.py
│   └── bulk_download_default.py
├── client_state_persistence/ # 클라이언트 UI 상태 저장
│   ├── client_state_persistence_base.py
│   └── client_state_persistence_sqlite.py
├── config/                 # ★ 앱 설정 (InvokeAIAppConfig)
│   ├── config_default.py   # 설정 클래스, YAML 로딩, 마이그레이션
│   └── __init__.py
├── download/               # 파일 다운로드 서비스
│   ├── download_base.py
│   └── download_default.py
├── events/                 # ★ 이벤트 시스템 (Socket.IO 기반)
│   ├── events_base.py      # EventServiceBase 추상 클래스
│   ├── events_common.py    # 이벤트 타입 정의
│   └── events_fastapievents.py # FastAPI 이벤트 구현
├── image_files/            # 이미지 파일 스토리지
│   ├── image_files_base.py
│   └── image_files_disk.py # 로컬 디스크 저장
├── image_records/          # 이미지 메타데이터 레코드 (SQLite)
│   ├── image_records_base.py
│   ├── image_records_common.py
│   └── image_records_sqlite.py
├── images/                 # ★ 이미지 서비스 (생성/조회/삭제)
│   ├── images_base.py
│   ├── images_common.py
│   └── images_default.py
├── invocation_cache/       # 노드 실행 결과 캐시
│   ├── invocation_cache_base.py
│   └── invocation_cache_memory.py
├── invocation_stats/       # 실행 통계
│   ├── invocation_stats_base.py
│   └── invocation_stats_default.py
├── item_storage/           # 일반 아이템 스토리지
│   ├── item_storage_base.py
│   └── item_storage_memory.py
├── model_images/           # 모델 이미지 관리
│   ├── model_images_base.py
│   └── model_images_default.py
├── model_install/          # ★ 모델 설치 서비스
│   ├── model_install_base.py
│   ├── model_install_common.py
│   └── model_install_default.py
├── model_load/             # ★ 모델 로딩 서비스
│   ├── model_load_base.py
│   └── model_load_default.py
├── model_manager/          # ★ 모델 매니저 (통합 인터페이스)
│   ├── model_manager_base.py
│   └── model_manager_default.py
├── model_records/          # 모델 레코드 (SQLite)
│   ├── model_records_base.py
│   └── model_records_sql.py
├── model_relationship_records/ # 모델 관계 레코드
│   ├── model_relationship_records_base.py
│   └── model_relationship_records_sqlite.py
├── model_relationships/    # 모델 관계 서비스
│   ├── model_relationships_base.py
│   └── model_relationships_default.py
├── names/                  # 이름 생성 서비스
│   ├── names_base.py
│   └── names_default.py
├── object_serializer/      # 텐서/컨디셔닝 객체 직렬화
│   ├── object_serializer_base.py
│   ├── object_serializer_disk.py
│   └── object_serializer_forward_cache.py
├── orphaned_models/        # 고아 모델 탐지/삭제
│   ├── orphaned_models_base.py
│   └── orphaned_models_default.py
├── session_processor/      # ★ 세션 프로세서 (작업 실행 엔진)
│   ├── session_processor_base.py
│   ├── session_processor_common.py
│   └── session_processor_default.py
├── session_queue/          # ★ 세션 큐 (작업 대기열)
│   ├── session_queue_base.py
│   ├── session_queue_common.py
│   └── session_queue_sqlite.py
├── shared/                 # 공유 인프라
│   ├── graph.py            # ★ Graph, GraphExecutionState (노드 그래프 실행)
│   ├── invocation_context.py # InvocationContext (노드 실행 컨텍스트)
│   ├── pagination.py       # 페이지네이션 유틸리티
│   ├── sqlite/             # SQLite 공통 유틸리티
│   │   ├── sqlite_common.py
│   │   ├── sqlite_database.py  # SqliteDatabase 클래스
│   │   └── sqlite_util.py      # DB 초기화 유틸리티
│   └── sqlite_migrator/    # ★ 자체 DB 마이그레이션 시스템
│       ├── sqlite_migrator_common.py
│       ├── sqlite_migrator_impl.py
│       └── migrations/     # 마이그레이션 1~25
│           ├── migration_1.py   # 초기 스키마 (boards, images, models, queue, workflows)
│           ├── migration_2.py   # workflow_library 테이블 추가
│           ├── ...
│           └── migration_25.py  # Qwen3 모델 variant 필드 추가
├── style_preset_images/    # 스타일 프리셋 이미지
│   └── style_preset_images_disk.py
├── style_preset_records/   # 스타일 프리셋 레코드
│   └── style_preset_records_sqlite.py
├── urls/                   # URL 생성 서비스
│   ├── urls_base.py
│   └── urls_default.py
├── workflow_records/       # 워크플로우 레코드 (SQLite)
│   ├── workflow_records_base.py
│   └── workflow_records_sqlite.py
└── workflow_thumbnails/    # 워크플로우 썸네일
    ├── workflow_thumbnails_base.py
    └── workflow_thumbnails_disk.py
```

### 4.3 인보케이션 (노드) 시스템 (`invokeai/app/invocations/`)

InvokeAI의 핵심은 **노드 기반 파이프라인 시스템**입니다. 각 노드는 `BaseInvocation`을 상속하며, `invoke()` 메서드로 실행됩니다.

```
invokeai/app/invocations/
├── baseinvocation.py       # ★ BaseInvocation, BaseInvocationOutput, InvocationRegistry
├── fields.py               # 공통 필드 타입 정의 (ImageField, LatentsField 등)
├── constants.py            # 상수 정의
├── batch.py                # 배치 처리
├── load_custom_nodes.py    # 커스텀 노드 로딩
├── custom_nodes/           # 사용자 커스텀 노드 디렉토리
│
│ # === Stable Diffusion 1.x / 2.x / SDXL 관련 ===
├── compel.py               # 텍스트 인코딩 (Compel 라이브러리)
├── denoise_latents.py      # ★ 디노이징 (SD 1.x/2.x/SDXL 핵심)
├── sdxl.py                 # SDXL 모델 로더
├── image_to_latents.py     # 이미지 → 잠재공간 변환
├── latents_to_image.py     # 잠재공간 → 이미지 변환
├── create_denoise_mask.py  # 디노이즈 마스크 생성
├── create_gradient_mask.py # 그래디언트 마스크 생성
├── blend_latents.py        # 잠재공간 블렌딩
├── crop_latents.py         # 잠재공간 크롭
├── resize_latents.py       # 잠재공간 리사이즈
├── noise.py                # 노이즈 생성
├── scheduler.py            # 스케줄러 선택
│
│ # === FLUX 모델 관련 ===
├── flux_model_loader.py    # FLUX 모델 로더
├── flux_text_encoder.py    # FLUX 텍스트 인코더 (T5/CLIP)
├── flux_denoise.py         # ★ FLUX 디노이징
├── flux_vae_decode.py      # FLUX VAE 디코딩
├── flux_vae_encode.py      # FLUX VAE 인코딩
├── flux_lora_loader.py     # FLUX LoRA 로더
├── flux_control_lora_loader.py # FLUX Control LoRA
├── flux_controlnet.py      # FLUX ControlNet
├── flux_ip_adapter.py      # FLUX IP-Adapter
├── flux_fill.py            # FLUX Fill (인페인팅)
├── flux_redux.py           # FLUX Redux
├── flux_kontext.py         # FLUX Kontext
│
│ # === FLUX 2 관련 ===
├── flux2_denoise.py        # FLUX 2 디노이징
├── flux2_klein_model_loader.py # FLUX 2 Klein 모델 로더
├── flux2_klein_text_encoder.py # FLUX 2 Klein 텍스트 인코더
├── flux2_vae_decode.py     # FLUX 2 VAE 디코딩
├── flux2_vae_encode.py     # FLUX 2 VAE 인코딩
│
│ # === Stable Diffusion 3 관련 ===
├── sd3_model_loader.py     # SD3 모델 로더
├── sd3_text_encoder.py     # SD3 텍스트 인코더
├── sd3_denoise.py          # SD3 디노이징
├── sd3_image_to_latents.py # SD3 이미지→잠재공간
├── sd3_latents_to_image.py # SD3 잠재공간→이미지
│
│ # === CogView4 관련 ===
├── cogview4_model_loader.py  # CogView4 모델 로더
├── cogview4_text_encoder.py  # CogView4 텍스트 인코더
├── cogview4_denoise.py       # CogView4 디노이징
├── cogview4_image_to_latents.py # CogView4 이미지→잠재공간
├── cogview4_latents_to_image.py # CogView4 잠재공간→이미지
│
│ # === Z-Image 관련 ===
├── z_image_model_loader.py   # Z-Image 모델 로더
├── z_image_text_encoder.py   # Z-Image 텍스트 인코더
├── z_image_denoise.py        # Z-Image 디노이징
├── z_image_image_to_latents.py # Z-Image 이미지→잠재공간
├── z_image_latents_to_image.py # Z-Image 잠재공간→이미지
├── z_image_lora_loader.py    # Z-Image LoRA 로더
├── z_image_control.py        # Z-Image 컨트롤
├── z_image_seed_variance_enhancer.py # Z-Image 시드 분산
│
│ # === ControlNet / IP-Adapter / T2I 관련 ===
├── controlnet.py           # ControlNet 노드
├── ip_adapter.py           # IP-Adapter 노드
├── t2i_adapter.py          # T2I-Adapter 노드
│
│ # === 이미지 전처리 (프리프로세서) ===
├── canny.py                # Canny 엣지 디텍션
├── content_shuffle.py      # Content Shuffle
├── color_map.py            # 컬러 맵
├── depth_anything.py       # Depth Anything (깊이 추정)
├── dw_openpose.py          # DW OpenPose (포즈 추정)
├── facetools.py            # 얼굴 도구
├── grounding_dino.py       # Grounding DINO (객체 탐지)
├── hed.py                  # HED 엣지 디텍션
├── lineart.py              # Line Art 추출
├── lineart_anime.py        # Anime Line Art
├── mediapipe_face.py       # MediaPipe 얼굴 탐지
├── mlsd.py                 # MLSD 라인 디텍션
├── normal_bae.py           # Normal BAE (법선맵 추정)
├── pidi.py                 # PIDI 소프트 엣지
├── segment_anything.py     # Segment Anything (세그먼테이션)
│
│ # === 이미지 처리/변환 ===
├── image.py                # ★ 이미지 조작 (리사이즈, 크롭, 블렌드 등)
├── image_panels.py         # 이미지 패널 처리
├── infill.py               # 인페인팅 인필 (PatchMatch, CV2 등)
├── mask.py                 # 마스크 처리
├── cv.py                   # OpenCV 유틸리티 노드
├── spandrel_image_to_image.py # Spandrel 업스케일링
├── upscale.py              # 업스케일 유틸리티
├── tiles.py                # 타일 처리
├── tiled_multi_diffusion_denoise_latents.py # 타일드 멀티 디퓨전
├── pbr_maps.py             # PBR 맵 생성
│
│ # === 기타 유틸리티 ===
├── collections.py          # 컬렉션 노드
├── composition-nodes.py    # 합성 노드
├── ideal_size.py           # 이상적 크기 계산
├── math.py                 # 수학 연산 노드
├── metadata.py             # 메타데이터 처리
├── metadata_linked.py      # 링크된 메타데이터
├── model.py                # 모델 관련 유틸리티 노드
├── param_easing.py         # 파라미터 이징
├── primitives.py           # 기본 타입 노드 (Int, Float, String 등)
├── prompt.py               # 프롬프트 처리
├── prompt_template.py      # 프롬프트 템플릿
├── strings.py              # 문자열 처리 노드
├── util.py                 # 유틸리티 함수
└── llava_onevision_vllm.py # LLaVA OneVision VLM 지원
```

## 5. AI/ML 백엔드 상세 구조 (`invokeai/backend/`)

```
invokeai/backend/
├── __init__.py
│
├── flux/                   # FLUX 모델 아키텍처
│   ├── controlnet/         # FLUX ControlNet 구현
│   ├── extensions/         # FLUX 확장 (LoRA, ControlNet, IP-Adapter)
│   ├── math.py            # FLUX 수학 유틸리티
│   ├── model.py           # ★ FLUX Transformer 모델
│   ├── modules/           # FLUX 모듈 (attention, MLP 등)
│   ├── sampling/          # FLUX 샘플링 알고리즘
│   └── text_conditioning.py # FLUX 텍스트 컨디셔닝
│
├── flux2/                  # FLUX 2 모델 아키텍처
│   ├── klein/             # FLUX 2 Klein 모델
│   └── ...                # FLUX 2 관련 모듈
│
├── image_util/             # ★ 이미지 처리 유틸리티
│   ├── depth_anything/    # Depth Anything 모델
│   ├── dw_openpose/       # DW OpenPose
│   ├── grounding_dino/    # Grounding DINO
│   ├── imwatermark/       # 이미지 워터마크
│   ├── mediapipe_face/    # MediaPipe 얼굴 인식
│   ├── mlsd/              # MLSD 라인 인식
│   ├── normal_bae/        # Normal BAE
│   ├── pidi/              # PIDI 소프트 엣지
│   ├── realesrgan/        # Real-ESRGAN 업스케일러
│   ├── segment_anything/  # SAM 세그먼테이션
│   ├── infill_cv2.py      # OpenCV 인필
│   ├── infill_patchmatch.py # PatchMatch 인필
│   ├── invisible_watermark.py # 보이지 않는 워터마크
│   ├── patchmatch.py      # PatchMatch 유틸리티
│   ├── safety_checker.py  # NSFW 안전 체커
│   └── util.py            # 이미지 유틸리티
│
├── ip_adapter/             # IP-Adapter 구현
│   ├── ip_adapter.py      # IP-Adapter 메인
│   ├── resampler.py       # 리샘플러
│   └── unet_patcher.py    # UNet 패처
│
├── model_hash/             # 모델 해시 계산
│   └── model_hash.py
│
├── model_manager/          # ★ 모델 매니저 (검색, 로딩, 캐시)
│   ├── configs/           # 모델 설정 클래스
│   │   ├── factory.py     # 모델 설정 팩토리
│   │   └── ...
│   ├── load/              # ★ 모델 로딩 시스템
│   │   ├── model_cache/   # ★ 모델 캐시 (RAM/VRAM 관리)
│   │   │   ├── cache_record.py
│   │   │   ├── model_cache.py
│   │   │   └── torch_module_autocast.py
│   │   ├── model_loader/  # 모델 로더 구현
│   │   └── load_base.py   # 로더 기반 클래스
│   ├── probe/             # 모델 프로브 (형식 감지)
│   ├── search/            # 모델 탐색
│   └── taxonomy.py        # ★ 모델 분류 체계 (ModelType, BaseModelType 등)
│
├── onnx/                   # ONNX 런타임 지원
├── patches/                # 모델 패치 (LoRA, textual inversion 등)
│   ├── layers/            # 패치 레이어 구현
│   └── ...
├── quantization/           # 모델 양자화 (GGUF, BnB)
├── rectified_flow/         # Rectified Flow 샘플링 (SD3)
├── sig_lip/                # SigLIP 비전 인코더
├── stable_diffusion/       # ★ Stable Diffusion 핵심 모듈
│   ├── diffusion/         # 디퓨전 프로세스
│   │   ├── conditioning_data.py # 컨디셔닝 데이터
│   │   ├── custom_attn_processor.py # 커스텀 어텐션
│   │   └── ...
│   └── ...
├── tiles/                  # 타일 기반 처리
├── util/                   # 유틸리티
│   ├── devices.py         # ★ TorchDevice (GPU/CPU 디바이스 관리)
│   ├── logging.py         # InvokeAI 로깅 시스템
│   └── ...
└── z_image/                # Z-Image 아키텍처 (최신)
    └── ...
```

## 6. 프론트엔드 상세 구조 (`invokeai/frontend/web/`)

### 6.1 기술 스택

| 기술 | 버전 | 용도 |
|------|------|------|
| React | 18.3.1 | UI 프레임워크 |
| TypeScript | 5.8.3 | 타입 시스템 |
| Vite | 7.0.5 | 빌드 도구 |
| Redux Toolkit (RTK) | 2.8.2 | 상태 관리 |
| RTK Query | (포함) | API 데이터 패칭 |
| Chakra UI | @invoke-ai/ui-library | UI 컴포넌트 라이브러리 |
| Konva | 9.3.22 | 캔버스 렌더링 |
| @xyflow/react | 12.8.2 | 노드 에디터 (xyflow) |
| Socket.IO Client | 4.8.1 | WebSocket 통신 |
| i18next | 25.3.2 | 국제화/다국어 지원 |
| Framer Motion | 11.10.0 | 애니메이션 |
| Zod | 4.0.10 | 런타임 스키마 검증 |
| React Hook Form | 7.60.0 | 폼 관리 |
| Dockview | 4.7.1 | 도킹 레이아웃 |

### 6.2 프론트엔드 소스 구조

```
invokeai/frontend/web/
├── package.json            # 의존성, 스크립트
├── vite.config.mts         # Vite 빌드 설정
├── tsconfig.json           # TypeScript 설정
├── eslint.config.mjs       # ESLint 설정
├── .prettierrc.yaml        # Prettier 설정
├── knip.json               # 미사용 코드 탐지
├── index.html              # HTML 엔트리포인트
├── scripts/
│   └── typegen.js          # OpenAPI 타입 생성 스크립트
├── static/                 # 정적 에셋
│   └── locales/            # ★ i18n 번역 파일 (20+ 언어)
│       ├── en.json         # 영어 (기본)
│       ├── ko.json         # 한국어
│       └── ...
│
└── src/                    # ★ React 소스 코드
    ├── main.tsx            # 앱 엔트리포인트
    ├── theme.ts            # Chakra UI 테마 설정
    │
    ├── app/                # 앱 전역 설정
    │   ├── components/     # 최상위 컴포넌트
    │   │   ├── App.tsx     # ★ 메인 App 컴포넌트
    │   │   └── ...
    │   ├── hooks/          # 전역 커스텀 훅
    │   ├── logging/        # 로깅 시스템 (Roarr)
    │   └── store/          # ★ Redux 스토어 설정
    │       ├── store.ts    # 스토어 생성, 미들웨어
    │       └── storeHooks.ts # useAppSelector, useAppDispatch
    │
    ├── common/             # 공통 유틸리티
    │   ├── components/     # 공통 UI 컴포넌트
    │   ├── hooks/          # 공통 훅
    │   └── util/           # 유틸리티 함수
    │
    ├── features/           # ★ 기능별 모듈
    │   ├── controlLayers/  # ★★ 컨트롤 레이어 (캔버스/레이어 시스템)
    │   │   ├── components/ # 캔버스 UI 컴포넌트
    │   │   ├── konva/      # ★ Konva 캔버스 렌더링 엔진
    │   │   ├── store/      # 캔버스 상태 관리
    │   │   └── util/       # 캔버스 유틸리티
    │   ├── gallery/        # ★ 이미지 갤러리
    │   │   ├── components/ # 갤러리 UI
    │   │   └── store/      # 갤러리 상태
    │   ├── nodes/          # ★ 노드 에디터 (워크플로우)
    │   │   ├── components/ # 노드 에디터 UI
    │   │   ├── store/      # 노드 에디터 상태
    │   │   ├── types/      # 노드 타입 정의
    │   │   └── util/       # 노드 유틸리티
    │   ├── parameters/     # ★ 생성 파라미터 패널
    │   │   ├── components/ # 파라미터 UI (Steps, CFG, Size 등)
    │   │   └── store/      # 파라미터 상태
    │   ├── modelManagerV2/ # ★ 모델 매니저 UI
    │   │   ├── components/ # 모델 목록, 설치, 설정 UI
    │   │   └── store/      # 모델 상태
    │   ├── queue/          # 작업 큐 UI
    │   │   ├── components/ # 큐 목록, 상태 표시 UI
    │   │   └── store/      # 큐 상태
    │   ├── prompt/         # 프롬프트 입력
    │   │   ├── PromptEditor.tsx
    │   │   └── ...
    │   ├── lora/           # LoRA 관리
    │   ├── sdxl/           # SDXL 파라미터
    │   ├── settingsAccordions/ # 설정 아코디언 패널
    │   ├── stylePresets/   # 스타일 프리셋
    │   ├── workflowLibrary/ # 워크플로우 라이브러리
    │   ├── dynamicPrompts/ # 다이나믹 프롬프트
    │   ├── metadata/       # 이미지 메타데이터
    │   ├── system/         # 시스템 설정
    │   ├── ui/             # ★ UI 레이아웃
    │   │   ├── components/ # 탭, 사이드바, 레이아웃 컴포넌트
    │   │   └── store/      # UI 상태
    │   ├── changeBoardModal/ # 보드 변경 모달
    │   ├── cropper/        # 이미지 크롭
    │   ├── deleteImageModal/ # 이미지 삭제 모달
    │   ├── dnd/            # 드래그 앤 드롭
    │   ├── imageActions/   # 이미지 액션
    │   └── toast/          # 토스트 알림
    │
    └── services/           # ★ API 서비스 계층
        ├── api/            # RTK Query API 정의
        │   ├── index.ts    # API 기본 설정
        │   ├── schema.ts   # ★ OpenAPI 생성 타입
        │   └── endpoints/  # 엔드포인트별 API 훅
        └── events/         # Socket.IO 이벤트 핸들링
            ├── setEventListeners.ts
            └── ...
```

## 7. 진입점 및 실행 흐름

### 7.1 앱 시작 순서

1. **CLI 진입** → `invokeai-web` → `invokeai.app.run_app:run_app()`
2. **CLI 파싱** → `InvokeAIArgs.parse_args()`
3. **설정 로드** → `get_config()` → `invokeai.yaml` 읽기 + 환경변수 병합
4. **CUDA 메모리 할당기 구성** → `configure_torch_cuda_allocator()`
5. **커스텀 노드 로딩** → `load_custom_nodes()`
6. **FastAPI 앱 생성** → `api_app.py` → 미들웨어, 라우터 등록
7. **서비스 초기화** → `ApiDependencies.initialize()`:
   - SQLite DB 초기화 + 마이그레이션 (v0 → v25)
   - 모든 서비스 인스턴스 생성
   - `Invoker` 생성 → `SessionProcessor` 시작
8. **Uvicorn 서버 시작** → `server.serve()`

### 7.2 이미지 생성 흐름

1. 사용자가 UI에서 "Generate" 클릭
2. 프론트엔드 → `POST /api/v1/queue/{queue_id}/enqueue_batch` 호출
3. 백엔드가 `Batch` → 하나 이상의 `SessionQueueItem` 생성
4. `SessionProcessor`가 큐에서 대기 항목 꺼냄
5. `SessionRunner`가 `GraphExecutionState` 실행 시작
6. 그래프 내 각 노드가 순차적으로 `invoke()` 실행:
   - Text Encoder → Noise → Denoise → Latents to Image
7. 각 노드 완료 시 `InvocationCompleteEvent` 발생 → Socket.IO로 프론트엔드에 전달
8. 최종 이미지가 디스크에 저장, 메타데이터가 DB에 기록
9. 프론트엔드 갤러리에 새 이미지 표시

## 8. 데이터베이스 현황

### 8.1 SQLite 스키마 (v25 기준)

InvokeAI는 **SQLite 단일 파일 데이터베이스** (`invokeai.db`)를 사용하며, 자체 마이그레이션 시스템(v0~v25)으로 스키마를 관리합니다.

**주요 테이블:**

| 테이블 | 용도 |
|--------|------|
| `images` | 생성된 이미지 메타데이터 |
| `boards` | 이미지 보드(앨범) |
| `board_images` | 보드-이미지 관계 (junction) |
| `models` (구 `model_config`) | 설치된 모델 정보 |
| `model_manager_metadata` | 모델 매니저 메타데이터 |
| `model_relationships` | 모델 간 관계 |
| `session_queue` | 작업 실행 대기열 |
| `workflows` | 저장된 워크플로우 |
| `workflow_images` | 워크플로우-이미지 관계 |
| `workflow_library` | 워크플로우 라이브러리 |
| `style_presets` | 스타일 프리셋 |
| `client_state` | 클라이언트 UI 상태 |

### 8.2 SaaS 전환 시 DB 개선 필요사항

| 문제 | 설명 | SaaS 대응 |
|------|------|-----------|
| **SQLite 단일 사용자** | 동시 접속 불가, 파일 기반 | **Aurora PostgreSQL (Serverless v2)** 마이그레이션 필수 |
| **인증/권한 없음** | 누구나 모든 기능 접근 가능 | JWT 기반 인증 + RBAC 추가 |
| **사용량 추적 없음** | 크레딧, 사용량 개념 없음 | 사용량 추적 테이블 추가 |
| **멀티 테넌시 없음** | 단일 사용자 전제 | 모든 테이블에 `user_id` / `tenant_id` 추가 |
| **결제 시스템 없음** | 로컬 무료 사용 전제 | Stripe 연동, 구독/결제 테이블 추가 |
| **세션 관리 미비** | 간단한 WebSocket | Redis 기반 세션 관리 |

## 9. 동기/비동기 처리 아키텍처 분석

InvokeAI는 **동기 처리 중심 아키텍처**입니다. FastAPI 계층은 async를 사용하지만, 서비스 계층 이하는 거의 전부 동기(synchronous) 방식으로 동작합니다.

### 9.1 동기 처리 (Synchronous) 영역

InvokeAI에서 동기적으로 실행되는 핵심 영역들입니다.

#### 9.1.1 노드 실행 시스템 (100% 동기)

```
파일: invokeai/app/invocations/baseinvocation.py
메서드: def invoke(self, context: InvocationContext) -> BaseInvocationOutput

→ 90개 이상의 모든 인보케이션 노드가 동기 invoke() 메서드를 사용
→ PyTorch GPU 연산, 모델 로딩, 파일 I/O 모두 블로킹 동기 호출
```

**주요 동기 노드 실행 예시:**

| 노드 | 파일 | 동기 작업 내용 | 블로킹 시간 |
|------|------|---------------|------------|
| DenoiseLatents | `denoise_latents.py` | GPU 디노이징 루프 (매 스텝 동기) | 5-30초 |
| FluxDenoise | `flux_denoise.py` | FLUX 모델 추론 (`@torch.no_grad()`) | 10-60초 |
| LatentsToImage | `latents_to_image.py` | VAE 디코딩 (GPU→CPU 전환) | 1-5초 |
| ImageCrop/Resize | `image.py` | PIL/NumPy 이미지 처리 | 0.1-2초 |
| TextEncoder | `compel.py` | CLIP 텍스트 인코딩 | 0.5-2초 |
| ModelLoader | `sdxl.py`, `flux_model_loader.py` | 모델 파일 로딩 + VRAM 전송 | 5-30초 |

#### 9.1.2 세션 프로세서 (단일 스레드 동기 루프)

```
파일: invokeai/app/services/session_processor/session_processor_default.py

- 전용 백그라운드 스레드 1개 (BoundedSemaphore(thread_limit=1))
- 큐에서 작업을 하나씩 꺼내 동기적으로 실행
- 그래프 내 모든 노드를 순차적(sequential)으로 실행
- 한 번에 하나의 워크플로우만 처리 가능
```

**실행 모델:**
```
SessionProcessor Thread:
  while not stopped:
    queue_item = session_queue.dequeue()     # 동기 - SQLite 쿼리
    session_runner.run(queue_item)            # 동기 - 전체 그래프 실행
      → for each node in graph:
          node.invoke(context)               # 동기 - GPU/CPU 블로킹
          save_output()                      # 동기 - 파일/DB I/O
```

#### 9.1.3 데이터베이스 (동기 + 스레드 잠금)

```
파일: invokeai/app/services/shared/sqlite/sqlite_database.py

- threading.RLock() 사용하여 스레드 안전성 확보
- 모든 DB 작업이 with self._lock: 블록 내에서 동기 실행
- WAL 모드 활성화되어 있으나, 쓰기 작업은 직렬화됨
```

**모든 SQLite 서비스 구현체가 동기:**

| 서비스 | 파일 | 주요 동기 메서드 |
|--------|------|-----------------|
| ImageRecordStorage | `image_records_sqlite.py` | `get()`, `save()`, `delete()`, `get_many()` |
| BoardRecordStorage | `board_records_sqlite.py` | `save()`, `get()`, `update()`, `delete()` |
| SessionQueue | `session_queue_sqlite.py` | `dequeue()`, `get_queue_item()`, `cancel()`, `clear()` |
| WorkflowRecords | `workflow_records_sqlite.py` | `create()`, `get()`, `update()`, `delete()` |
| ModelRecords | `model_records_sql.py` | `get_model()`, `search_by_attr()`, `update_model()` |
| StylePresetRecords | `style_preset_records_sqlite.py` | `create()`, `get()`, `update()`, `delete()` |
| ClientStatePersistence | `client_state_persistence_sqlite.py` | `get_by_key()`, `set_by_key()` |

**예외 (유일한 async DB 호출):**
- `session_queue_sqlite.py`의 `enqueue_batch()` 메서드만 `asyncio.to_thread()` 사용

#### 9.1.4 모델 로딩 및 캐시 (동기 + 스레드 안전 경고)

```
파일: invokeai/backend/model_manager/load/load_default.py
경고: # TO DO: The loader is not thread safe! (소스 코드 주석)

파일: invokeai/backend/model_manager/load/model_cache/model_cache.py
- threading.RLock() + @synchronized 데코레이터 사용
- put(), get(), lock(), unlock() 모두 동기
- make_room() - LRU 캐시 퇴출 동기
- _load_locked_model() - VRAM 전송 동기 (5-30초 블로킹)
```

**동기 모델 로딩 체인:**
```
context.models.load(model_key)
  → ModelManager.load_model()              # 동기
    → ModelCache.get_cached()              # 동기 + 락
    → ModelLoader.load_from_disk()         # 동기 - 파일 I/O (2-20GB)
      → safetensors.torch.load_file()      # 동기 - 디스크 읽기
    → ModelCache._load_locked_model()      # 동기 - VRAM 전송
      → _offload_unlocked_models()         # 동기 - 다른 모델 해제
      → _move_model_to_vram()              # 동기 - GPU 메모리 복사
```

#### 9.1.5 이미지 파일 I/O (동기 디스크 작업)

```
파일: invokeai/app/services/image_files/image_files_disk.py

- get() → PIL Image.open() 동기 디스크 읽기
- save() → 원본 저장 + 썸네일 생성 + 메타데이터 기록 (모두 동기)
- delete() → Path.unlink() 동기 파일 삭제
```

```
파일: invokeai/app/services/object_serializer/object_serializer_disk.py

- load() → torch.load() 동기 (텐서/컨디셔닝 데이터)
- save() → torch.save() 동기
```

#### 9.1.6 API 라우터 (async 핸들러 → 동기 서비스 호출)

```
패턴: 모든 128개 엔드포인트가 async def이지만, 내부에서 동기 서비스 호출

async def upload_image():                    # async 핸들러
    result = service.create(image)           # 동기 호출 (SQLite + 파일 I/O)
    return result                            # 이벤트 루프 블로킹

→ FastAPI의 스레드풀에서 실행되지만, 동기 호출이 스레드를 점유
→ 고부하 시 스레드풀 고갈 위험
```

**라우터별 동기 블로킹 호출 현황:**

| 라우터 | 엔드포인트 수 | 동기 블로킹 호출 포함 |
|--------|-------------|---------------------|
| images.py | 26 | 26 (SQLite + 파일 I/O + PIL) |
| model_manager.py | 28 | 28 (SQLite + 파일 I/O + HTTP + 모델 로딩) |
| session_queue.py | 21 | 20 (SQLite) - `enqueue_batch`만 to_thread 사용 |
| workflows.py | 12 | 12 (SQLite + 파일 I/O) |
| style_presets.py | 8 | 8 (SQLite + 파일 I/O) |
| boards.py | 6 | 6 (SQLite + 파일 I/O) |
| app_info.py | 9 | 3 (캐시/로거 접근) |
| board_images.py | 4 | 4 (SQLite) |
| model_relationships.py | 4 | 4 (SQLite) |
| client_state.py | 3 | 3 (SQLite) |
| download_queue.py | 6 | 2 (스레드풀) |
| utilities.py | 1 | 1 (CPU 연산) |
| **합계** | **128** | **~120+ 블로킹** |

#### 9.1.7 백엔드 AI 연산 (100% 동기)

```
invokeai/backend/stable_diffusion/diffusion_backend.py
- latents_from_embeddings() → 메인 디노이징 루프 (동기 반복)
- step() → 단일 디노이징 스텝 (동기 GPU 연산)
- run_unet() → UNet 순전파 (동기)

invokeai/backend/flux/sampling/*.py
- FLUX 샘플링 알고리즘 (동기 GPU 연산)

invokeai/backend/image_util/*.py
- 모든 이미지 처리 유틸리티 (PIL, OpenCV, NumPy) 동기
```

### 9.2 비동기 처리 (Asynchronous) 영역

InvokeAI에서 실제로 비동기적으로 동작하는 영역은 매우 제한적입니다.

#### 9.2.1 이벤트 시스템 (유일한 완전 비동기 컴포넌트)

```
파일: invokeai/app/services/events/events_fastapievents.py

- asyncio.Queue[EventBase | None]() 사용
- async def _dispatch_from_queue() → 비동기 이벤트 디스패치
- call_soon_threadsafe() → 동기 스레드에서 비동기 이벤트 큐로 브릿지

→ 이벤트 발행이 노드 실행을 블로킹하지 않음
→ WebSocket 브로드캐스트가 비동기적으로 처리됨
```

#### 9.2.2 FastAPI 요청 처리 (부분 비동기)

```
파일: invokeai/app/api_app.py

- @asynccontextmanager lifespan → 비동기 앱 생명주기
- Socket.IO 서버 → 비동기 WebSocket 처리
- 파일 업로드 → await file.read() 비동기

→ 하지만 서비스 계층 호출 시점에서 동기로 전환됨
```

#### 9.2.3 다운로드/설치 서비스 (백그라운드 스레드)

```
파일: invokeai/app/services/download/download_default.py
- threading.Thread로 백그라운드 워커 스레드 생성
- requests.get() + iter_content() → 동기 HTTP (스레드 내)
- HTTP 핸들러를 블로킹하지 않지만, 스레드 내부는 동기

파일: invokeai/app/services/model_install/model_install_default.py
- threading.Thread로 설치 백그라운드 스레드 생성
- 모델 프로브, 해시 계산, 파일 이동 → 동기 (스레드 내)
```

### 9.3 동기/비동기 처리 요약표

| 컴포넌트 | 처리 방식 | 동기 이유 | SaaS 영향 |
|----------|----------|----------|----------|
| **노드 실행 (90+ 노드)** | 동기 | PyTorch GPU 연산 특성 | 🔴 치명적 |
| **세션 프로세서** | 단일 스레드 동기 | GPU 경합 방지, 모델 캐시 일관성 | 🔴 치명적 |
| **SQLite 데이터베이스** | 동기 + RLock | SQLite 동시성 한계 | 🟡 높음 |
| **모델 로딩/캐시** | 동기 + Lock (비스레드세이프 경고!) | 대용량 파일 I/O, 역직렬화 | 🔴 치명적 |
| **이미지 파일 I/O** | 동기 디스크 I/O | PIL/torch 동기 API | 🟡 중-높음 |
| **API 라우터 (128개)** | async→동기 호출 | 서비스 계층이 전부 동기 | 🟡 중간 |
| **백엔드 AI 연산** | 100% 동기 | PyTorch, NumPy, PIL | 🔴 치명적 |
| **다운로드/설치** | 백그라운드 스레드 동기 | requests 라이브러리 | 🟢 낮음 |
| **이벤트 시스템** | ✅ 비동기 | 실시간 업데이트 | 🟢 양호 |
| **인보케이션 캐시** | 동기 + Lock | 인메모리 dict 접근 | 🟢 낮음 |

### 9.4 핵심 동기 처리 병목점 (SaaS 전환 시)

**🔴 아키텍처 변경 필수 (Critical):**

1. **단일 스레드 실행**: 인스턴스당 1개 워크플로우만 동시 처리
   - 해결: 멀티 GPU 워커 프로세스로 수평 확장
2. **동기 노드 실행**: 90+ 노드 모두 스레드 블로킹
   - 해결: PyTorch 특성상 async 전환 불가 → 수평 확장으로 대응
3. **모델 로더 비스레드세이프**: 소스 코드에 TODO 경고 존재
   - 해결: 워커별 독립 모델 캐시 + 사전 워밍(pre-warming)
4. **GPU 직렬화**: GPU당 동시 1개 작업만 가능
   - 해결: 멀티 GPU 워커 또는 모델 배치 처리

**🟡 최적화 기회 (High):**

5. **SQLite 쓰기 직렬화**: 모든 사용자가 단일 DB 락 공유
   - 해결: PostgreSQL + 연결 풀링 + asyncpg 비동기 드라이버
6. **동기 이미지 I/O**: 요청 스레드 블로킹
   - 해결: 백그라운드 워커 위임 또는 aiofiles 비동기 I/O
7. **API 스레드풀 고갈**: async 핸들러에서 동기 호출 시 스레드 점유
   - 해결: `asyncio.to_thread()` 래핑 또는 비동기 서비스 계층 도입

## 10. 현재 시스템의 강점과 약점

### 9.1 강점 (SaaS 전환 시 활용 가능)

1. **견고한 서비스 아키텍처**: 추상 클래스 + 구현 패턴으로 인터페이스 교체 용이
2. **노드 기반 파이프라인**: 유연하고 확장 가능한 이미지 생성 워크플로우
3. **멀티 모델 지원**: SD 1.x/2.x, SDXL, FLUX, SD3, CogView4, Z-Image
4. **잘 분리된 프론트/백엔드**: REST API + WebSocket 기반 통신
5. **OpenAPI 스키마 자동 생성**: 프론트엔드 타입 자동 생성 가능
6. **이미지 메타데이터 시스템**: 생성 이력 추적 기능 내장
7. **커스텀 노드 시스템**: 확장 가능한 플러그인 아키텍처
8. **실시간 진행률 피드백**: Socket.IO 기반 실시간 이벤트

### 9.2 약점 / 개선 필요사항

1. **인증/인가 부재**: 완전 오픈 → SaaS에서는 치명적
2. **단일 사용자 설계**: 멀티테넌시 지원 불가
3. **SQLite 한계**: 동시성, 확장성 부족
4. **로컬 파일 스토리지**: 디스크 기반 → S3 전환 필요
5. **GPU 리소스 관리 부재**: 단일 GPU 직접 사용 → GPU 풀링/격리 필요
6. **큐 시스템 한계**: SQLite 기반 큐 → SQS/Redis Queue 필요
7. **모니터링 부재**: 서비스 헬스 체크, 메트릭 수집 없음
8. **수평 확장 불가**: 단일 프로세스 설계 → 컨테이너 오케스트레이션 필요
9. **CORS 설정 전역 와일드카드**: 보안 강화 필요
10. **에러 핸들링 일관성 부족**: 일부 라우터에서 generic Exception 캐치

## 10. 의존성 주요 패키지 분석

### 10.1 Python 핵심 의존성

| 패키지 | 버전 | 용도 | SaaS 시 변경 여부 |
|--------|------|------|-------------------|
| fastapi | 0.118.3 | API 프레임워크 | 유지 (최신 업데이트 필요) |
| uvicorn | standard | ASGI 서버 | 유지 |
| torch | ~2.7.0 | PyTorch | 유지 (GPU 인스턴스 필수) |
| diffusers | 0.36.0 | 디퓨전 모델 | 유지 |
| transformers | >= 4.56.0 | 트랜스포머 모델 | 유지 |
| pydantic | latest | 데이터 검증 | 유지 |
| python-socketio | latest | WebSocket | 유지 (Redis adapter 추가) |
| sqlite3 | 내장 | 데이터베이스 | PostgreSQL로 교체 |
| pillow | latest | 이미지 처리 | 유지 |
| safetensors | latest | 모델 포맷 | 유지 |
| accelerate | latest | GPU 가속 | 유지 |

### 10.2 프론트엔드 핵심 의존성

| 패키지 | 버전 | 용도 | SaaS 시 변경 여부 |
|--------|------|------|-------------------|
| react | 18.3.1 | UI | 유지 |
| @reduxjs/toolkit | 2.8.2 | 상태 관리 | 유지 |
| @xyflow/react | 12.8.2 | 노드 에디터 | 유지 |
| konva | 9.3.22 | 캔버스 | 유지 |
| socket.io-client | 4.8.1 | 실시간 통신 | 유지 |
| i18next | 25.3.2 | 다국어 | 유지 |
| zod | 4.0.10 | 스키마 검증 | 유지 |
| chakra-react-select | 4.9.2 | UI 선택 | 유지 |
| dockview | 4.7.1 | 도킹 레이아웃 | 유지 |

## 11. 테스트 현황

```
tests/
├── backend/                # 백엔드 테스트
│   ├── flux/              # FLUX 모델 테스트
│   ├── ip_adapter/        # IP-Adapter 테스트
│   ├── model_manager/     # 모델 매니저 테스트
│   ├── patches/           # 패치 테스트
│   ├── quantization/      # 양자화 테스트
│   ├── stable_diffusion/  # SD 테스트
│   └── tiles/             # 타일 테스트
├── app/                    # 앱 서비스 테스트
│   ├── routers/           # API 라우터 테스트
│   ├── services/          # 서비스 계층 테스트
│   └── util/              # 유틸리티 테스트
├── nodes/                  # 노드 테스트
├── test_config.py          # 설정 테스트
└── conftest.py             # 공통 테스트 픽스처
```

- **커버리지 목표**: 85% (`fail_under = 85`)
- **테스트 도구**: pytest, pytest-cov, pytest-timeout
- **프론트엔드**: vitest + @vitest/coverage-v8
