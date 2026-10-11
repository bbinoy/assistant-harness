// Phone numbers and credentials never reach a log, whatever a library or an error message includes.
export function redact(text: string): string {
  return text
    .replace(/\+\d{7,15}/g, (m) => `+***${m.slice(-2)}`)
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1***")
    .replace(/(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=\S+/g, "$1=***");
}
