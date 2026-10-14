# Security

## Credentials

- API keys are stored through the DSH credential service as one `grant` record scoped to this plugin (`geek2api/keys`), which lands in the local credentials file with the permissions DSH enforces (owner-only).
- Keys never enter the settings document, the session transcript, logs, or an error message. `src/key-ring.js` returns key material only through `secrets()`, which is callable from the host half alone.
- The browser receives key labels, states, and balances — never a key, and never a masked fragment of one. The RPC surface in `src/rpc.js` is the only way in.
- The plugin disables ambient discovery (`authContext.env` and `fileExists` resolve empty), so an exported `GEEK2API_API_KEY` cannot authenticate a request behind the user's back.
- There is no fallback to another provider, another credential, or an unauthenticated request. When every stored key is disabled, the request fails with a message that says so.

## Network

- Balance requests carry a timeout (`AbortSignal.timeout`) and `redirect: 'error'`, and go only to the configured Geek2API endpoints.
- Model traffic goes to the configured model host through the host's own pi-ai adapter, with the harness attribution headers, exactly like a configured provider route.

## Claude CLI MCP search bridge

- Each CLI invocation owns a temporary HTTP MCP server bound exclusively to `127.0.0.1` on a random port. Every method requires an independent cryptographically random capability; Host/Origin validation rejects rebinding and cross-origin browser requests. No CORS access is granted.
- The owner-only temporary MCP config (private directory, file mode 0600 on POSIX) contains only this local capability. The search API keys remain in the host's key ring and are never placed in MCP configuration, argv, schemas, tool results or raw diagnostics. Result/CLI redaction handles escaped keys and secrets split across text deltas.
- The endpoint offers only bounded `web_search`; models cannot supply backend, API host, credentials, session IDs, shell commands or arbitrary fetch requests. Input size, query size, concurrency, search count, output size and an end-to-end timeout are bounded. Run stop and tool cancellation abort the provider.
- Native CLI WebSearch is denied even in full mode. Read-only/edit modes add only the exact MCP search tool to their auto-approval lists. Existing MCP/settings and user/managed deny rules remain effective; `--allowedTools` is not an exclusive whitelist. Hooks, other trusted MCP servers and full-permission commands remain part of the CLI's existing trust boundary.
- The local capability and owner-only files reduce accidental exposure; they do **not** isolate the service from a compromised process or customization running as the same OS user. Do not run the delegated CLI in an untrusted workspace with hostile hooks/MCP configuration.
- Startup cancellation also revokes an already-bound listener while filesystem setup is pending. Completed/failed/abandoned invocations and plugin unload close the server and clean up only their own temporary config directory.

## Reporting

Report a security issue through the repository's GitHub issues rather than a public discussion of a live credential. Never paste a key, token, or credential-store value into an issue, a log, or a chat.
