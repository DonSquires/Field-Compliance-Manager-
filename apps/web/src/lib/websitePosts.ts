export interface WebsitePost {
  id: string;
  provider_organization_id: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  photo_path: string | null;
  photo_alt: string;
  published_content: Record<string, unknown> | null;
  version: number;
  updated_at: string;
}

export function parseWebsitePost(value: unknown): WebsitePost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid website post receipt.');
  const row = value as Record<string, unknown>;
  const strings = ['id', 'provider_organization_id', 'slug', 'title', 'summary', 'body', 'photo_alt', 'updated_at'];
  if (strings.some(key => typeof row[key] !== 'string')
    || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || (row.photo_path !== null && typeof row.photo_path !== 'string')
    || (row.published_content !== null && (!row.published_content
      || typeof row.published_content !== 'object' || Array.isArray(row.published_content)))) {
    throw new Error('The saved website post could not be verified. Reload before continuing.');
  }
  const published = row.published_content as Record<string, unknown> | null;
  if (published && (published.id !== row.id || published.slug !== row.slug
    || typeof published.title !== 'string' || !published.title.trim()
    || typeof published.body !== 'string' || !published.body.trim()
    || typeof published.published_at !== 'string' || !Number.isFinite(Date.parse(published.published_at))
    || !Number.isSafeInteger(published.version) || Number(published.version) < 1 || Number(published.version) > Number(row.version))) {
    throw new Error('The published website post receipt could not be verified. Reload before continuing.');
  }
  return {
    id: String(row.id), provider_organization_id: String(row.provider_organization_id), slug: String(row.slug),
    title: String(row.title), summary: String(row.summary), body: String(row.body),
    photo_path: row.photo_path as string | null, photo_alt: String(row.photo_alt),
    published_content: published,
    version: Number(row.version), updated_at: String(row.updated_at),
  };
}

export async function prepareWebsitePhoto(file: File): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error('Choose a JPEG, PNG or WebP photo smaller than 10 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40000000) throw new Error('This photo is too large. Choose a smaller image.');
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo processing is unavailable in this browser.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const photo = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The photo could not be processed.')), 'image/jpeg', 0.85);
    });
    if (photo.size > 5 * 1024 * 1024) throw new Error('The processed photo is too large. Choose a smaller image.');
    return photo;
  } finally {
    bitmap.close();
  }
}
