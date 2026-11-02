import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, BarChart3, ExternalLink, FileText, Inbox, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isAdminTierRole } from '../lib/roles';
import { getWebsiteAnalyticsDateRange, parseWebsiteAnalyticsSummary } from '../lib/websiteAnalytics';
import { supabase } from '../lib/supabase';
import type { NavigateWithContext } from '../lib/workflowNavigation';
import './PageStyles.css';
import './WebsiteHubPage.css';

const numberFormatter = new Intl.NumberFormat('en-NZ');

export default function WebsiteHubPage({ onNavigate }: { onNavigate: NavigateWithContext }) {
  const { profile } = useAuth();
  const canView = isAdminTierRole(profile?.role);
  const [newEnquiries, setNewEnquiries] = useState<number | null>(null);
  const [pageViews, setPageViews] = useState<number | null>(null);
  const [enquiryError, setEnquiryError] = useState<string | null>(null);
  const [statisticsError, setStatisticsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setEnquiryError(null);
    setStatisticsError(null);
    const range = getWebsiteAnalyticsDateRange(30);
    const [enquiryResult, statisticsResult] = await Promise.all([
      supabase.from('website_enquiries').select('id', { count: 'exact', head: true }).eq('status', 'new'),
      supabase.rpc('get_website_page_view_summary', { p_from: range.from, p_to: range.to }),
    ]);

    if (enquiryResult.error) {
      setNewEnquiries(null);
      setEnquiryError('New enquiry count is unavailable. Try refreshing.');
    } else {
      setNewEnquiries(enquiryResult.count ?? 0);
    }

    const summary = parseWebsiteAnalyticsSummary(statisticsResult.data);
    if (statisticsResult.error || !summary) {
      setPageViews(null);
      setStatisticsError('Website statistics are unavailable. Try refreshing.');
    } else {
      setPageViews(summary.total_page_views);
    }
    setLoading(false);
  }, [canView]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  if (!canView) {
    return (
      <div className="page-container website-hub-page">
        <div className="module-access-state" role="status">
          <ShieldAlert size={22} aria-hidden="true" />
          <h1>Only R&amp;M administrators can see website information</h1>
          <p>Ask an R&amp;M administrator if you need to follow up an enquiry or view website statistics.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container website-hub-page">
      <header className="page-header">
        <div>
          <p className="website-hub-eyebrow">Clients &amp; Delivery</p>
          <h1>Website</h1>
          <p>Review enquiries, check website statistics, and publish news and updates.</p>
        </div>
        <div className="website-hub-header-actions">
          <a className="btn btn-secondary btn-sm" href="https://randmsecurity.com" target="_blank" rel="noopener noreferrer">
            Open public website <ExternalLink size={14} aria-hidden="true" />
          </a>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadSummary()} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
      </header>

      <section className="website-hub-cards" aria-label="Website workspaces">
        <article className="website-hub-card">
          <div className="website-hub-card-icon" aria-hidden="true"><FileText size={20} /></div>
          <div className="website-hub-card-content">
            <h2>News and updates</h2>
            <p>Write an update, add a photo, and publish it to the public website. Drafts stay private.</p>
            <button type="button" className="btn btn-primary" onClick={() => onNavigate('website-posts')}>
              Write or manage updates <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </article>
        <article className="website-hub-card">
          <div className="website-hub-card-icon" aria-hidden="true"><Inbox size={20} /></div>
          <div className="website-hub-card-content">
            <h2>Website enquiries</h2>
            <p>Review new requests and follow up with people who contacted R&amp;M.</p>
            <p className="website-hub-metric" aria-live="polite">
              <strong>{loading ? 'Loading…' : enquiryError ? 'Unavailable' : numberFormatter.format(newEnquiries ?? 0)}</strong>
              <span>new enquiries</span>
            </p>
            {enquiryError && <p className="website-hub-card-error" role="status">{enquiryError}</p>}
            <button type="button" className="btn btn-primary" onClick={() => onNavigate('website-enquiries')}>
              Open enquiries <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </article>

        <article className="website-hub-card">
          <div className="website-hub-card-icon" aria-hidden="true"><BarChart3 size={20} /></div>
          <div className="website-hub-card-content">
            <h2>Website statistics</h2>
            <p>See daily page views and approximate regional totals for the last 30 days.</p>
            <p className="website-hub-metric" aria-live="polite">
              <strong>{loading ? 'Loading…' : statisticsError ? 'Unavailable' : numberFormatter.format(pageViews ?? 0)}</strong>
              <span>page views, not visitors</span>
            </p>
            {statisticsError && <p className="website-hub-card-error" role="status">{statisticsError}</p>}
            <button type="button" className="btn btn-primary" onClick={() => onNavigate('website-statistics')}>
              Open statistics <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </article>
      </section>

      <aside className="website-hub-privacy" role="note">
        <strong>Privacy boundary:</strong> website activity is stored as daily aggregates only. The view does not identify visitors,
        count unique visitors, or store raw IP addresses or user-agent values.
      </aside>
    </div>
  );
}
