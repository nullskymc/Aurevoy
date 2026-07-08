import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"
import { searchWeb } from "../../web-content.js"

const Input = Schema.Struct({
  query: Schema.String.annotations({ description: "Search query string." }),
})

const Output = Schema.Struct({
  provider: Schema.Literal("duckduckgo_lite", "tavily", "searxng", "custom"),
  query: Schema.String,
  resultCount: Schema.Number,
  searchedAt: Schema.String,
  results: Schema.Array(Schema.Struct({
    title: Schema.String,
    url: Schema.String,
    snippet: Schema.String,
  })),
})

export const webSearchTool = make({
  name: "web_search",
  description: "Search the web using the configured search provider. Returns titles, URLs, and snippets for the top results.",
  input: Input,
  output: Output,
  execute: async (input) => {
    return searchWeb(input.query)
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => {
    if (out.results.length === 0) return [{ type: "text", text: "No results found" }]
    const lines = [
      `Provider: ${out.provider}`,
      `Query: ${out.query}`,
      "",
      ...out.results.map((r) => `**${r.title}**\n${r.url}\n${r.snippet}`),
    ]
    return [{ type: "text", text: lines.join("\n\n") }]
  },
})
