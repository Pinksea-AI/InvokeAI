# Storybook 도입 및 UI 컴포넌트 관리 가이드

## 개요

이 문서는 Pingvas Studio 프로젝트에서 Storybook을 활용하여 UI 컴포넌트를 체계적으로 개발, 관리, 문서화하는 방법을 안내합니다.

---

## 현재 InvokeAI의 Storybook 구조

### 기존 설정 분석

InvokeAI는 이미 Storybook 9.x를 사용하고 있습니다:

```
invokeai/frontend/web/
├── .storybook/
│   ├── main.ts           # Storybook 설정
│   └── preview.tsx       # 전역 데코레이터
├── src/
│   └── features/
│       └── */components/*.stories.tsx
└── package.json
```

**현재 설정 (main.ts)**:
```typescript
const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: ['@storybook/addon-links', '@storybook/addon-docs'],
  framework: '@storybook/react-vite',
  core: { disableTelemetry: true }
};
```

**현재 데코레이터 (preview.tsx)**:
```typescript
decorators: [
  (Story) => (
    <Provider store={store}>
      <ThemeLocaleProvider>
        <ReduxInit>
          <Story />
        </ReduxInit>
      </ThemeLocaleProvider>
    </Provider>
  )
]
```

---

## 1단계: Storybook 확장 설정

### 1.1 추가 애드온 설치

```bash
cd invokeai/frontend/web

# 유용한 애드온 추가 설치
pnpm add -D @storybook/addon-a11y \
            @storybook/addon-viewport \
            @storybook/addon-backgrounds \
            @storybook/addon-measure \
            @storybook/addon-outline \
            storybook-dark-mode
```

### 1.2 main.ts 업데이트

```typescript
// .storybook/main.ts

import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: [
    '../src/**/*.mdx',
    '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'
  ],
  addons: [
    '@storybook/addon-links',
    '@storybook/addon-docs',
    '@storybook/addon-a11y',           // 접근성 검사
    '@storybook/addon-viewport',        // 반응형 뷰포트
    '@storybook/addon-backgrounds',     // 배경색 변경
    '@storybook/addon-measure',         // 요소 측정
    '@storybook/addon-outline',         // 요소 아웃라인
    'storybook-dark-mode',              // 다크 모드 전환
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  core: {
    disableTelemetry: true
  },
  typescript: {
    check: false,
    reactDocgen: 'react-docgen-typescript',
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      propFilter: (prop) => (prop.parent ? !/node_modules/.test(prop.parent.fileName) : true),
    },
  },
  viteFinal: async (config) => {
    // Vite 설정 확장
    return config;
  },
};

export default config;
```

### 1.3 preview.tsx 업데이트

```typescript
// .storybook/preview.tsx

import type { Preview } from '@storybook/react-vite';
import { Provider } from 'react-redux';
import { themes } from '@storybook/theming';
import { ThemeLocaleProvider } from '../src/app/components/ThemeLocaleProvider';
import { createStore } from '../src/app/store/store';

const store = createStore();

// 반응형 뷰포트 설정
const VIEWPORTS = {
  mobile: {
    name: 'Mobile',
    styles: { width: '375px', height: '667px' },
  },
  tablet: {
    name: 'Tablet',
    styles: { width: '768px', height: '1024px' },
  },
  desktop: {
    name: 'Desktop',
    styles: { width: '1440px', height: '900px' },
  },
};

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: '^on[A-Z].*' },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
    viewport: {
      viewports: VIEWPORTS,
      defaultViewport: 'desktop',
    },
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#1a1a2e' },
        { name: 'light', value: '#ffffff' },
        { name: 'gray', value: '#2d2d3a' },
      ],
    },
    darkMode: {
      dark: { ...themes.dark },
      light: { ...themes.light },
      current: 'dark',
    },
    docs: {
      theme: themes.dark,
    },
  },
  decorators: [
    (Story, context) => (
      <Provider store={store}>
        <ThemeLocaleProvider>
          <div style={{
            padding: '1rem',
            minHeight: '100vh',
            backgroundColor: context.globals.backgrounds?.value || '#1a1a2e'
          }}>
            <Story />
          </div>
        </ThemeLocaleProvider>
      </Provider>
    ),
  ],
  globalTypes: {
    locale: {
      name: 'Locale',
      description: 'Internationalization locale',
      defaultValue: 'ko',
      toolbar: {
        icon: 'globe',
        items: [
          { value: 'ko', title: '한국어' },
          { value: 'en', title: 'English' },
          { value: 'ja', title: '日本語' },
        ],
      },
    },
  },
};

export default preview;
```

