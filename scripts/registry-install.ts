/** Only missing-version responses may be retried after an npm publish. */
export function isRegistryPropagationError(output: string): boolean {
  return (
    /\b(?:ETARGET|E404)\b/.test(output) &&
    /(?:No matching version|No match found|notarget|Not Found)/i.test(output)
  );
}
