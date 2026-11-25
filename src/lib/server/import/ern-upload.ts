import { fromBufferPromise } from 'yauzl';
import type { ErnDocument } from './ern';

export const MAX_ERN_UPLOAD_BYTES = 4_000_000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100;

export class ErnUploadError extends Error {}

const decoder = new TextDecoder('utf-8', { fatal: true });

export async function readErnUpload(name: string, bytes: Buffer): Promise<ErnDocument[]> {
	if (!bytes.length || bytes.length > MAX_ERN_UPLOAD_BYTES) {
		throw new ErnUploadError('Choose a non-empty file up to 4 MB.');
	}
	try {
		if (/\.xml$/i.test(name)) return [{ name, text: decoder.decode(bytes) }];
		if (!/\.zip$/i.test(name)) throw new ErnUploadError('Choose an ERN XML file or ZIP archive.');
		const zip = await fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true });
		try {
			if (zip.entryCount > MAX_ARCHIVE_ENTRIES) throw new ErnUploadError('Too many ZIP entries.');
			const documents: ErnDocument[] = [];
			const names = new Set<string>();
			let total = 0;
			for await (const entry of zip.eachEntry()) {
				if (entry.fileName.endsWith('/')) continue;
				if (!/\.xml$/i.test(entry.fileName)) {
					throw new ErnUploadError('The ZIP archive may contain only XML files.');
				}
				if (names.has(entry.fileName)) throw new ErnUploadError('Duplicate XML file name in ZIP.');
				names.add(entry.fileName);
				if (entry.uncompressedSize > MAX_IMPORT_BYTES - total) {
					throw new ErnUploadError('The extracted ZIP files exceed 5 MB.');
				}
				const chunks: Buffer[] = [];
				const stream = await zip.openReadStreamPromise(entry);
				for await (const chunk of stream) {
					total += chunk.length;
					if (total > MAX_IMPORT_BYTES)
						throw new ErnUploadError('The extracted ZIP files exceed 5 MB.');
					chunks.push(chunk);
				}
				documents.push({ name: entry.fileName, text: decoder.decode(Buffer.concat(chunks)) });
			}
			if (!documents.length) throw new ErnUploadError('The ZIP archive contains no XML.');
			return documents;
		} finally {
			zip.close();
		}
	} catch (e) {
		if (e instanceof ErnUploadError) throw e;
		throw new ErnUploadError(
			'The upload could not be read. Use UTF-8 XML or an unencrypted ZIP of XML files.'
		);
	}
}
