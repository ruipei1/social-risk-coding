export function addSelectedCode(dimension, selectedIds, pickedId, codes) {
  let ids = [...new Set([...selectedIds, pickedId])];
  if (dimension !== 'who') return ids;
  const unspecified = codes.find(code => code.dimension === 'who' && code.name === 'Unspecified' && code.status !== 'retired')?.id;
  if (pickedId === unspecified) return [pickedId];
  if (unspecified) ids = ids.filter(id => id !== unspecified);
  return ids;
}
