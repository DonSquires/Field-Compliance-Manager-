import { describe, expect, it } from 'vitest';
import { parseWebsitePost, prepareWebsitePhoto } from './websitePosts';

const row = {
  id: '00000000-0000-4000-8000-000000000001', provider_organization_id: '00000000-0000-4000-8000-000000000002',
  slug: 'synthetic-update', title: 'Synthetic update', summary: '', body: 'Synthetic text',
  photo_path: null, photo_alt: '', published_content: null, version: 1, updated_at: '2026-11-02T09:00:00Z',
};

describe('website post receipts', () => {
  it('accepts a verified private draft', () => expect(parseWebsitePost(row).published_content).toBeNull());
  it('rejects missing and malformed receipts', () => {
    for (const value of [null, [], {}, { ...row, version: 0 }, { ...row, body: null }, { ...row, photo_path: {} }]) {
      expect(() => parseWebsitePost(value)).toThrow();
    }
  });
  it('does not count an empty or mismatched public object as a publish receipt', () => {
    expect(() => parseWebsitePost({ ...row, published_content: {} })).toThrow(/published/);
    expect(() => parseWebsitePost({ ...row, published_content: { id: 'different' } })).toThrow(/published/);
  });
  it('preserves a separately verified public version while the draft changes', () => {
    const published = { id: row.id, slug: row.slug, title: 'Earlier public title', body: 'Earlier public text',
      published_at: row.updated_at, version: 1 };
    expect(parseWebsitePost({ ...row, version: 2, published_content: published }).published_content?.title).toBe('Earlier public title');
  });
  it('rejects unsupported photo types before attempting to decode them', async () => {
    await expect(prepareWebsitePhoto(new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }))).rejects.toThrow('JPEG, PNG or WebP');
  });
});
