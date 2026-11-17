import { expect, it } from 'vitest';
import { RecordingForm, ReleaseFields } from './catalog-edit';
it('rejects impossible release dates before a database write', () => {
	const fields = {
		title: 'Test',
		versionTitle: '',
		releaseDate: '2026-02-31',
		catalogNumber: '',
		upc: '000123450102',
		labelId: '11111111-1111-4111-8111-111111111111',
		genre: '',
		subgenre: ''
	};
	expect(ReleaseFields.safeParse(fields).success).toBe(false);
	expect(ReleaseFields.safeParse({ ...fields, releaseDate: '2028-02-29' }).success).toBe(true);
});
it('rejects zero and overflowing durations while keeping an unknown duration valid', () => {
	const fields = { title: 'Test', versionTitle: '', isrc: 'USAAA2600001', genre: '', subgenre: '' };
	for (const duration of ['00:00', '999999999:00'])
		expect(RecordingForm.safeParse({ ...fields, duration }).success).toBe(false);
	expect(RecordingForm.safeParse({ ...fields, duration: '' }).success).toBe(true);
	expect(RecordingForm.safeParse({ ...fields, duration: '03:00' }).success).toBe(true);
});
