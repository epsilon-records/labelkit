import { normalizeHost } from './branding';
import llms from './crawler/llms.txt?raw';
import robots from './crawler/robots.txt?raw';
import sitemap from './crawler/sitemap.xml?raw';

const metadata = new Map([
	['/robots.txt', { body: robots, type: 'text/plain; charset=utf-8' }],
	['/sitemap.xml', { body: sitemap, type: 'application/xml; charset=utf-8' }],
	['/llms.txt', { body: llms, type: 'text/plain; charset=utf-8' }]
]);

export function crawlerMetadata(url: URL, method: string): Response | undefined {
	const file = metadata.get(url.pathname);
	if (!file) return;
	if (normalizeHost(url.host) !== 'labelkit.co') {
		return noindex(new Response(null, { status: 404 }));
	}
	if (method !== 'GET' && method !== 'HEAD') {
		return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
	}
	return new Response(method === 'HEAD' ? null : file.body, {
		headers: { 'Content-Type': file.type }
	});
}

export function noindex(response: Response): Response {
	response.headers.set('X-Robots-Tag', 'noindex');
	return response;
}
