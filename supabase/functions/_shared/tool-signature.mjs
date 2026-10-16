export function toolSignature(tool, args) {
  return `${tool}::${JSON.stringify(args, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  })}`;
}
