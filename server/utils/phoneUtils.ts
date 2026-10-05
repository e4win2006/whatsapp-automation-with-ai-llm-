/**
 * Phone Number Normalization and Formatting Utilities for WhatsApp Identities
 */

export function getWhatsAppIdentityType(id?: string | null): 'lid' | 'phone' | 'status' | 'group' | 'unknown' {
  if (!id) return 'unknown';
  const str = String(id).trim();
  if (str.endsWith('@lid')) return 'lid';
  if (str.endsWith('@c.us') || str.endsWith('@s.whatsapp.net')) return 'phone';
  if (str.includes('@g.us')) return 'group';
  if (str === 'status@broadcast' || str.includes('@broadcast')) return 'status';
  return 'unknown';
}

export function normalizePhoneNumber(raw?: string | null): string | null {
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;

  // Never treat LID, group, broadcast or status as phone numbers
  if (str.includes('@lid') || str.includes('@g.us') || str.includes('@broadcast') || str === 'status@broadcast') {
    return null;
  }

  // If serialized WhatsApp user ID with @c.us or @s.whatsapp.net
  let cleaned = str;
  if (cleaned.endsWith('@c.us')) {
    cleaned = cleaned.replace('@c.us', '');
  } else if (cleaned.endsWith('@s.whatsapp.net')) {
    cleaned = cleaned.replace('@s.whatsapp.net', '');
  }

  // Remove all non-digits
  let digits = cleaned.replace(/\D/g, '');
  if (!digits || digits.length < 5) return null;

  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  if (digits.length === 10) {
    digits = '91' + digits;
  }

  return digits;
}

export function formatPhoneNumberForDisplay(raw?: string | null): string {
  if (!raw) return '';
  const str = String(raw).trim();
  if (str.includes('@lid') || str.includes('@g.us') || str.includes('@broadcast') || str === 'status@broadcast') {
    return '';
  }

  const digits = normalizePhoneNumber(str);
  if (!digits || digits.length < 7) return '';

  // India (12 digits starting with 91)
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.substring(2, 7)} ${digits.substring(7)}`;
  }

  // 10-digit number (common national format)
  if (digits.length === 10) {
    return `+91 ${digits.substring(0, 5)} ${digits.substring(5)}`;
  }

  // US/Canada (11 digits starting with 1)
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.substring(1, 4)}) ${digits.substring(4, 7)}-${digits.substring(7)}`;
  }

  // Default international
  return `+${digits}`;
}

export function parseAlternateNames(raw?: string | null): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function mergeAlternateNames(primaryName: string, existingAlts: string[], newNames: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const name of [...existingAlts, ...newNames]) {
    if (!name || typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes('@') || /^\+?\d+$/.test(trimmed)) continue;
    const clean = trimmed.toLowerCase();
    // Safety check: Never add owner account aliases to contact alternate names
    if (clean.includes('account owner') || clean === 'you' || clean === 'account owner (you)') {
      continue;
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      result.push(trimmed);
    }
  }

  return result;
}

