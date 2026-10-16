import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureBobPageContext } from './bobPageContext';

describe('Bob page context', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

  it('captures current visible navigation hints, never private data or draft field values', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    document.body.innerHTML = `<main data-app-content>
      <h1>Account register</h1><button>Review proposal</button><button disabled>Apply</button>
      <input value="private draft"><table><tbody><tr><td>Private table data<button>Private record action</button></td></tr></tbody></table>
      <div data-bob-private><h2>Private heading</h2><button>Private action</button></div>
      <div hidden><h2>Hidden heading</h2></div><div class="bob-panel"><h2>Chat content</h2></div>
    </main>`;
    expect(captureBobPageContext()).toEqual({
      path: '/',
      headings: ['Account register'],
      controls: ['Review proposal', 'Apply'],
    });
    document.querySelector('h1')!.textContent = 'Agreements';
    expect(captureBobPageContext().headings).toEqual(['Agreements']);
  });
});
