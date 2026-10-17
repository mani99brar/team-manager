import assert from 'node:assert/strict'
import test from 'node:test'
import { redactCredentials, redactText } from '../../contracts/projects/redact.ts'

// The shared redaction (contracts/projects/redact.ts): PEM blocks first, then token shapes, then credential assignments.

test('[F1.1] a PEM block behind an unquoted assignment is redacted whole, BEGIN line, body and END line', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq\nZmFrZSBrZXkgYm9keQ==\n-----END RSA PRIVATE KEY-----'
  assert.equal(redactCredentials(`PRIVATE_KEY=${pem}\nafter`), 'PRIVATE_KEY=<redacted>\nafter')
  assert.equal(redactCredentials(`private_key: ${pem}`), 'private_key: <redacted>')
  assert.equal(redactCredentials('SSH_KEY=-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r'), 'SSH_KEY=<redacted>')
})

test('[F1.2] prefixed lower- and mixed-case credential names keep their name and lose their value, with = or : and spaces', () => {
  const cases: [string, string][] = [
    ['access_token=ya29abcdefgh', 'access_token=<redacted>'],
    ['refresh_token: 1//0gabcdefgh', 'refresh_token: <redacted>'],
    ['client_secret = GOCSPX-abcdef', 'client_secret = <redacted>'],
    ['db_password=hunter22', 'db_password=<redacted>'],
    ['aws_secret_access_key = wJalrXUtnFEMI', 'aws_secret_access_key = <redacted>'],
    ['Github-Token:abcdefghij', 'Github-Token:<redacted>'],
    ['app.client.secret=s3cr3tvalue', 'app.client.secret=<redacted>'],
    ['my_api_key=abcdefghij', 'my_api_key=<redacted>'],
    ['Access-Key: AKIAabcdefgh', 'Access-Key: <redacted>'],
    ['x_auth = abcdefghijk', 'x_auth = <redacted>'],
    ['config._access_token=zzzzzzzz end', 'config._access_token=<redacted> end'],
  ]
  for (const [input, expected] of cases) assert.equal(redactCredentials(input), expected, input)
  assert.equal(redactText('see https://api.example.com/x?access_token=abcdefgh123 now'), 'see https://api.example.com/x?access_token=<redacted> now')
})

test('[F1.3] quoted values are redacted whole, single or double, spaces and short words included', () => {
  assert.equal(redactCredentials('api_key="abcdefghijklmnop"'), 'api_key=<redacted>')
  assert.equal(redactCredentials("Token='abcdefghijklmnop'"), 'Token=<redacted>')
  assert.equal(redactCredentials('password="correct horse battery"'), 'password=<redacted>')
  assert.equal(redactCredentials('password = "abc def" then'), 'password = <redacted> then')
  assert.equal(redactCredentials('{"client_secret": "x y", "id": 3}'), '{"client_secret": <redacted>, "id": 3}')
})

test('ordinary prose and short or non-credential assignments stay unchanged', () => {
  for (const text of [
    'Password policy: strong', 'token count: 5', 'keyboard', 'the secret is out', 'author: Jane Doe', 'max_tokens: 4096',
    'TOKEN_COUNT=5', 'Token=short; secret=abc, apikey=12345', 'tokenizer: bpe', 'secretary: Ann', 'pwd=abc', 'auth: yes',
  ]) assert.equal(redactText(text), text, text)
  assert.equal(redactCredentials('password=hunter22.'), 'password=<redacted>.', 'a trailing full stop stays')
})

test('token shapes still go, and an assignment around an already redacted token keeps its name', () => {
  assert.equal(redactCredentials(`GH_TOKEN=ghp_${'a'.repeat(36)}`), 'GH_TOKEN=<redacted>')
  assert.equal(redactCredentials(`token: ghp_${'a'.repeat(36)}`), 'token: <redacted>')
  assert.equal(redactCredentials(`Authorization: Bearer ${'c'.repeat(30)}`), 'Authorization: <redacted>')
})

test('redaction stays linear on adversarial input (a bounded name pattern; the unbounded one took 8 s on 140 KB)', async () => {
  const { redactText } = await import('../../contracts/projects/redact.ts')
  for (const text of ['access_'.repeat(20000) + 'token', 'ACCESS_'.repeat(20000) + 'TOKEN', 'a.'.repeat(50000) + 'token', 'Access-'.repeat(20000) + 'Key', 'SECRET'.repeat(20000), 'password' + ' '.repeat(50000) + 'x']) {
    const started = performance.now()
    redactText(text)
    assert.ok(performance.now() - started < 500, `redactText took ${Math.round(performance.now() - started)} ms on ${text.slice(0, 16)}… (${text.length} chars)`)
  }
  assert.equal(redactText('aws_secret_access_key = "AKIAabcdefghij"'), 'aws_secret_access_key = <redacted>')
})

test('assignment scanner: escaped, stray, unterminated and multi-line quotes, joined pairs, a value starting with a redacted token, long names and YAML next-line values leave nothing behind (review check-090500 F1.1-F1.5)', async () => {
  const { redactText } = await import('../../contracts/projects/redact.ts')
  const cases: [string, string][] = [
    ['password=\\"hunter22pass\\"', 'password=<redacted>'],
    ["password=abc'def12345", 'password=<redacted>'],
    ['password="unterminated hunter22', 'password=<redacted>'],
    ['{"password":"abc\\"privateSuffix"}', '{"password":<redacted>}'],
    ['token=123456;password="hunter22"', 'token=<redacted>'],
    ['PASSWORD=ghp_' + 'a'.repeat(36) + '!privateSuffix', 'PASSWORD=<redacted>'],
    ['A'.repeat(65) + 'KEY=hunter22', 'A'.repeat(65) + 'KEY=<redacted>'],
    ['password:\n  hunter22pass', 'password:\n  <redacted>'],
    ['SECRET_KEY="abc\ndef"', 'SECRET_KEY=<redacted>'],
    ['https://x.io/cb?access_token=abcdef123456&x=1', 'https://x.io/cb?access_token=<redacted>'],
  ]
  for (const [input, expected] of cases) assert.equal(redactText(input), expected, input)
})

test('assignment scanner: prose with a credential word before ":" stays (review check-090500 F1.6)', async () => {
  const { redactText } = await import('../../contracts/projects/redact.ts')
  for (const text of ['auth: refactored the session middleware', 'Token: rotated nightly', 'see the password: section below', 'key: value pairs', 'Read the passwords: chapter']) {
    assert.equal(redactText(text), text)
  }
})

test('run summary: a secret split across lines is redacted after the paragraph is flattened (review check-090500 F2.1)', async () => {
  const { redactText } = await import('../../contracts/projects/redact.ts')
  const { runSummaryMarkdown } = await import('../../contracts/projects/summary.ts')
  const text = runSummaryMarkdown({ runId: 'r', workflowId: 'w', feature: null, status: 'succeeded', headline: null, branch: null, baseCommit: null, integratedCommit: null, review: null, costUsd: null, pr: null, lanes: [{ lane: 'ui', summary: 'Set db_password:\n  hunter22pass in env. Also SECRET_KEY="abc\ndef" set.', team: null }] }, redactText)
  assert.ok(!text.includes('hunter22pass') && !text.includes('def"') && !/\babc\b/.test(text), text)
})
