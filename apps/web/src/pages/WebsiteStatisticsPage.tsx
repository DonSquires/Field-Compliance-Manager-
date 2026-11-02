import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, BarChart3, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isAdminTierRole } from '../lib/roles';
import {
  getWebsiteAnalyticsDateRange,
  parseWebsiteAnalyticsSummary,
  type WebsiteAnalyticsPeriod,
  type WebsiteAnalyticsSummary,
} from '../lib/websiteAnalytics';
import { supabase } from '../lib/supabase';
import type { NavigateWithContext } from '../lib/workflowNavigation';
import './PageStyles.css';
import './WebsiteStatisticsPage.css';

const PERIODS: Array<{ value: WebsiteAnalyticsPeriod; label: string }> = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

const numberFormatter = new Intl.NumberFormat('en-NZ');

function formatUtcDate(value: string): string {
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

export default function WebsiteStatisticsPage({ onNavigate }: { onNavigate: NavigateWithContext }) {
  const { profile } = useAuth();
  const canView = isAdminTierRole(profile?.role);
  const [period, setPeriod] = useState<WebsiteAnalyticsPeriod>(30);
  const [summary, setSummary] = useState<WebsiteAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const loadStatistics = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    const range = getWebsiteAnalyticsDateRange(period);
    setLoading(true);
    setLoadError(null);
    setPermissionDenied(false);
    const { data, error } = await supabase.rpc('get_website_page_view_summary', {
      p_from: range.from,
      p_to: range.to,
    });
    if (error) {
      setSummary(null);
      if (error.code === '42501') setPermissionDenied(true);
      else setLoadError('Website statistics could not be loaded. Try again.');
    } else {
      const parsed = parseWebsiteAnalyticsSummary(data);
      if (!parsed) {
        setSummary(null);
        setLoadError('The statistics response was not in the expected format.');
      } else {
        setSummary(parsed);
      }
    }
    setLoading(false);
  }, [canView, period]);

  useEffect(() => {
    void loadStatistics();
  }, [loadStatistics]);

  if (!canView || permissionDenied) {
    return (
      <div className="page-container website-statistics-page">
        <div className="module-access-state" role="status">
          <ShieldAlert size={22} aria-hidden="true" />
          <h1>Only R&amp;M administrators can see website statistics</h1>
          <p>Ask an R&amp;M administrator if you need aggregate website activity.</p>
          <button type="button" className="btn btn-secondary" onClick={() => onNavigate('website')}>
            <ArrowLeft size={15} aria-hidden="true" /> Back to Website
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container website-statistics-page">
      <header className="page-header">
        <div>
          <p className="website-statistics-eyebrow">Clients &amp; Delivery / Website</p>
          <h1>Website statistics</h1>
          <p>Daily page views and approximate regional totals. This view does not measure unique visitors.</p>
        </div>
        <div className="website-statistics-header-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNavigate('website')}>
            <ArrowLeft size={14} aria-hidden="true" /> Back to Website
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadStatistics()} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
      </header>

      <div className="website-statistics-toolbar">
        <div className="website-statistics-periods" role="group" aria-label="Statistics date range">
          {PERIODS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`btn btn-sm ${period === option.value ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={period === option.value}
              onClick={() => setPeriod(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="website-statistics-retention">Aggregate data retained for 12 months</span>
      </div>

      <aside className="website-statistics-privacy" role="note">
        <strong>Privacy:</strong> daily aggregates only; no visitor IDs, unique-visitor metrics, raw IP addresses,
        city-level location, or user-agent values. Regional totals with fewer than five page views are withheld.
      </aside>

      {loadError && (
        <div className="alert alert-error website-statistics-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void loadStatistics()}>Try again</button>
        </div>
      )}

      {loading ? (
        <div className="loading-state" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Loading website statistics…</span>
        </div>
      ) : !loadError && summary ? (
        <>
          <section className="website-statistics-total" aria-label="Total page views">
            <BarChart3 size={20} aria-hidden="true" />
            <div>
              <span>Page views in selected period</span>
              <strong aria-live="polite">{numberFormatter.format(summary.total_page_views)}</strong>
            </div>
          </section>
          {summary.total_page_views === 0 && (
            <p className="website-statistics-empty" role="status">
              No page-view aggregates were recorded in this period. If collection is expected, check that the approved notice is published and analytics is enabled.
            </p>
          )}
          <div className="website-statistics-tables">
            <section className="website-statistics-section" aria-labelledby="website-pages-heading">
              <h2 id="website-pages-heading">Pages</h2>
              {summary.pages.length === 0 ? <p>No page totals for this period.</p> : (
                <table>
                  <thead><tr><th scope="col">Page</th><th scope="col">Page views</th></tr></thead>
                  <tbody>
                    {summary.pages.map((item) => (
                      <tr key={item.page_path}>
                        <th scope="row">{item.page_path === '/' ? 'Home' : item.page_path}</th>
                        <td>{numberFormatter.format(item.page_views)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="website-statistics-section" aria-labelledby="website-regions-heading">
              <h2 id="website-regions-heading">Approximate regions</h2>
              {summary.regions.length === 0 ? <p>No regions met the reporting threshold in this period.</p> : (
                <table>
                  <thead><tr><th scope="col">Country / region</th><th scope="col">Page views</th></tr></thead>
                  <tbody>
                    {summary.regions.map((item) => (
                      <tr key={`${item.country_code}-${item.region_code}`}>
                        <th scope="row">{item.country_code} · {item.region_code}</th>
                        <td>{numberFormatter.format(item.page_views)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="website-statistics-section website-statistics-daily" aria-labelledby="website-daily-heading">
              <h2 id="website-daily-heading">Daily activity (UTC)</h2>
              {summary.daily.length === 0 ? <p>No daily totals for this period.</p> : (
                <table>
                  <thead><tr><th scope="col">Date</th><th scope="col">Page views</th></tr></thead>
                  <tbody>
                    {summary.daily.map((item) => (
                      <tr key={item.viewed_on}>
                        <th scope="row">{formatUtcDate(item.viewed_on)}</th>
                        <td>{numberFormatter.format(item.page_views)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
