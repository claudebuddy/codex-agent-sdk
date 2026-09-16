/**
 * Tests for gateway / custom-endpoint configuration.
 *
 * The gateway contract under test:
 *   - baseUrl + apiKey  -> custom provider with requires_openai_auth=false
 *                          (the no-login switch), key via CODEX_SDK_API_KEY env
 *   - baseUrl alone     -> openai_base_url override only, login flow unchanged
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildGatewayConfig } from '../src/index.js'

test('baseUrl + apiKey registers a no-login gateway provider', () => {
  const { providerId, config } = buildGatewayConfig({
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'sk-test-123',
  })

  assert.equal(providerId, 'codex-sdk-gateway')

  const providers = config.model_providers as Record<string, any>
  const gw = providers['codex-sdk-gateway']

  // The switch that makes login unnecessary.
  assert.equal(gw.requires_openai_auth, false)
  assert.equal(gw.base_url, 'https://gw.example.com/v1')
  assert.equal(gw.env_key, 'CODEX_SDK_API_KEY')
  assert.equal(gw.wire_api, 'responses')

  // The key must not be embedded in the config.
  assert.equal(JSON.stringify(config).includes('sk-test-123'), false)
  assert.equal(gw.experimental_bearer_token, undefined)
})

test('baseUrl without apiKey only overrides openai_base_url', () => {
  const { providerId, config } = buildGatewayConfig({
    baseUrl: 'https://relay.example.com/v1',
  })

  assert.equal(providerId, null)
  assert.deepEqual(config, { openai_base_url: 'https://relay.example.com/v1' })
})

test('custom provider id is honored', () => {
  const { providerId, config } = buildGatewayConfig({
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'k',
    provider: 'my-relay',
  })
  assert.equal(providerId, 'my-relay')
  assert.ok((config.model_providers as Record<string, unknown>)['my-relay'])
})

test('gateway headers become http_headers', () => {
  const { config } = buildGatewayConfig({
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'k',
    gatewayHeaders: { 'X-Gateway': 'abc' },
  })
  const gw = (config.model_providers as Record<string, any>)['codex-sdk-gateway']
  assert.deepEqual(gw.http_headers, { 'X-Gateway': 'abc' })
})

test('no gateway options produce an empty config', () => {
  assert.deepEqual(buildGatewayConfig({}), { providerId: null, config: {} })
})
