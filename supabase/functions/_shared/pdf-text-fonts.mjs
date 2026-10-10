/**
 * @template TFont
 * @typedef {{ text: string, font: TFont }} PdfTextFontRun
 */

/**
 * @template TFont
 * @typedef {{ latin: TFont, latinExtended: TFont, latinCodePoints: ReadonlySet<number>, latinExtendedCodePoints: ReadonlySet<number> }} PdfTextFontPair
 */

/**
 * @template TFont
 * @param {string} text
 * @param {TFont} latinFont
 * @param {TFont} latinExtendedFont
 * @param {ReadonlySet<number>} latinCodePoints
 * @param {ReadonlySet<number>} latinExtendedCodePoints
 * @returns {PdfTextFontRun<TFont>[]}
 */
export function pdfTextFontRuns(text, latinFont, latinExtendedFont, latinCodePoints, latinExtendedCodePoints) {
  const runs = [];
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

/**
 * @template {{ widthOfTextAtSize(text: string, size: number): number }} TFont
 * @param {string} text
 * @param {PdfTextFontPair<TFont>} fonts
 * @param {number} size
 * @returns {number}
 */
export function pdfTextWidth(text, fonts, size) {
  return pdfTextFontRuns(text, fonts.latin, fonts.latinExtended, fonts.latinCodePoints, fonts.latinExtendedCodePoints)
    .reduce((width, run) => width + run.font.widthOfTextAtSize(run.text, size), 0);
}

/**
 * @template {{ widthOfTextAtSize(text: string, size: number): number }} TFont
 * @param {string} token
 * @param {PdfTextFontPair<TFont>} fonts
 * @param {number} size
 * @param {number} maxWidth
 * @returns {string[]}
 */
function splitPdfToken(token, fonts, size, maxWidth) {
  const chunks = [];
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

/**
 * @template {{ widthOfTextAtSize(text: string, size: number): number }} TFont
 * @param {string} text
 * @param {PdfTextFontPair<TFont>} fonts
 * @param {number} size
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapPdfText(text, fonts, size, maxWidth) {
  const lines = [];
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

/**
 * @template {{ getCharacterSet(): number[] }} TFont
 * @param {TFont} latin
 * @param {TFont} latinExtended
 * @returns {PdfTextFontPair<TFont>}
 */
export function pdfTextFontPair(latin, latinExtended) {
  return {
    latin,
    latinExtended,
    latinCodePoints: new Set(latin.getCharacterSet()),
    latinExtendedCodePoints: new Set(latinExtended.getCharacterSet()),
  };
}