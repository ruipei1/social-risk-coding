export function addSelectedCode(dimension, selectedIds, pickedId, codes) {
  let ids = [...new Set([...selectedIds, pickedId])];
  if (!['who','anticipated_interpersonal_consequence'].includes(dimension)) return ids;
  const unspecified = codes.find(code => code.dimension === dimension && code.name === 'Unspecified' && code.status !== 'retired')?.id;
  if (pickedId === unspecified) return [pickedId];
  if (unspecified) ids = ids.filter(id => id !== unspecified);
  return ids;
}
