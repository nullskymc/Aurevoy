import { Schema } from "effect"
import { make, type ContentPart } from "../../framework/definition.js"
import { bundleReportHtml } from "./bundler.js"

const Input = Schema.Struct({
  htmlPath: Schema.String.annotations({
    description: "Path to the input HTML file. Relative paths resolve from the workspace root.",
  }),
  outputPath: Schema.optional(Schema.String.annotations({
    description: "Path for the bundled output. Defaults to overwriting htmlPath.",
  })),
  componentsPath: Schema.optional(Schema.String.annotations({
    description: "Override path to the report components.js library. Defaults to the built-in research skill components.",
  })),
  inlineImages: Schema.optional(Schema.Boolean.annotations({
    description: "Base64-encode local images into the HTML. Default true.",
  })),
  inlineScripts: Schema.optional(Schema.Boolean.annotations({
    description: "Inline local scripts into the HTML. Default true.",
  })),
  inlineStyles: Schema.optional(Schema.Boolean.annotations({
    description: "Inline local stylesheets into the HTML. Default true.",
  })),
})

const Output = Schema.Struct({
  outputPath: Schema.String,
  bytesRead: Schema.Number,
  bytesWritten: Schema.Number,
  inlinedScripts: Schema.Number,
  inlinedImages: Schema.Number,
  inlinedStyles: Schema.Number,
  warnings: Schema.Array(Schema.String),
})

export const bundleReportTool = make({
  name: "bundle_report",
  riskLevel: "safe",
  description:
    "Bundle a report HTML draft into a single self-contained file. " +
    "Inlines the report components.js library, local stylesheets, and base64-encodes local images. " +
    "The resulting HTML can be opened directly in a browser without file:// subresource restrictions.",
  input: Input,
  output: Output,
  execute: async (input, ctx) => {
    return bundleReportHtml({
      htmlPath: input.htmlPath,
      outputPath: input.outputPath,
      componentsPath: input.componentsPath,
      workspaceDir: ctx.workspaceDir,
      inlineImages: input.inlineImages,
      inlineScripts: input.inlineScripts,
      inlineStyles: input.inlineStyles,
    })
  },
  toModelOutput: (_input, output): ReadonlyArray<ContentPart> => [
    {
      type: "text",
      text: [
        `Bundled report: ${output.outputPath}`,
        `Bytes read: ${output.bytesRead}`,
        `Bytes written: ${output.bytesWritten}`,
        `Inlined scripts: ${output.inlinedScripts}`,
        `Inlined stylesheets: ${output.inlinedStyles}`,
        `Inlined images: ${output.inlinedImages}`,
        ...(output.warnings.length > 0
          ? ["Warnings:", ...output.warnings.map((w) => `  - ${w}`)]
          : []),
      ].join("\n"),
    },
  ],
})
