import { Flex, Text } from '@invoke-ai/ui-library';
import { setFocusedRegion } from 'common/hooks/focus';
import { useCallbackOnDragEnter } from 'common/hooks/useCallbackOnDragEnter';
import type { IDockviewPanelHeaderProps } from 'dockview';
import ProgressBar from 'features/system/components/ProgressBar';
import { memo, useCallback, useRef } from 'react';
import { useIsGenerationInProgress } from 'services/api/endpoints/queue';

import type { PanelParameters } from './auto-layout-context';

export const DockviewTabProgress = memo((props: IDockviewPanelHeaderProps<PanelParameters>) => {
  const isGenerationInProgress = useIsGenerationInProgress();

  const ref = useRef<HTMLDivElement>(null);
  const setActive = useCallback(() => {
    if (!props.api.isActive) {
      props.api.setActive();
    }
  }, [props.api]);

  useCallbackOnDragEnter(setActive, ref, 300);

  const onPointerDown = useCallback(() => {
    setFocusedRegion(props.params.focusRegion);
  }, [props.params.focusRegion]);

  return (
    <Flex ref={ref} position="relative" alignItems="center" h="full" onPointerDown={onPointerDown}>
      <Text userSelect="none" px={4}>
        {props.api.title ?? props.api.id}
      </Text>
      {isGenerationInProgress && (
        <ProgressBar position="absolute" bottom={0} left={0} right={0} h={1} borderRadius="none" />
      )}
    </Flex>
  );
});
DockviewTabProgress.displayName = 'DockviewTabProgress';
