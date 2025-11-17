# InvokeAI 프론트엔드 상세 분석

> React, TypeScript, Redux를 사용한 모던 프론트엔드 아키텍처 완전 가이드

## 목차

1. [프론트엔드 아키텍처 개요](#1-프론트엔드-아키텍처-개요)
2. [Redux Store 구조](#2-redux-store-구조)
3. [주요 Feature 모듈 상세](#3-주요-feature-모듈-상세)
4. [API 통신 레이어](#4-api-통신-레이어)
5. [Socket.IO 실시간 통신](#5-socketio-실시간-통신)
6. [상태 관리 패턴](#6-상태-관리-패턴)
7. [컴포넌트 설계 패턴](#7-컴포넌트-설계-패턴)
8. [성능 최적화 기법](#8-성능-최적화-기법)

---

## 1. 프론트엔드 아키텍처 개요

### 1.1 기술 스택 요약

```typescript
// 코어 프레임워크
React 18.3.1              // UI 라이브러리
TypeScript 5.8.3          // 정적 타입 체크
Vite 7.0.5                // 빌드 도구

// 상태 관리
Redux Toolkit 2.8.2       // 상태 관리
React Redux 9.2.0         // React 바인딩
redux-remember            // 상태 영속화 (IndexedDB)
redux-undo                // 실행 취소/다시 실행

// UI 라이브러리
@invoke-ai/ui-library     // 커스텀 컴포넌트
framer-motion 11.10.0     // 애니메이션
dockview 4.7.1            // 도킹 레이아웃

// 캔버스
konva 9.3.22              // 2D 캔버스 렌더링

// 워크플로우
@xyflow/react 12.8.2      // 노드 그래프 에디터

// 네트워킹
socket.io-client 4.8.1    // 실시간 통신
```

### 1.2 디렉토리 구조

```
src/
├── app/                          # 앱 설정 및 초기화
│   ├── store/                    # Redux store 설정
│   │   ├── store.ts              # Store 생성 및 설정
│   │   ├── middleware/           # 커스텀 미들웨어
│   │   │   ├── listenerMiddleware/  # RTK Listener 미들웨어
│   │   │   └── devtools/         # DevTools 설정
│   │   └── enhancers/            # Store enhancer
│   │       └── reduxRemember/    # 상태 영속화
│   ├── components/               # 최상위 컴포넌트
│   └── App.tsx                   # 루트 컴포넌트
│
├── common/                       # 공통 코드
│   ├── components/               # 재사용 가능한 컴포넌트
│   ├── hooks/                    # 커스텀 React hooks
│   └── util/                     # 유틸리티 함수
│
├── features/                     # Feature 모듈 (기능별 분리)
│   ├── controlLayers/            # 캔버스 및 컨트롤 레이어
│   │   ├── components/           # 컴포넌트
│   │   ├── store/                # Redux slice
│   │   ├── hooks/                # Feature 훅
│   │   ├── konva/                # Konva 렌더링 로직
│   │   └── util/                 # 유틸리티
│   │
│   ├── nodes/                    # 노드 에디터
│   │   ├── components/
│   │   ├── store/
│   │   ├── hooks/
│   │   └── util/
│   │
│   ├── gallery/                  # 갤러리
│   ├── queue/                    # 큐 관리
│   ├── parameters/               # 생성 파라미터
│   ├── modelManagerV2/           # 모델 관리
│   ├── stylePresets/             # 스타일 프리셋
│   └── ... (18+ features)
│
├── services/                     # 외부 서비스
│   └── api/                      # API 클라이언트
│       ├── endpoints/            # API 엔드포인트 정의
│       ├── schema.ts             # OpenAPI 타입
│       └── index.ts              # RTK Query API
│
└── theme/                        # 테마 설정
    └── ...
```

### 1.3 Feature-Based Architecture

**Feature-Based 구조란?**

기능별로 코드를 그룹화하는 아키텍처 패턴입니다.

```
❌ 잘못된 구조 (Layer-Based)
src/
├── components/
│   ├── GalleryImage.tsx
│   ├── NodeEditor.tsx
│   └── QueueItem.tsx
├── actions/
│   ├── galleryActions.ts
│   ├── nodeActions.ts
│   └── queueActions.ts
└── reducers/
    ├── galleryReducer.ts
    ├── nodeReducer.ts
    └── queueReducer.ts
```

위 구조의 문제:
- 한 기능을 수정하려면 여러 디렉토리를 오가야 함
- 코드 응집도(Cohesion)가 낮음
- 모듈 간 의존성 파악이 어려움

```
✅ 올바른 구조 (Feature-Based)
src/features/
├── gallery/
│   ├── components/
│   │   └── GalleryImage.tsx
│   ├── store/
│   │   └── gallerySlice.ts
│   └── hooks/
│       └── useGalleryImages.ts
├── nodes/
│   ├── components/
│   │   └── NodeEditor.tsx
│   ├── store/
│   │   └── nodesSlice.ts
│   └── hooks/
│       └── useNodeData.ts
└── queue/
    ├── components/
    │   └── QueueItem.tsx
    ├── store/
    │   └── queueSlice.ts
    └── hooks/
        └── useQueueStatus.ts
```

장점:
- 관련 코드가 한 곳에 모임
- 높은 응집도
- 독립적인 모듈 (다른 프로젝트로 쉽게 이동 가능)
- 팀 협업 시 충돌 최소화

---

## 2. Redux Store 구조

### 2.1 Store 설정

파일: `invokeai/frontend/web/src/app/store/store.ts`

#### Slice 등록 (라인 60-79)

```typescript
// Slice 설정 객체
const SLICE_CONFIGS = {
  // 캔버스 관련
  canvasSession: canvasSessionSliceConfig,
  canvasSettings: canvasSettingsSliceConfig,
  canvas: canvasSliceConfig,  // Undoable

  // 갤러리
  gallery: gallerySliceConfig,

  // 노드 에디터
  nodes: nodesSliceConfig,  // Undoable
  workflowSettings: workflowSettingsSliceConfig,
  workflowLibrary: workflowLibrarySliceConfig,

  // 생성 파라미터
  params: paramsSliceConfig,
  loras: lorasSliceConfig,
  upscale: upscaleSliceConfig,
  stylePresets: stylePresetSliceConfig,

  // 모델 관리
  modelManager: modelManagerSliceConfig,

  // 큐
  queue: queueSliceConfig,

  // 시스템
  system: systemSliceConfig,
  ui: uiSliceConfig,

  // 기타
  changeBoardModal: changeBoardModalSliceConfig,
  dynamicPrompts: dynamicPromptsSliceConfig,
  refImages: refImagesSliceConfig,
};
```

#### Reducer 결합 (라인 83-112)

```typescript
const ALL_REDUCERS = {
  // RTK Query API
  [api.reducerPath]: api.reducer,

  // 일반 Reducer
  canvasSession: canvasSessionSlice.reducer,
  canvasSettings: canvasSettingsSlice.reducer,
  gallery: gallerySlice.reducer,
  params: paramsSlice.reducer,
  queue: queueSlice.reducer,
  system: systemSlice.reducer,
  ui: uiSlice.reducer,

  // Undoable Reducer (실행 취소 가능)
  canvas: undoable(
    canvasSlice.reducer,
    {
      limit: 64,  // 최대 64개 히스토리
      filter: (action) => {
        // 특정 액션만 히스토리에 포함
        return action.type.startsWith('canvas/')
      },
    }
  ),

  nodes: undoable(
    nodesSlice.reducer,
    {
      limit: 64,
      filter: (action) => action.type.startsWith('nodes/'),
    }
  ),
};
```

#### Store 생성

```typescript
export const store = configureStore({
  reducer: combineReducers(ALL_REDUCERS),

  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      // 직렬화 가능성 체크 비활성화 (Konva 객체 등)
      serializableCheck: {
        ignoredActions: [
          'canvas/setTool',
          'nodes/connectionMade',
        ],
        ignoredPaths: [
          'canvas.layerState.konva',
          'nodes.edges',
        ],
      },
    })
      .concat(api.middleware)  // RTK Query
      .concat(listenerMiddleware.middleware),  // Listener

  enhancers: (getDefaultEnhancers) =>
    getDefaultEnhancers()
      // Redux Remember (상태 영속화)
      .concat(
        rememberEnhancer(
          reduxRememberDriver,
          SLICE_CONFIGS,
          {
            serialize: customSerialize,
            unserialize: customUnserialize,
          }
        )
      ),

  devTools: {
    // Redux DevTools 설정
    actionSanitizer,        // 액션 sanitize
    stateSanitizer,         // 상태 sanitize
    actionsDenylist,        // 특정 액션 필터링
    maxAge: 200,            // 최대 200개 액션 기록
  },
});

// TypeScript 타입 추론
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

### 2.2 상태 영속화 (Redux Remember)

**Redux Remember란?**

브라우저를 새로고침해도 상태를 유지하는 라이브러리입니다.

#### 저장 위치

```
IndexedDB
└── redux-remember
    ├── canvas           # 캔버스 상태
    ├── gallery          # 갤러리 설정
    ├── params           # 생성 파라미터
    └── ... (각 slice)
```

#### 커스텀 직렬화

```typescript
const customSerialize: SerializeFunction = (data, key) => {
  // 특정 필드 제외
  if (key === 'canvas') {
    // Konva 객체는 저장하지 않음
    return omit(data, ['layerState.konva']);
  }

  // 민감한 정보 제외
  if (key === 'system') {
    return omit(data, ['authToken']);
  }

  return data;
};

const customUnserialize: UnserializeFunction = (data, key) => {
  // 버전 마이그레이션
  if (key === 'params' && data.version < 2) {
    // 구버전 데이터를 신버전으로 변환
    return migrateParamsV1toV2(data);
  }

  return data;
};
```

### 2.3 Listener Middleware

**Listener Middleware란?**

특정 액션에 반응하여 부수 효과(Side Effect)를 실행하는 미들웨어입니다.

파일: `invokeai/frontend/web/src/app/store/middleware/listenerMiddleware/`

#### 예시 1: 이미지 업로드 완료 시

```typescript
// listeners/imageUploaded.ts
export const addImageUploadedFulfilledListener = (
  startAppListening: AppStartListening
) => {
  startAppListening({
    // RTK Query의 특정 endpoint 완료 감지
    matcher: imagesApi.endpoints.uploadImage.matchFulfilled,

    effect: async (action, listenerApi) => {
      const { image_name } = action.payload;

      // 1. 갤러리에 이미지 추가
      listenerApi.dispatch(imageAdded(image_name));

      // 2. 썸네일 로드 요청
      listenerApi.dispatch(
        imagesApi.endpoints.getImageMetadata.initiate(image_name)
      );

      // 3. 토스트 알림
      toast({
        title: '이미지 업로드 완료',
        status: 'success',
      });
    },
  });
};
```

#### 예시 2: 모델 선택 시

```typescript
// listeners/modelSelected.ts
export const addModelSelectedListener = (
  startAppListening: AppStartListening
) => {
  startAppListening({
    actionCreator: modelSelected,  // 특정 액션 감지

    effect: async (action, listenerApi) => {
      const modelKey = action.payload;

      // 1. 모델 정보 조회
      const model = await listenerApi.dispatch(
        modelsApi.endpoints.getModelConfig.initiate(modelKey)
      ).unwrap();

      // 2. 모델에 맞는 기본 설정 적용
      if (model.base === 'sdxl') {
        listenerApi.dispatch(setWidth(1024));
        listenerApi.dispatch(setHeight(1024));
      } else if (model.base === 'sd-1') {
        listenerApi.dispatch(setWidth(512));
        listenerApi.dispatch(setHeight(512));
      }

      // 3. 호환되지 않는 LoRA 제거
      const state = listenerApi.getState();
      const currentLoras = state.loras.loras;

      for (const lora of currentLoras) {
        if (lora.base !== model.base) {
          listenerApi.dispatch(loraRemoved(lora.key));
        }
      }
    },
  });
};
```

#### 예시 3: Socket.IO 연결 시

```typescript
// listeners/socketConnected.ts
export const addSocketConnectedEventListener = (
  startAppListening: AppStartListening
) => {
  startAppListening({
    actionCreator: socketConnected,

    effect: async (action, listenerApi) => {
      // 1. 큐 상태 새로고침
      listenerApi.dispatch(
        queueApi.endpoints.getQueueStatus.initiate()
      );

      // 2. 진행 중인 세션 확인
      listenerApi.dispatch(
        queueApi.endpoints.getCurrentQueueItem.initiate()
      );

      // 3. 시스템 정보 업데이트
      listenerApi.dispatch(
        appInfoApi.endpoints.getAppVersion.initiate()
      );
    },
  });
};
```

---

## 3. 주요 Feature 모듈 상세

### 3.1 Gallery (갤러리)

위치: `features/gallery/`

#### State 구조

```typescript
// store/gallerySlice.ts
interface GalleryState {
  // 선택된 이미지
  selectedImageName: string | null;

  // 선택된 보드
  selectedBoardId: string | null;

  // 갤러리 뷰 모드
  galleryView: 'images' | 'assets';

  // 이미지 정렬
  orderBy: 'created_at' | 'updated_at' | 'starred';
  orderDirection: 'ASC' | 'DESC';

  // 검색
  searchTerm: string;

  // 무한 스크롤
  offset: number;
  limit: number;
}
```

#### 주요 액션

```typescript
const gallerySlice = createSlice({
  name: 'gallery',
  initialState,
  reducers: {
    // 이미지 선택
    imageSelected(state, action: PayloadAction<string>) {
      state.selectedImageName = action.payload;
    },

    // 보드 선택
    boardSelected(state, action: PayloadAction<string | null>) {
      state.selectedBoardId = action.payload;
      state.offset = 0;  // 리셋
    },

    // 검색어 설정
    searchTermChanged(state, action: PayloadAction<string>) {
      state.searchTerm = action.payload;
      state.offset = 0;
    },

    // 다음 페이지 로드
    moreImagesLoaded(state) {
      state.offset += state.limit;
    },
  },
});
```

#### API 통합 (RTK Query)

```typescript
// services/api/endpoints/images.ts
const imagesApi = api.injectEndpoints({
  endpoints: (build) => ({
    // 이미지 목록 조회
    listImages: build.query<
      ImageListResponse,
      {
        board_id?: string;
        offset?: number;
        limit?: number;
      }
    >({
      query: (params) => ({
        url: 'images/',
        params,
      }),
      // 캐시 태그
      providesTags: (result) =>
        result
          ? [
              ...result.items.map(({ image_name }) => ({
                type: 'Image' as const,
                id: image_name,
              })),
              { type: 'Image', id: 'LIST' },
            ]
          : [{ type: 'Image', id: 'LIST' }],
    }),

    // 이미지 삭제
    deleteImage: build.mutation<void, string>({
      query: (imageName) => ({
        url: `images/${imageName}`,
        method: 'DELETE',
      }),
      // 캐시 무효화
      invalidatesTags: (result, error, imageName) => [
        { type: 'Image', id: imageName },
        { type: 'Image', id: 'LIST' },
      ],
    }),
  }),
});

export const { useListImagesQuery, useDeleteImageMutation } = imagesApi;
```

#### 컴포넌트 예시

```typescript
// components/ImageGrid/GalleryImageGrid.tsx
const GalleryImageGrid = () => {
  // Redux 상태
  const selectedBoardId = useAppSelector((s) => s.gallery.selectedBoardId);
  const offset = useAppSelector((s) => s.gallery.offset);
  const limit = useAppSelector((s) => s.gallery.limit);

  // API 호출 (자동 캐싱 및 로딩 상태 관리)
  const { data, isLoading, isFetching } = useListImagesQuery({
    board_id: selectedBoardId,
    offset,
    limit,
  });

  // 무한 스크롤
  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;

    // 하단 도달 시 다음 페이지 로드
    if (scrollTop + clientHeight >= scrollHeight - 100) {
      dispatch(moreImagesLoaded());
    }
  }, [dispatch]);

  return (
    <Box onScroll={handleScroll}>
      {isLoading && <Spinner />}

      <Grid templateColumns="repeat(auto-fill, minmax(150px, 1fr))">
        {data?.items.map((image) => (
          <GalleryImageItem key={image.image_name} image={image} />
        ))}
      </Grid>

      {isFetching && <Spinner />}
    </Box>
  );
};
```

### 3.2 Nodes (노드 에디터)

위치: `features/nodes/`

#### State 구조

```typescript
// store/nodesSlice.ts
interface NodesState {
  // React Flow 노드
  nodes: Node[];

  // React Flow 엣지 (연결)
  edges: Edge[];

  // 워크플로우 메타데이터
  workflow: {
    id: string;
    name: string;
    description: string;
    version: string;
    author: string;
  };

  // 선택 상태
  selectedNodes: string[];
  selectedEdges: string[];

  // UI 상태
  shouldShowMinimapPanel: boolean;
  shouldValidateGraph: boolean;
  nodeOpacity: number;

  // 실행 상태
  nodeExecutionStates: {
    [nodeId: string]: {
      status: 'pending' | 'in_progress' | 'completed' | 'error';
      progress: number;
      error?: string;
    };
  };
}
```

#### 주요 액션

```typescript
const nodesSlice = createSlice({
  name: 'nodes',
  initialState,
  reducers: {
    // 노드 추가
    nodeAdded(
      state,
      action: PayloadAction<{
        nodeId: string;
        nodeType: string;
        position: XYPosition;
      }>
    ) {
      const { nodeId, nodeType, position } = action.payload;

      // 노드 생성
      const newNode: Node = {
        id: nodeId,
        type: nodeType,
        position,
        data: getDefaultNodeData(nodeType),
      };

      state.nodes.push(newNode);
    },

    // 연결 생성
    connectionMade(
      state,
      action: PayloadAction<Connection>
    ) {
      const { source, sourceHandle, target, targetHandle } = action.payload;

      // 순환 참조 체크
      if (wouldCreateCycle(state.nodes, state.edges, action.payload)) {
        return;  // 순환 참조 방지
      }

      // 타입 호환성 체크
      const sourceType = getOutputType(state.nodes, source, sourceHandle);
      const targetType = getInputType(state.nodes, target, targetHandle);

      if (!areTypesCompatible(sourceType, targetType)) {
        return;  // 타입 불일치
      }

      // 엣지 생성
      const newEdge: Edge = {
        id: `${source}-${sourceHandle}-${target}-${targetHandle}`,
        source,
        sourceHandle,
        target,
        targetHandle,
      };

      state.edges.push(newEdge);
    },

    // 필드 값 변경
    fieldValueChanged(
      state,
      action: PayloadAction<{
        nodeId: string;
        fieldName: string;
        value: any;
      }>
    ) {
      const { nodeId, fieldName, value } = action.payload;

      const node = state.nodes.find((n) => n.id === nodeId);
      if (node) {
        node.data.inputs[fieldName].value = value;
      }
    },
  },
});
```

#### React Flow 통합

```typescript
// components/Flow/Flow.tsx
const Flow = () => {
  const nodes = useAppSelector((s) => s.nodes.nodes);
  const edges = useAppSelector((s) => s.nodes.edges);
  const dispatch = useAppDispatch();

  // 노드 변경 핸들러
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      dispatch(nodesChanged(changes));
    },
    [dispatch]
  );

  // 연결 핸들러
  const onConnect = useCallback(
    (connection: Connection) => {
      dispatch(connectionMade(connection));
    },
    [dispatch]
  );

  // 커스텀 노드 타입
  const nodeTypes = useMemo(
    () => ({
      invocation: InvocationNode,
      notes: NotesNode,
      current_image: CurrentImageNode,
    }),
    []
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      nodeTypes={nodeTypes}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );
};
```

#### 워크플로우 빌더

```typescript
// util/buildWorkflow.ts
export const buildWorkflow = (state: NodesState): Graph => {
  const graph: Graph = {
    nodes: {},
    edges: [],
  };

  // 노드 변환
  for (const node of state.nodes) {
    graph.nodes[node.id] = {
      id: node.id,
      type: node.type,
      // inputs에서 값만 추출
      ...Object.entries(node.data.inputs).reduce(
        (acc, [key, input]) => {
          acc[key] = input.value;
          return acc;
        },
        {} as Record<string, any>
      ),
    };
  }

  // 엣지 변환
  for (const edge of state.edges) {
    graph.edges.push({
      source: {
        node_id: edge.source,
        field: edge.sourceHandle,
      },
      destination: {
        node_id: edge.target,
        field: edge.targetHandle,
      },
    });
  }

  return graph;
};
```

### 3.3 Control Layers (캔버스)

위치: `features/controlLayers/`

#### State 구조

```typescript
// store/canvasSlice.ts
interface CanvasState {
  // 레이어
  layers: {
    [layerId: string]: Layer;
  };

  // 레이어 순서
  layerOrder: string[];

  // 선택된 레이어
  selectedLayerId: string | null;

  // 도구
  tool: 'brush' | 'eraser' | 'rect' | 'move';

  // 브러시 설정
  brushSize: number;
  brushHardness: number;  // 0-100
  brushOpacity: number;   // 0-100

  // 색상
  brushColor: RgbaColor;

  // 캔버스 크기
  width: number;
  height: number;

  // Konva 상태 (비직렬화)
  konva: {
    stage: Konva.Stage | null;
    layers: Map<string, Konva.Layer>;
  };
}

interface Layer {
  id: string;
  type: 'image' | 'control' | 'mask';
  name: string;
  isVisible: boolean;
  isLocked: boolean;
  opacity: number;  // 0-1
  blendMode: 'normal' | 'multiply' | 'screen' | 'overlay';

  // 이미지 레이어
  imageObject?: {
    imageName: string;
  };

  // 컨트롤 레이어
  controlAdapter?: {
    type: 'canny' | 'depth' | 'openpose';
    weight: number;
    beginStepPercent: number;
    endStepPercent: number;
  };
}
```

#### Konva 렌더링

```typescript
// konva/renderers.ts
export const renderLayer = (
  layer: Layer,
  konvaLayer: Konva.Layer,
  images: Map<string, HTMLImageElement>
) => {
  // 레이어 클리어
  konvaLayer.destroyChildren();

  if (layer.type === 'image' && layer.imageObject) {
    // 이미지 레이어 렌더링
    const image = images.get(layer.imageObject.imageName);
    if (image) {
      const konvaImage = new Konva.Image({
        image,
        opacity: layer.opacity,
        globalCompositeOperation: layer.blendMode,
      });
      konvaLayer.add(konvaImage);
    }
  } else if (layer.type === 'mask') {
    // 마스크 레이어 렌더링
    // ... 브러시 스트로크를 Konva Line으로 렌더링
  }

  konvaLayer.batchDraw();
};
```

#### 브러시 도구

```typescript
// components/Tool/BrushTool.tsx
const BrushTool = () => {
  const dispatch = useAppDispatch();
  const brushSize = useAppSelector((s) => s.canvas.brushSize);
  const brushColor = useAppSelector((s) => s.canvas.brushColor);

  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<number[]>([]);

  const handleMouseDown = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      setIsDrawing(true);

      const pos = e.target.getStage()?.getPointerPosition();
      if (pos) {
        setCurrentStroke([pos.x, pos.y]);
      }
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      if (!isDrawing) return;

      const pos = e.target.getStage()?.getPointerPosition();
      if (pos) {
        setCurrentStroke((prev) => [...prev, pos.x, pos.y]);
      }
    },
    [isDrawing]
  );

  const handleMouseUp = useCallback(() => {
    if (!isDrawing) return;

    // Redux에 스트로크 저장
    dispatch(
      strokeAdded({
        layerId: selectedLayerId,
        points: currentStroke,
        brushSize,
        brushColor,
      })
    );

    setIsDrawing(false);
    setCurrentStroke([]);
  }, [isDrawing, currentStroke, selectedLayerId, brushSize, brushColor]);

  return (
    <Layer
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* 현재 그리는 중인 스트로크 */}
      {isDrawing && (
        <Line
          points={currentStroke}
          stroke={rgbaToString(brushColor)}
          strokeWidth={brushSize}
          lineCap="round"
          lineJoin="round"
        />
      )}
    </Layer>
  );
};
```

---

## 4. API 통신 레이어

### 4.1 RTK Query 설정

파일: `services/api/index.ts`

```typescript
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const api = createApi({
  reducerPath: 'api',

  baseQuery: fetchBaseQuery({
    baseUrl: '/api/v1',
    prepareHeaders: (headers, { getState }) => {
      // 인증 토큰 추가 (필요 시)
      const token = (getState() as RootState).system.authToken;
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return headers;
    },
  }),

  // 캐시 태그 타입 정의
  tagTypes: [
    'Image',
    'Board',
    'Model',
    'Workflow',
    'QueueItem',
    'AppInfo',
  ],

  endpoints: () => ({}),  // 엔드포인트는 각 파일에서 inject
});
```

### 4.2 엔드포인트 정의 패턴

```typescript
// services/api/endpoints/boards.ts
const boardsApi = api.injectEndpoints({
  endpoints: (build) => ({
    // === 조회 (Query) ===
    listBoards: build.query<BoardDTO[], void>({
      query: () => 'boards/',
      providesTags: (result) =>
        result
          ? [
              ...result.map(({ board_id }) => ({
                type: 'Board' as const,
                id: board_id,
              })),
              { type: 'Board', id: 'LIST' },
            ]
          : [{ type: 'Board', id: 'LIST' }],
    }),

    getBoard: build.query<BoardDTO, string>({
      query: (boardId) => `boards/${boardId}`,
      providesTags: (result, error, boardId) => [
        { type: 'Board', id: boardId },
      ],
    }),

    // === 변경 (Mutation) ===
    createBoard: build.mutation<BoardDTO, { board_name: string }>({
      query: (body) => ({
        url: 'boards/',
        method: 'POST',
        body,
      }),
      invalidatesTags: [{ type: 'Board', id: 'LIST' }],
    }),

    updateBoard: build.mutation<
      BoardDTO,
      { board_id: string; changes: Partial<BoardDTO> }
    >({
      query: ({ board_id, changes }) => ({
        url: `boards/${board_id}`,
        method: 'PATCH',
        body: changes,
      }),
      invalidatesTags: (result, error, { board_id }) => [
        { type: 'Board', id: board_id },
        { type: 'Board', id: 'LIST' },
      ],
    }),

    deleteBoard: build.mutation<void, string>({
      query: (boardId) => ({
        url: `boards/${boardId}`,
        method: 'DELETE',
      }),
      invalidatesTags: (result, error, boardId) => [
        { type: 'Board', id: boardId },
        { type: 'Board', id: 'LIST' },
      ],
    }),
  }),
});

export const {
  useListBoardsQuery,
  useGetBoardQuery,
  useCreateBoardMutation,
  useUpdateBoardMutation,
  useDeleteBoardMutation,
} = boardsApi;
```

### 4.3 자동 캐싱 및 무효화

**RTK Query의 캐싱 메커니즘:**

```
1. Query 실행
   └─> 캐시 확인
       ├─> 히트: 캐시된 데이터 즉시 반환
       └─> 미스: API 요청 → 응답 캐시

2. Mutation 실행
   └─> API 요청
       └─> 성공 시: 관련 캐시 무효화
           └─> 무효화된 Query 자동 재실행
```

**예시:**

```typescript
// 컴포넌트 A: 보드 목록 표시
const BoardList = () => {
  const { data: boards } = useListBoardsQuery();
  // 캐시 태그: [{ type: 'Board', id: 'LIST' }]

  return <>{boards?.map(...)}</>;
};

// 컴포넌트 B: 보드 생성
const CreateBoardButton = () => {
  const [createBoard] = useCreateBoardMutation();

  const handleClick = async () => {
    await createBoard({ board_name: 'New Board' });
    // invalidatesTags: [{ type: 'Board', id: 'LIST' }]
    // → BoardList의 쿼리가 자동으로 재실행됨!
  };

  return <Button onClick={handleClick}>Create</Button>;
};
```

---

## 5. Socket.IO 실시간 통신

### 5.1 Socket 연결 관리

파일: `services/events/socketio.ts`

```typescript
import { io, Socket } from 'socket.io-client';

class SocketIOService {
  private socket: Socket | null = null;

  connect() {
    this.socket = io({
      path: '/ws/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });

    // 연결 이벤트
    this.socket.on('connect', () => {
      console.log('Socket.IO connected');
      store.dispatch(socketConnected());
    });

    this.socket.on('disconnect', () => {
      console.log('Socket.IO disconnected');
      store.dispatch(socketDisconnected());
    });

    this.socket.on('connect_error', (error) => {
      console.error('Socket.IO error:', error);
      store.dispatch(socketError(error.message));
    });

    // 백엔드 이벤트 리스너 등록
    this.registerEventListeners();
  }

  private registerEventListeners() {
    if (!this.socket) return;

    // === Invocation 이벤트 ===
    this.socket.on('invocation_started', (data) => {
      store.dispatch(invocationStarted(data));
    });

    this.socket.on('invocation_complete', (data) => {
      store.dispatch(invocationComplete(data));
    });

    this.socket.on('invocation_error', (data) => {
      store.dispatch(invocationError(data));
    });

    // === 생성 진행률 ===
    this.socket.on('generator_progress', (data) => {
      store.dispatch(generatorProgress(data));
    });

    // === 세션 이벤트 ===
    this.socket.on('session_started', (data) => {
      store.dispatch(sessionStarted(data));
    });

    this.socket.on('session_complete', (data) => {
      store.dispatch(sessionComplete(data));
    });

    // === 큐 이벤트 ===
    this.socket.on('queue_item_status_changed', (data) => {
      store.dispatch(queueItemStatusChanged(data));
    });

    // === 모델 로딩 ===
    this.socket.on('model_load_started', (data) => {
      store.dispatch(modelLoadStarted(data));
    });

    this.socket.on('model_load_complete', (data) => {
      store.dispatch(modelLoadComplete(data));
    });
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
  }
}

export const socketService = new SocketIOService();
```

### 5.2 실시간 진행률 업데이트

```typescript
// features/queue/components/QueueItem.tsx
const QueueItemWithProgress = ({ itemId }: Props) => {
  const queueItem = useAppSelector((s) =>
    s.queue.queueItems.find((item) => item.item_id === itemId)
  );

  // Socket.IO를 통해 실시간 업데이트됨
  const progress = queueItem?.progress;
  const currentNode = queueItem?.current_node;

  return (
    <Box>
      <Text>{queueItem?.session.name}</Text>

      {progress && (
        <>
          <Progress value={progress.percentage} />
          <Text>
            Step {progress.current_step} / {progress.total_steps}
          </Text>

          {/* 중간 결과 이미지 */}
          {progress.progress_image && (
            <Image src={`data:image/png;base64,${progress.progress_image}`} />
          )}
        </>
      )}

      {currentNode && (
        <Text fontSize="sm" color="gray.500">
          현재: {currentNode.type}
        </Text>
      )}
    </Box>
  );
};
```

---

## 6. 상태 관리 패턴

### 6.1 Selector 패턴

**Selector란?**

Redux 상태에서 파생 데이터를 계산하는 함수입니다.

```typescript
// ❌ 컴포넌트에서 직접 계산 (비효율적)
const MyComponent = () => {
  const allImages = useAppSelector((s) => s.gallery.images);

  // 매 렌더링마다 필터링 (비효율)
  const starredImages = allImages.filter((img) => img.starred);

  return <>...</>;
};

// ✅ Selector 사용 (효율적)
// store/selectors.ts
import { createSelector } from '@reduxjs/toolkit';

export const selectStarredImages = createSelector(
  [(state: RootState) => state.gallery.images],
  (images) => images.filter((img) => img.starred)
  // 입력(images)이 변경되지 않으면 재계산하지 않음 (memoization)
);

const MyComponent = () => {
  const starredImages = useAppSelector(selectStarredImages);
  return <>...</>;
};
```

**복잡한 Selector 예시:**

```typescript
// 노드 그래프 검증 Selector
export const selectGraphHasErrors = createSelector(
  [
    (state: RootState) => state.nodes.nodes,
    (state: RootState) => state.nodes.edges,
  ],
  (nodes, edges) => {
    // 1. 모든 필수 입력이 연결되었는지 확인
    for (const node of nodes) {
      for (const [fieldName, field] of Object.entries(node.data.inputs)) {
        if (field.required) {
          const isConnected = edges.some(
            (edge) =>
              edge.target === node.id &&
              edge.targetHandle === fieldName
          );

          const hasValue = field.value !== undefined;

          if (!isConnected && !hasValue) {
            return { hasError: true, error: `${node.id}: ${fieldName} is required` };
          }
        }
      }
    }

    // 2. 순환 참조 확인
    if (hasCycle(nodes, edges)) {
      return { hasError: true, error: 'Graph has cycle' };
    }

    return { hasError: false };
  }
);
```

### 6.2 Optimistic Updates

**Optimistic Update란?**

서버 응답을 기다리지 않고 즉시 UI를 업데이트하는 패턴입니다.

```typescript
const BoardsList = () => {
  const [updateBoard] = useUpdateBoardMutation();

  const handleRename = async (boardId: string, newName: string) => {
    // Optimistic Update
    await updateBoard({
      board_id: boardId,
      changes: { board_name: newName },
    }, {
      // RTK Query Optimistic Update 옵션
      optimisticUpdate: {
        // 즉시 캐시 업데이트
        updateCachedData: (draft) => {
          const board = draft.find((b) => b.board_id === boardId);
          if (board) {
            board.board_name = newName;
          }
        },
        // 실패 시 롤백
        rollback: (draft) => {
          const board = draft.find((b) => b.board_id === boardId);
          if (board) {
            board.board_name = board.board_name;  // 원래 이름으로
          }
        },
      },
    });
  };

  return <>...</>;
};
```

---

## 7. 컴포넌트 설계 패턴

### 7.1 Container/Presentational 패턴

```typescript
// ❌ 한 컴포넌트에 모든 로직 (좋지 않음)
const ImageCard = ({ imageId }: Props) => {
  // Redux
  const image = useAppSelector((s) =>
    s.gallery.images.find((img) => img.image_id === imageId)
  );
  const dispatch = useAppDispatch();

  // API
  const [deleteImage] = useDeleteImageMutation();

  // 로컬 상태
  const [isHovered, setIsHovered] = useState(false);

  // 핸들러
  const handleClick = () => dispatch(imageSelected(imageId));
  const handleDelete = () => deleteImage(imageId);

  // 렌더링
  return (
    <Box
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
    >
      <Image src={image.url} />
      {isHovered && (
        <Button onClick={handleDelete}>Delete</Button>
      )}
    </Box>
  );
};

// ✅ Container/Presentational 분리 (좋음)

// Presentational: UI만 담당
interface ImageCardUIProps {
  imageUrl: string;
  isHovered: boolean;
  isSelected: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
  onDelete: () => void;
}

const ImageCardUI = (props: ImageCardUIProps) => {
  return (
    <Box
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onClick={props.onClick}
      borderColor={props.isSelected ? 'blue.500' : 'transparent'}
    >
      <Image src={props.imageUrl} />
      {props.isHovered && (
        <Button onClick={props.onDelete}>Delete</Button>
      )}
    </Box>
  );
};

// Container: 로직 담당
const ImageCardContainer = ({ imageId }: Props) => {
  const image = useAppSelector((s) =>
    s.gallery.images.find((img) => img.image_id === imageId)
  );
  const selectedImageId = useAppSelector((s) => s.gallery.selectedImageId);
  const dispatch = useAppDispatch();
  const [deleteImage] = useDeleteImageMutation();
  const [isHovered, setIsHovered] = useState(false);

  return (
    <ImageCardUI
      imageUrl={image.url}
      isHovered={isHovered}
      isSelected={selectedImageId === imageId}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => dispatch(imageSelected(imageId))}
      onDelete={() => deleteImage(imageId)}
    />
  );
};
```

**장점:**
- Presentational 컴포넌트는 Storybook에서 쉽게 테스트 가능
- 재사용성 증가
- 단위 테스트 용이

---

## 8. 성능 최적화 기법

### 8.1 React.memo

```typescript
// 불필요한 리렌더링 방지
const ImageCard = React.memo(
  ({ image }: Props) => {
    return <Box>...</Box>;
  },
  // 커스텀 비교 함수
  (prevProps, nextProps) => {
    return prevProps.image.image_id === nextProps.image.image_id;
  }
);
```

### 8.2 useCallback / useMemo

```typescript
const MyComponent = () => {
  // ❌ 매 렌더링마다 새로운 함수 생성
  const handleClick = () => {
    console.log('clicked');
  };

  // ✅ useCallback: 함수 memoize
  const handleClick = useCallback(() => {
    console.log('clicked');
  }, []);  // deps가 변경되지 않으면 같은 함수 반환

  // ❌ 매 렌더링마다 계산
  const expensiveValue = computeExpensiveValue(props.data);

  // ✅ useMemo: 값 memoize
  const expensiveValue = useMemo(
    () => computeExpensiveValue(props.data),
    [props.data]  // props.data가 변경될 때만 재계산
  );

  return <>...</>;
};
```

### 8.3 가상화 (Virtualization)

큰 리스트를 효율적으로 렌더링:

```typescript
import { FixedSizeList } from 'react-window';

const ImageList = ({ images }: Props) => {
  // ❌ 10,000개 이미지를 한번에 렌더링 (느림)
  return (
    <div>
      {images.map((image) => (
        <ImageCard key={image.id} image={image} />
      ))}
    </div>
  );

  // ✅ 가상화: 화면에 보이는 것만 렌더링 (빠름)
  return (
    <FixedSizeList
      height={600}
      itemCount={images.length}
      itemSize={150}
      width="100%"
    >
      {({ index, style }) => (
        <div style={style}>
          <ImageCard image={images[index]} />
        </div>
      )}
    </FixedSizeList>
  );
};
```

### 8.4 Code Splitting

```typescript
// ❌ 모든 컴포넌트를 번들에 포함 (초기 로딩 느림)
import NodeEditor from './NodeEditor';
import Gallery from './Gallery';

// ✅ Lazy Loading: 필요할 때만 로드 (초기 로딩 빠름)
const NodeEditor = lazy(() => import('./NodeEditor'));
const Gallery = lazy(() => import('./Gallery'));

const App = () => {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/nodes" element={<NodeEditor />} />
        <Route path="/gallery" element={<Gallery />} />
      </Routes>
    </Suspense>
  );
};
```

---

## 요약

InvokeAI 프론트엔드의 핵심 특징:

1. **모던 React 아키텍처**
   - TypeScript로 타입 안전성 확보
   - Feature-based 구조로 높은 모듈성
   - 함수형 컴포넌트 및 Hooks

2. **강력한 상태 관리**
   - Redux Toolkit으로 간결한 코드
   - RTK Query로 자동 캐싱 및 동기화
   - Listener Middleware로 복잡한 부수 효과 처리

3. **실시간 통신**
   - Socket.IO로 양방향 통신
   - 진행률 및 중간 결과 실시간 업데이트

4. **최적화된 성능**
   - React.memo, useCallback, useMemo
   - 가상화 (react-window)
   - Code Splitting (lazy loading)

5. **풍부한 UI**
   - Konva로 고성능 캔버스
   - React Flow로 노드 기반 워크플로우
   - Framer Motion으로 부드러운 애니메이션

이 문서가 InvokeAI 프론트엔드를 깊이 이해하는 데 도움이 되기를 바랍니다!
