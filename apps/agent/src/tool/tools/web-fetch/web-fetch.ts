import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  url: Schema.String.annotations({ description: "URL to fetch." }),
})

const Output = Schema.Struct({
  status: Schema.Number,
  content: Schema.String,
  contentType: Schema.String,
})

export const webFetchTool = make({
  name: "web_fetch",
  description: "Fetch content from a URL. Returns status code, content type, and text content.",
  input: Input,
  output: Output,
  execute: async (input) => {
    const url = new URL(input.url)
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
      throw new Error("Fetching from localhost is not allowed")
    }
    const resp = await fetch(input.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Aurevoy/1.0)" },
      signal: AbortSignal.timeout(30000),
      redirect: "follow",
    })
    const text = await resp.text()
    return {
      status: resp.status,
      content: text,
      contentType: resp.headers.get("content-type") ?? "unknown",
    }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => [
    { type: "text", text: out.content.slice(0, 10000) + (out.content.length > 10000 ? "\n\n[content truncated]" : "") },
  ],
})
