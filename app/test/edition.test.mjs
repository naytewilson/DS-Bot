// The ANVIL edition is moved by its fabric: an app that bundles it never asks the upstream
// releases for an update.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundledEdition, editionOf, updatesManagedByEdition } from '../src/edition.mjs'

test('a package names an edition or none', () => {
  assert.equal(editionOf({ dsBot: { edition: 'anvil', base: '0.3.2' } }), 'anvil')
  for (const pkg of [undefined, null, {}, { dsBot: {} }, { dsBot: { edition: '' } }, { dsBot: { edition: 3 } }, 'text']) assert.equal(editionOf(pkg), null)
})

test('the bundled ds-bot says which edition the app is; one that cannot be read is the upstream release', async () => {
  assert.equal(await bundledEdition(async () => ({ name: 'ds-bot', dsBot: { edition: 'anvil' } })), 'anvil')
  assert.equal(await bundledEdition(async () => ({ name: 'ds-bot', version: '0.3.2' })), null)
  assert.equal(await bundledEdition(async () => { throw new Error('Cannot find module') }), null)
})

test('an edition updates through its fabric unless a feed was given on purpose', () => {
  assert.equal(updatesManagedByEdition('anvil', undefined), true)
  assert.equal(updatesManagedByEdition('anvil', 'https://example.test/feed'), false)
  assert.equal(updatesManagedByEdition(null, undefined), false)
  assert.equal(updatesManagedByEdition(null, 'https://example.test/feed'), false)
})
