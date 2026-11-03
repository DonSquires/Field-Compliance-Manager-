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

/** @type {WeakMap<object, Map<string, number>>} */
const characterWidths = new WeakMap();

/**
 * pdf-lib measures embedded fonts by summing glyph advances (ligatures are disabled), so a
 * cached per-character width gives the same result without laying the string out again.
 * @template {{ widthOfTextAtSize(text: string, size: number): number }} TFont
 * @param {TFont} font
 * @param {string} character
 * @returns {number}
 */
function characterWidth(font, character) {
  let widths = characterWidths.get(font);
  if (!widths) {
    widths = new Map();
    characterWidths.set(font, widths);
  }
  let width = widths.get(character);
  if (width === undefined) {
    width = font.widthOfTextAtSize(character, 1);
    widths.set(character, width);
  }
  return width;
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
    .reduce((width, run) => width + pdfFontTextWidth(run.font, run.text, size), 0);
}

/**
 * Width of text already resolved to a single font run.
 * @template {{ widthOfTextAtSize(text: string, size: number): number }} TFont
 * @param {TFont} font
 * @param {string} text
 * @param {number} size
 * @returns {number}
 */
export function pdfFontTextWidth(font, text, size) {
  let width = 0;
  for (const character of Array.from(text)) width += characterWidth(font, character);
  return width * size;
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
  if (pdfTextWidth(token, fonts, size) <= maxWidth) return [token];
  const chunks = [];
  let chunk = '';
  let chunkWidth = 0;
  for (const character of Array.from(token)) {
    const width = pdfTextWidth(character, fonts, size);
    if (chunk && chunkWidth + width > maxWidth) {
      chunks.push(chunk);
      chunk = character;
      chunkWidth = width;
    } else {
      chunk += character;
      chunkWidth += width;
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
  const spaceWidth = pdfTextWidth(' ', fonts, size);
  for (const paragraph of text.split('\n')) {
    const tokens = paragraph.trim().split(/\s+/).filter(Boolean)
      .flatMap((token) => splitPdfToken(token, fonts, size, maxWidth));
    let line = '';
    let lineWidth = 0;
    for (const token of tokens) {
      const tokenWidth = pdfTextWidth(token, fonts, size);
      if (line && lineWidth + spaceWidth + tokenWidth > maxWidth) {
        lines.push(line);
        line = token;
        lineWidth = tokenWidth;
      } else {
        lineWidth = line ? lineWidth + spaceWidth + tokenWidth : tokenWidth;
        line = line ? `${line} ${token}` : token;
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