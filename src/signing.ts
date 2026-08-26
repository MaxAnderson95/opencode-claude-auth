/**
 * Build the complete billing header string for insertion into system[0].
 * Claude Code 2.1.234 sends a static build suffix and no content hash.
 */
export function buildBillingHeaderValue(
  version: string,
  versionSuffix: string,
  entrypoint: string,
): string {
  return (
    `x-anthropic-billing-header: ` +
    `cc_version=${version}.${versionSuffix}; ` +
    `cc_entrypoint=${entrypoint};`
  )
}
