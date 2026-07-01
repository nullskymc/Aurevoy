import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"

const Input = Schema.Struct({
  query: Schema.String.annotations({ description: "Search query string." }),
})

const Output = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    title: Schema.String,
    url: Schema.String,
    snippet: Schema.String,
  })),
})

export const webSearchTool = make({
  name: "web_search",
  description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets for the top results.",
  input: Input,
  output: Output,
  execute: async (input) => {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(input.query)}`
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Aurevoy/1.0)",
      },
      signal: AbortSignal.timeout(15000),
    })
    const html = await resp.text()
    const results: Array<{ title: string; url: string; snippet: string }> = []

    const linkRe = /<a[^>]*href="([^"]*)"[^>]*class="result-link"[^>]*>([^<]*)<\/a>/gi
    const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([^<]*(?:<(?!\/td)[^>]*>[^<]*)*)<\/td>/gi

    let match
    while ((match = linkRe.exec(html)) !== null) {
      const rawUrl = match[1]
      if (rawUrl.includes("duckduckgo.com")) continue
      const urlDecoded = decodeURIComponent(rawUrl.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, ""))
      const cleanUrl = new URL(urlDecoded).toString()
      results.push({ title: match[2].replace(/<\/?[^>]+(>|$)/g, ""), url: cleanUrl, snippet: "" })
    }

    let si = 0
    while ((match = snippetRe.exec(html)) !== null && si < results.length) {
      results[si].snippet = match[1].replace(/<\/?[^>]+(>|$)/g, "").trim()
      si++
    }

    return { results: results.slice(0, 10) }
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => {
    if (out.results.length === 0) return [{ type: "text", text: "No results found" }]
    const lines = out.results.map((r) => `**${r.title}**\n${r.url}\n${r.snippet}`)
    return [{ type: "text", text: lines.join("\n\n") }]
  },
})
