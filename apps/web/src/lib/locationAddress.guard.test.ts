import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/lib/locationAddress.ts'), 'utf8');

describe('location address resolver', () => {
  it('keeps address lookup behind the server-side LINZ and Google proxy', () => {
    expect(source).toContain("functions.invoke<{ candidates?: AddressCandidate[] }>('linz-lookup'");
    expect(source).toContain("action: 'address_autocomplete'");
    expect(source).toContain("'google_address'");
    expect(source).not.toContain('maps.googleapis.com');
  });
});