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
