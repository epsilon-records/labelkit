import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseKeyRing } from '../audiokit-credentials';
import { brandedSender, fromHeader, labelName, redirectHost, sealSenderKey } from './branding';

const ORG = '019a0000-0000-7000-8000-0000000000b2';
const ringEnv = () => `t1:${randomBytes(32).toString('base64')}`;

describe('auth email branding helpers (EPSILON-146)', () => {
	it('labelName: display_name, else name, else LabelKit; control characters removed', () => {
		expect(labelName({ displayName: 'ERMS', name: 'Epsilon Records' })).toBe('ERMS');
		expect(labelName({ displayName: ' ', name: 'Label B' })).toBe('Label B');
		expect(labelName({ displayName: null, name: null })).toBe('LabelKit');
		expect(labelName(null)).toBe('LabelKit');
		expect(labelName({ displayName: 'A\r\nBcc: x@evil.test', name: null })).toBe(
			'A Bcc: x@evil.test'
		);
	});

	it('fromHeader always quotes the name and escapes quotes and backslashes', () => {
		expect(fromHeader('ERMS', 'auth.epsilonrecords.com')).toBe(
			'"ERMS" <no-reply@auth.epsilonrecords.com>'
		);
		expect(fromHeader('a"b\\c', 'auth.labelkit.co')).toBe(
			'"a\\"b\\\\c" <no-reply@auth.labelkit.co>'
		);
	});

	it('redirectHost: lowercase https host only', () => {
		expect(redirectHost('https://ERMS.epsilonrecords.com/auth/callback?next=/')).toBe(
			'erms.epsilonrecords.com'
		);
		expect(redirectHost('http://erms.epsilonrecords.com/')).toBeNull();
		expect(redirectHost('')).toBeNull();
		expect(redirectHost('not a url')).toBeNull();
	});

	it('brandedSender opens the label’s own key, bound to its org and domain', () => {
		const env = ringEnv();
		const sealed = sealSenderKey(parseKeyRing(env), ORG, 'auth.b.example.test', 'fake-key-b');
		const brand = {
			orgId: ORG,
			name: 'Label B',
			displayName: null,
			senderDomain: 'auth.b.example.test',
			senderKeySealed: sealed
		};
		const own = brandedSender(brand, { labelkitKey: 'fake-lk', credentialsKey: env });
		expect(own).toMatchObject({
			key: 'fake-key-b',
			sender: { id: 'org', domain: 'auth.b.example.test', product: 'Label B', branded: true }
		});
		expect(own.fallbackReason).toBeUndefined();
		// Same sealed value under another domain does not open: falls back to LabelKit's sender.
		const moved = brandedSender(
			{ ...brand, senderDomain: 'auth.other.example.test' },
			{ labelkitKey: 'fake-lk', credentialsKey: env }
		);
		expect(moved.key).toBe('fake-lk');
		expect(moved.sender.domain).toBe('auth.labelkit.co');
		expect(moved.fallbackReason).toBeTruthy();
		// No key ring set at all: falls back too.
		expect(brandedSender(brand, { labelkitKey: 'fake-lk', credentialsKey: undefined }).key).toBe(
			'fake-lk'
		);
	});
});
