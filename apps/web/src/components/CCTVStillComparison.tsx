import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Image, ScanSearch, ShieldCheck } from 'lucide-react';
import { analyseFramePixels, cssFilterFor, planEnhancement } from '../lib/cctvEnhance';
import './CCTVStillComparison.css';

export type EnhancementReceipt = {
  profile?: string;
  operations?: string[];
  generative?: boolean;
  source_sha256?: string;
  enhanced_sha256?: string;
};

export type CCTVStillComparisonProps = {
  original: string;
  enhanced?: string | null;
  receipt?: EnhancementReceipt | null;
  subjectLabel: string;
};

const ANALYSIS_WIDTH = 128;
const MAX_PREVIEW_WIDTH = 1600;

export function CCTVStillComparison({ original, enhanced = null, receipt = null, subjectLabel }: CCTVStillComparisonProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const storedDerivative = Boolean(enhanced);

  useEffect(() => {
    if (storedDerivative || !canvasRef.current) return;
    let active = true;
    const image = new window.Image();
    image.decoding = 'async';
    image.onload = () => {
      if (!active || !canvasRef.current) return;
      try {
        const canvas = canvasRef.current;
        const scale = Math.min(2, MAX_PREVIEW_WIDTH / Math.max(1, image.naturalWidth));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const analysisHeight = Math.max(8, Math.round(ANALYSIS_WIDTH * image.naturalHeight / Math.max(1, image.naturalWidth)));
        const analysis = document.createElement('canvas');
        analysis.width = ANALYSIS_WIDTH;
        analysis.height = analysisHeight;
        const analysisContext = analysis.getContext('2d', { willReadFrequently: true });
        const output = canvas.getContext('2d');
        if (!analysisContext || !output) throw new Error('Image canvas is unavailable');
        analysisContext.drawImage(image, 0, 0, ANALYSIS_WIDTH, analysisHeight);
        const stats = analyseFramePixels(analysisContext.getImageData(0, 0, ANALYSIS_WIDTH, analysisHeight).data, ANALYSIS_WIDTH, analysisHeight);
        const plan = planEnhancement(stats, { zoom: scale, smoothing: 1 });
        output.imageSmoothingEnabled = true;
        output.imageSmoothingQuality = 'high';
        output.filter = cssFilterFor(plan, { brightness: 100, contrast: 100, saturation: 100, detail: 100 });
        output.drawImage(image, 0, 0, canvas.width, canvas.height);
        output.filter = 'none';
        setPreviewError(null);
      } catch (error) {
        setPreviewError(error instanceof Error ? error.message : 'Enhanced preview could not be rendered');
      }
    };
    image.onerror = () => { if (active) setPreviewError('Original still could not be read for comparison'); };
    image.src = original;
    return () => { active = false; };
  }, [original, storedDerivative]);

  const operations = receipt?.operations?.length
    ? receipt.operations.map((operation) => operation.replaceAll('_', ' ')).join(' · ')
    : 'auto levels · IR cast correction · denoise · high-quality resize · sharpen';

  return <section className="cctv-still-compare" aria-label={`Original and enhanced still for ${subjectLabel}`}>
    <header>
      <div><ScanSearch size={17} aria-hidden="true" /><span><strong>Still comparison</strong><small>Inspect both pictures before confirming identity, plate, species, or incident relevance.</small></span></div>
      <span className="cctv-still-compare__authority"><ShieldCheck size={14} aria-hidden="true" /> Original remains authoritative</span>
    </header>
    <div className="cctv-still-compare__grid">
      <figure>
        <div className="cctv-still-compare__image"><img src={original} alt={`Original observation still for ${subjectLabel}`} /></div>
        <figcaption><strong>Original observation still</strong><span>Source crop · unchanged</span></figcaption>
      </figure>
      <figure>
        <div className="cctv-still-compare__image">
          {enhanced ? <img src={enhanced} alt={`Enhanced review still for ${subjectLabel}`} /> : <canvas ref={canvasRef} aria-label="Enhanced review preview" />}
          {previewError ? <span className="cctv-still-compare__error"><AlertTriangle size={16} />{previewError}</span> : null}
        </div>
        <figcaption><strong>{storedDerivative ? receipt?.generative ? 'AI-enhanced derivative' : 'Enhanced recognition derivative' : 'Enhanced review preview'}</strong><span>{storedDerivative ? receipt?.generative ? 'AI-restored · interpretive pixels' : 'Stored deterministic derivative' : 'Local deterministic preview · display only'}</span></figcaption>
      </figure>
    </div>
    <footer><Image size={13} aria-hidden="true" /><span>{operations}</span>{receipt?.profile ? <em>{receipt.profile}</em> : <em>No stored GPU derivative for this observation</em>}</footer>
  </section>;
}
