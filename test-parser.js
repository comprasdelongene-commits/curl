const assert = require('assert');
const { parseCurl } = require('./server');
let r = parseCurl(`curl -X PUT 'https://a.com/x?y=1' \\
  -H "Content-Type: application/json" -H 'X-A: b' \\
  --compressed -d '{"a":"it\\'s"}'`.replace("it\\'s","its"));
assert.equal(r.method, 'PUT'); assert.equal(r.headers.length, 2); assert.equal(r.body, '{"a":"its"}');
r = parseCurl('curl https://a.com -u user:pass'); assert.equal(r.headers[0].value, 'Basic ' + Buffer.from('user:pass').toString('base64'));
r = parseCurl('curl -G https://a.com/s -d q=1 -d b=2'); assert.equal(r.url, 'https://a.com/s?q=1&b=2'); assert.equal(r.method, 'GET'); assert.equal(r.body, '');
r = parseCurl(`curl --json '{"x":1}' https://a.com`); assert.equal(r.method, 'POST'); assert.equal(r.body, '{"x":1}');
assert(r.headers.some(h => h.name === 'Content-Type' && h.value === 'application/json'));
r = parseCurl('curl -sSLXPOST --data-raw "a=1" --data-binary "b=2" https://a.com'); assert.equal(r.method, 'POST'); assert.equal(r.body, 'a=1&b=2');
r = parseCurl(`curl -H $'X-T: a\\tb' --header="X: y" --url=https://a.com`.replace('--header="X: y"', '--header "X: y"')); assert.equal(r.headers[0].value, 'a\tb'); assert.equal(r.url, 'https://a.com');
r = parseCurl('curl example.com'); assert.equal(r.url, 'https://example.com');
r = parseCurl('curl -I https://a.com'); assert.equal(r.method, 'HEAD');
r = parseCurl(`curl "https://a.com" -H "Authorization: Bearer \\"t\\""`); assert.equal(r.headers[0].value, 'Bearer "t"');
console.log('parser OK');
