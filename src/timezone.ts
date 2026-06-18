/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Authoritative weekday + date in a given timezone, e.g. "Thursday, Jun 18, 2026".
 * Computed deterministically via Intl with an EXPLICIT timeZone so the weekday is
 * never derived by hand (or by an LLM) and never skewed by the host's system zone.
 * Falls back to UTC if the timezone is invalid. Accepts a Date or a date string.
 */
export function formatLocalDate(when: Date | string, timezone: string): string {
  const date = typeof when === 'string' ? new Date(when) : when;
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
