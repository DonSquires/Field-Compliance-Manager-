import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPlaceServices, type PlaceService, type PlaceServicesWorkspace } from '../../lib/placeServices';
import { CheckTypesDialog } from './CheckTypesDialog';
import { PatrolScheduleEditor } from './PatrolScheduleEditor';
import { PlaceSettingsPanel } from './PlaceSettingsPanel';
import { ResponsibleRunDialog } from './ResponsibleRunDialog';
import { ServiceCard } from './ServiceCard';
import { StaticPostDialog } from './StaticPostDialog';
import './PlaceServicesTab.css';

export function PlaceServicesTab({ locationId, moduleLabels = {} }: { locationId: string; moduleLabels?: Record<string, string> }) {
  const [workspace, setWorkspace] = useState<PlaceServicesWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ service: PlaceService | null; ending: boolean } | null>(null);
  const [panel, setPanel] = useState<{ kind: 'static_post' | 'check_types' | 'settings' } | { kind: 'responsible_run'; service: PlaceService } | null>(null);
  const loadSequence = useRef(0);
  const activeLocation = useRef(locationId);
  const mounted = useRef(false);
  activeLocation.current = locationId;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchPlaceServices(locationId);
      if (sequence === loadSequence.current) setWorkspace(next);
    } catch (cause) {
      if (sequence === loadSequence.current) {
        setWorkspace(null);
        setError(cause instanceof Error ? cause.message : 'Services could not be loaded');
      }
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [locationId]);
  useEffect(() => {
    setEditor(null);
    setPanel(null);
    setNotice(null);
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  if (loading) return <p role="status">Loading patrols and services…</p>;
  if (error || !workspace) return <div><p role="alert">{error ?? 'Services could not be loaded'}</p><button type="button" onClick={() => void load()}>Retry</button></div>;
  if (!workspace.location) return <section className="place-services">
    <h3>Patrols &amp; services</h3>
    <p>No operational agreement is available to you for this place, or you do not have permission to view its services. Check the client portfolio or contact an administrator.</p>
    <a href="/admin/crm">Open the client portfolio</a>
  </section>;

  if (editor) return <PatrolScheduleEditor locationId={locationId} workspace={workspace} service={editor.service} ending={editor.ending}
    moduleLabels={moduleLabels} onCancel={() => setEditor(null)} onSaved={status => {
      if (!mounted.current || activeLocation.current !== locationId) return;
      setEditor(null);
      setNotice(status === 'pending' ? 'Change saved and waiting for approval.' : 'Change saved.');
      void load();
    }} />;

  const closePanel = (changed: boolean) => {
    setPanel(null);
    if (changed) void load();
  };
  if (panel?.kind === 'static_post') return <StaticPostDialog locationId={locationId} workspace={workspace} onClose={closePanel} />;
  if (panel?.kind === 'check_types') return <CheckTypesDialog workspace={workspace} onClose={closePanel} />;
  if (panel?.kind === 'settings') return <PlaceSettingsPanel workspace={workspace} onClose={closePanel} />;
  if (panel?.kind === 'responsible_run') return <ResponsibleRunDialog locationId={locationId} service={panel.service}
    onClose={() => setPanel(null)} onSaved={() => {
      if (!mounted.current || activeLocation.current !== locationId) return;
      setPanel(null);
      setNotice('Responsible run saved.');
      void load();
    }} />;

  const canAdd = workspace.can_manage && workspace.agreements.length > 0;
  return <section className="place-services">
    <div className="place-manager-heading">
      <div><h3>Patrols &amp; services</h3><p>Services and schedules delivered at this place.</p></div>
      {canAdd && <div className="place-service-actions">
        <button type="button" className="is-primary" onClick={() => setEditor({ service: null, ending: false })}>Add patrol</button>
        <button type="button" onClick={() => setPanel({ kind: 'static_post' })} disabled={!workspace.anchors.length}>Add static post</button>
        <button type="button" onClick={() => setPanel({ kind: 'check_types' })}>Check types</button>
        {workspace.settings && <button type="button" onClick={() => setPanel({ kind: 'settings' })}>Settings</button>}
      </div>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {!workspace.can_manage && <p>You can view but not change this place's services.</p>}
    {workspace.can_manage && !workspace.agreements.length && <p>No operational agreement is available for this place. <a href={`/admin/crm?account=${encodeURIComponent(workspace.location?.organization_id ?? '')}`}>Open the client portfolio to add an agreement</a>.</p>}
    {workspace.can_manage && workspace.agreements.length > 0 && !workspace.anchors.length && <p>Add a site or work area to this place before creating a patrol.</p>}
    {!workspace.services.length ? <p>No patrols or services at this place yet.</p> : <div className="place-service-list">
      {workspace.services.map((service, index) => <ServiceCard key={service.delivery_schedule_id ?? service.work_unit?.id ?? service.pending?.version_id ?? index}
        service={service} workspace={workspace} moduleLabels={moduleLabels}
        onEdit={() => setEditor({ service, ending: false })} onEnd={() => setEditor({ service, ending: true })} onResponsibleRun={() => setPanel({ kind: 'responsible_run', service })}
        onPostEnded={status => {
          if (!mounted.current || activeLocation.current !== locationId) return;
          setNotice(status === 'pending' ? 'Ending this post is waiting for approval.' : 'Static post ended. Existing rostered shifts are kept.');
          void load();
        }} />)}
    </div>}
  </section>;
}