---

## 2단계: 컴포넌트 구조화

### 2.1 컴포넌트 디렉토리 구조

```
src/
├── common/
│   └── components/
│       ├── Button/
│       │   ├── Button.tsx
│       │   ├── Button.stories.tsx
│       │   ├── Button.test.tsx
│       │   └── index.ts
│       ├── Input/
│       ├── Modal/
│       └── Card/
│
├── features/
│   ├── auth/
│   │   └── components/
│   │       ├── LoginForm/
│   │       │   ├── LoginForm.tsx
│   │       │   ├── LoginForm.stories.tsx
│   │       │   └── index.ts
│   │       └── SignupForm/
│   │
│   ├── subscription/
│   │   └── components/
│   │       ├── PricingCard/
│   │       ├── CreditDisplay/
│   │       └── UpgradeModal/
│   │
│   └── gallery/
│       └── components/
│           ├── ImageCard/
│           ├── ImageGrid/
│           └── ImageViewer/
```

### 2.2 컴포넌트 파일 템플릿

**컴포넌트 파일 (Button.tsx)**:
```typescript
// src/common/components/Button/Button.tsx

import { forwardRef } from 'react';
import { Button as ChakraButton, ButtonProps as ChakraButtonProps } from '@invoke-ai/ui-library';

export interface ButtonProps extends ChakraButtonProps {
  /** 버튼 변형 */
  variant?: 'solid' | 'outline' | 'ghost' | 'link';
  /** 버튼 크기 */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** 버튼 색상 스키마 */
  colorScheme?: 'invokeBlue' | 'invokeGreen' | 'invokeRed' | 'invokeYellow';
  /** 로딩 상태 */
  isLoading?: boolean;
  /** 비활성화 상태 */
  isDisabled?: boolean;
  /** 전체 너비 */
  isFullWidth?: boolean;
}

/**
 * Pingvas Studio의 기본 버튼 컴포넌트
 *
 * @example
 * ```tsx
 * <Button colorScheme="invokeBlue" onClick={handleClick}>
 *   생성하기
 * </Button>
 * ```
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ children, variant = 'solid', size = 'md', colorScheme = 'invokeBlue', ...props }, ref) => {
    return (
      <ChakraButton
        ref={ref}
        variant={variant}
        size={size}
        colorScheme={colorScheme}
        {...props}
      >
        {children}
      </ChakraButton>
    );
  }
);

Button.displayName = 'Button';
```

