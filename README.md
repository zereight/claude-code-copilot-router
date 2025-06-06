# Claude Code Router

> This is a repository for testing routing Claude Code requests to different models.

## ⚠️ Important Notice: Not Suitable for Claude Code Integration

**This project is NOT recommended for use with Claude Code due to high request frequency causing 429 (rate limit) errors.** During POC testing, we found that Claude Code makes numerous rapid requests in short time periods, which consistently triggers rate limiting on most API providers. This makes the integration unreliable and impractical for real-world use.

![demo.png](https://github.com/musistudio/claude-code-reverse/blob/main/screenshoots/demo.png)

## Warning! This project is for testing purposes and may consume a lot of tokens! It may also fail to complete tasks!

## Implemented

- [x] Mormal Mode and Router Mode

- [x] Using the qwen2.5-coder-3b model as the routing dispatcher (since it’s currently free on Alibaba Cloud’s official website)

- [x] Using the qwen-max-0125 model as the tool invoker

- [x] Using deepseek-v3 as the coder model

- [x] Using deepseek-r1 as the reasoning model

- [x] Support proxy

Thanks to the free qwen2.5-coder-3b model from Alibaba and deepseek’s KV-Cache, we can significantly reduce the cost of using Claude Code. Make sure to set appropriate ignorePatterns for the project. See: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview

## Usage

0. Install Claude Code

```shell
npm install -g @anthropic-ai/claude-code
```

1. Clone this repo

```shell
git clone https://github.com/musistudio/claude-code-reverse.git
```

2. Install dependencies

```shell
npm i
```

3. Start server

```shell
# Alternatively, you can create an .env file in the repo directory
# You can refer to the .env.example file to create the .env file

## disable router
ENABLE_ROUTER=false
OPENAI_API_KEY=""
OPENAI_BASE_URL=""
OPENAI_MODEL=""

## enable router
ENABLE_ROUTER=true
export TOOL_AGENT_API_KEY=""
export TOOL_AGENT_BASE_URL=""
export TOOL_AGENT_MODEL="qwen-max-2025-01-25"

export CODER_AGENT_API_KEY=""
export CODER_AGENT_BASE_URL="https://api.deepseek.com"
export CODER_AGENT_MODEL="deepseek-chat"

export THINK_AGENT_API_KEY=""
export THINK_AGENT_BASE_URL="https://api.deepseek.com"
export THINK_AGENT_MODEL="deepseek-reasoner"

export ROUTER_AGENT_API_KEY=""
export ROUTER_AGENT_BASE_URL=""
export ROUTER_AGENT_MODEL="qwen2.5-coder-3b-instruct"

node index.mjs
```

4. Set environment variable to start claude code

```shell
export DISABLE_PROMPT_CACHING=1
export ANTHROPIC_AUTH_TOKEN="test"
export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
export API_TIMEOUT_MS=600000
claude
```

## Normal Mode

The initial version uses a single model to accomplish all tasks. This model needs to support function calling and must allow for a sufficiently large tool description length, ideally greater than 1754. If the model used in this mode does not support KV Cache, it will consume a significant number of tokens.

![normal mode](https://github.com/musistudio/claude-code-reverse/blob/main/screenshoots/normal.png)

## Router Mode

Using multiple models to handle different tasks, this mode requires setting ENABLE_ROUTER to true and configuring four models: ROUTER_AGENT_MODEL, TOOL_AGENT_MODEL, CODER_AGENT_MODEL, and THINK_AGENT_MODEL.

ROUTER_AGENT_MODEL does not require high intelligence and is only responsible for request routing. A small model is sufficient for this task (testing has shown that the qwen-coder-3b model performs well).
TOOL_AGENT_MODEL must support function calling and allow for a sufficiently large tool description length, ideally greater than 1754. If the model used in this mode does not support KV Cache, it will consume a significant number of tokens.

CODER_AGENT_MODEL and THINK_AGENT_MODEL can use the DeepSeek series of models.

The purpose of router mode is to separate tool invocation from coding tasks, enabling the use of inference models like r1, which do not support function calling.

![router mode](https://github.com/musistudio/claude-code-reverse/blob/main/screenshoots/router.png)
