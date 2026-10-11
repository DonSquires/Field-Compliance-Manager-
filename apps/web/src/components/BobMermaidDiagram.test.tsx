import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from './BobMermaidDiagram';

describe('sanitizeSvg', () => {
  it('preserves text-only Mermaid labels while removing executable foreign content', () => {
    const svg = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <foreignObject x="0" y="0" width="200" height="40">
          <div xmlns="http://www.w3.org/1999/xhtml" style="background:url(https://example.invalid)" onclick="alert(1)">
            <script>alert(1)</script>
            <span>Safe label</span>
            <img src="https://example.invalid/tracker.png" />
          </div>
        </foreignObject>
      </svg>
    `);

    expect(svg).not.toBeNull();
    expect(svg?.querySelector('foreignObject')).not.toBeNull();
    expect(svg?.textContent).toContain('Safe label');
    expect(svg?.querySelector('script, img')).toBeNull();
    expect(svg?.querySelector('div')?.hasAttribute('onclick')).toBe(false);
    expect(svg?.querySelector('div')?.hasAttribute('style')).toBe(false);
  });
});
