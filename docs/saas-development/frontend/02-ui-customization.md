# UI 커스터마이징 가이드

## 개요

이 문서는 InvokeAI 기반 Pingvas Studio의 UI 커스터마이징 방법을 설명합니다. 테마, 레이아웃, 컴포넌트 확장 방법을 다룹니다.

---

## InvokeAI UI 구조 분석

### 기존 프로젝트 구조
```
invokeai/frontend/web/
├── src/
│   ├── app/                    # Redux 스토어, 라우팅
│   │   ├── store/
│   │   │   └── store.ts
│   │   └── App.tsx
│   ├── features/              # 기능별 모듈
│   │   ├── canvas/            # 캔버스 기능
│   │   ├── gallery/           # 갤러리
│   │   ├── nodes/             # 워크플로우 노드
│   │   ├── parameters/        # 생성 파라미터
│   │   ├── queue/             # 작업 큐
│   │   ├── system/            # 시스템 설정
│   │   └── ui/                # 공통 UI
│   ├── common/                # 공통 컴포넌트
│   │   └── components/
│   ├── services/              # API 서비스
│   │   └── api/
│   └── theme/                 # 테마 설정
│       └── theme.ts
├── public/
└── index.html
```

### Pingvas 확장 구조
```
invokeai/frontend/web/
├── src/
│   ├── pingvas/               # Pingvas 전용 확장
│   │   ├── components/        # 커스텀 컴포넌트
│   │   │   ├── Header/
│   │   │   ├── Sidebar/
│   │   │   ├── Subscription/
│   │   │   └── Credits/
│   │   ├── features/          # 추가 기능
│   │   │   ├── subscription/
│   │   │   ├── billing/
│   │   │   └── onboarding/
│   │   ├── hooks/             # 커스텀 훅
│   │   ├── theme/             # 테마 오버라이드
│   │   └── utils/
│   └── ... (기존 InvokeAI 코드)
```

---

## 테마 커스터마이징

### Chakra UI 테마 확장

```typescript
// src/pingvas/theme/pingvasTheme.ts
import { extendTheme, type ThemeConfig } from '@chakra-ui/react';
import { invokeAITheme } from '../../theme/theme';

const config: ThemeConfig = {
  initialColorMode: 'dark',
  useSystemColorMode: false,
};

const colors = {
  pingvas: {
    // Primary - Gradient Purple/Pink
    primary: {
      50: '#fdf2ff',
      100: '#f8e1ff',
      200: '#f0c4ff',
      300: '#e596ff',
      400: '#d659ff',
      500: '#c026d3',  // Main
      600: '#a020b0',
      700: '#831890',
      800: '#6b1575',
      900: '#571060',
    },
    // Secondary - Teal
    secondary: {
      50: '#f0fdfa',
      100: '#ccfbf1',
      200: '#99f6e4',
      300: '#5eead4',
      400: '#2dd4bf',
      500: '#14b8a6',  // Main
      600: '#0d9488',
      700: '#0f766e',
      800: '#115e59',
      900: '#134e4a',
    },
    // Accent - Amber (크레딧, 경고)
    accent: {
      50: '#fffbeb',
      100: '#fef3c7',
      200: '#fde68a',
      300: '#fcd34d',
      400: '#fbbf24',
      500: '#f59e0b',  // Main
      600: '#d97706',
      700: '#b45309',
      800: '#92400e',
      900: '#78350f',
    },
  },
  // 티어별 색상
  tier: {
    starter: '#6366f1',   // Indigo
    pro: '#8b5cf6',       // Purple
    studio: '#ec4899',    // Pink
    enterprise: '#f59e0b', // Amber
  },
};

const components = {
  Button: {
    variants: {
      pingvasPrimary: {
        bg: 'linear-gradient(135deg, #c026d3 0%, #7c3aed 100%)',
        color: 'white',
        _hover: {
          bg: 'linear-gradient(135deg, #a020b0 0%, #6d28d9 100%)',
          transform: 'translateY(-1px)',
          boxShadow: 'lg',
        },
        _active: {
          transform: 'translateY(0)',
        },
      },
      pingvasSecondary: {
        bg: 'transparent',
        border: '1px solid',
        borderColor: 'pingvas.primary.500',
        color: 'pingvas.primary.500',
        _hover: {
          bg: 'pingvas.primary.500',
          color: 'white',
        },
      },
      tierStarter: {
        bg: 'tier.starter',
        color: 'white',
      },
      tierPro: {
        bg: 'tier.pro',
        color: 'white',
      },
      tierStudio: {
        bg: 'tier.studio',
        color: 'white',
      },
    },
  },
  Badge: {
    variants: {
      tierBadge: (props: { tier: string }) => ({
        bg: `tier.${props.tier}`,
        color: 'white',
        px: 3,
        py: 1,
        borderRadius: 'full',
        fontSize: 'xs',
        fontWeight: 'bold',
        textTransform: 'uppercase',
      }),
    },
  },
  Card: {
    variants: {
      pingvasCard: {
        container: {
          bg: 'gray.800',
          borderRadius: 'xl',
          border: '1px solid',
          borderColor: 'gray.700',
          overflow: 'hidden',
          transition: 'all 0.2s',
          _hover: {
            borderColor: 'pingvas.primary.500',
            boxShadow: '0 0 20px rgba(192, 38, 211, 0.2)',
          },
        },
      },
    },
  },
};

const styles = {
  global: {
    body: {
      bg: 'gray.900',
      color: 'gray.100',
    },
    // 스크롤바 커스터마이징
    '::-webkit-scrollbar': {
      width: '8px',
      height: '8px',
    },
    '::-webkit-scrollbar-track': {
      bg: 'gray.800',
    },
    '::-webkit-scrollbar-thumb': {
      bg: 'gray.600',
      borderRadius: '4px',
      _hover: {
        bg: 'gray.500',
      },
    },
  },
};

export const pingvasTheme = extendTheme({
  ...invokeAITheme,
  config,
  colors: {
    ...invokeAITheme.colors,
    ...colors,
  },
  components: {
    ...invokeAITheme.components,
    ...components,
  },
  styles,
});
```

