/** ISRC: CC-XXX-YY-NNNNN, written without dashes (12 chars). */
export function normalizeIsrc(raw: string): string {
	return raw.replace(/[\s-]/g, '').toUpperCase();
}

export function isValidIsrc(isrc: string): boolean {
	return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc);
}

/** UPC-A (12) or EAN-13 (13) with a valid GTIN check digit. */
export function isValidGtin(code: string): boolean {
	if (!/^\d{12,13}$/.test(code)) return false;
	const digits = [...code].map(Number);
	const check = digits.pop()!;
	const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
	return (10 - (sum % 10)) % 10 === check;
}

/**
 * One identity for a UPC/EAN however it is zero-padded: UPC-A (12 digits) where the code has
 * one, otherwise EAN-13. A 14-digit form is read only when its indicator digit is zero.
 * Null when the code is not a valid GTIN.
 */
export function canonicalGtin(code: string): string | null {
	const short = /^0\d{13}$/.test(code) ? code.slice(1) : code;
	if (!isValidGtin(short)) return null;
	return short.length === 13 && short.startsWith('0') ? short.slice(1) : short;
}

/** Every form the catalogue can hold for one UPC/EAN: the canonical one and its padded twin. */
export function gtinForms(code: string): string[] {
	const canonical = canonicalGtin(code);
	if (!canonical) return [code];
	return canonical.length === 12 ? [canonical, '0' + canonical] : [canonical];
}

/** "06:16" or "1:02:03" to milliseconds; empty or malformed gives null. */
export function parseDuration(raw: string): number | null {
	const s = raw.trim();
	if (!s) return null;
	const parts = s.split(':').map((p) => Number(p));
	if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
		return null;
	}
	const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
	return seconds * 1000;
}

export function formatDuration(ms: number | null): string {
	if (ms == null) return '--:--';
	const total = Math.round(ms / 1000);
	return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Key used to match an imported name to an existing party: case and spacing insensitive. */
export function partyMatchKey(name: string): string {
	return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Split a SymphonicMS multi-artist cell ("Rook Sable,Lanthorn"). */
export function splitArtists(cell: string): string[] {
	return cell
		.split(',')
		.map((a) => a.trim().replace(/\s+/g, ' '))
		.filter(Boolean);
}
