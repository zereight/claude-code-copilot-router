import express from 'express';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { Router } from './router.mjs';
import { sanitizeJson } from './utils.mjs';
import fetch from 'node-fetch';
import { TextDecoder } from 'util';

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
  client = {
    call: async data => {
      console.log('🔎 OpenAI API 호출 파라미터:');
      console.log(data);

      // OpenRouter에서 지원하지 않는 Claude 모델들을 DeepSeek으로 강제 변경
      const supportedModel = process.env.OPENAI_MODEL || 'google/gemini-2.5-pro-preview';
      const newData = {
        ...data,
        model: supportedModel // 항상 환경변수의 지원되는 모델 사용
      };
      console.log('🔎 실제 API 호출 모델:', newData.model);
      console.log('🔎 원본 요청 모델:', data.model);

      // 메시지에 이미지가 포함되어 있는지 확인
      const hasImage = newData.messages?.some(
        msg => Array.isArray(msg.content) && msg.content.some(part => part.type === 'image_url')
      );

      // 헤더 준비
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'HTTP-Referer': 'https://claude-code-copilot-router.local',
        'X-Title': 'Claude Code Copilot Router'
      };

      // 이미지가 포함된 경우 비전 헤더 추가
      if (hasImage) {
        headers['Copilot-Vision-Request'] = 'true';
        console.log('🖼️ 비전 요청 헤더 추가됨');
      }

      // OpenRouter API에 직접 HTTP 요청 (OpenAI SDK 헤더 문제 해결)
      const response = await fetch(process.env.OPENAI_BASE_URL + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(newData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenRouter API 에러:', response.status, errorText);
        throw new Error(`OpenRouter API 에러: ${response.status} ${errorText}`);
      }

      // 스트림 응답을 OpenAI SDK 형식으로 변환
      return {
        [Symbol.asyncIterator]: async function* () {
          // Node.js 환경에서는 response.body.getReader()가 동작하지 않으므로, response.body를 직접 처리
          const decoder = new TextDecoder();
          let buffer = '';

          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 마지막 불완전한 줄 유지

            for (const line of lines) {
              if (line.startsWith('data: ') && line.length > 6) {
                const data = line.slice(6);
                if (data === '[DONE]') return;

                try {
                  const parsed = JSON.parse(data);
                  yield parsed;
                } catch (e) {
                  console.warn('JSON 파싱 에러:', e, 'data:', data);
                }
              }
            }
          }
        }
      };
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
    // map 호출 전 배열 보장
    messages = Array.isArray(messages) ? messages : [];
    tools = Array.isArray(tools) ? tools : [];
    system = Array.isArray(system) ? system : [];
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
            // 디버깅: 받은 content 내용 확인
            if (it?.type === 'image_url' || it?.type === 'image') {
              console.log('🖼️ 이미지 데이터 구조:', JSON.stringify(it, null, 2));
            }

            // OpenRouter는 'text'와 'image_url' 타입만 지원
            if (it?.type === 'image_url' || it?.type === 'image') {
              // 이미지 URL 확인 - 다양한 형식 지원
              let imageUrl = '';

              // Claude의 다양한 이미지 형식 처리
              if (it?.type === 'image' && it?.source) {
                // Claude의 image 타입 처리
                if (it.source.type === 'base64' && it.source.data) {
                  // base64 데이터를 data URL로 변환
                  const mediaType = it.source.media_type || 'image/png';
                  imageUrl = `data:${mediaType};base64,${it.source.data}`;
                } else if (it.source.data) {
                  // 이미 data URL 형식인 경우
                  imageUrl = it.source.data;
                }
              } else if (it?.image_url?.url) {
                // image_url 타입
                imageUrl = it.image_url.url;
              } else if (it?.url) {
                // 단순 url 속성
                imageUrl = it.url;
              }

              console.log('🔗 추출된 이미지 URL:', imageUrl.substring(0, 100) + '...');

              // 이미지 URL이 비어있는 경우
              if (!imageUrl) {
                console.log('❌ 이미지 URL을 찾을 수 없음');
                return {
                  type: 'text',
                  text: '[이미지를 찾을 수 없습니다. 이미지가 제대로 업로드되었는지 확인해주세요.]'
                };
              }

              // file:// 프로토콜은 로컬 파일이므로 OpenRouter에 전송 불가
              if (imageUrl.startsWith('file://')) {
                console.log('❌ 로컬 파일 이미지 감지');
                return {
                  type: 'text',
                  text: '[로컬 이미지는 OpenRouter로 전송할 수 없습니다. 이미지를 base64로 인코딩하거나 외부 URL을 사용해주세요.]'
                };
              }

              // data: URL이나 https: URL은 그대로 전달
              if (imageUrl.startsWith('data:') || imageUrl.startsWith('http')) {
                console.log('✅ 지원되는 이미지 형식 감지');
                return {
                  type: 'image_url',
                  image_url: {
                    url: imageUrl,
                    detail: 'auto' // OpenRouter 권장 설정
                  }
                };
              }

              // 기타 형식의 이미지는 텍스트로 변환
              console.log('⚠️ 지원하지 않는 이미지 형식');
              return {
                type: 'text',
                text: '[지원하지 않는 이미지 형식입니다]'
              };
            }

            // 이미지가 아닌 경우 기존 로직
            const msg = {
              ...it,
              type: 'text'
            };
            msg.text = it?.content ? JSON.stringify(it.content) : it?.text || '';
            delete msg.content;
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
            // function name 64자 제한, 허용 문자만 필터링, 첫 글자 영문/언더스코어 보장
            let safeName = item.name
              .replace(/[^a-zA-Z0-9_.-]/g, '_') // 허용 문자만
              .replace(/^[^a-zA-Z_]+/, '_') // 첫 글자 보정
              .slice(0, 64); // 64자 제한
            return {
              type: 'function',
              function: {
                name: safeName,
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
        messages: data.messages.map(msg => ({
          role: msg.role,
          content: Array.isArray(msg.content)
            ? msg.content.map(c => ({
                type: c.type,
                text: c.text ? c.text.substring(0, 50) + '...' : undefined,
                image_url: c.image_url ? '이미지 URL 있음' : undefined
              }))
            : msg.content
        })),
        tools: data.tools?.length || 0,
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
