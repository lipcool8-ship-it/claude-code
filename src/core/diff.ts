import { createPatch } from "diff";

export interface DiffResult {
  patch: string;
  hasChanges: boolean;
}

export function computeDiff(
  originalContent: string,
  newContent: string,
  filePath: string
): DiffResult {
  const patch = createPatch(filePath, originalContent, newContent, "original", "proposed");
  const hasChanges = originalContent !== newContent;
  return { patch, hasChanges };
}