**스토리 파일 (Button.stories.tsx)**:
```typescript
// src/common/components/Button/Button.stories.tsx

import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { Flex, Stack } from '@invoke-ai/ui-library';

const meta: Meta<typeof Button> = {
  title: 'Common/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['solid', 'outline', 'ghost', 'link'],
      description: '버튼 스타일 변형',
    },
    size: {
      control: 'select',
      options: ['xs', 'sm', 'md', 'lg'],
      description: '버튼 크기',
    },
    colorScheme: {
      control: 'select',
      options: ['invokeBlue', 'invokeGreen', 'invokeRed', 'invokeYellow'],
      description: '색상 스키마',
    },
    isLoading: {
      control: 'boolean',
      description: '로딩 상태',
    },
    isDisabled: {
      control: 'boolean',
      description: '비활성화 상태',
    },
  },
  parameters: {
    docs: {
      description: {
        component: 'Pingvas Studio의 기본 버튼 컴포넌트입니다. 다양한 변형과 크기를 지원합니다.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

// 기본 스토리
export const Default: Story = {
  args: {
    children: '버튼',
    variant: 'solid',
    size: 'md',
    colorScheme: 'invokeBlue',
  },
};

// 변형별 스토리
export const Variants: Story = {
  render: () => (
    <Flex gap={4}>
      <Button variant="solid">Solid</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </Flex>
  ),
};

// 크기별 스토리
export const Sizes: Story = {
  render: () => (
    <Flex gap={4} alignItems="center">
      <Button size="xs">Extra Small</Button>
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
    </Flex>
  ),
};

// 색상별 스토리
export const ColorSchemes: Story = {
  render: () => (
    <Flex gap={4}>
      <Button colorScheme="invokeBlue">Blue</Button>
      <Button colorScheme="invokeGreen">Green</Button>
      <Button colorScheme="invokeRed">Red</Button>
      <Button colorScheme="invokeYellow">Yellow</Button>
    </Flex>
  ),
};

// 상태별 스토리
export const States: Story = {
  render: () => (
    <Stack direction="row" spacing={4}>
      <Button>Normal</Button>
      <Button isLoading>Loading</Button>
      <Button isDisabled>Disabled</Button>
    </Stack>
  ),
};

// 실제 사용 예시
export const UsageExample: Story = {
  render: () => (
    <Flex gap={4}>
      <Button colorScheme="invokeBlue" size="lg">
        이미지 생성
      </Button>
      <Button variant="outline" colorScheme="invokeGreen">
        저장하기
      </Button>
      <Button variant="ghost" colorScheme="invokeRed">
        취소
      </Button>
    </Flex>
  ),
};
```

---

## 3단계: 새로운 UI 컴포넌트 개발

### 3.1 PricingCard 컴포넌트

