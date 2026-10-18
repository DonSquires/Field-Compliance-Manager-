/** Capture navigation hints, not form values, table data, or hidden content. */
export function captureVisiblePageLabels(selector: string, limit: number) {
  const page = document.querySelector<HTMLElement>('[data-app-content]');
    if (!page) return [];
    const elements = Array.from(page.querySelectorAll<HTMLElement>(selector));
    return [...new Set(elements.filter(element =>
      !element.closest('.bob-panel, [role="dialog"], dialog, [hidden], [aria-hidden="true"], [data-bob-private], table, [role="grid"], [role="table"]')
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden',
    ).map(element => (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean))].slice(0, limit);
}

export function captureBobPageContext() {
  return {
    path: window.location.pathname,
    headings: captureVisiblePageLabels('h1, h2, h3, [role="heading"]', 12),
    controls: captureVisiblePageLabels('button, a, [role="tab"]', 24),
  };
}
