// provider.js —— 模型适配层（OpenAI 兼容协议）
//
// V1 只实现一套适配，但通过 base_url 可指向任意 OpenAI 兼容端点：
//   - OpenAI 官方：https://api.openai.com/v1
//   - DeepSeek：   https://api.deepseek.com
//   - 通义千问：    https://dashscope.aliyuncs.com/compatible-mode/v1
//   - Moonshot：    https://api.moonshot.cn/v1
//   - 本地 Ollama：  http://localhost:11434/v1
//   - 本地 vLLM/LM Studio：相应 /v1 端点
// 这样「一家实现」反而覆盖最广，后续如需原生 Claude/Gemini 协议再在此文件加分支。
//
// 错误模型：所有失败统一抛 AiError，带 retryable 标志。
//   - 网络/超时/5xx/429 → retryable=true（调用方可重试）
//   - 401/403/400（请求格式错） → retryable=false（重试无意义）
// report.js / schedule.js 据此决定是否走降级路径。

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { SYSTEM_PROMPT, buildUserMessage } = require('./prompt');

class AiError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = 'AiError';
    this.retryable = retryable;
    this.status = status;
  }
}

// 调用模型。返回 { text, usage, model }。
//   config: db.getAiConfig() 的返回值
//   summary: summarizer.summarize() 的返回值
async function analyze(config, summary) {
  if (!config.api_key) {
    throw new AiError('未配置 API Key', { retryable: false });
  }
  if (!config.model) {
    throw new AiError('未配置模型名称', { retryable: false });
  }

  const baseUrl = (config.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const endpoint = baseUrl + '/chat/completions';
  const userMsg = buildUserMessage(summary);

  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg }
    ],
    temperature: 0.3,    // 低温度：分析报告倾向稳定、可复现
    response_format: { type: 'json_object' } // 强制 JSON 输出（兼容端点支持时生效，不支持则忽略）
  });

  const result = await httpRequest(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.api_key}`,
      'Content-Length': Buffer.byteLength(body) // 显式声明，避免非标代理 411
    },
    body,
    timeoutMs: 30000 // 超时偏保守：日报非实时，失败会降级而非丢失
  });

  // 解析 OpenAI 兼容响应结构
  let data;
  try { data = JSON.parse(result.body); }
  catch (e) {
    throw new AiError('响应不是合法 JSON：' + result.body.slice(0, 200), { retryable: false, status: result.status });
  }

  if (data.error) {
    // API 层错误（如 invalid_api_key、model_not_found、rate_limit_exceeded）
    const msg = data.error.message || JSON.stringify(data.error);
    const status = result.status || 0;
    const retryable = status === 429 || (status >= 500 && status < 600);
    throw new AiError(msg, { retryable, status });
  }

  const text = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  if (!text) {
    throw new AiError('响应缺少 choices[0].message.content', { retryable: false, status: result.status });
  }

  return {
    text,
    usage: data.usage || null,
    model: data.model || config.model
  };
}

// 底层 HTTP 请求（原生 http/https，避免引入额外依赖，与 alerts.js 的 Telegram 请求风格一致）。
function httpRequest(urlStr, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(urlStr); }
    catch (e) { return reject(new AiError('无效的 base_url：' + urlStr, { retryable: false })); }

    const lib = urlObj.protocol === 'https:' ? https : http;
    const MAX_BYTES = 2 * 1024 * 1024; // 响应上限 2MB，防异常端点撑爆内存
    let received = 0;
    const req = lib.request(urlObj, { method, headers }, (res) => {
      let chunks = '';
      res.on('data', (c) => {
        received += c.length;
        if (received > MAX_BYTES) {
          req.destroy();
          return reject(new AiError('响应超过 2MB 上限', { retryable: false, status: res.statusCode }));
        }
        chunks += c;
      });
      res.on('end', () => {
        // 4xx/5xx 仍尝试返回 body 供上层从 data.error 解析；若非 JSON 再抛错
        resolve({ status: res.statusCode || 0, body: chunks });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new AiError('请求超时', { retryable: true }));
    });
    req.on('error', (e) => {
      // 网络层错误（DNS/连接中断/RESET）一律可重试
      reject(new AiError('网络错误：' + e.message, { retryable: true }));
    });

    req.setTimeout(timeoutMs);
    req.write(body);
    req.end();
  });
}

// 把模型的 JSON 文本解析为结构化对象，容错处理（去 markdown 围栏、截取首个 JSON 对象）。
function parseAnalysis(text) {
  if (!text) return null;
  let t = String(text).trim();
  // 去掉可能的 ```json ... ``` 围栏（即便要求了不输出，模型偶尔还是会加）
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // 截取首个 { 到末尾 }（容错模型在 JSON 前后加了废话）
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

module.exports = { analyze, parseAnalysis, AiError };
