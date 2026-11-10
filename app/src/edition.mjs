// The ANVIL edition (ds-bot/package.json, `dsBot.edition`) is installed from the owner's own commit
// and moves when the owner's fabric moves (ds-bot/src/host/update.js). The app's updaters read
// the upstream releases, so an app built from the edition must not run them: electron-updater
// would download an upstream installer over the fork on quit.

/** The edition a package.json names, or null for the upstream release. */
export const editionOf = pkg => (typeof pkg?.dsBot?.edition === 'string' && pkg.dsBot.edition !== '' ? pkg.dsBot.edition : null)

/**
 * The edition of the `ds-bot` this app bundles (npm copies it into node_modules), or null when
 * it names none or cannot be read.
 * @param {() => unknown} [read] the package.json of ds-bot; a test passes its own
 */
export async function bundledEdition(read = async () => (await import('node:module')).createRequire(import.meta.url)('ds-bot/package.json')) {
  try {
    return editionOf(await read())
  } catch {
    return null
  }
}

/** Whether the app leaves updating to the edition's fabric: it does unless a feed was given on purpose. */
export const updatesManagedByEdition = (edition, feed) => edition !== null && feed === undefined
