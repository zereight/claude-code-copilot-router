# CLAUDE.md

## Build/Lint/Test Commands

- Install dependencies: `npm i`
- Start server: `node index.mjs` (requires OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL env vars)
- Set environment variables:
  ```shell
  export DISABLE_PROMPT_CACHING=1
  export ANTHROPIC_AUTH_TOKEN="test"
  export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
  export API_TIMEOUT_MS=600000
  ```

## Code Style Guidelines

- Follow existing formatting in README.md and other files
- Use ES module syntax (`import`/`export`)
- Environment variables are uppercase with underscores
- API endpoints use `/v1/` prefix
- JSON payloads follow strict structure with model, max_tokens, messages, system, etc.
- Include type information in JSON payloads where possible
- Use descriptive variable names
- Keep code modular - separate files for router, index, etc.
- Include example usage/documentation in README
- Use markdown code blocks for code samples
- Document API endpoints and parameters
