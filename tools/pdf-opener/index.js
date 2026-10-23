import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import path from "path";

const server = new Server(
  { name: "pdf-opener", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "open_pdf",
      description: "Open a PDF file in macOS Preview at a specific page",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute file path to the PDF",
          },
          page: {
            type: "integer",
            description: "Page number to open (1-indexed)",
          },
        },
        required: ["path", "page"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "open_pdf") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { path: filePath, page } = request.params.arguments;
  const filename = path.basename(filePath);

  // Escape double quotes in the path for AppleScript string safety
  const escapedPath = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const script = `
tell application "Preview"
  activate
  open POSIX file "${escapedPath}"
  delay 1.5
  tell front document
    set currentPage to ${page}
  end tell
end tell
  `.trim();

  return new Promise((resolve) => {
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout, stderr) => {
      if (err) {
        resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                message: stderr || err.message,
              }),
            },
          ],
        });
      } else {
        resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Opened ${filename} at page ${page}`,
              }),
            },
          ],
        });
      }
    });
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
