import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/context/ServiceRelationshipContext.tsx'), 'utf8');

describe('service relationship operational scope', () => {
  it('loads only active agreement-location links', () => {
    expect(source).toContain(".from('service_agreement_locations')");
    expect(source).toContain(".eq('status', 'active')");
  });
});