### 테마 적용

```typescript
// src/main.tsx
import { ChakraProvider } from '@chakra-ui/react';
import { pingvasTheme } from './pingvas/theme/pingvasTheme';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ChakraProvider theme={pingvasTheme}>
      <App />
    </ChakraProvider>
  </React.StrictMode>
);
```

---

## 커스텀 컴포넌트

### 1. 크레딧 표시 컴포넌트

```typescript
// src/pingvas/components/Credits/CreditDisplay.tsx
import {
  HStack,
  Text,
  Icon,
  Tooltip,
  Progress,
  Box,
  useColorModeValue,
} from '@chakra-ui/react';
import { FaCoins } from 'react-icons/fa';
import { useAppSelector } from '../../../app/store/storeHooks';

export const CreditDisplay = () => {
  const { remainingCredits, totalCredits } = useAppSelector(
    (state) => state.subscription
  );

  const percentage = (remainingCredits / totalCredits) * 100;
  const isLow = percentage < 20;

  const bgColor = useColorModeValue('white', 'gray.800');
  const progressColor = isLow ? 'red' : 'pingvas.primary';

  return (
    <Tooltip
      label={`${remainingCredits.toLocaleString()} / ${totalCredits.toLocaleString()} 크레딧`}
      placement="bottom"
    >
      <Box
        bg={bgColor}
        px={4}
        py={2}
        borderRadius="full"
        border="1px solid"
        borderColor={isLow ? 'red.500' : 'gray.600'}
      >
        <HStack spacing={3}>
          <Icon as={FaCoins} color="pingvas.accent.500" />
          <Box minW="100px">
            <Text fontSize="sm" fontWeight="bold" mb={1}>
              {remainingCredits.toLocaleString()}
            </Text>
            <Progress
              value={percentage}
              size="xs"
              colorScheme={progressColor}
              borderRadius="full"
            />
          </Box>
        </HStack>
      </Box>
    </Tooltip>
  );
};
```

### 2. 구독 티어 배지

