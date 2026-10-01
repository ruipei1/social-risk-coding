// Combine earlier memo fields only until the unified field is explicitly saved.
export function observationsText(memos = {}) {
  if (typeof memos.observations === 'string') return memos.observations;
  return [
    ['at_stake', 'At stake'], ['unstated', 'Unstated details'],
    ['context', 'Context'], ['reflection', 'Other observations']
  ].filter(([key]) => memos[key]?.trim()).map(([key, label]) => `${label}: ${memos[key]}`).join('\n\n');
}
