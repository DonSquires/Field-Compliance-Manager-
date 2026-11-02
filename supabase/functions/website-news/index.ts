// ATLAS EXTERNAL CALLER: randmsecurity-website-vercel-api
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.113.0';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

Deno.serve(async (request) => {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
  const query = new URL(request.url).searchParams;
  const image = query.get('image');
  const slug = query.get('slug');
  if ((query.has('image') && (!image || !uuid.test(image))) || (query.has('slug') && (!slug || !/^[a-z0-9-]{1,140}$/.test(slug)))
    || (image && slug) || [...query.keys()].some(key => !['image', 'slug'].includes(key) || query.getAll(key).length !== 1)) {
    return json(400, { error: 'invalid_request' });
  }
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('Missing service configuration');
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.rpc('read_published_website_posts', {
      p_slug: slug, p_id: image,
    });
    if (error) {
      console.error('website news read failed', { code: error.code });
      return json(503, { error: 'news_unavailable' });
    }
    if (!Array.isArray(data)) throw new Error('Invalid published post response');
    if (image) {
      const path = data[0]?.photo_path;
      if (typeof path !== 'string') return json(404, { error: 'not_found' });
      const { data: photo, error: photoError } = await client.storage.from('website-post-images').download(path);
      if (photoError || !photo || photo.type !== 'image/jpeg' || photo.size > 5242880) {
        console.error('website news photo unavailable', { code: photoError?.name ?? 'invalid_photo' });
        return json(503, { error: 'photo_unavailable' });
      }
      return new Response(photo, { headers: { ...headers, 'Content-Type': 'image/jpeg' } });
    }
    return json(200, data.map(({ photo_path, ...post }) => ({
      ...post, image_url: photo_path ? `/api/website-news?image=${post.id}` : null,
    })));
  } catch (error) {
    console.error('website news request failed', { error: error instanceof Error ? error.name : 'unknown' });
    return json(503, { error: 'news_unavailable' });
  }
});
