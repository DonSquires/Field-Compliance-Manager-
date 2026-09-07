import { useEffect, useId, useRef, useState } from 'react';

function sanitizeSvg(svgText: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (!(svg instanceof SVGSVGElement)) return null;

  svg.querySelectorAll('script, foreignObject, iframe, object, embed').forEach((node) => node.remove());
  svg.querySelectorAll('*').forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href') && (value.startsWith('javascript:') || value.startsWith('data:')))) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return svg;
}

export function BobMermaidDiagram({ chart, title = 'Bob diagram' }: { chart: string; title?: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const renderChart = async () => {
      setRendering(true);
      setError(null);
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
          themeVariables: {
            background: '#07111c',
            primaryColor: '#123a44',
            primaryTextColor: '#e8f4f2',
            primaryBorderColor: '#61c7bb',
            lineColor: '#87aab8',
            secondaryColor: '#1b3342',
            tertiaryColor: '#0d2233',
            fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
          },
        });
        const { svg } = await mermaid.render(`bob-diagram-${reactId}`, chart);
        const safeSvg = sanitizeSvg(svg);
        if (!safeSvg) throw new Error('Diagram renderer returned no SVG.');
        if (!cancelled && hostRef.current) hostRef.current.replaceChildren(document.importNode(safeSvg, true));
      } catch (renderError) {
        if (!cancelled) setError(renderError instanceof Error ? renderError.message : 'Diagram could not be rendered.');
      } finally {
        if (!cancelled) setRendering(false);
      }
    };

    void renderChart();
    return () => { cancelled = true; };
  }, [chart, reactId]);

  return (
    <figure className="bob-mermaid" aria-label={title}>
      {error ? <pre>{chart}</pre> : <div ref={hostRef} className="bob-mermaid-canvas" role="img" aria-label={title} />}
      {rendering && !error && <figcaption>Rendering diagram…</figcaption>}
      {error && <figcaption role="alert">Diagram preview failed: {error}</figcaption>}
    </figure>
  );
}
