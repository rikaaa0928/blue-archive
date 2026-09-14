type SelectionStoryUnit = {
  GroupId: number;
  SelectionGroup: number;
};

export function findSelectionTargetIndex(
  storyUnits: SelectionStoryUnit[],
  currentStoryIndex: number,
  selectionGroup: number
) {
  const currentStoryUnit = storyUnits[currentStoryIndex];
  if (!currentStoryUnit) return -1;

  return storyUnits.findIndex(
    (unit, storyIndex) =>
      storyIndex > currentStoryIndex &&
      unit.GroupId === currentStoryUnit.GroupId &&
      unit.SelectionGroup === selectionGroup
  );
}
