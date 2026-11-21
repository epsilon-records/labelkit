import net from 'node:net';

/**
 * A TCP proxy that reads what the client sends and counts the messages after which it waits for
 * the server: Flush (H), Sync (S) and simple Query (Q). Each one is a round trip, about 98 ms from
 * Netlify's Ohio functions to Supabase in Frankfurt (knowledge labelkit/decisions/0029). For tests.
 */
export async function countingProxy(host: string, port: number) {
	let trips = 0;
	let latencyMs = 0;
	const pending = new Set<ReturnType<typeof setTimeout>>();
	const sockets = new Set<net.Socket>();
	const server = net.createServer((client) => {
		const upstream = net.connect(port, host);
		sockets.add(client).add(upstream);
		let buf = Buffer.alloc(0);
		let started = false;
		client.on('data', (chunk: Buffer) => {
			// A one-way delay models one measured RTT per sequential exchange. Protocol frames
			// in the same write still travel together; server-to-client bytes stay immediate.
			if (latencyMs) {
				const timer = setTimeout(() => {
					pending.delete(timer);
					upstream.write(chunk);
				}, latencyMs);
				pending.add(timer);
			} else upstream.write(chunk);
			buf = Buffer.concat([buf, chunk]);
			for (;;) {
				if (!started) {
					// Startup and SSL/GSS requests have no type byte.
					if (buf.length < 8) break;
					const len = buf.readInt32BE(0);
					if (buf.length < len) break;
					const code = buf.readInt32BE(4);
					buf = buf.subarray(len);
					started = code !== 80877103 && code !== 80877104;
					continue;
				}
				if (buf.length < 5) break;
				const len = buf.readInt32BE(1);
				if (buf.length < len + 1) break;
				if ('HSQ'.includes(String.fromCharCode(buf[0]))) trips++;
				buf = buf.subarray(len + 1);
			}
		});
		upstream.on('data', (chunk) => client.write(chunk));
		client.on('close', () => upstream.destroy());
		upstream.on('close', () => client.destroy());
		client.on('error', () => {});
		upstream.on('error', () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		async count(fn: () => Promise<unknown>, delayMs = 0) {
			const before = trips;
			latencyMs = delayMs;
			try {
				await fn();
				return trips - before;
			} finally {
				latencyMs = 0;
			}
		},
		close() {
			for (const timer of pending) clearTimeout(timer);
			for (const s of sockets) s.destroy();
			server.close();
		}
	};
}
