export interface PdfTextFontRun<TFont> {
  text: string;
  font: TFont;
}

export interface PdfTextFontPair<TFont> {
  latin: TFont;
  latinExtended: TFont;
  latinCodePoints: ReadonlySet<number>;
  latinExtendedCodePoints: ReadonlySet<number>;
}

export { pdfTextFontRuns, pdfTextFontPair, pdfTextWidth, wrapPdfText } from './pdf-text-fonts.mjs';