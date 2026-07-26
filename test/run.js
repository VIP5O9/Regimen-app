/* Tests for the two checks that stand between the API and the network.
   No framework: node test/run.js */
const assert = require('assert');
const { tokenMatches, assertSafePushEndpoint, isPrivateAddress } = require('../security');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const rejects = (endpoint, why) =>
  test(why + ': ' + endpoint, () => assert.throws(() => assertSafePushEndpoint(endpoint)));

console.log('\ntokenMatches');
test('accepts the exact token', () => assert.strictEqual(tokenMatches('s3cret-token-value', 's3cret-token-value'), true));
test('rejects a wrong token of equal length', () => assert.strictEqual(tokenMatches('s3cret-token-valuX', 's3cret-token-value'), false));
test('rejects a prefix', () => assert.strictEqual(tokenMatches('s3cret', 's3cret-token-value'), false));
test('rejects empty', () => assert.strictEqual(tokenMatches('', 's3cret-token-value'), false));
test('rejects undefined without throwing', () => assert.strictEqual(tokenMatches(undefined, 's3cret-token-value'), false));
test('rejects a non-string', () => assert.strictEqual(tokenMatches({}, 's3cret-token-value'), false));

console.log('\nisPrivateAddress');
test('flags 127.0.0.1', () => assert.strictEqual(isPrivateAddress('127.0.0.1'), true));
test('flags 169.254.169.254 (cloud metadata)', () => assert.strictEqual(isPrivateAddress('169.254.169.254'), true));
test('flags 10.x', () => assert.strictEqual(isPrivateAddress('10.0.0.5'), true));
test('flags 172.16-31.x', () => assert.strictEqual(isPrivateAddress('172.20.1.1'), true));
test('allows 172.32.x (outside the private block)', () => assert.strictEqual(isPrivateAddress('172.32.1.1'), false));
test('flags ::1', () => assert.strictEqual(isPrivateAddress('::1'), true));
test('flags fd00:: unique-local', () => assert.strictEqual(isPrivateAddress('fd00::1'), true));
test('allows a public v4', () => assert.strictEqual(isPrivateAddress('93.184.216.34'), false));

console.log('\nassertSafePushEndpoint');
test('accepts a real push endpoint', () =>
  assert.ok(assertSafePushEndpoint('https://web.push.apple.com/QAbc123')));
test('accepts an FCM endpoint', () =>
  assert.ok(assertSafePushEndpoint('https://fcm.googleapis.com/fcm/send/abc')));
rejects('http://web.push.apple.com/x', 'plain http');
rejects('https://localhost:3117/relay', 'loopback by name');
rejects('https://127.0.0.1/relay', 'loopback by IP');
rejects('https://169.254.169.254/latest/meta-data/', 'cloud metadata');
rejects('https://10.0.0.5/internal', 'private range');
rejects('https://[::1]/relay', 'IPv6 loopback');
rejects('file:///etc/passwd', 'non-http scheme');
rejects('not a url', 'unparseable');
rejects(undefined, 'missing');
rejects(12345, 'non-string');
test('rejects an over-long URL', () =>
  assert.throws(() => assertSafePushEndpoint('https://x.com/' + 'a'.repeat(3000))));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
