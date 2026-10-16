/** Capture navigation hints, not form values, table data, or hidden content. */
export function captureBobPageContext() {
  const page = document.querySelector<HTMLElement>('[data-app-content]');
  const labels = (selector: string, limit: number) => {
    if (!page) return [];
    const elements = Array.from(page.querySelectorAll<HTMLElement>(selector));
    return [...new Set(elements.filter(element =>
      !element.closest('.bob-panel, [hidden], [aria-hidden="true"], [data-bob-private], table, [role="grid"], [role="table"]')
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden',
    ).map(element => (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean))].slice(0, limit);
  };
  return {
    path: window.location.pathname,
    headings: labels('h1, h2, h3, [role="heading"]', 12),
    controls: labels('button, a, [role="tab"]', 24),
  };
}
