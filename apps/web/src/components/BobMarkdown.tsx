/**
 * Minimal markdown renderer for Bob's assistant replies.
 *
 * Bob's output is model-generated, so this renderer only ever produces React
 * elements and never touches dangerouslySetInnerHTML. Link hrefs are restricted
 * to http/https to block javascript: and data: URLs.
 */

import React from 'react';
import { BobMermaidDiagram } from './BobMermaidDiagram';

type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'video'; label: string; src: string }
  | { kind: 'list'; ordered: boolean; items: Array<{ depth: number; text: string }> };

const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i;

function safeHref(raw: string) {
  try {
    const url = new URL(raw, 'https://example.invalid');
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** Splits a line into bold, code, and link spans. Unmatched text stays literal. */
export function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-b${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={`${keyPrefix}-c${index}`}>{token.slice(1, -1)}</code>);
    } else {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      nodes.push(href
        ? <a key={`${keyPrefix}-l${index}`} href={href} target="_blank" rel="noreferrer noopener">{label}</a>
        : label);
    }

    lastIndex = match.index + token.length;
    index += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length ? nodes : [text];
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      flushParagraph();
      const language = line.trim().slice(3).trim().toLowerCase();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const image = IMAGE.exec(line.trim());
    if (image) {
      flushParagraph();
      const src = safeHref(image[2]);
      if (src) blocks.push({ kind: 'image', alt: image[1], src });
      continue;
    }

    const linkedMedia = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(line.trim());
    if (linkedMedia) {
      const src = safeHref(linkedMedia[2]);
      if (src && VIDEO_EXTENSIONS.test(src)) {
        flushParagraph();
        blocks.push({ kind: 'video', label: linkedMedia[1], src });
        continue;
      }
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(4, Math.max(2, heading[1].length + 1)) as 2 | 3 | 4;
      blocks.push({ kind: 'heading', level, text: heading[2].trim() });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const match = (bullet ?? ordered) as RegExpExecArray;
      // Model output indents erratically, so depth is capped to keep nesting readable.
      const depth = Math.min(2, Math.floor(match[1].replace(/\t/g, '  ').length / 2));
      const previous = blocks[blocks.length - 1];

      if (previous && previous.kind === 'list' && previous.ordered === isOrdered) {
        previous.items.push({ depth, text: match[2].trim() });
      } else {
        blocks.push({ kind: 'list', ordered: isOrdered, items: [{ depth, text: match[2].trim() }] });
      }
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}

export function BobMarkdown({ content }: { content: string }) {
  const blocks = parseBlocks(content);

  if (!blocks.length) return <>{content}</>;

  return (
    <div className="bob-markdown">
      {blocks.map((block, blockIndex) => {
        const key = `block-${blockIndex}`;

        if (block.kind === 'code') {
          return block.language === 'mermaid'
            ? <BobMermaidDiagram key={key} chart={block.text} />
            : <pre key={key}><code>{block.text}</code></pre>;
        }

        if (block.kind === 'image') {
          return <img key={key} src={block.src} alt={block.alt || 'Bob supplied image'} loading="lazy" />;
        }

        if (block.kind === 'video') {
          return <video key={key} src={block.src} controls preload="metadata" aria-label={block.label || 'Bob supplied video'} />;
        }

        if (block.kind === 'heading') {
          const Tag = `h${block.level}` as 'h2' | 'h3' | 'h4';
          return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
        }

        if (block.kind === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-i${itemIndex}`} data-depth={item.depth}>
                  {renderInline(item.text, `${key}-i${itemIndex}`)}
                </li>
              ))}
            </ListTag>
          );
        }

        return <p key={key}>{renderInline(block.text, key)}</p>;
      })}
    </div>
  );
}
