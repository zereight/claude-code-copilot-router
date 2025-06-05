import express from 'express';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { Router } from './router.mjs';
import { getOpenAICommonOptions, sanitizeJson } from './utils.mjs';

dotenv.config();
const app = express();
const port = 3456;
app.use(express.json({ limit: '500mb' }));

let client;
if (process.env.ENABLE_ROUTER && process.env.ENABLE_ROUTER === 'true') {
  const router = new Router();
  client = {
    call: data => {
      return router.route(data);
    }
  };
} else {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    ...getOpenAICommonOptions()
  });
  client = {
    call: data => {
      const newData = { ...data, model: process.env.OPENAI_MODEL };
      return openai.chat.completions.create(newData);
    }
  };
}

app.post('/v1/messages', async (req, res) => {
  // 상태 변수 선언 (eslint 에러 방지)
  let completion;
  let currentContentBlocks;
  let toolUseJson;
  let isToolUse;
  let hasStartedTextBlock;
  let contentBlockIndex;

  try {
    let { model, messages, system = [], temperature, tools } = req.body;
    // 상태 변수 초기화
    completion = undefined;
    currentContentBlocks = [];
    toolUseJson = '';
    isToolUse = false;
    hasStartedTextBlock = false;
    contentBlockIndex = 0;

    messages = messages.map(item => {
      if (item.content instanceof Array) {
        return {
          role: item.role,
          content: item.content.map(it => {
            const msg = {
              ...it,
              type: ['tool_result', 'tool_use'].includes(it?.type) ? 'text' : it?.type
            };
            if (msg.type === 'text') {
              msg.text = it?.content ? JSON.stringify(it.content) : it?.text || '';
              delete msg.content;
            }
            return msg;
          })
        };
      }
      return {
        role: item.role,
        content: item.content
      };
    });
    // messages, system, tools 모두 새 객체로 깊은 복사
    const safeSystem = Array.isArray(system)
      ? system.map(item => ({
          role: 'system',
          content: item.text
        }))
      : [];
    const safeMessages = Array.isArray(messages)
      ? messages.map(item => ({
          role: item.role,
          content:
            typeof item.content === 'object'
              ? JSON.parse(JSON.stringify(item.content))
              : item.content
        }))
      : [];
    // tools 파라미터 개수 제한(최대 64개), 필요 없는 function/tool 제외
    const safeTools = Array.isArray(tools)
      ? tools
          .filter(
            tool =>
              tool &&
              typeof tool === 'object' &&
              tool.name &&
              !['StickerRequest', 'UnusedFunction', 'DeprecatedTool'].includes(tool.name) // 필요시 제외 항목 확장
          )
          .slice(0, 64)
          .map(item => {
            // input_schema를 안전하게 JSON으로 변환
            let schema =
              item.input_schema && typeof item.input_schema === 'object'
                ? sanitizeJson(item.input_schema)
                : {};
            if (schema && typeof schema === 'object' && '$schema' in schema) {
              delete schema['$schema'];
            }
            return {
              type: 'function',
              function: {
                name: item.name,
                description: item.description,
                parameters: schema
              }
            };
          })
      : undefined;

    const data = Object.freeze({
      model,
      messages: [...safeSystem, ...safeMessages],
      temperature,
      stream: true,
      ...(safeTools ? { tools: safeTools } : {})
    });

    // OpenAI API 호출 직전 파라미터 구조 출력
    console.log('🔎 OpenAI API 호출 파라미터:');
    console.dir(
      {
        model: data.model,
        messages: data.messages,
        tools: data.tools,
        temperature: data.temperature,
        stream: data.stream
      },
      { depth: 10 }
    );
    // tools 파라미터 JSON.stringify로 실제 전송 구조 확인
    if (data.tools) {
      try {
        console.log('🔎 tools 파라미터(JSON):\n' + JSON.stringify(data.tools, null, 2));
      } catch (e) {
        console.error('tools 파라미터 stringify 실패:', e);
      }
    }

    completion = await client.call(data);

    // Set SSE response headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const messageId = 'msg_' + Date.now();

    // Send message_start event
    const messageStart = {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

    try {
      for await (const chunk of completion) {
        // 방어적 코딩: chunk, choices, choices[0], delta 존재 여부 체크
        const delta =
          chunk &&
          Array.isArray(chunk.choices) &&
          chunk.choices.length > 0 &&
          chunk.choices[0] &&
          chunk.choices[0].delta
            ? chunk.choices[0].delta
            : undefined;
        if (!delta) continue;
        if (delta.tool_calls && delta.tool_calls.length > 0) {
          const toolCall = delta.tool_calls[0];

          if (!isToolUse) {
            // Start new tool call block
            isToolUse = true;

            const toolBlockStart = {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: {
                type: 'tool_use',
                id: `toolu_${Date.now()}`,
                name: toolCall.function.name,
                input: {}
              }
            };

            // Add to content blocks list
            currentContentBlocks.push({
              type: 'tool_use',
              id: toolBlockStart.content_block.id,
              name: toolCall.function.name,
              input: {}
            });

            res.write(`event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`);
            toolUseJson = '';
          }

          // Stream tool call JSON
          if (toolCall.function.arguments) {
            const jsonDelta = {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: toolCall.function.arguments
              }
            };

            toolUseJson += toolCall.function.arguments;

            // Try to parse complete JSON and update content block
            try {
              const parsedJson = JSON.parse(toolUseJson);
              currentContentBlocks = currentContentBlocks.map((block, idx) =>
                idx === contentBlockIndex ? { ...block, input: parsedJson } : block
              );
            } catch {
              // JSON not yet complete, continue accumulating
            }

            res.write(`event: content_block_delta\ndata: ${JSON.stringify(jsonDelta)}\n\n`);
          }
        } else if (delta.content) {
          // Handle regular text content
          if (isToolUse) {
            // End previous tool call block
            const contentBlockStop = {
              type: 'content_block_stop',
              index: contentBlockIndex
            };

            res.write(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`);
            contentBlockIndex++;
            isToolUse = false;
          }

          if (!delta.content) continue;

          // If text block not yet started, send content_block_start
          if (!hasStartedTextBlock) {
            const textBlockStart = {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: {
                type: 'text',
                text: ''
              }
            };

            // Add to content blocks list
            currentContentBlocks.push({
              type: 'text',
              text: ''
            });

            res.write(`event: content_block_start\ndata: ${JSON.stringify(textBlockStart)}\n\n`);
            hasStartedTextBlock = true;
          }

          // Send regular text content
          const contentDelta = {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: {
              type: 'text_delta',
              text: delta.content
            }
          };

          // Update content block text
          if (currentContentBlocks[contentBlockIndex]) {
            currentContentBlocks = currentContentBlocks.map((block, idx) =>
              idx === contentBlockIndex ? { ...block, text: block.text + delta.content } : block
            );
          }

          res.write(`event: content_block_delta\ndata: ${JSON.stringify(contentDelta)}\n\n`);
        }
      }
    } finally {
      // 클린업: 상태값, 스트림 등 모두 초기화
      completion = null;
      currentContentBlocks = [];
      toolUseJson = '';
      isToolUse = false;
      hasStartedTextBlock = false;
      contentBlockIndex = 0;
    }

    // Close last content block
    const contentBlockStop = {
      type: 'content_block_stop',
      index: contentBlockIndex
    };

    res.write(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`);

    // Send message_delta event with appropriate stop_reason
    const messageDelta = {
      type: 'message_delta',
      delta: {
        stop_reason: isToolUse ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        content: currentContentBlocks
      },
      usage: { input_tokens: 100, output_tokens: 150 }
    };

    res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);

    // Send message_stop event
    const messageStop = {
      type: 'message_stop'
    };

    res.write(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`);
    res.end();
  } catch (error) {
    console.error('Error in streaming response:', error);
    // 방어적 코딩: 이미 응답이 전송된 경우 추가 응답 방지
    if (!res.headersSent) {
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  }
});

async function initializeClaudeConfig() {
  const homeDir = process.env.HOME;
  const configPath = `${homeDir}/.claude.json`;
  if (!existsSync(configPath)) {
    const userID = Array.from({ length: 64 }, () => Math.random().toString(16)[2]).join('');
    const configContent = {
      numStartups: 184,
      autoUpdaterStatus: 'enabled',
      userID,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '0.2.9',
      projects: {}
    };
    await writeFile(configPath, JSON.stringify(configContent, null, 2));
  }
}

async function run() {
  await initializeClaudeConfig();

  app.listen(port, '0.0.0.0', () => {
    console.log(`Example app listening on port ${port}`);
  });
}
run();
