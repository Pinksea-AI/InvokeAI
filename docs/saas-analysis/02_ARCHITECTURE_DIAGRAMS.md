# InvokeAI v6.11.1.post1 - 아키텍처 다이어그램 모음

## 목차
1. [현재 시스템 전체 아키텍처](#1-현재-시스템-전체-아키텍처)
2. [SaaS 전환 후 목표 아키텍처 (AWS)](#2-saas-전환-후-목표-아키텍처-aws)
3. [백엔드 서비스 계층 구조](#3-백엔드-서비스-계층-구조)
4. [프론트엔드 컴포넌트 아키텍처](#4-프론트엔드-컴포넌트-아키텍처)
5. [이미지 생성 데이터 흐름](#5-이미지-생성-데이터-흐름)
6. [비동기 처리 시퀀스 다이어그램](#6-비동기-처리-시퀀스-다이어그램)
7. [사용자 시퀀스 다이어그램](#7-사용자-시퀀스-다이어그램)
8. [모델 로딩 시퀀스](#8-모델-로딩-시퀀스)
9. [노드 그래프 실행 흐름](#9-노드-그래프-실행-흐름)
10. [구독 플랜 사용자 플로우](#10-구독-플랜-사용자-플로우)
11. [서비스 IA 및 사이트맵](#11-서비스-ia-및-사이트맵)

---

## 1. 현재 시스템 전체 아키텍처

```mermaid
graph TB
    subgraph "Client Browser"
        UI["React Frontend<br/>(Vite + TypeScript)"]
        WS["Socket.IO Client"]
    end

    subgraph "InvokeAI Server (Local Machine)"
        subgraph "FastAPI Application"
            API["FastAPI Router Layer<br/>/api/v1/*"]
            CORS["CORS Middleware"]
            GZIP["GZip Middleware"]
            EVT["Event Middleware<br/>(fastapi-events)"]
            SIO["Socket.IO Server"]
        end

        subgraph "Service Layer"
            INV["Invoker<br/>(Orchestrator)"]
            SQ["Session Queue<br/>(SQLite-backed)"]
            SP["Session Processor<br/>(Background Thread)"]
            SR["Session Runner"]
            IMG["Image Service"]
            MM["Model Manager"]
            ML["Model Loader"]
            MC["Model Cache<br/>(RAM + VRAM)"]
            DL["Download Queue"]
            IC["Invocation Cache"]
            EVS["Event Service"]
        end

        subgraph "Data Layer"
            DB["SQLite Database<br/>(invokeai.db)"]
            FS["Local File System<br/>(outputs/images/)"]
            MS["Model Storage<br/>(models/)"]
        end

        subgraph "AI Engine"
            GE["Graph Execution Engine"]
            NODES["Invocation Nodes<br/>(90+ types)"]
            PT["PyTorch Runtime"]
            GPU["GPU (CUDA/MPS)"]
        end
    end

    UI -->|"HTTP REST"| API
    UI -->|"WebSocket"| WS
    WS <-->|"Socket.IO"| SIO
    API --> INV
    INV --> SQ
    SQ --> SP
    SP --> SR
    SR --> GE
    GE --> NODES
    NODES --> PT
    PT --> GPU
    NODES -->|"save"| IMG
    IMG --> FS
    IMG --> DB
    INV --> MM
    MM --> ML
    ML --> MC
    MC -->|"load"| MS
    INV --> EVS
    EVS --> SIO
    SQ --> DB
    DL -->|"download"| MS

    style GPU fill:#ff6b6b,color:#fff
    style DB fill:#4ecdc4,color:#fff
    style UI fill:#45b7d1,color:#fff
    style API fill:#96ceb4,color:#fff
```

---

## 2. SaaS 전환 후 목표 아키텍처 (AWS)

```mermaid
graph TB
    subgraph "Users"
        U1["User Browser"]
        U2["User Browser"]
        U3["User Browser"]
    end

    subgraph "AWS Cloud"
        subgraph "Edge Layer"
            CF["CloudFront CDN"]
            WAF["AWS WAF"]
            R53["Route 53 DNS"]
        end

        subgraph "Frontend Hosting"
            S3F["S3 Static Hosting<br/>(React Build)"]
        end

        subgraph "API Layer (ECS Fargate)"
            ALB["Application Load Balancer"]
            subgraph "API Containers"
                API1["InvokeAI API<br/>Container #1"]
                API2["InvokeAI API<br/>Container #2"]
            end
        end

        subgraph "Auth & API Gateway"
            COG["Amazon Cognito<br/>(User Auth)"]
            APIGW["API Gateway<br/>(Rate Limiting)"]
        end

        subgraph "GPU Worker Layer (ECS/EKS)"
            subgraph "GPU Pool - Basic"
                GW1["GPU Worker<br/>T4 (16GB)"]
            end
            subgraph "GPU Pool - Pro"
                GW2["GPU Worker<br/>A10G (24GB)"]
            end
            subgraph "GPU Pool - Enterprise"
                GW3["GPU Worker<br/>A100 (40GB)"]
            end
        end

        subgraph "Queue & Cache"
            SQS["Amazon SQS<br/>(Job Queue)"]
            REDIS["ElastiCache Redis<br/>(Session + Cache)"]
        end

        subgraph "Data Layer"
            RDS["Amazon RDS PostgreSQL<br/>(Multi-AZ)"]
            S3["Amazon S3<br/>(Images + Models)"]
            EFS["Amazon EFS<br/>(Shared Model Storage)"]
        end

        subgraph "Billing & Monitoring"
            STRIPE["Stripe<br/>(Payment)"]
            CW["CloudWatch<br/>(Monitoring)"]
            XRAY["X-Ray<br/>(Tracing)"]
        end
    end

    U1 --> R53
    U2 --> R53
    U3 --> R53
    R53 --> CF
    CF --> WAF
    WAF --> S3F
    WAF --> ALB
    ALB --> API1
    ALB --> API2
    API1 --> COG
    API2 --> COG
    API1 --> RDS
    API2 --> RDS
    API1 --> SQS
    API2 --> SQS
    API1 --> REDIS
    API2 --> REDIS
    SQS --> GW1
    SQS --> GW2
    SQS --> GW3
    GW1 --> S3
    GW2 --> S3
    GW3 --> S3
    GW1 --> EFS
    GW2 --> EFS
    GW3 --> EFS
    API1 --> STRIPE
    API1 --> CW
    GW1 --> CW

    style GW1 fill:#ff6b6b,color:#fff
    style GW2 fill:#ff4757,color:#fff
    style GW3 fill:#ff3838,color:#fff
    style RDS fill:#4ecdc4,color:#fff
    style S3 fill:#ffa502,color:#fff
    style COG fill:#7bed9f,color:#fff
    style STRIPE fill:#a29bfe,color:#fff
```

---

## 3. 백엔드 서비스 계층 구조

```mermaid
graph LR
    subgraph "API Routers"
        R1["images_router"]
        R2["boards_router"]
        R3["session_queue_router"]
        R4["model_manager_router"]
        R5["workflows_router"]
        R6["style_presets_router"]
        R7["app_info_router"]
        R8["download_queue_router"]
        R9["client_state_router"]
        R10["utilities_router"]
    end

    subgraph "ApiDependencies"
        INV["Invoker"]
    end

    subgraph "InvocationServices"
        direction TB
        IS_IMG["ImageService"]
        IS_IMGR["ImageRecordStorage"]
        IS_IMGF["ImageFileStorage"]
        IS_BD["BoardService"]
        IS_BDR["BoardRecordStorage"]
        IS_BIR["BoardImageRecordStorage"]
        IS_SQ["SessionQueue"]
        IS_SP["SessionProcessor"]
        IS_MM["ModelManager"]
        IS_DQ["DownloadQueue"]
        IS_EVT["EventService"]
        IS_WF["WorkflowRecords"]
        IS_SP2["StylePresetRecords"]
        IS_IC["InvocationCache"]
        IS_TEN["TensorSerializer"]
        IS_CND["ConditioningSerializer"]
        IS_BLK["BulkDownload"]
        IS_URL["UrlService"]
        IS_NM["NameService"]
        IS_STAT["InvocationStats"]
        IS_CFG["Configuration"]
        IS_LOG["Logger"]
        IS_MR["ModelRelationships"]
        IS_MI["ModelImages"]
        IS_CSP["ClientStatePersistence"]
        IS_WT["WorkflowThumbnails"]
    end

    R1 --> INV
    R2 --> INV
    R3 --> INV
    R4 --> INV
    R5 --> INV
    R6 --> INV
    R7 --> INV
    R8 --> INV
    R9 --> INV
    R10 --> INV

    INV --> IS_IMG
    INV --> IS_BD
    INV --> IS_SQ
    INV --> IS_SP
    INV --> IS_MM
    INV --> IS_DQ
    INV --> IS_EVT
    INV --> IS_WF
    INV --> IS_SP2
    INV --> IS_IC
```

---

## 4. 프론트엔드 컴포넌트 아키텍처

```mermaid
graph TB
    subgraph "App Shell"
        APP["App.tsx"]
        THEME["ThemeProvider<br/>(Chakra UI)"]
        STORE["Redux Store"]
        I18N["i18next Provider"]
        SIO_P["Socket.IO Provider"]
    end

    subgraph "Layout"
        DOCK["Dockview Layout"]
        TAB["Tab Navigation"]
        SIDE["Side Panels"]
    end

    subgraph "Main Features"
        subgraph "Generation Panel"
            PROMPT["Prompt Editor"]
            PARAMS["Parameters Panel<br/>(Steps, CFG, Size)"]
            LORA["LoRA Selector"]
            CTRL["ControlNet Panel"]
            IPA["IP-Adapter Panel"]
            STYLE["Style Presets"]
        end

        subgraph "Canvas System"
            CL["Control Layers Manager"]
            KONVA["Konva Canvas<br/>(Drawing + Composition)"]
            TOOLS["Tool Bar<br/>(Brush, Eraser, Move)"]
        end

        subgraph "Node Editor"
            NE["Node Editor<br/>(@xyflow/react)"]
            NP["Node Palette"]
            NI["Node Inspector"]
        end

        subgraph "Gallery"
            GAL["Image Gallery<br/>(Virtuoso)"]
            BOARD["Board Manager"]
            VIEWER["Image Viewer"]
        end

        subgraph "Model Manager"
            MLIST["Model List"]
            MINST["Model Installer"]
            MCONF["Model Config"]
        end

        subgraph "Queue Manager"
            QLIST["Queue List"]
            QSTAT["Queue Status"]
        end
    end

    subgraph "Data Layer"
        RTK["RTK Query<br/>(API Cache)"]
        REDUX["Redux Slices"]
        SOCKET["Socket.IO Events"]
    end

    APP --> THEME
    APP --> STORE
    APP --> I18N
    APP --> SIO_P
    APP --> DOCK

    DOCK --> TAB
    DOCK --> SIDE

    TAB --> PROMPT
    TAB --> PARAMS
    TAB --> CL
    TAB --> NE
    TAB --> MLIST

    SIDE --> GAL
    SIDE --> QLIST

    PROMPT --> RTK
    GAL --> RTK
    NE --> RTK
    MLIST --> RTK
    QLIST --> RTK
    RTK --> REDUX
    SOCKET --> REDUX
```

---

## 5. 이미지 생성 데이터 흐름

```mermaid
flowchart TB
    subgraph "User Input"
        P["Positive Prompt"]
        NP["Negative Prompt"]
        SET["Settings<br/>(Steps, CFG, Size, Seed)"]
        IMG_IN["Input Image<br/>(optional)"]
        CTRL_IN["ControlNet Image<br/>(optional)"]
    end

    subgraph "Graph Construction"
        GB["Graph Builder"]
        GS["Graph Validation"]
    end

    subgraph "Queue System"
        BATCH["Batch Creator"]
        QUEUE["Session Queue"]
        PROC["Session Processor<br/>(Background Thread)"]
    end

    subgraph "Graph Execution"
        GE["Graph Execution State"]

        subgraph "Node Pipeline"
            N1["CLIP Text Encoder<br/>(Positive)"]
            N2["CLIP Text Encoder<br/>(Negative)"]
            N3["Noise Generator"]
            N4["Model Loader"]
            N5["VAE Loader"]
            N6["Denoise Latents<br/>(Core Diffusion)"]
            N7["Latents to Image<br/>(VAE Decode)"]
            N8["Image Save"]
        end
    end

    subgraph "Model Cache System"
        CACHE["Model Cache<br/>(RAM)"]
        VRAM["VRAM Cache"]
        DISK["Model Files<br/>(Disk/EFS)"]
    end

    subgraph "Output"
        OUT_IMG["Generated Image"]
        OUT_META["Image Metadata"]
        OUT_DB["Database Record"]
        OUT_EVT["WebSocket Event"]
    end

    P --> GB
    NP --> GB
    SET --> GB
    IMG_IN --> GB
    CTRL_IN --> GB
    GB --> GS
    GS --> BATCH
    BATCH --> QUEUE
    QUEUE --> PROC
    PROC --> GE

    GE --> N1
    GE --> N2
    GE --> N3
    GE --> N4
    GE --> N5

    N4 --> CACHE
    CACHE --> VRAM
    VRAM --> DISK
    N5 --> CACHE

    N1 --> N6
    N2 --> N6
    N3 --> N6
    N4 --> N6
    N6 --> N7
    N5 --> N7
    N7 --> N8

    N8 --> OUT_IMG
    N8 --> OUT_META
    N8 --> OUT_DB
    N8 --> OUT_EVT

    style N6 fill:#ff6b6b,color:#fff
    style VRAM fill:#ffa502,color:#fff
    style OUT_IMG fill:#7bed9f,color:#000
```

---

## 6. 비동기 처리 시퀀스 다이어그램

### 6.1 이미지 생성 전체 시퀀스

```mermaid
sequenceDiagram
    actor User
    participant UI as React Frontend
    participant API as FastAPI Server
    participant Queue as Session Queue (SQLite)
    participant Proc as Session Processor (Thread)
    participant Runner as Session Runner
    participant Graph as Graph Execution
    participant Cache as Model Cache
    participant GPU as GPU (PyTorch)
    participant FS as File System
    participant DB as SQLite DB
    participant WS as Socket.IO

    User->>UI: Click "Generate"
    UI->>UI: Build graph from parameters
    UI->>API: POST /api/v1/queue/{id}/enqueue_batch
    API->>Queue: enqueue_batch(batch)
    Queue->>DB: INSERT session_queue items
    API-->>UI: 201 EnqueueBatchResult
    API->>WS: BatchEnqueuedEvent

    loop Process Queue Items
        Proc->>Queue: get_next(queue_id)
        Queue->>DB: SELECT next pending item
        Queue-->>Proc: SessionQueueItem
        Proc->>Queue: set status = in_progress
        Proc->>WS: QueueItemStatusChanged

        Proc->>Runner: run(queue_item)
        Runner->>Graph: create GraphExecutionState

        loop For Each Node in Graph
            Graph->>Graph: get_next_node()
            Graph->>Cache: load required models
            Cache->>GPU: transfer to VRAM

            Note over Graph,GPU: Node Execution (e.g., Denoise)
            Graph->>GPU: invoke() - run inference
            GPU-->>Graph: output tensors/images

            Graph->>WS: InvocationCompleteEvent
            WS-->>UI: progress update
        end

        Runner->>FS: save final image
        Runner->>DB: INSERT image record
        Runner->>Queue: set status = completed
        Runner->>WS: QueueItemStatusChanged + InvocationCompleteEvent
        WS-->>UI: show new image in gallery
    end

    UI->>API: GET /api/v1/images/i/{name}/full
    API->>FS: read image file
    API-->>UI: image binary
```

### 6.2 모델 다운로드 및 설치 시퀀스

```mermaid
sequenceDiagram
    actor User
    participant UI as React Frontend
    participant API as FastAPI Server
    participant MI as Model Install Service
    participant DQ as Download Queue
    participant Probe as Model Probe
    participant DB as SQLite DB
    participant FS as File System
    participant WS as Socket.IO
    participant HF as HuggingFace Hub

    User->>UI: Enter model URL/repo
    UI->>API: POST /api/v2/models/install
    API->>MI: install_model(source)
    MI->>MI: create ModelInstallJob
    MI->>WS: ModelInstallStartedEvent
    MI-->>API: ModelInstallJob
    API-->>UI: 201 Created

    MI->>DQ: enqueue download(url)
    DQ->>HF: HTTP GET model files
    loop Download Progress
        HF-->>DQ: chunks
        DQ->>WS: ModelInstallDownloadProgressEvent
        WS-->>UI: update progress bar
    end
    DQ->>WS: ModelInstallDownloadsCompleteEvent

    MI->>Probe: probe model format
    Probe->>Probe: detect type, base, format
    Probe-->>MI: ModelProbeInfo

    MI->>MI: compute hash (blake3)
    MI->>DB: INSERT model record
    MI->>FS: move to models directory

    MI->>WS: ModelInstallCompleteEvent
    WS-->>UI: show model in list
```

---

## 7. 사용자 시퀀스 다이어그램

### 7.1 텍스트-투-이미지 워크플로우

```mermaid
sequenceDiagram
    actor User
    participant PromptPanel as Prompt Panel
    participant ParamPanel as Parameters Panel
    participant GenBtn as Generate Button
    participant QueueUI as Queue Panel
    participant Gallery as Image Gallery
    participant API as Backend API
    participant WS as WebSocket

    User->>PromptPanel: Type prompt
    User->>ParamPanel: Set steps, CFG, size, seed
    User->>ParamPanel: Select model (SD/FLUX/SD3)
    User->>GenBtn: Click Generate

    GenBtn->>API: POST enqueue_batch
    API-->>QueueUI: batch enqueued
    QueueUI->>QueueUI: Show pending item

    loop Generation Progress
        WS-->>QueueUI: InvocationProgress (%)
        QueueUI->>QueueUI: Update progress bar
    end

    WS-->>Gallery: InvocationComplete
    Gallery->>Gallery: Display new image
    User->>Gallery: Click on image
    Gallery->>Gallery: Show full resolution
    User->>Gallery: Star / Add to Board
```

### 7.2 이미지-투-이미지 (인페인팅) 워크플로우

```mermaid
sequenceDiagram
    actor User
    participant Canvas as Canvas System
    participant Layers as Control Layers
    participant Tools as Tool Bar
    participant API as Backend API
    participant WS as WebSocket
    participant Gallery as Gallery

    User->>Gallery: Select source image
    User->>Canvas: Open in Canvas
    Canvas->>Canvas: Load image as base layer

    User->>Layers: Add Inpaint Mask layer
    User->>Tools: Select Brush tool
    User->>Canvas: Paint mask area

    User->>Tools: Set denoise strength
    User->>Canvas: Type inpaint prompt
    User->>Canvas: Click Generate

    Canvas->>API: POST enqueue_batch (with mask + image)

    loop Generation
        WS-->>Canvas: Progress updates
    end

    WS-->>Gallery: New inpainted image
    User->>Gallery: Compare original vs result
```

### 7.3 워크플로우 에디터 사용 시퀀스

```mermaid
sequenceDiagram
    actor User
    participant NE as Node Editor
    participant Palette as Node Palette
    participant Inspector as Node Inspector
    participant API as Backend API
    participant WS as WebSocket
    participant Gallery as Gallery

    User->>NE: Open Node Editor tab
    User->>Palette: Search for node type
    User->>NE: Drag & drop node to canvas
    User->>NE: Connect node outputs to inputs

    User->>Inspector: Configure node parameters
    User->>NE: Add more nodes to build pipeline

    User->>NE: Click Save Workflow
    NE->>API: POST /api/v1/workflows

    User->>NE: Click Run
    NE->>API: POST enqueue_batch (graph)

    loop Execution
        WS-->>NE: Node execution progress
        NE->>NE: Highlight active node
    end

    WS-->>Gallery: Final output image
```

---

## 8. 모델 로딩 시퀀스

```mermaid
sequenceDiagram
    participant Node as Invocation Node
    participant Context as InvocationContext
    participant MM as Model Manager
    participant Loader as Model Loader
    participant Cache as Model Cache
    participant RAM as System RAM
    participant VRAM as GPU VRAM
    participant Disk as Model Files

    Node->>Context: context.models.load(model_key)
    Context->>MM: load_model(model_key)
    MM->>Cache: get_cached(model_key)

    alt Model in VRAM Cache
        Cache-->>MM: CachedModel (VRAM)
        MM-->>Node: LoadedModel context manager
    else Model in RAM Cache
        Cache->>VRAM: transfer RAM to VRAM
        Note over Cache,VRAM: Partial loading if VRAM insufficient
        Cache-->>MM: CachedModel
        MM-->>Node: LoadedModel context manager
    else Model not cached
        Cache->>Loader: load_from_disk(model_key)
        Loader->>Disk: read safetensors/ckpt
        Disk-->>RAM: load to RAM
        RAM-->>Cache: store in cache

        alt VRAM sufficient
            Cache->>VRAM: full transfer
        else VRAM insufficient + partial loading enabled
            Cache->>VRAM: partial transfer (streaming)
        else VRAM insufficient + partial loading disabled
            Cache->>Cache: evict LRU models
            Cache->>VRAM: transfer after eviction
        end

        Cache-->>MM: CachedModel
        MM-->>Node: LoadedModel context manager
    end

    Node->>Node: use model for inference
    Node->>MM: release model (exit context)
```

---

## 9. 노드 그래프 실행 흐름

```mermaid
flowchart TB
    START["Graph Execution Start"] --> INIT["Initialize GraphExecutionState"]
    INIT --> NEXT["Get Next Ready Node"]

    NEXT --> CHECK{Node available?}
    CHECK -->|Yes| CACHE_CHECK{"Check Invocation Cache"}
    CHECK -->|No - All Done| COMPLETE["Graph Complete"]

    CACHE_CHECK -->|Cache Hit| CACHED["Return Cached Output"]
    CACHE_CHECK -->|Cache Miss| PREP["Prepare InvocationContext"]

    CACHED --> STORE["Store Node Output"]
    PREP --> INVOKE["node.invoke(context)"]
    INVOKE --> OUTPUT["BaseInvocationOutput"]
    OUTPUT --> CACHE_STORE["Store in Invocation Cache"]
    CACHE_STORE --> STORE

    STORE --> EMIT["Emit InvocationCompleteEvent"]
    EMIT --> PROPAGATE["Propagate Output to Connected Nodes"]
    PROPAGATE --> NEXT

    INVOKE -->|Error| ERROR["Emit InvocationErrorEvent"]
    ERROR --> FAIL["Mark Session as Failed"]

    COMPLETE --> FINAL["Emit Session Complete"]

    style INVOKE fill:#ff6b6b,color:#fff
    style COMPLETE fill:#7bed9f,color:#000
    style ERROR fill:#ff4757,color:#fff
```

---

## 10. 구독 플랜 사용자 플로우 (SaaS 목표)

```mermaid
flowchart TB
    START["사용자 방문"] --> LANDING["랜딩 페이지"]
    LANDING --> PLAN["구독 플랜 선택"]

    PLAN --> FREE["Free Plan<br/>기능 제한 체험"]
    PLAN --> BASIC["Basic Plan<br/>$9.99/월"]
    PLAN --> PRO["Pro Plan<br/>$29.99/월"]
    PLAN --> ENT["Enterprise Plan<br/>$99.99/월"]
    PLAN --> TEST["Test Plan<br/>관리자 부여"]

    FREE --> SIGNUP["회원가입<br/>(Cognito)"]
    BASIC --> SIGNUP
    PRO --> SIGNUP
    ENT --> SIGNUP
    TEST --> ADMIN_GRANT["관리자가<br/>크레딧 부여"]

    SIGNUP --> PAY{유료 플랜?}
    PAY -->|Yes| STRIPE["Stripe 결제"]
    PAY -->|No| DASHBOARD

    STRIPE --> CREDIT["크레딧 부여"]
    ADMIN_GRANT --> CREDIT
    CREDIT --> DASHBOARD["대시보드"]

    DASHBOARD --> GENERATE["이미지 생성"]
    GENERATE --> CHECK_CREDIT{"크레딧 충분?"}
    CHECK_CREDIT -->|Yes| GPU_ASSIGN["GPU 할당<br/>(플랜별 등급)"]
    CHECK_CREDIT -->|No| UPGRADE["업그레이드 안내"]

    GPU_ASSIGN --> PROCESS["이미지 생성 처리"]
    PROCESS --> DEDUCT["크레딧 차감"]
    DEDUCT --> RESULT["결과 이미지"]
    RESULT --> GENERATE

    UPGRADE --> PLAN

    style BASIC fill:#4ecdc4,color:#fff
    style PRO fill:#45b7d1,color:#fff
    style ENT fill:#a29bfe,color:#fff
    style FREE fill:#dfe6e9,color:#000
    style TEST fill:#ffeaa7,color:#000
```

---

## 11. 서비스 IA 및 사이트맵

### 11.1 현재 InvokeAI 서비스 IA

```mermaid
graph TB
    ROOT["InvokeAI Web App<br/>(Single Page)"]

    ROOT --> GENERATION["Generation"]
    ROOT --> CANVAS["Canvas"]
    ROOT --> WORKFLOWS["Workflows"]
    ROOT --> MODELS["Model Manager"]
    ROOT --> GALLERY["Gallery"]
    ROOT --> QUEUE["Queue"]
    ROOT --> SETTINGS["Settings"]

    GENERATION --> GEN_PROMPT["Prompt Input"]
    GENERATION --> GEN_PARAMS["Parameters<br/>(Steps, CFG, Size, Seed)"]
    GENERATION --> GEN_MODEL["Model Selection"]
    GENERATION --> GEN_LORA["LoRA Selection"]
    GENERATION --> GEN_CTRL["ControlNet"]
    GENERATION --> GEN_IPA["IP-Adapter"]
    GENERATION --> GEN_T2I["T2I-Adapter"]
    GENERATION --> GEN_STYLE["Style Presets"]

    CANVAS --> CAN_LAYERS["Layer Management"]
    CANVAS --> CAN_TOOLS["Drawing Tools"]
    CANVAS --> CAN_MASK["Mask Editing"]
    CANVAS --> CAN_COMP["Composition"]

    WORKFLOWS --> WF_EDITOR["Node Editor"]
    WORKFLOWS --> WF_LIB["Workflow Library"]
    WORKFLOWS --> WF_SAVE["Save/Load"]

    MODELS --> MOD_LIST["Model List"]
    MODELS --> MOD_INSTALL["Install Models"]
    MODELS --> MOD_HF["HuggingFace Import"]
    MODELS --> MOD_SCAN["Scan Local"]
    MODELS --> MOD_CONFIG["Model Settings"]

    GALLERY --> GAL_GRID["Image Grid"]
    GALLERY --> GAL_BOARDS["Boards (Albums)"]
    GALLERY --> GAL_VIEW["Image Viewer"]
    GALLERY --> GAL_META["Metadata"]
    GALLERY --> GAL_SEARCH["Search"]
    GALLERY --> GAL_DOWNLOAD["Bulk Download"]

    QUEUE --> Q_LIST["Queue Items"]
    QUEUE --> Q_STATUS["Status"]
    QUEUE --> Q_CANCEL["Cancel/Clear"]

    SETTINGS --> SET_GENERAL["General"]
    SETTINGS --> SET_CACHE["Model Cache"]
    SETTINGS --> SET_DEVICE["Device"]
```

### 11.2 SaaS 전환 후 확장 사이트맵

```mermaid
graph TB
    ROOT["SaaS Platform"]

    ROOT --> PUBLIC["Public Pages"]
    ROOT --> AUTH["Authentication"]
    ROOT --> APP["App (Authenticated)"]
    ROOT --> ADMIN["Admin Panel"]

    PUBLIC --> LAND["Landing Page"]
    PUBLIC --> PRICING["Pricing / Plans"]
    PUBLIC --> DOCS_PUB["Documentation"]
    PUBLIC --> DEMO["Live Demo"]

    AUTH --> LOGIN["Login"]
    AUTH --> SIGNUP["Sign Up"]
    AUTH --> RESET["Password Reset"]
    AUTH --> OAUTH["Social Login<br/>(Google, GitHub)"]

    APP --> DASH["Dashboard"]
    APP --> STUDIO["AI Studio<br/>(Generation)"]
    APP --> GALLERY_S["My Gallery"]
    APP --> WORKFLOW_S["My Workflows"]
    APP --> MODELS_S["Model Hub"]
    APP --> ACCOUNT["Account"]

    DASH --> DASH_USAGE["Usage Stats"]
    DASH --> DASH_CREDIT["Credit Balance"]
    DASH --> DASH_RECENT["Recent Generations"]

    STUDIO --> STU_GEN["Generation Panel"]
    STUDIO --> STU_CANVAS["Canvas Editor"]
    STUDIO --> STU_NODE["Node Editor"]
    STUDIO --> STU_BATCH["Batch Processing"]

    ACCOUNT --> ACC_PROFILE["Profile"]
    ACCOUNT --> ACC_SUB["Subscription"]
    ACCOUNT --> ACC_BILLING["Billing History"]
    ACCOUNT --> ACC_API["API Keys"]
    ACCOUNT --> ACC_SETTINGS["Preferences"]

    ADMIN --> ADM_USERS["User Management"]
    ADMIN --> ADM_PLANS["Plan Management"]
    ADMIN --> ADM_TEST["Test Plan Grant"]
    ADMIN --> ADM_MONITOR["System Monitor"]
    ADMIN --> ADM_MODELS["Model Management"]
    ADMIN --> ADM_BILLING["Revenue Dashboard"]
    ADMIN --> ADM_GPU["GPU Pool Monitor"]

    style ADMIN fill:#ff6b6b,color:#fff
    style AUTH fill:#7bed9f,color:#000
    style APP fill:#45b7d1,color:#fff
    style PUBLIC fill:#dfe6e9,color:#000
```