```typescript
// src/features/subscription/components/PricingCard/PricingCard.tsx

import { memo } from 'react';
import { Box, Flex, Text, VStack, List, ListItem, ListIcon } from '@invoke-ai/ui-library';
import { FiCheck, FiX } from 'react-icons/fi';
import { Button } from '@/common/components/Button';

export interface PricingPlan {
  id: string;
  name: string;
  displayName: string;
  monthlyPrice: number;
  yearlyPrice: number;
  credits: number;
  storage: string;
  queueCount: number;
  features: {
    key: string;
    label: string;
    enabled: boolean;
  }[];
  isPopular?: boolean;
}

export interface PricingCardProps {
  plan: PricingPlan;
  billingCycle: 'monthly' | 'yearly';
  currentPlan?: string;
  onSelect: (planId: string) => void;
  isLoading?: boolean;
}

export const PricingCard = memo(({
  plan,
  billingCycle,
  currentPlan,
  onSelect,
  isLoading
}: PricingCardProps) => {
  const price = billingCycle === 'monthly' ? plan.monthlyPrice : plan.yearlyPrice;
  const isCurrentPlan = currentPlan === plan.id;

  return (
    <Box
      borderWidth={plan.isPopular ? 2 : 1}
      borderColor={plan.isPopular ? 'invokeBlue.500' : 'whiteAlpha.200'}
      borderRadius="xl"
      p={6}
      bg="blackAlpha.400"
      position="relative"
      _hover={{ borderColor: 'invokeBlue.400', transform: 'translateY(-2px)' }}
      transition="all 0.2s"
    >
      {plan.isPopular && (
        <Box
          position="absolute"
          top={-3}
          left="50%"
          transform="translateX(-50%)"
          bg="invokeBlue.500"
          px={3}
          py={1}
          borderRadius="full"
          fontSize="xs"
          fontWeight="bold"
        >
          인기
        </Box>
      )}

      <VStack spacing={4} align="stretch">
        {/* 플랜 이름 */}
        <Text fontSize="xl" fontWeight="bold" color="white">
          {plan.displayName}
        </Text>

        {/* 가격 */}
        <Flex align="baseline" gap={1}>
          <Text fontSize="4xl" fontWeight="bold" color="white">
            ${price}
          </Text>
          <Text color="whiteAlpha.600">
            /{billingCycle === 'monthly' ? '월' : '년'}
          </Text>
        </Flex>

        {/* 크레딧 */}
        <Box bg="whiteAlpha.100" p={3} borderRadius="md">
          <Text fontSize="sm" color="whiteAlpha.700">월간 크레딧</Text>
          <Text fontSize="2xl" fontWeight="bold" color="invokeGreen.400">
            {plan.credits.toLocaleString()}
          </Text>
        </Box>

        {/* 스토리지 & 큐 */}
        <Flex justify="space-between">
          <Box>
            <Text fontSize="xs" color="whiteAlpha.500">스토리지</Text>
            <Text fontWeight="medium">{plan.storage}</Text>
          </Box>
          <Box>
            <Text fontSize="xs" color="whiteAlpha.500">동시 큐</Text>
            <Text fontWeight="medium">{plan.queueCount}개</Text>
          </Box>
        </Flex>

        {/* 기능 목록 */}
        <List spacing={2}>
          {plan.features.map((feature) => (
            <ListItem key={feature.key} display="flex" alignItems="center">
              <ListIcon
                as={feature.enabled ? FiCheck : FiX}
                color={feature.enabled ? 'invokeGreen.400' : 'whiteAlpha.400'}
              />
              <Text
                fontSize="sm"
                color={feature.enabled ? 'white' : 'whiteAlpha.400'}
                textDecoration={feature.enabled ? 'none' : 'line-through'}
              >
                {feature.label}
              </Text>
            </ListItem>
          ))}
        </List>

        {/* 선택 버튼 */}
        <Button
          colorScheme={isCurrentPlan ? 'invokeGreen' : 'invokeBlue'}
          variant={isCurrentPlan ? 'outline' : 'solid'}
          size="lg"
          isFullWidth
          isLoading={isLoading}
          isDisabled={isCurrentPlan}
          onClick={() => onSelect(plan.id)}
        >
          {isCurrentPlan ? '현재 플랜' : '선택하기'}
        </Button>
      </VStack>
    </Box>
  );
});

PricingCard.displayName = 'PricingCard';
```

