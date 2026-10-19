/** Search syntax is separate from canonical plate identity: only % is a wildcard. */
export function vehiclePlateSearchPattern(input: string): string {
  const pattern = input.trim().toUpperCase().replace(/[\s-]/g, '').replace(/%+/g, '%');
  if (pattern.length > 38 || !/[A-Z0-9]/.test(pattern) || /[^A-Z0-9%]/.test(pattern)) {
    throw new Error('Enter part of a registration using letters, numbers and % wildcards.');
  }
  return pattern.includes('%') ? pattern : `%${pattern}%`;
}
