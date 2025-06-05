import { OpenAI } from 'openai';
import { getOpenAICommonOptions } from './utils.mjs';

const useToolRouter = {
  name: 'use-tool',
  description: `This agent can call user-specified tools to perform tasks. The user provides a list of tools to be used, and the agent integrates these tools to complete the specified tasks efficiently. The agent follows user instructions and ensures proper tool utilization for each request`,
  run(args) {
    const client = new OpenAI({
      apiKey: process.env.TOOL_AGENT_API_KEY,
      baseURL: process.env.TOOL_AGENT_BASE_URL,
      ...getOpenAICommonOptions()
    });
    return client.chat.completions.create({
      ...args,
      messages: [
        ...args.messages,
        {
          role: 'system',
          content:
            'You need to select the appropriate tool for the task based on the user’s request. Review the requirements and choose the tool that fits the task best.'
        }
      ],
      model: process.env.TOOL_AGENT_MODEL
    });
  }
};

const coderRouter = {
  name: 'coder',
  description: `This agent is solely responsible for helping users write code. This agent could not call tools. This agent is used for writing and modifying code when the user provides clear and specific coding requirements. For example, tasks like implementing a quicksort algorithm in JavaScript or creating an HTML layout. If the user's request is unclear or cannot be directly translated into code, please route the task to 'Thinker' first for clarification or further processing.`,
  run(args) {
    const client = new OpenAI({
      apiKey: process.env.CODER_AGENT_API_KEY,
      baseURL: process.env.CODER_AGENT_BASE_URL,
      ...getOpenAICommonOptions()
    });
    delete args.tools;
    args.messages.forEach(item => {
      if (Array.isArray(item.content)) {
        item.content = JSON.stringify(item.content);
      }
    });
    return client.chat.completions.create({
      ...args,
      messages: [
        ...args.messages,
        {
          role: 'system',
          content:
            'You are a code writer who helps users write code based on their specific requirements. You create algorithms, implement functionality, and build structures according to the clear instructions provided by the user. Your focus is solely on writing code, ensuring that the task is completed accurately and efficiently.'
        }
      ],
      model: process.env.CODER_AGENT_MODEL
    });
  }
};

const thinkRouter = {
  name: 'thinker',
  description: `This agent is used solely for complex reasoning and thinking tasks. It should not be called for information retrieval or repetitive, frequent requests. Only use this agent for tasks that require deep analysis or problem-solving. If there is an existing result from the Thinker agent, do not call this agent again.`,
  run(args) {
    const client = new OpenAI({
      apiKey: process.env.THINK_AGENT_API_KEY,
      baseURL: process.env.THINK_AGENT_BASE_URL,
      ...getOpenAICommonOptions()
    });
    const messages = JSON.parse(JSON.stringify(args.messages));
    messages.forEach(msg => {
      if (Array.isArray(msg.content)) {
        msg.content = JSON.stringify(msg.content);
      }
    });

    let startIdx = messages.findIndex(msg => msg.role !== 'system');
    if (startIdx === -1) startIdx = messages.length;

    for (let i = startIdx; i < messages.length; i++) {
      const expectedRole = (i - startIdx) % 2 === 0 ? 'user' : 'assistant';
      messages[i].role = expectedRole;
    }

    if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
      messages.push({
        role: 'user',
        content: 'Please follow the instructions provided above to resolve the issue.'
      });
    }
    delete args.tools;
    return client.chat.completions.create({
      ...args,
      messages,
      model: process.env.THINK_AGENT_MODEL
    });
  }
};

export class Router {
  constructor() {
    this.routers = [useToolRouter, coderRouter, thinkRouter];
    this.client = new OpenAI({
      apiKey: process.env.ROUTER_AGENT_API_KEY,
      baseURL: process.env.ROUTER_AGENT_BASE_URL,
      ...getOpenAICommonOptions()
    });
  }
  async route(args) {
    const res = await this.client.chat.completions.create({
      ...args,
      messages: [
        ...args.messages,
        {
          role: 'system',
          content: `You are an AI task router that receives user requests and forwards them to the appropriate AI models for task handling. You do not process any requests directly but are responsible for understanding the user's request and choosing the correct router based on the task and necessary steps. The available routers are: ${JSON.stringify(
            this.routers.map(router => {
              return {
                name: router.name,
                description: router.description
              };
            })
          )}. Each router is designated for specific types of tasks, and you ensure that the request is routed accordingly for efficient processing. Use the appropriate router based on the user’s request:

If external tools are needed to gather more information, use the 'use-tool' router.
If the task involves writing code, use the 'coder' router.
If deep reasoning or analysis is required to break down steps, use the 'thinker' router.
Instead, format your response as a JSON object with one field: 'use' (string)`
        }
      ],
      model: process.env.ROUTER_AGENT_MODEL,
      stream: false
    });
    let result;
    try {
      const text = res.choices[0].message.content;
      result = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch (e) {
      console.log(e);
      res.choices[0].delta = res.choices[0].message;
      return [res];
    }
    const router = this.routers.find(item => item.name === result.use);
    if (!router) {
      res.choices[0].delta = res.choices[0].message;
      return [res];
    }
    if (router.name === 'thinker' || router.name === 'coder') {
      const agentResult = await router.run({
        ...args,
        stream: false
      });
      try {
        args.messages.push({
          role: 'assistant',
          content: `${router.name} Agent Result: ` + agentResult.choices[0].message.content
        });
        return await this.route(args);
      } catch (error) {
        console.log(agentResult);
        throw error;
      }
    }
    return router.run(args);
  }
}
