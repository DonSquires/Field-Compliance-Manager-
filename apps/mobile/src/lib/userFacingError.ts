export function userFacingError(error: unknown, message: string): string {
  console.error('Mobile field workflow failed', error);
  return message;
}