import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Image, ScanSearch, ShieldCheck } from 'lucide-react';
import { analyseFramePixels, cssFilterFor, planEnhancement } from '../lib/cctvEnhance';
import type { DetectionBox } from '../lib/cctvQuality';
import './CCTVStillComparison.css';

export type EnhancementReceipt = {
  profile?: string;
  model?: string | null;
  execution_provider?: string | null;
  operations?: string[];
  generative?: boolean;
  source_sha256?: string;
  enhanced_sha256?: string;
};

type RecognitionComparison = {
  alpr?: { source?: { text?: string; confidence?: number } | null; enhanced?: { text?: string; confidence?: number } | null; agreement?: boolean; review_required?: boolean };
  source_face_count?: number;
  enhanced_face_count?: number;
  source_animal_count?: number;
  enhanced_animal_count?: number;
};

export type CCTVStillComparisonProps = {
  original: string;
  enhanced?: string | null;
  receipt?: EnhancementReceipt | null;
  provider?: string | null;
  recognitionComparison?: RecognitionComparison | null;
  subjectLabel: string;
  /** Detector box over `original`; pass it only when `original` is the whole frame the box was measured on. */
  detection?: DetectionBox | null;
};

const ANALYSIS_WIDTH = 128;
const MAX_PREVIEW_WIDTH = 1600;

export function DetectionOverlay({ box, subjectLabel }: { box: DetectionBox; subjectLabel: string }) {
  return <span
    className="cctv-still-compare__box"
    style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
    role="img"
    aria-label={`Detector box around the ${subjectLabel}`}
  />;
}

export function CCTVStillComparison({ original, enhanced = null, receipt = null, provider = null, recognitionComparison = null, subjectLabel, detection = null }: CCTVStillComparisonProps) {
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
  const providerLabel = provider === 'laptop_gpu' ? 'Laptop GPU' : provider === 'runpod_fallback' ? 'RunPod fallback' : provider === 'worker_deterministic' ? 'Worker deterministic' : null;
  const sourcePlate = recognitionComparison?.alpr?.source;
  const enhancedPlate = recognitionComparison?.alpr?.enhanced;

  return <section className="cctv-still-compare" aria-label={`Original and enhanced still for ${subjectLabel}`}>
    <header>
      <div><ScanSearch size={17} aria-hidden="true" /><span><strong>Still comparison</strong><small>Inspect both pictures before confirming identity, plate, species, or incident relevance.</small></span></div>
      <span className="cctv-still-compare__authority"><ShieldCheck size={14} aria-hidden="true" /> Original remains authoritative{providerLabel ? ` · ${providerLabel}` : ''}</span>
    </header>
    <div className="cctv-still-compare__grid">
      <figure>
        <div className="cctv-still-compare__image"><img src={original} alt={`Original observation still for ${subjectLabel}`} />{detection ? <DetectionOverlay box={detection} subjectLabel={subjectLabel} /> : null}</div>
        <figcaption><strong>Original observation still</strong><span>{detection ? 'Full frame · unchanged · detector box outlined' : 'Source crop · unchanged'}</span></figcaption>
      </figure>
      <figure>
        <div className="cctv-still-compare__image">
          {enhanced ? <img src={enhanced} alt={`Enhanced review still for ${subjectLabel}`} /> : <canvas ref={canvasRef} aria-label="Enhanced review preview" />}
          {previewError ? <span className="cctv-still-compare__error"><AlertTriangle size={16} />{previewError}</span> : null}
        </div>
        <figcaption><strong>{storedDerivative ? receipt?.generative ? 'AI-enhanced derivative' : 'Enhanced recognition derivative' : 'Enhanced review preview'}</strong><span>{storedDerivative ? receipt?.generative ? 'AI-restored · interpretive pixels' : 'Stored deterministic derivative' : 'Local deterministic preview · display only'}</span></figcaption>
      </figure>
    </div>
    {recognitionComparison ? <div className="cctv-still-compare__recognition" aria-label="Source and enhanced recognition comparison">
      <strong>Recognition comparison</strong>
      <span><b>Plate:</b> source {sourcePlate?.text || 'no reading'}{sourcePlate?.confidence ? ` (${Math.round(sourcePlate.confidence * 100)}%)` : ''} · enhanced {enhancedPlate?.text || 'no reading'}{enhancedPlate?.confidence ? ` (${Math.round(enhancedPlate.confidence * 100)}%)` : ''} · {recognitionComparison.alpr?.agreement ? 'readings agree' : 'human comparison required'}</span>
      <span><b>Faces:</b> source {recognitionComparison.source_face_count ?? 0} · enhanced {recognitionComparison.enhanced_face_count ?? 0} <b>Animals:</b> source {recognitionComparison.source_animal_count ?? 0} · enhanced {recognitionComparison.enhanced_animal_count ?? 0}</span>
    </div> : null}
    <footer><Image size={13} aria-hidden="true" /><span>{operations}</span>{receipt?.profile ? <em>{receipt.profile}</em> : <em>No stored GPU derivative for this observation</em>}</footer>
  </section>;
}
