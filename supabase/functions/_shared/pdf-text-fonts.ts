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

export function pdfTextFontRuns<TFont>(
  text: string,
  latinFont: TFont,
  latinExtendedFont: TFont,
  latinCodePoints: ReadonlySet<number>,
  latinExtendedCodePoints: ReadonlySet<number>,
): PdfTextFontRun<TFont>[] {
  const runs: PdfTextFontRun<TFont>[] = [];
  for (const character of Array.from(text)) {
    const codePoint = character.codePointAt(0) ?? 0;
    const hasLatin = latinCodePoints.has(codePoint);
    const hasLatinExtended = latinExtendedCodePoints.has(codePoint);
    const font = hasLatin ? latinFont : hasLatinExtended ? latinExtendedFont : latinFont;
    const renderedCharacter = hasLatin || hasLatinExtended ? character : '?';
    const previous = runs[runs.length - 1];
    if (previous?.font === font) previous.text += renderedCharacter;
    else runs.push({ text: renderedCharacter, font });
  }
  return runs;
}

export function pdfTextWidth<TFont extends { widthOfTextAtSize(text: string, size: number): number }>(
  text: string,
  fonts: PdfTextFontPair<TFont>,
  size: number,
): number {
  return pdfTextFontRuns(text, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)
    .reduce((width, run) => width + run.font.widthOfTextAtSize(run.text, size), 0);
}

function splitPdfToken<TFont extends { widthOfTextAtSize(text: string, size: number): number }>(
  token: string,
  fonts: PdfTextFontPair<TFont>,
  size: number,
  maxWidth: number,
): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of Array.from(token)) {
    const candidate = `${chunk}${character}`;
    if (chunk && pdfTextWidth(candidate, fonts, size) > maxWidth) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function wrapPdfText<TFont extends { widthOfTextAtSize(text: string, size: number): number }>(
  text: string,
  fonts: PdfTextFontPair<TFont>,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const tokens = paragraph.trim().split(/\s+/).filter(Boolean)
      .flatMap((token) => splitPdfToken(token, fonts, size, maxWidth));
    let line = '';
    for (const token of tokens) {
      const candidate = line ? `${line} ${token}` : token;
      if (line && pdfTextWidth(candidate, fonts, size) > maxWidth) {
        lines.push(line);
        line = token;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    if (!tokens.length) lines.push(' ');
  }
  return lines;
}

export function pdfTextFontPair<TFont extends { getCharacterSet(): number[] }>(
  latin: TFont,
  latinExtended: TFont,
): PdfTextFontPair<TFont> {
  return {
    latin,
    latinExtended,
    latinCodePoints: new Set(latin.getCharacterSet()),
    latinExtendedCodePoints: new Set(latinExtended.getCharacterSet()),
  };
}