```typescript
// src/pingvas/components/Subscription/TierBadge.tsx
import { Badge, HStack, Icon } from '@chakra-ui/react';
import { FaStar, FaCrown, FaGem, FaBuilding } from 'react-icons/fa';

type Tier = 'starter' | 'pro' | 'studio' | 'enterprise';

interface TierBadgeProps {
  tier: Tier;
  showIcon?: boolean;
}

const tierConfig = {
  starter: {
    label: 'Starter',
    icon: FaStar,
    color: 'tier.starter',
  },
  pro: {
    label: 'Pro',
    icon: FaCrown,
    color: 'tier.pro',
  },
  studio: {
    label: 'Studio',
    icon: FaGem,
    color: 'tier.studio',
  },
  enterprise: {
    label: 'Enterprise',
    icon: FaBuilding,
    color: 'tier.enterprise',
  },
};

export const TierBadge = ({ tier, showIcon = true }: TierBadgeProps) => {
  const config = tierConfig[tier];

  return (
    <Badge
      bg={config.color}
      color="white"
      px={3}
      py={1}
      borderRadius="full"
      fontSize="xs"
      fontWeight="bold"
      textTransform="uppercase"
    >
      <HStack spacing={1}>
        {showIcon && <Icon as={config.icon} boxSize={3} />}
        <span>{config.label}</span>
      </HStack>
    </Badge>
  );
};
```

### 3. 생성 진행률 오버레이

```typescript
// src/pingvas/components/Generation/ProgressOverlay.tsx
import {
  Box,
  VStack,
  Text,
  Progress,
  Image,
  Spinner,
  useColorModeValue,
} from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppSelector } from '../../../app/store/storeHooks';

const MotionBox = motion(Box);

export const ProgressOverlay = () => {
  const { isGenerating, progress, previewUrl, currentStep, totalSteps } =
    useAppSelector((state) => state.generation);

  const bgColor = useColorModeValue('blackAlpha.700', 'blackAlpha.800');

  return (
    <AnimatePresence>
      {isGenerating && (
        <MotionBox
          position="fixed"
          top={0}
          left={0}
          right={0}
          bottom={0}
          bg={bgColor}
          display="flex"
          alignItems="center"
          justifyContent="center"
          zIndex={9999}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <VStack spacing={6} maxW="400px" w="full" p={8}>
            {/* 프리뷰 이미지 */}
            <Box
              w="300px"
              h="300px"
              borderRadius="xl"
              overflow="hidden"
              bg="gray.800"
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              {previewUrl ? (
                <Image
                  src={previewUrl}
                  alt="Preview"
                  objectFit="cover"
                  w="full"
                  h="full"
                />
              ) : (
                <Spinner
                  size="xl"
                  color="pingvas.primary.500"
                  thickness="4px"
                />
              )}
            </Box>

            {/* 진행률 */}
            <Box w="full">
              <Text fontSize="sm" color="gray.400" mb={2} textAlign="center">
                Step {currentStep} / {totalSteps}
              </Text>
              <Progress
                value={progress}
                size="lg"
                colorScheme="pingvas.primary"
                borderRadius="full"
                hasStripe
                isAnimated
              />
              <Text
                fontSize="2xl"
                fontWeight="bold"
                textAlign="center"
                mt={2}
                bgGradient="linear(to-r, pingvas.primary.400, pingvas.secondary.400)"
                bgClip="text"
              >
                {Math.round(progress)}%
              </Text>
            </Box>
          </VStack>
        </MotionBox>
      )}
    </AnimatePresence>
  );
};
```

### 4. 요금제 선택 카드

