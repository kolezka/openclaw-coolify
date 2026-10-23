export function mergePatch(original, patch) {
  const result = structuredClone(original);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergePatch(result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? result[key] : {}, value);
    } else result[key] = structuredClone(value);
  }
  return result;
}
