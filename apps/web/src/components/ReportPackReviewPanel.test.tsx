import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activityReportFixture } from '../lib/reportActivity.fixture';
import { ReportPackReviewPanel, type ReviewableReportPack } from './ReportPackReviewPanel';

const invoke = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) }, rpc: vi.fn() } }));
vi.mock('./ReportActivityReview', () => ({ ReportActivityReview: ({ summary }: { summary?: string }) => <p data-testid="preview">{summary}</p> }));

const DRAFT = 'During the period 3 patrols were completed.\n\nDiesel was taken at Smiths.';

function pack(overrides: Partial<ReviewableReportPack> = {}): ReviewableReportPack {
  return {
    id: 'pack-1', template_code: 'monthly_summary', report_kind: 'monthly', report_scope: {},
    period_start: '2026-10-01', period_end: '2026-10-31', status: 'draft',
    data: { activityReport: activityReportFixture }, editorial: null, updated_at: '2026-11-01T00:00:00Z',
    reviewed_at: null, published_at: null, delivery_channel: 'email', agreementName: 'Forest Co', ...overrides,
  };
}

const summaryBox = () => screen.getByRole('textbox', { name: 'Executive summary' }) as HTMLTextAreaElement;

describe('ReportPackReviewPanel executive summary drafting', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('prepopulates an empty summary with Bob\'s draft, unsaved, and shows it in the preview', async () => {
    invoke.mockResolvedValue({ data: { summary: DRAFT }, error: null });
    render(<ReportPackReviewPanel pack={pack()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(summaryBox().value).toBe(DRAFT));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('draft-report-executive-summary', { body: { pack_id: 'pack-1' } });
    expect(screen.getByText(/it is not saved until you save the draft or publish/)).toBeTruthy();
    expect(screen.getByTestId('preview').textContent).toBe(DRAFT);
    expect(screen.getByRole('button', { name: /Redraft with Bob/ })).toBeTruthy();
  });

  it('never auto-drafts over a saved summary, sent pack or report without activity', () => {
    render(<ReportPackReviewPanel pack={pack({ editorial: { executive_summary: 'Saved words.' } })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(summaryBox().value).toBe('Saved words.');
    render(<ReportPackReviewPanel pack={pack({ id: 'pack-2', status: 'sent' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    render(<ReportPackReviewPanel pack={pack({ id: 'pack-3', data: {} })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps text typed while the automatic draft was running', async () => {
    let finish: (value: unknown) => void = () => undefined;
    invoke.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<ReportPackReviewPanel pack={pack()} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(summaryBox(), { target: { value: 'My own words.' } });
    await act(async () => finish({ data: { summary: DRAFT }, error: null }));
    expect(summaryBox().value).toBe('My own words.');
  });

  it('asks before replacing written text and reports a failed draft without losing it', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(<ReportPackReviewPanel pack={pack({ editorial: { executive_summary: 'Saved words.' } })} onClose={vi.fn()} onSaved={vi.fn()} />);
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /Redraft with Bob/ }));
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue({ data: null, error: { message: 'Edge Function returned a non-2xx status code' } });
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /Redraft with Bob/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Bob could not draft the summary/);
    expect(summaryBox().value).toBe('Saved words.');
    confirm.mockRestore();
  });
});
