/**
 * The host-side HTTP plumbing every reader shares: fetch resolved at call
 * time, one request bounded by a timeout and the caller's cancellation with
 * redirects refused, and a shared request one caller's cancellation cannot
 * abort for the others.
 *
 * @module dsh-geek2api/request
 */

/**
 * Resolve fetch at call time. A sibling plugin may wrap `globalThis.fetch`
 * and later dismantle that wrapper; a binding captured during `apply()` would
 * keep the dead wrapper for the process lifetime.
 */
export function ambientFetch(input, init) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity')
  return globalThis.fetch(input, { ...init, headers })
}

/** One caller's cancellation must not abort a request other callers share. */
export function waitForSharedRequest(promise, signal) {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * A request that got no answer. Node's fetch reports every transport fault as
 * a bare `fetch failed`; the message names the part a reader can act on.
 */
export class TransportError extends Error {
  /**
   * @param cause - what fetch threw.
   * @param state - whether the timeout or the caller ended the request.
   */
  constructor(cause, { timedOut, aborted, timeoutMs }) {
    const code = typeof cause?.cause?.code === 'string' ? cause.cause.code : typeof cause?.code === 'string' ? cause.code : undefined
    const text = cause instanceof Error ? cause.message : String(cause)
    super(timedOut ? `no answer within ${Math.round(timeoutMs / 1000)}s` : code === undefined ? text : `${text} (${code})`, { cause })
    this.name = 'TransportError'
    /** The system error code, when the transport reported one. */
    this.code = code
    /** The timeout ended the request. */
    this.timedOut = timedOut
    /** The caller ended the request. */
    this.aborted = aborted
  }
}

/**
 * One request, bounded by `timeoutMs` and the caller's `signal`, refusing
 * redirects. A transport failure throws a {@link TransportError}.
 * @param url - the target.
 * @param init - fetch options; `redirect` and `signal` are set here.
 * @param options - the fetch to use, the timeout, and the caller's signal.
 * @returns the response, whatever its status.
 */
export async function boundedFetch(url, init, { fetchImpl = ambientFetch, timeoutMs, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    return await fetchImpl(url, { ...init, redirect: 'error', signal: requestSignal })
  } catch (error) {
    const aborted = signal?.aborted === true
    throw new TransportError(error, { aborted, timedOut: !aborted && timeout.aborted, timeoutMs })
  }
}
