// Room codes: 4 letters, always sent UPPERCASE (the backend rejects lowercase).
export const CODE_LEN = 4;

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LEN);
}

/** Join URL format: https://<ControllerUrl>/?r=<CODE>. The code only, no personal data. */
export function codeFromUrl(href: string): string {
  try { return normalizeCode(new URL(href).searchParams.get('r') ?? ''); } catch { return ''; }
}