**스토리 파일**:
```typescript
// src/features/subscription/components/PricingCard/PricingCard.stories.tsx

import type { Meta, StoryObj } from '@storybook/react';
import { PricingCard, PricingPlan } from './PricingCard';
import { Flex } from '@invoke-ai/ui-library';

const SAMPLE_PLANS: PricingPlan[] = [
  {
    id: 'starter',
    name: 'starter',
    displayName: 'Starter',
    monthlyPrice: 25,
    yearlyPrice: 250,
    credits: 5000,
    storage: '20GB',
    queueCount: 1,
    features: [
      { key: 'sd_models', label: 'SD 1.5/2.0/XL 모델', enabled: true },
      { key: 'flux_model', label: 'Flux 모델', enabled: false },
      { key: 'nano_banana', label: 'nano-banana API', enabled: false },
      { key: 'lora_training', label: 'LoRA 학습', enabled: false },
    ],
  },
  {
    id: 'pro',
    name: 'pro',
    displayName: 'Pro',
    monthlyPrice: 75,
    yearlyPrice: 750,
    credits: 15000,
    storage: '100GB',
    queueCount: 1,
    isPopular: true,
    features: [
      { key: 'sd_models', label: 'SD 1.5/2.0/XL 모델', enabled: true },
      { key: 'flux_model', label: 'Flux 모델', enabled: true },
      { key: 'nano_banana', label: 'nano-banana API', enabled: true },
      { key: 'lora_training', label: 'LoRA 학습', enabled: false },
    ],
  },
  {
    id: 'studio',
    name: 'studio',
    displayName: 'Studio',
    monthlyPrice: 150,
    yearlyPrice: 1500,
    credits: 30000,
    storage: '200GB',
    queueCount: 3,
    features: [
      { key: 'sd_models', label: 'SD 1.5/2.0/XL 모델', enabled: true },
      { key: 'flux_model', label: 'Flux 모델', enabled: true },
      { key: 'nano_banana', label: 'nano-banana API', enabled: true },
      { key: 'lora_training', label: 'LoRA 학습', enabled: true },
    ],
  },
];

const meta: Meta<typeof PricingCard> = {
  title: 'Features/Subscription/PricingCard',
  component: PricingCard,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: '구독 플랜을 표시하는 가격 카드 컴포넌트입니다.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PricingCard>;

export const Default: Story = {
  args: {
    plan: SAMPLE_PLANS[1], // Pro
    billingCycle: 'monthly',
    onSelect: (id) => console.log('Selected:', id),
  },
};

export const AllPlans: Story = {
  render: () => (
    <Flex gap={6} wrap="wrap">
      {SAMPLE_PLANS.map((plan) => (
        <PricingCard
          key={plan.id}
          plan={plan}
          billingCycle="monthly"
          onSelect={(id) => console.log('Selected:', id)}
        />
      ))}
    </Flex>
  ),
};

export const YearlyBilling: Story = {
  render: () => (
    <Flex gap={6} wrap="wrap">
      {SAMPLE_PLANS.map((plan) => (
        <PricingCard
          key={plan.id}
          plan={plan}
          billingCycle="yearly"
          onSelect={(id) => console.log('Selected:', id)}
        />
      ))}
    </Flex>
  ),
};

export const CurrentPlan: Story = {
  args: {
    plan: SAMPLE_PLANS[1],
    billingCycle: 'monthly',
    currentPlan: 'pro',
    onSelect: (id) => console.log('Selected:', id),
  },
};

export const Loading: Story = {
  args: {
    plan: SAMPLE_PLANS[1],
    billingCycle: 'monthly',
    isLoading: true,
    onSelect: (id) => console.log('Selected:', id),
  },
};
```

---

## 4단계: 테마 커스터마이징

### 4.1 컬러 팔레트 확장

```typescript
// src/theme/colors.ts

export const colors = {
  // 기존 InvokeAI 색상
  invokeBlue: {
    50: '#e6f2ff',
    100: '#b3d9ff',
    200: '#80bfff',
    300: '#4da6ff',
    400: '#1a8cff',
    500: '#0073e6',
    600: '#005bb3',
    700: '#004280',
    800: '#002a4d',
    900: '#00111a',
  },
  invokeGreen: {
    50: '#e6fff2',
    100: '#b3ffd9',
    200: '#80ffbf',
    300: '#4dffa6',
    400: '#1aff8c',
    500: '#00e673',
    600: '#00b35a',
    700: '#008040',
    800: '#004d26',
    900: '#001a0d',
  },

  // Pingvas Studio 추가 색상
  pingvas: {
    primary: '#6366f1',    // Indigo
    secondary: '#8b5cf6',  // Violet
    accent: '#f59e0b',     // Amber
    success: '#10b981',    // Emerald
    warning: '#f59e0b',    // Amber
    error: '#ef4444',      // Red
    info: '#3b82f6',       // Blue
  },

  // 티어별 색상
  tier: {
    free: '#9ca3af',       // Gray
    starter: '#60a5fa',    // Blue
    pro: '#a78bfa',        // Purple
    studio: '#fbbf24',     // Yellow/Gold
    enterprise: '#f87171', // Red
  },
};
```

### 4.2 테마 적용

