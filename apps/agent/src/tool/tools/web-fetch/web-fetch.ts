import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"
import { fetchWebContent } from "../../web-content.js"

const Input = Schema.Struct({
  url: Schema.String.annotations({ description: "URL to fetch." }),
})

const Output = Schema.Struct({
  url: Schema.String,
  fetchedAt: Schema.String,
  status: Schema.Number,
  content: Schema.String,
  contentType: Schema.NullOr(Schema.String),
  redirects: Schema.Array(Schema.String),
  links: Schema.Array(Schema.Struct({
    text: Schema.String,
    url: Schema.String,
  })),
  truncated: Schema.Boolean,
  binary: Schema.Boolean,
  contentLength: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.String),
})

export const webFetchTool = make({
  name: "web_fetch",
  description: "Fetch a public http(s) URL. HTML is extracted into readable text with links; binary content is not injected.",
  input: Input,
  output: Output,
  execute: async (input) => {
    return fetchWebContent(input.url)
  },
  toModelOutput: (_in, out): ReadonlyArray<ContentPart> => {
    const header = [
      `URL: ${out.url}`,
      `Status: ${out.status}`,
      `Content-Type: ${out.contentType ?? "unknown"}`,
      ...(out.redirects.length > 0 ? [`Redirects: ${out.redirects.join(" -> ")}`] : []),
      ...(out.binary ? ["Binary: true"] : []),
      ...(out.truncated ? ["Truncated: true"] : []),
      ...(out.note ? [`Note: ${out.note}`] : []),
    ].join("\n")
    const content = out.content.slice(0, 10000)
    const links = out.links.length > 0
      ? "\n\nLinks:\n" + out.links.slice(0, 20).map((link) => `- ${link.text || link.url}: ${link.url}`).join("\n")
      : ""
    return [{
      type: "text",
      text: `${header}\n\n${content}${out.content.length > 10000 ? "\n\n[content truncated]" : ""}${links}`,
    }]
  },
})
