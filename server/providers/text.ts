export function stripHtml(input: string): string {
  if (!input) return '';
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function safeText(input: unknown): string {
  if (input == null) return '';
  return stripHtml(String(input)).replace(/\r\n/g, '\n').trim();
}

export function safeUrl(input: unknown): string {
  const url = safeText(input);
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return '';
}
