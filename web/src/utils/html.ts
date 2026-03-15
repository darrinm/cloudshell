/**
 * Decode HTML entities (e.g., &#39; -> ', &amp; -> &)
 */
export function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement('textarea')
  textarea.innerHTML = text
  return textarea.value
}
