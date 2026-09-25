import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(resolve(process.cwd(), 'src/components/CCTVStillComparison.tsx'), 'utf8');
const triage = readFileSync(resolve(process.cwd(), 'src/pages/CCTVTriagePage.tsx'), 'utf8');

describe('CCTV still comparison', () => {
  it('keeps the original visibly authoritative and labels every derivative honestly', () => {
    expect(component).toContain('Original remains authoritative');
    expect(component).toContain('Original observation still');
    expect(component).toContain('Source crop · unchanged');
    expect(component).toContain('AI-enhanced derivative');
    expect(component).toContain('AI-restored · interpretive pixels');
    expect(component).toContain('Local deterministic preview · display only');
    expect(component).toContain("provider === 'laptop_gpu' ? 'Laptop GPU'");
    expect(component).toContain('Source and enhanced recognition comparison');
    expect(component).toContain('human comparison required');
  });

  it('derives the local fallback through the tested non-generative enhancement plan', () => {
    expect(component).toContain('analyseFramePixels(');
    expect(component).toContain('planEnhancement(stats');
    expect(component).toContain('cssFilterFor(plan');
    expect(component).toContain('auto levels · IR cast correction · denoise · high-quality resize · sharpen');
  });

  it('is shown in the governed editor and accepts a future capture receipt without writing evidence', () => {
    expect(triage).toContain('<CCTVStillComparison original={comparisonOriginal}');
    expect(triage).toContain('captureRecognition.enhancement');
    expect(triage).toContain('captureRecognition.enhanced_storage_path');
    expect(triage).toContain('createSignedUrl(enhancedStoragePath, 15 * 60)');
    expect(component).not.toContain('supabase');
  });
});