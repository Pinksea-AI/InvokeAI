import { useAppSelector } from 'app/store/storeHooks';
import { useInvocationNodeContext } from 'features/nodes/components/flow/nodes/Invocation/context';
import type { FieldInputTemplate } from 'features/nodes/types/field';
import { useMemo } from 'react';

/**
 * Returns the template for a specific input field of a node.
 *
 * **Note:** This function is a safe version of `useInputFieldTemplate` and will not throw an error if the template is not found.
 *
 * @param nodeId - The ID of the node.
 * @param fieldName - The name of the input field.
 */
export const useInputFieldTemplateSafe = (fieldName: string): FieldInputTemplate | null => {
  const ctx = useInvocationNodeContext();
  const selector = useMemo(() => ctx.buildSelectInputFieldTemplateSafe(fieldName), [ctx, fieldName]);
  return useAppSelector(selector);
};
