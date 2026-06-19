import * as crypto from 'crypto';
import JSONBig from 'json-bigint';
import { CONFIG } from './config.js';

const JSONBigParse = JSONBig({ storeAsString: true });

const ENV_URLS = {
  'prod-live': ['https://open-api.bingx.com', 'https://open-api.bingx.pro'],
  'prod-vst': ['https://open-api-vst.bingx.com', 'https://open-api-vst.bingx.pro']
};

function isNetworkOrTimeout(e) {
  if (e instanceof TypeError) return true;
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'TimeoutError') return true;
  return false;
}

function validateParams(params) {
  const FORBIDDEN = /[&=?#\r\n]/;
  for (const [k, v] of Object.entries(params)) {
    const s = String(v);
    if (FORBIDDEN.test(s)) {
      throw new Error(`Parameter "${k}" contains forbidden character in value: "${s}".`);
    }
  }
}

function buildCanonical(params) {
  return Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

function encodeQueryValues(params, signature) {
  const pairs = Object.keys(params)
    .sort()
    .map(k => {
      const v = String(params[k]);
      const needsEncoding = v.includes('[') || v.includes('{');
      return `${k}=${needsEncoding ? encodeURIComponent(v) : v}`;
    });
  pairs.push(`signature=${signature}`);
  return pairs.join('&');
}

export async function fetchSigned(method, path, params = {}, jsonBody = false) {
  if (!CONFIG.bingxApiKey || !CONFIG.bingxSecretKey) {
    throw new Error('Thiếu BINGX_API_KEY hoặc BINGX_SECRET_KEY trong .env');
  }

  const baseUrls = ENV_URLS[CONFIG.bingxEnv] ?? ENV_URLS['prod-vst'];
  const timestamp = Date.now();
  const allParams = { ...params, timestamp, recvWindow: params.recvWindow ?? 5000 };
  validateParams(allParams);

  const canonical = buildCanonical(allParams);
  const signature = crypto
    .createHmac('sha256', CONFIG.bingxSecretKey)
    .update(canonical)
    .digest('hex');

  const needsValueEncoding = canonical.includes('[') || canonical.includes('{');

  for (const baseUrl of baseUrls) {
    try {
      let url;
      let body;
      let contentType;

      if (method === 'POST' && jsonBody) {
        url = `${baseUrl}${path}`;
        body = JSON.stringify({ ...allParams, signature });
        contentType = 'application/json';
      } else if (method === 'POST') {
        url = `${baseUrl}${path}`;
        body = `${canonical}&signature=${signature}`;
        contentType = 'application/x-www-form-urlencoded';
      } else {
        const query = needsValueEncoding ? encodeQueryValues(allParams, signature) : `${canonical}&signature=${signature}`;
        url = `${baseUrl}${path}?${query}`;
      }

      const res = await fetch(url, {
        method,
        headers: {
          'X-BX-APIKEY': CONFIG.bingxApiKey,
          'X-SOURCE-KEY': 'BX-AI-SKILL',
          ...(contentType ? { 'Content-Type': contentType } : {})
        },
        body,
        signal: AbortSignal.timeout(10000)
      });

      const text = await res.text();
      const json = JSONBigParse.parse(text);
      if (json.code !== 0) throw new Error(`BingX error ${json.code}: ${json.msg || text}`);
      return json.data;
    } catch (e) {
      if (!isNetworkOrTimeout(e) || baseUrl === baseUrls[baseUrls.length - 1]) throw e;
    }
  }
}

export async function fetchPublic(path, params = {}) {
  const baseUrls = ENV_URLS[CONFIG.bingxEnv] ?? ENV_URLS['prod-vst'];
  const query = new URLSearchParams(params).toString();

  for (const baseUrl of baseUrls) {
    try {
      const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-SOURCE-KEY': 'BX-AI-SKILL' },
        signal: AbortSignal.timeout(10000)
      });
      const text = await res.text();
      const json = JSONBigParse.parse(text);
      if (json.code !== 0) throw new Error(`BingX error ${json.code}: ${json.msg || text}`);
      return json.data;
    } catch (e) {
      if (!isNetworkOrTimeout(e) || baseUrl === baseUrls[baseUrls.length - 1]) throw e;
    }
  }
}
