// The edition check of the main process test: the app runs as the upstream release unless a test
// names an edition.
export const state = { edition: null }
export const bundledEdition = async () => state.edition
export const updatesManagedByEdition = (edition, feed) => edition !== null && feed === undefined