```typescript
// src/pingvas/components/Subscription/PricingCard.tsx
import {
  Box,
  VStack,
  HStack,
  Text,
  Button,
  List,
  ListItem,
  ListIcon,
  useColorModeValue,
  Badge,
} from '@chakra-ui/react';
import { FaCheck, FaTimes } from 'react-icons/fa';
import { motion } from 'framer-motion';

const MotionBox = motion(Box);

interface PricingCardProps {
  name: string;
  price: number;
  credits: number;
  storage: string;
  features: Array<{ name: string; included: boolean }>;
  isPopular?: boolean;
  isCurrentPlan?: boolean;
  onSelect: () => void;
}

export const PricingCard = ({
  name,
  price,
  credits,
  storage,
  features,
  isPopular = false,
  isCurrentPlan = false,
  onSelect,
}: PricingCardProps) => {
  const bgColor = useColorModeValue('white', 'gray.800');
  const borderColor = isPopular ? 'pingvas.primary.500' : 'gray.600';

  return (
    <MotionBox
      whileHover={{ y: -8, scale: 1.02 }}
      transition={{ duration: 0.2 }}
    >
      <Box
        bg={bgColor}
        borderRadius="2xl"
        border="2px solid"
        borderColor={borderColor}
        p={8}
        position="relative"
        overflow="hidden"
        boxShadow={isPopular ? '0 20px 40px rgba(192, 38, 211, 0.3)' : 'xl'}
      >
        {/* 인기 배지 */}
        {isPopular && (
          <Badge
            position="absolute"
            top={4}
            right={4}
            bg="pingvas.primary.500"
            color="white"
            px={3}
            py={1}
            borderRadius="full"
          >
            인기
          </Badge>
        )}

        {/* 플랜 이름 */}
        <Text
          fontSize="2xl"
          fontWeight="bold"
          bgGradient={
            isPopular
              ? 'linear(to-r, pingvas.primary.400, pingvas.secondary.400)'
              : 'none'
          }
          bgClip={isPopular ? 'text' : 'none'}
          mb={4}
        >
          {name}
        </Text>

        {/* 가격 */}
        <HStack align="baseline" mb={6}>
          <Text fontSize="5xl" fontWeight="bold">
            ${price}
          </Text>
          <Text color="gray.500">/월</Text>
        </HStack>

        {/* 주요 혜택 */}
        <VStack align="stretch" spacing={2} mb={6}>
          <HStack>
            <Text color="gray.400">크레딧:</Text>
            <Text fontWeight="bold">{credits.toLocaleString()}</Text>
          </HStack>
          <HStack>
            <Text color="gray.400">스토리지:</Text>
            <Text fontWeight="bold">{storage}</Text>
          </HStack>
        </VStack>

        {/* 기능 목록 */}
        <List spacing={3} mb={8}>
          {features.map((feature, index) => (
            <ListItem key={index} display="flex" alignItems="center">
              <ListIcon
                as={feature.included ? FaCheck : FaTimes}
                color={feature.included ? 'green.400' : 'gray.500'}
              />
              <Text
                color={feature.included ? 'gray.200' : 'gray.500'}
                textDecoration={feature.included ? 'none' : 'line-through'}
              >
                {feature.name}
              </Text>
            </ListItem>
          ))}
        </List>

        {/* 선택 버튼 */}
        <Button
          w="full"
          size="lg"
          variant={isCurrentPlan ? 'outline' : 'pingvasPrimary'}
          isDisabled={isCurrentPlan}
          onClick={onSelect}
        >
          {isCurrentPlan ? '현재 플랜' : '선택하기'}
        </Button>
      </Box>
    </MotionBox>
  );
};
```

---

## 레이아웃 커스터마이징

### 메인 레이아웃 수정

```typescript
// src/pingvas/layouts/MainLayout.tsx
import { Box, Flex } from '@chakra-ui/react';
import { Outlet } from 'react-router-dom';
import { PingvasHeader } from '../components/Header/PingvasHeader';
import { PingvasSidebar } from '../components/Sidebar/PingvasSidebar';
import { ProgressOverlay } from '../components/Generation/ProgressOverlay';

export const MainLayout = () => {
  return (
    <Flex h="100vh" direction="column">
      {/* 상단 헤더 */}
      <PingvasHeader />

      {/* 메인 컨텐츠 영역 */}
      <Flex flex={1} overflow="hidden">
        {/* 사이드바 */}
        <PingvasSidebar />

        {/* 메인 컨텐츠 */}
        <Box flex={1} overflow="auto" bg="gray.900">
          <Outlet />
        </Box>
      </Flex>

      {/* 생성 진행률 오버레이 */}
      <ProgressOverlay />
    </Flex>
  );
};
```

