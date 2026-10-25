import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BuilderMemoryRecall } from './BuilderMemoryRecall';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke } } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('recalls privately only on request and does not include any memory until the reviewer selects an excerpt', async () => {
  const onUse = vi.fn();
  invoke.mockResolvedValue({ data: { ok: true, memories: [{ id: 'memory-id', content: 'A private diary lesson.', memory_type: 'reflection', created_at: '2026-10-25' }] }, error: null });
  render(<BuilderMemoryRecall disabled={false} onUse={onUse} onError={vi.fn()} />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Memory search'), { target: { value: 'Atlas' } });
  fireEvent.click(screen.getByText('Recall private memories'));
  expect(await screen.findByText('A private diary lesson.')).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith('bob-self-memory-read', { body: { search: 'Atlas', limit: 5 } });
  expect(onUse).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Use excerpt in reviewed summary'));
  expect(onUse).toHaveBeenCalledWith(expect.stringContaining('unverified reflection excerpt'));
  expect(onUse).toHaveBeenCalledWith(expect.stringContaining('A private diary lesson.'));
});

it('labels bounded excerpts, empty memory and failures without inventing continuity', async () => {
  const onError = vi.fn(), onUse = vi.fn();
  invoke.mockResolvedValueOnce({ data: { ok: true, memories: [{ id: 'm', content: 'a'.repeat(2500), memory_type: 'builder_note', created_at: '2026-10-25' }] }, error: null });
  const { rerender } = render(<BuilderMemoryRecall disabled={false} onUse={onUse} onError={onError} />);
  fireEvent.click(screen.getByText('Recall private memories'));
  expect(await screen.findByText(/first 2,000 characters/)).toBeTruthy();
  fireEvent.click(screen.getByText('Use excerpt in reviewed summary'));
  expect(onUse.mock.calls[0][0]).not.toContain('a'.repeat(2001));
  invoke.mockResolvedValueOnce({ data: { ok: true, memories: [] }, error: null });
  fireEvent.click(screen.getByText('Recall private memories'));
  expect(await screen.findByText(/No matching memories/)).toBeTruthy();
  invoke.mockResolvedValueOnce({ error: new Error('Forbidden') });
  fireEvent.click(screen.getByText('Recall private memories'));
  await waitFor(() => expect(onError).toHaveBeenCalledWith('Private memory recall failed: Forbidden'));
  rerender(<BuilderMemoryRecall disabled onUse={onUse} onError={onError} />);
  expect((screen.getByText('Recall private memories') as HTMLButtonElement).disabled).toBe(true);
});
