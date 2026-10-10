import { PDFDocument, type PDFFont } from 'https://esm.sh/pdf-lib@1.17.1';
import * as fontkitModule from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';
import { pdfNotoFontBytes } from './pdf-noto-font-data.ts';
import { pdfTextFontPair, type PdfTextFontPair } from './pdf-text-fonts.ts';

type PdfFontkit = Parameters<PDFDocument['registerFontkit']>[0];
const fontkit = (fontkitModule as unknown as { default: PdfFontkit }).default;
export interface PdfNotoFontSet {
  normal: PdfTextFontPair<PDFFont>;
  bold: PdfTextFontPair<PDFFont>;
}

export async function embedPdfNotoFonts(pdf: PDFDocument): Promise<PdfNotoFontSet> {
  pdf.registerFontkit(fontkit);
  const fontBytes = pdfNotoFontBytes();
  const [latinNormal, latinBold] = await Promise.all([
    pdf.embedFont(fontBytes.normal, { subset: false }),
    pdf.embedFont(fontBytes.bold, { subset: false }),
  ]);
  return {
    normal: pdfTextFontPair(latinNormal, latinNormal),
    bold: pdfTextFontPair(latinBold, latinBold),
  };
}