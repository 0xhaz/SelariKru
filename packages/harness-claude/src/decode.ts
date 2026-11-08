/**
 * Streaming UTF-8 decode for launchers: a multibyte character split across chunks must not be corrupted,
 * so never call `toString()` per chunk. Use this to turn a byte stream into the string chunks `LaunchedProcess.lines` expects.
 */
export async function* decodeUtf8Stream(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  for await (const b of bytes) {
    const s = decoder.decode(b, { stream: true });
    if (s) yield s;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}
