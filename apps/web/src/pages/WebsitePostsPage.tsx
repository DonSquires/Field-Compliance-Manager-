import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isAdminTierRole } from '../lib/roles';
import { supabase } from '../lib/supabase';
import { parseWebsitePost, prepareWebsitePhoto, type WebsitePost } from '../lib/websitePosts';
import type { NavigateWithContext } from '../lib/workflowNavigation';
import './PageStyles.css';
import './WebsitePostsPage.css';

type Draft = Pick<WebsitePost, 'title' | 'summary' | 'body' | 'photo_path' | 'photo_alt'>;
const emptyDraft: Draft = { title: '', summary: '', body: '', photo_path: null, photo_alt: '' };
const draftOf = (post: WebsitePost): Draft => ({
  title: post.title, summary: post.summary, body: post.body, photo_path: post.photo_path, photo_alt: post.photo_alt,
});

export default function WebsitePostsPage({ onNavigate }: { onNavigate: NavigateWithContext }) {
  const { profile } = useAuth();
  const allowed = isAdminTierRole(profile?.role);
  const context = `${profile?.id}:${profile?.organizationId}:${profile?.role}`;
  const currentContext = useRef(context);
  currentContext.current = context;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const postId = useRef<string>(crypto.randomUUID());
  const [posts, setPosts] = useState<WebsitePost[]>([]);
  const [selected, setSelected] = useState<WebsitePost | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [listAvailable, setListAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [approved, setApproved] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const dirty = JSON.stringify(draft) !== JSON.stringify(selected ? draftOf(selected) : emptyDraft);

  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!allowed) { setLoading(false); return; }
    setLoading(true);
    try {
      const { data, error: failure } = await supabase.rpc('list_website_posts');
      if (request !== generation.current || currentContext.current !== context) return;
      if (failure) {
        console.error('Website posts list failed', { code: failure.code });
        if (failure.code === '42501') setDenied(true);
        throw new Error('News updates could not be loaded. Try refreshing.');
      }
      if (!Array.isArray(data)) throw new Error('The news list response could not be verified.');
      setPosts(data.map(parseWebsitePost));
      setListAvailable(true);
    } catch (failure) {
      if (request === generation.current && currentContext.current === context) {
        setListAvailable(false);
        setError(failure instanceof Error ? failure.message : 'News updates could not be loaded. Try refreshing.');
      }
    } finally {
      if (request === generation.current && currentContext.current === context) setLoading(false);
    }
  }, [allowed, context]);

  useEffect(() => {
    setPosts([]); setSelected(null); setDraft(emptyDraft); setError(null); setNotice(null);
    setDenied(false); setBusy(false); setApproved(false); setConflict(false); setConfirmUnpublish(false);
    setListAvailable(false); inFlight.current = false;
    attempt.current = null; postId.current = crypto.randomUUID();
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  useEffect(() => {
    let active = true;
    setPreview(null);
    if (draft.photo_path && allowed) {
      void supabase.storage.from('website-post-images').createSignedUrl(draft.photo_path, 60).then(({ data, error: failure }) => {
        if (!active) return;
        if (failure || !data?.signedUrl) {
          console.error('Website draft photo preview failed', { code: failure?.name ?? 'invalid_receipt' });
          setError('Photo preview is unavailable. Reopen the update to try again.');
        } else setPreview(data.signedUrl);
      }, () => {
        if (active) setError('Photo preview is unavailable. Reopen the update to try again.');
      });
    }
    return () => { active = false; };
  }, [draft.photo_path, allowed, context]);

  function open(post: WebsitePost | null) {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    setSelected(post); setDraft(post ? draftOf(post) : emptyDraft);
    postId.current = post?.id ?? crypto.randomUUID();
    attempt.current = null;
    setError(null); setNotice(null); setApproved(false); setConflict(false); setConfirmUnpublish(false);
  }

  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setApproved(false); setConfirmUnpublish(false); setNotice(null);
  }

  async function save(action: 'save' | 'publish' | 'unpublish') {
    if (inFlight.current || conflict || loading || !listAvailable || !form.current?.reportValidity() || (action === 'publish' && !approved)) return;
    const operation = generation.current;
    inFlight.current = true;
    const values = {
      p_post_id: postId.current, p_expected_version: selected?.version ?? 0, p_action: action,
      p_title: draft.title.trim(), p_summary: draft.summary.trim(), p_body: draft.body.trim(),
      p_photo_path: draft.photo_path, p_photo_alt: draft.photo_alt.trim(),
    };
    const fingerprint = JSON.stringify({ context, ...values });
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true); setError(null); setNotice(null); setConfirmUnpublish(false);
    try {
      const { data, error: failure } = await supabase.rpc('manage_website_post', {
        ...values, p_request_id: attempt.current.id,
      });
      if (currentContext.current !== context || generation.current !== operation) return;
      if (failure) {
        console.error('Website post action failed', { code: failure.code });
        if (failure.code === '42501') setDenied(true);
        if (failure.code === '40001') {
          setConflict(true);
          throw new Error('This update changed elsewhere. Refresh the list and reopen it before saving.');
        }
        if (failure.code === '22023' && failure.message.includes('website_post_invalid:pricing_not_permitted')) {
          throw new Error('Do not publish prices, hourly rates or discounts. Each job is quoted for its scope and risk after a site assessment.');
        }
        if (failure.code === '22023') throw new Error('Check the title, update text, photo and photo description before trying again.');
        throw new Error('The action was not confirmed. Keep your text and retry unchanged, or refresh to verify the saved state.');
      }
      const saved = parseWebsitePost(data);
      if (saved.id !== values.p_post_id || saved.version !== values.p_expected_version + 1
        || (action === 'publish' && !saved.published_content)
        || (action === 'unpublish' && saved.published_content)) {
        throw new Error('The action receipt could not be verified. Refresh before continuing.');
      }
      setSelected(saved); setDraft(draftOf(saved)); setApproved(false); attempt.current = null;
      setPosts(previous => [saved, ...previous.filter(post => post.id !== saved.id)].slice(0, 100));
      setNotice(action === 'publish' ? 'Published to the website. Open the public update to check it.'
        : action === 'unpublish' ? 'Unpublished. This update is now a private draft.'
          : saved.published_content ? 'Draft saved. The published version is unchanged.' : 'Private draft saved.');
    } catch (failure) {
      if (currentContext.current === context && generation.current === operation) setError(failure instanceof Error ? failure.message : 'The action was not confirmed. Refresh to verify its state.');
    } finally {
      if (currentContext.current === context && generation.current === operation) { inFlight.current = false; setBusy(false); }
    }
  }

  async function upload(file: File) {
    if (!selected || inFlight.current || conflict || loading || !listAvailable) return;
    const operation = generation.current;
    inFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const photo = await prepareWebsitePhoto(file);
      if (currentContext.current !== context || generation.current !== operation) return;
      const path = `${selected.provider_organization_id}/${selected.id}/${crypto.randomUUID()}.jpg`;
      const { error: failure } = await supabase.storage.from('website-post-images').upload(path, photo, {
        contentType: 'image/jpeg', upsert: false,
      });
      if (currentContext.current !== context || generation.current !== operation) return;
      if (failure) {
        console.error('Website draft photo upload failed', { code: failure.name });
        throw new Error('The photo upload was not confirmed. Your update text has been kept; choose the photo again to retry.');
      }
      change('photo_path', path);
      setNotice('Photo uploaded privately. Save the draft or publish to attach it to the update.');
    } catch (failure) {
      if (currentContext.current === context && generation.current === operation) setError(failure instanceof Error ? failure.message : 'The photo could not be processed or uploaded.');
    } finally {
      if (currentContext.current === context && generation.current === operation) { inFlight.current = false; setBusy(false); }
    }
  }

  if (!allowed || denied) {
    return <div className="page-container website-posts-page"><h1>News and updates</h1>
      <p role="status">Only R&amp;M administrators can manage website updates.</p>
      <button className="btn btn-secondary" onClick={() => onNavigate('website')}>Back to Website</button></div>;
  }
  const visible = posts.filter(post => post.title.toLowerCase().includes(search.toLowerCase())
    && (filter === 'all' || (filter === 'published') === Boolean(post.published_content)));

  return <div className="page-container website-posts-page">
    <header className="page-header"><div><p>Website</p><h1>News and updates</h1>
      <p>Write privately, check your photo, then publish to the R&amp;M website.</p></div>
      <div className="website-posts-actions">
        <button className="btn btn-secondary" onClick={() => onNavigate('website')} disabled={busy}><ArrowLeft size={15} /> Website hub</button>
        <button className="btn btn-secondary" onClick={() => { setError(null); void load(); }} disabled={loading || busy}><RefreshCw size={15} /> Refresh list</button>
        <button className="btn btn-primary" onClick={() => open(null)} disabled={busy}><Plus size={15} /> New update</button>
      </div>
    </header>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <div className="website-posts-layout">
      <section className="website-posts-list" aria-label="Saved updates">
        <h2>Latest 100 updates</h2>
        <label>Search updates<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label>Status<select value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">All updates</option><option value="draft">Private drafts</option><option value="published">Published</option>
        </select></label>
        {loading ? <p role="status">Loading updates...</p> : !listAvailable ? <p>Saved updates could not be verified. Refresh the list to try again.</p> : visible.length === 0 ? <p>No matching updates.</p>
          : <ul>{visible.map(post => <li key={post.id}><button type="button" disabled={busy}
            className={selected?.id === post.id ? 'selected' : ''} onClick={() => open(post)}>
            <strong>{post.title}</strong><span>{post.published_content ? 'Published' : 'Private draft'}</span>
          </button></li>)}</ul>}
      </section>
      <form ref={form} className="website-posts-editor" onSubmit={event => { event.preventDefault(); void save('save'); }}>
        <h2>{selected ? 'Edit update' : 'Write an update'}</h2>
        {selected?.published_content && <p className="website-posts-note">A version is public. Draft edits stay private until you publish again.</p>}
        <fieldset disabled={busy || conflict || loading || !listAvailable}>
          <label>Title<input required maxLength={160} value={draft.title} onChange={event => change('title', event.target.value)} /></label>
          <label>Short summary (optional)<textarea rows={2} maxLength={300} value={draft.summary}
            onChange={event => change('summary', event.target.value)} /></label>
          <p>When no summary is entered, the first part of the update is used.</p>
          <label>Update text<textarea rows={10} maxLength={20000} value={draft.body} onChange={event => change('body', event.target.value)} /></label>
          <p>Plain text and paragraphs. Do not include private operational, customer or staff information. Do not publish prices or rates: each job is quoted after a site assessment.</p>
          <label>Add photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={!selected} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file);
          }} /></label>
          <p>{selected ? 'JPEG, PNG or WebP, up to 10 MB. Photos are resized and metadata is removed before upload.' : 'Save your first draft to enable photo upload.'}</p>
          {draft.photo_path && <div className="website-posts-photo">
            {preview && <img src={preview} alt={draft.photo_alt || 'Private draft photo preview'} />}
            <label>Photo description<input maxLength={240} value={draft.photo_alt}
              onChange={event => change('photo_alt', event.target.value)} /></label>
            <p>A description is required when publishing a photo.</p>
            <button type="button" className="btn btn-secondary" onClick={() => { change('photo_path', null); change('photo_alt', ''); }}>Remove photo from draft</button>
          </div>}
          <label className="website-posts-approval"><input type="checkbox" checked={approved}
            onChange={event => setApproved(event.target.checked)} /> I confirm this text and photo are approved for the public website.</label>
          <div className="website-posts-actions">
            <button type="submit" className="btn btn-secondary">Save draft</button>
            <button type="button" className="btn btn-primary" disabled={!approved || !draft.body.trim() || Boolean(draft.photo_path && !draft.photo_alt.trim())}
              onClick={() => void save('publish')}>{selected?.published_content ? 'Publish changes' : 'Publish to website'}</button>
            {selected?.published_content && <button type="button" className="btn btn-secondary" onClick={() => setConfirmUnpublish(true)}>Unpublish</button>}
          </div>
        </fieldset>
        {busy && <p role="status">Saving or uploading. Please wait...</p>}
        {confirmUnpublish && <div className="website-posts-note" role="alertdialog" aria-label="Confirm unpublish">
          <p>Remove this update from the public website and keep it as a private draft?</p>
          <button type="button" className="btn btn-secondary" onClick={() => setConfirmUnpublish(false)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void save('unpublish')}>Confirm unpublish</button>
        </div>}
        {selected?.published_content && <a className="btn btn-secondary" target="_blank" rel="noopener noreferrer"
          href={`https://www.randmsecurity.com/blog/${selected.slug}`}>Open public update <ExternalLink size={15} /></a>}
      </form>
    </div>
  </div>;
}
