---
name: langfuse-setup
description: Create ~/.cursor/langfuse.json so Langfuse tracing can start
---

The user wants Langfuse tracing turned on. Do these steps in order.

1. Create `~/.cursor/langfuse.json` with mode 600 when the file is missing. Leave the fields empty so tracing stays off until the user sets the keys and the host for their region:

```json
{
  "publicKey": "",
  "secretKey": "",
  "baseUrl": ""
}
```

The file is done when it exists and its mode is 600. Do not overwrite a file that already has keys.

2. Tell the user, briefly:

   Create a project at https://langfuse.com/cloud if you don't have one. In the project, open Settings → API Keys and copy the public key, secret key, and base URL for your region.

   Self-hosted: follow https://langfuse.com/self-hosting (Langfuse v4) and use your instance URL as the base URL.

   Give them a clickable link to the absolute path of `~/.cursor/langfuse.json` and ask them to paste the three values there. Leave the secret key out of the chat.

   This step is done when the user has been told to edit that file.

3. When both values are real keys, find `dist/index.mjs` under `~/.cursor/plugins/cache/cursor-public/langfuse-observability/` or `~/.cursor/plugins/local/langfuse-observability/` and run `node <that file> status`. Report the project name from that output. Do not print the keys.