```typescript
// src/theme/theme.ts

import { extendTheme } from '@invoke-ai/ui-library';
import { colors } from './colors';

export const pingvasTheme = extendTheme({
  colors,
  fonts: {
    heading: '"Inter Variable", sans-serif',
    body: '"Inter Variable", sans-serif',
    mono: '"JetBrains Mono", monospace',
  },
  components: {
    Button: {
      variants: {
        pingvasPrimary: {
          bg: 'pingvas.primary',
          color: 'white',
          _hover: {
            bg: 'pingvas.secondary',
          },
        },
        tier: (props: { tier: string }) => ({
          bg: `tier.${props.tier}`,
          color: 'white',
        }),
      },
    },
    Badge: {
      variants: {
        tier: (props: { tier: string }) => ({
          bg: `tier.${props.tier}`,
          color: 'white',
          textTransform: 'uppercase',
          fontSize: 'xs',
          fontWeight: 'bold',
        }),
      },
    },
  },
});
```

---

## 5단계: 컴포넌트 문서화

### 5.1 MDX 문서 작성

```mdx
{/* src/common/components/Button/Button.mdx */}

import { Meta, Story, Canvas, ArgTypes } from '@storybook/addon-docs';
import { Button } from './Button';

<Meta title="Common/Button/문서" />

# Button 컴포넌트

Pingvas Studio의 기본 버튼 컴포넌트입니다.

## 사용법

```tsx
import { Button } from '@/common/components/Button';

<Button colorScheme="invokeBlue" onClick={handleClick}>
  클릭하세요
</Button>
```

## 예시

<Canvas>
  <Story id="common-button--default" />
</Canvas>

## Props

<ArgTypes of={Button} />

## 디자인 가이드라인

### 언제 사용하나요?

- **Primary 버튼**: 페이지당 하나의 주요 액션에 사용
- **Secondary 버튼**: 보조적인 액션에 사용
- **Ghost 버튼**: 덜 강조되는 액션에 사용

### 색상 사용

| 색상 | 용도 |
|------|------|
| invokeBlue | 주요 액션 (생성, 저장) |
| invokeGreen | 긍정적 액션 (확인, 완료) |
| invokeRed | 부정적 액션 (삭제, 취소) |
| invokeYellow | 경고 액션 |

### 접근성

- 버튼에는 항상 명확한 레이블을 제공하세요
- 아이콘만 있는 버튼에는 `aria-label`을 추가하세요
- 색상만으로 상태를 구분하지 마세요
```

---

## 6단계: Storybook 실행 및 빌드

### 6.1 개발 모드

```bash
cd invokeai/frontend/web

# Storybook 개발 서버 실행
pnpm storybook

# http://localhost:6006 에서 확인
```

### 6.2 정적 빌드

```bash
# 정적 파일 빌드
pnpm build-storybook

# 빌드 결과 확인
ls -la storybook-static/

# 로컬에서 확인
npx http-server storybook-static
```

### 6.3 CI/CD 통합

```yaml
# .github/workflows/storybook.yml

name: Storybook

on:
  push:
    branches: [develop]
    paths:
      - 'invokeai/frontend/web/**'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 10

      - name: Install dependencies
        run: |
          cd invokeai/frontend/web
          pnpm install

      - name: Build Storybook
        run: |
          cd invokeai/frontend/web
          pnpm build-storybook

      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./invokeai/frontend/web/storybook-static
```

---

## 체크리스트

- [ ] Storybook 애드온 설치됨
- [ ] main.ts 업데이트됨
- [ ] preview.tsx 업데이트됨
- [ ] 컴포넌트 디렉토리 구조화됨
- [ ] 기본 컴포넌트 스토리 작성됨
- [ ] 테마 커스터마이징됨
- [ ] MDX 문서 작성됨
- [ ] CI/CD 파이프라인 설정됨

---

## 다음 단계

1. [UI 커스터마이징 가이드](./02-ui-customization.md)에서 레이아웃 변경을 확인합니다.
2. [결제 연동 가이드](../guides/02-payment-integration.md)에서 결제 UI를 구현합니다.
3. [API 명세서](../api/01-api-specification.md)와 연동합니다.
