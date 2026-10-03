import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Safe Markdown: marked renders, DOMPurify strips scripts/handlers; links open in a new tab without referrer.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || '', { async: false, gfm: true, breaks: true }) as string, { FORBID_TAGS: ['style', 'iframe', 'form', 'input'], FORBID_ATTR: ['style'] }), [text]);
  if (!text.trim()) return <p className="muted">Nothing here yet.</p>;
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