### 커스텀 헤더

```typescript
// src/pingvas/components/Header/PingvasHeader.tsx
import {
  Box,
  Flex,
  HStack,
  Image,
  Button,
  Menu,
  MenuButton,
  MenuList,
  MenuItem,
  Avatar,
  Text,
  IconButton,
  useDisclosure,
} from '@chakra-ui/react';
import { FaBell, FaCog } from 'react-icons/fa';
import { CreditDisplay } from '../Credits/CreditDisplay';
import { TierBadge } from '../Subscription/TierBadge';
import { useAppSelector } from '../../../app/store/storeHooks';

export const PingvasHeader = () => {
  const { user } = useAppSelector((state) => state.auth);
  const { currentTier } = useAppSelector((state) => state.subscription);
  const { isOpen, onOpen, onClose } = useDisclosure();

  return (
    <Box
      as="header"
      bg="gray.800"
      borderBottom="1px solid"
      borderColor="gray.700"
      px={6}
      py={3}
    >
      <Flex justify="space-between" align="center">
        {/* 로고 */}
        <HStack spacing={4}>
          <Image src="/logo.svg" alt="Pingvas Studio" h="32px" />
          <Text
            fontSize="xl"
            fontWeight="bold"
            bgGradient="linear(to-r, pingvas.primary.400, pingvas.secondary.400)"
            bgClip="text"
          >
            Pingvas Studio
          </Text>
        </HStack>

        {/* 우측 영역 */}
        <HStack spacing={4}>
          {/* 크레딧 표시 */}
          <CreditDisplay />

          {/* 알림 */}
          <IconButton
            aria-label="Notifications"
            icon={<FaBell />}
            variant="ghost"
            onClick={onOpen}
          />

          {/* 설정 */}
          <IconButton
            aria-label="Settings"
            icon={<FaCog />}
            variant="ghost"
          />

          {/* 사용자 메뉴 */}
          <Menu>
            <MenuButton>
              <HStack spacing={3}>
                <Avatar
                  size="sm"
                  name={user?.displayName}
                  src={user?.avatarUrl}
                />
                <Box textAlign="left">
                  <Text fontSize="sm" fontWeight="medium">
                    {user?.displayName}
                  </Text>
                  <TierBadge tier={currentTier} showIcon={false} />
                </Box>
              </HStack>
            </MenuButton>
            <MenuList>
              <MenuItem>프로필</MenuItem>
              <MenuItem>구독 관리</MenuItem>
              <MenuItem>결제 내역</MenuItem>
              <MenuItem color="red.400">로그아웃</MenuItem>
            </MenuList>
          </Menu>
        </HStack>
      </Flex>
    </Box>
  );
};
```

---

## 애니메이션 효과

### Framer Motion 유틸리티

```typescript
// src/pingvas/utils/animations.ts
import { Variants } from 'framer-motion';

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.3 } },
};

export const slideUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.3 } },
};

export const pulseAnimation = {
  scale: [1, 1.05, 1],
  transition: {
    duration: 2,
    repeat: Infinity,
    ease: 'easeInOut',
  },
};
```

---

## 반응형 디자인

### 브레이크포인트 설정

```typescript
// src/pingvas/theme/breakpoints.ts
export const breakpoints = {
  sm: '480px',
  md: '768px',
  lg: '992px',
  xl: '1280px',
  '2xl': '1536px',
};

// 반응형 유틸리티
export const responsive = {
  sidebar: {
    width: { base: 'full', md: '280px' },
    display: { base: 'none', md: 'block' },
  },
  header: {
    height: { base: '56px', md: '64px' },
  },
  container: {
    px: { base: 4, md: 6, lg: 8 },
  },
};
```

---

## 다음 단계

- [Storybook 가이드](./01-storybook-guide.md)에서 컴포넌트 문서화 확인
- [데이터 흐름](../architecture/03-data-flow.md)에서 상태 관리 확인
- [API 명세](../api/01-api-specification.md)에서 백엔드 연동 확인
