import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bell, BellRing, Check, CheckCheck, ChevronRight, CircleAlert, Info, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './NotificationCenter.css';

export type NotificationCategory =
  | 'credential_expiry' | 'sla_breach' | 'report_ready' | 'welfare' | 'dispatch'
  | 'roster' | 'open_job' | 'report_reviewed' | 'leave_decision' | 'timesheet_decision' | 'breach_decision' | 'system' | 'schema_change_request' | 'bob_conversation' | 'bob_self_memory';

export interface NotificationRecord {
  id: string;
  category: NotificationCategory;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  link_page: string | null;
  link_payload: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

interface NotificationCenterProps {
  onNavigate?: (notification: NotificationRecord) => boolean | void;
}

type ViewFilter = 'all' | 'unread' | 'critical';

export function NotificationCenter({ onNavigate }: NotificationCenterProps) {
  const { profile } = useAuth();
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<ViewFilter>('all');

  const load = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase
        .from('notifications')
        .select('id, category, severity, title, body, link_page, link_payload, read_at, created_at')
        .eq('organization_id', profile.organizationId)
        .order('created_at', { ascending: false })
        .limit(60);
      if (queryError) throw queryError;
      setRows((data as NotificationRecord[]) ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Notifications could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!profile?.organizationId) return;
    const channel = supabase
      .channel(`notification_center_${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `organization_id=eq.${profile.organizationId}` }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [load, profile?.id, profile?.organizationId]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [open]);

  const unreadCount = rows.filter((row) => !row.read_at).length;
  const visibleRows = useMemo(() => rows.filter((row) => {
    if (filter === 'unread') return !row.read_at;
    if (filter === 'critical') return row.severity === 'critical';
    return true;
  }), [filter, rows]);

  const markRead = useCallback(async (ids: string[]) => {
    if (!ids.length) return true;
    const readAt = new Date().toISOString();
    setBusy(ids.length === 1 ? ids[0] : 'all');
    setError(null);
    try {
      const { data, error: updateError } = await supabase
        .from('notifications')
        .update({ read_at: readAt })
        .in('id', ids)
        .is('read_at', null)
        .select('id');
      if (updateError) throw updateError;
      const updated = new Set((data ?? []).map((row) => row.id));
      setRows((current) => current.map((row) => updated.has(row.id) ? { ...row, read_at: readAt } : row));
      return true;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Read status could not be saved.');
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const openNotification = async (notification: NotificationRecord) => {
    if (!notification.read_at && !(await markRead([notification.id]))) return;
    const handled = onNavigate?.(notification);
    if (handled !== false) setOpen(false);
  };

  return (
    <div className="notification-center" ref={panelRef}>
      <button type="button" className="notification-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open} title={unreadCount ? `${unreadCount} unread notifications` : 'Notifications'}>
        {unreadCount ? <BellRing size={19} aria-hidden="true" /> : <Bell size={19} aria-hidden="true" />}
        {unreadCount > 0 && <span>{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      {open && (
        <section className="notification-panel" aria-label="Notifications">
          <header><div><span>Activity center</span><h2>Notifications</h2></div><button type="button" onClick={() => setOpen(false)} title="Close notifications"><X size={18} /><span className="sr-only">Close notifications</span></button></header>
          <div className="notification-toolbar">
            <div role="tablist" aria-label="Notification filter">{(['all', 'unread', 'critical'] as ViewFilter[]).map((item) => <button type="button" role="tab" aria-selected={filter === item} className={filter === item ? 'is-active' : ''} onClick={() => setFilter(item)} key={item}>{item}</button>)}</div>
            <button type="button" onClick={() => void markRead(rows.filter((row) => !row.read_at).map((row) => row.id))} disabled={!unreadCount || busy === 'all'} title="Mark all as read"><CheckCheck size={16} /><span>Mark all read</span></button>
          </div>

          {error && <div className="notification-error" role="alert"><AlertTriangle size={16} /> {error}</div>}
          {loading ? <div className="notification-empty"><RefreshCw size={19} className="is-spinning" /> Loading notifications</div> : visibleRows.length === 0 ? <div className="notification-empty"><Bell size={19} /> No notifications in this view</div> : (
            <div className="notification-list">
              {visibleRows.map((notification) => {
                const SeverityIcon = notification.severity === 'critical' ? ShieldAlert : notification.severity === 'warning' ? CircleAlert : Info;
                return (
                  <article className={`${notification.read_at ? 'is-read' : 'is-unread'} severity-${notification.severity}`} key={notification.id}>
                    <span className="notification-icon"><SeverityIcon size={17} /></span>
                    <button type="button" className="notification-content" onClick={() => void openNotification(notification)}>
                      <strong>{notification.title}</strong>
                      {notification.body && <span>{notification.body}</span>}
                      <small>{formatCategory(notification.category)} · {formatAge(notification.created_at)}</small>
                    </button>
                    {!notification.read_at ? <button type="button" className="notification-read-button" onClick={() => void markRead([notification.id])} disabled={busy === notification.id} title="Mark as read"><Check size={15} /></button> : notification.link_page ? <ChevronRight size={16} className="notification-chevron" /> : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function formatCategory(category: string): string {
  return category.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatAge(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}