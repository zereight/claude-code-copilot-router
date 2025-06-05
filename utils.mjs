import { HttpsProxyAgent } from 'https-proxy-agent';

export function getOpenAICommonOptions() {
  const options = {};
  if (process.env.PROXY_URL) {
    options.httpAgent = new HttpsProxyAgent(process.env.PROXY_URL);
  }
  return options;
}

/**
 * 순수 JSON만 남기고 undefined, 함수, Symbol, 순환 참조, [Object] 등 직렬화 불가 값 제거
 */
export function sanitizeJson(obj, seen = new WeakSet()) {
  // null, undefined, function, symbol, circular, stringified [Object] 제거
  if (
    obj === null ||
    typeof obj === 'undefined' ||
    typeof obj === 'function' ||
    typeof obj === 'symbol'
  )
    return undefined;
  if (typeof obj === 'string') {
    // '[Object]' 또는 '[object Object]' 등 stringified placeholder 제거
    if (
      obj.trim() === '[Object]' ||
      obj.trim() === '[object Object]' ||
      obj.trim().startsWith('[object') ||
      obj.trim().startsWith('{ [native code]') // 혹시 모를 native code stringified
    ) {
      return undefined;
    }
    return obj;
  }
  if (typeof obj !== 'object') return obj;
  if (seen.has(obj)) return undefined;
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj
      .map(item => sanitizeJson(item, seen))
      .filter(item => item !== undefined && item !== null);
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === 'function' ||
      typeof value === 'symbol' ||
      typeof value === 'undefined' ||
      value === null
    ) {
      continue;
    }
    const sanitized = sanitizeJson(value, seen);
    if (
      sanitized !== undefined &&
      sanitized !== null &&
      !(
        typeof sanitized === 'string' &&
        (sanitized.trim() === '[Object]' ||
          sanitized.trim() === '[object Object]' ||
          sanitized.trim().startsWith('[object') ||
          sanitized.trim().startsWith('{ [native code]'))
      )
    ) {
      result[key] = sanitized;
    }
  }
  return result;
}
