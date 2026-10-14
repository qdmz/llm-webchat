// LLM WebChat - 零依赖 Node.js (>=18) 服务端
// 功能：静态页面 + OpenAI 兼容接口转发（流式）+ 在线配置 + 多模态上传（图片/文档/视频）+ 悬浮挂件
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH && !fs.existsSync(path.join(__dirname, "admin.hash"))) console.warn("[警告] 未设置 ADMIN_PASSWORD，设置页将无法登录。");

// ---------- 配置 ----------
const DEFAULT_CONFIG = {
  baseUrl: 'https://api.openai.com/v1',   // 仅用于兼容旧配置迁移
  apiKey: '',
  models: [],
  providers: null,         // [{id,name,type:'openai'|'systemone',baseUrl,apiKey,models:[],questions}]
  defaultModel: 'gpt-4o-mini',
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
  publicAccess: true,
  accessCode: '',
  vision: true,            // 图片以 image_url 发给模型
  videoMode: 'frames',     // frames=抽帧成图片 | video_url=发送视频链接 | off=不发送
  videoFrames: 6,
  maxUploadMB: 20,
  retentionDays: 7,
  docMaxChars: 60000,
  widgetTitle: '在线助手',
  widgetColor: '#2563eb'
};
const DEFAULT_QUESTIONS = JSON.stringify({
  intent: { type: 'choice', instructions: '这段内容属于哪类诉求？', criteria: { consult: '咨询', complaint: '投诉', tech: '技术问题', other: '其他' } },
  urgent: { type: 'noul', instructions: '是否需要紧急处理？' },
  severity: { type: 'score', instructions: '严重程度', criteria: ['轻微', '一般', '严重', '非常严重'] }
}, null, 2);
function newProviderId() { return 'p' + crypto.randomBytes(3).toString('hex'); }
function normalizeConfig(c) {
  if (!Array.isArray(c.providers) || !c.providers.length) {
    // 兼容旧版单服务商配置
    const models = c.models && c.models.length ? c.models : [c.defaultModel];
    c.providers = [{ id: 'p1', name: '默认', type: 'openai', baseUrl: c.baseUrl, apiKey: c.apiKey, models, questions: '' }];
    if (c.defaultModel && !String(c.defaultModel).includes('::')) c.defaultModel = 'p1::' + c.defaultModel;
  }
  delete c.baseUrl; delete c.apiKey; delete c.models;
  return c;
}
function loadConfig() {
  let c;
  try { c = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { c = { ...DEFAULT_CONFIG }; }
  return applyEnvProvider(normalizeConfig(c));
}
// 通过环境变量预置服务商（适合无持久磁盘的云平台）：LLM_API_KEY / LLM_BASE_URL / LLM_MODELS(逗号分隔) / LLM_PROVIDER_NAME
function applyEnvProvider(c) {
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return c;
  const models = String(process.env.LLM_MODELS || process.env.DEFAULT_MODEL || 'gpt-4o-mini').split(',').map(s => s.trim()).filter(Boolean);
  const env = { id: 'penv', name: process.env.LLM_PROVIDER_NAME || '默认', type: 'openai',
    baseUrl: (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: key, models, questions: '', fromEnv: true };
  // 去掉没有 key 的占位服务商，替换旧的 env 服务商
  c.providers = [env, ...c.providers.filter(p => p.id !== 'penv' && p.apiKey)];
  const valid = c.providers.some(p => (p.models || []).some(m => `${p.id}::${m}` === c.defaultModel) && p.apiKey);
  if (!valid) c.defaultModel = `penv::${models[0]}`;
  return c;
}
function modelList() {
  const multi = config.providers.length > 1;
  const out = [];
  for (const p of config.providers) for (const m of (p.models || [])) {
    out.push({ value: `${p.id}::${m}`, label: (p.type === 'systemone' ? '🧭 ' : '') + m + (multi ? ` · ${p.name}` : ''), type: p.type });
  }
  return out;
}
function resolveModel(value) {
  const list = modelList();
  const hit = list.find(x => x.value === value) || list.find(x => x.value === config.defaultModel) || list[0];
  if (!hit) return null;
  const [pid, ...rest] = hit.value.split('::');
  return { provider: config.providers.find(p => p.id === pid), model: rest.join('::'), value: hit.value };
}
// 管理员密码：优先用设置页修改后的哈希，否则用环境变量
function hashPassword(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); }
function checkPassword(pw) {
  if (config.adminPasswordHash) {
    const [salt, h] = config.adminPasswordHash.split(':');
    return safeEqual(crypto.scryptSync(String(pw), salt, 32).toString('hex'), h);
  }
  if (ADMIN_PASSWORD) return safeEqual(pw, ADMIN_PASSWORD);
  // 无环境变量时可用仓库内 admin.hash（scrypt "salt:hash"），适合不能设置环境变量的平台
  const fileHash = process.env.ADMIN_PASSWORD_HASH || (() => { try { return fs.readFileSync(path.join(__dirname, 'admin.hash'), 'utf8').trim(); } catch { return ''; } })();
  if (fileHash.includes(':')) {
    const [salt, h] = fileHash.split(':');
    return safeEqual(crypto.scryptSync(String(pw), salt, 32).toString('hex'), h);
  }
  return false;
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 }); }
let config = loadConfig();

// ---------- 管理员会话 ----------
const sessions = new Map();
function newSession() { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, Date.now() + 12 * 3600e3); return t; }
function bearer(req) { return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''); }
function isAdmin(req) {
  const exp = sessions.get(bearer(req));
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(bearer(req)); return false; }
  return true;
}
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
const loginFails = new Map();
function tooManyFails(ip) { const r = loginFails.get(ip); return r && r.count >= 5 && Date.now() - r.t < 600e3; }

// ---------- 工具 ----------
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function maskKey(k) { return k ? (k.length > 10 ? k.slice(0, 4) + '****' + k.slice(-4) : '****') : ''; }
function upstreamUrl(base, p) { return base.replace(/\/+$/, '') + p; }
// 用户常把 Base URL 少填 /v1，这里按协议自动补全
function provBase(prov) {
  let b = String(prov.baseUrl || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/(messages|chat\/completions|models)$/, '');
  if (prov.type === 'anthropic' && !/\/v\d+[a-z0-9]*$/i.test(b)) b += '/v1';
  if (prov.type === 'gemini' && !/\/v\d+[a-z0-9]*$/i.test(b)) b += '/v1beta';
  return b;
}
function publicConfig() {
  const models = modelList();
  const def = resolveModel(config.defaultModel);
  return { models, defaultModel: def ? def.value : '', needAccessCode: !config.publicAccess, maxUploadMB: config.maxUploadMB, widgetTitle: config.widgetTitle, widgetColor: config.widgetColor };
}
function checkAccess(req) { return config.publicAccess || (config.accessCode && safeEqual(req.headers['x-access-code'] || '', config.accessCode)); }
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120e3, ...opts }, (e, out, err) => e ? reject(new Error((err || e.message).toString().slice(0, 300))) : resolve(out)));
}
function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return (process.env.PUBLIC_URL || `${proto}://${req.headers.host}`).replace(/\/+$/, '');
}

// ---------- 上传文件 ----------
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.xml': 'text/xml', '.zip': 'application/zip'
};
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.ini', '.conf', '.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.php', '.rb', '.sh', '.sql', '.vue', '.kt', '.swift', '.cs']);
function kindOf(mime, ext) {
  if (mime.startsWith('image/') && ext !== '.svg') return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (TEXT_EXT.has(ext) || mime.startsWith('text/') || ['.pdf', '.docx', '.xlsx', '.pptx'].includes(ext)) return 'doc';
  return 'file';
}
const ID_RE = /^[a-f0-9]{24}$/;
async function getMeta(id) {
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(await fsp.readFile(path.join(UPLOAD_DIR, id + '.json'), 'utf8')); } catch { return null; }
}
function filePath(meta) { return path.join(UPLOAD_DIR, meta.id + meta.ext); }

async function handleUpload(req, res) {
  const max = config.maxUploadMB * 1024 * 1024;
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > max) return json(res, 413, { error: `文件超过 ${config.maxUploadMB}MB 上限` });
  let name = 'file';
  try { name = decodeURIComponent(req.headers['x-filename'] || 'file'); } catch {}
  name = path.basename(name).replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
  const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [''])[0];
  const mime = MIME_BY_EXT[ext] || (req.headers['content-type'] || 'application/octet-stream').split(';')[0];
  const id = crypto.randomBytes(12).toString('hex');
  const dest = path.join(UPLOAD_DIR, id + ext);
  const out = fs.createWriteStream(dest);
  let size = 0, aborted = false;
  await new Promise(resolve => {
    req.on('data', c => {
      size += c.length;
      if (size > max && !aborted) { aborted = true; out.destroy(); req.destroy(); resolve(); }
      else if (!aborted) out.write(c);
    });
    req.on('end', () => out.end(resolve));
    req.on('error', () => { aborted = true; resolve(); });
  });
  if (aborted || size === 0) { fs.rm(dest, { force: true }, () => {}); return json(res, aborted ? 413 : 400, { error: aborted ? `文件超过 ${config.maxUploadMB}MB 上限` : '空文件' }); }
  const meta = { id, name, ext, mime, size, kind: kindOf(mime, ext), t: Date.now() };
  await fsp.writeFile(path.join(UPLOAD_DIR, id + '.json'), JSON.stringify(meta));
  json(res, 200, { id, name, mime, size, kind: meta.kind, url: 'uploads/' + id });
}

async function serveUpload(req, res, id, download) {
  const meta = await getMeta(id);
  if (!meta) { res.writeHead(404); return res.end('文件不存在或已过期'); }
  const fp = filePath(meta);
  let st; try { st = await fsp.stat(fp); } catch { res.writeHead(404); return res.end('文件不存在'); }
  const inline = !download && (meta.kind === 'image' || meta.kind === 'video' || meta.kind === 'audio' || meta.mime === 'application/pdf');
  const headers = {
    'Content-Type': meta.mime === 'image/svg+xml' || meta.mime === 'text/html' ? 'text/plain; charset=utf-8' : meta.mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400'
  };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? +range[1] : st.size - +range[2];
    let end = range[1] && range[2] ? +range[2] : st.size - 1;
    if (start >= st.size || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(fp, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(fp).pipe(res);
}

// 文档转文字（缓存为 <id>.txt）
async function docText(meta) {
  const cache = path.join(UPLOAD_DIR, meta.id + '.txt');
  try { return await fsp.readFile(cache, 'utf8'); } catch {}
  const fp = filePath(meta);
  let text = '';
  try {
    if (meta.ext === '.pdf') text = await run('pdftotext', ['-layout', '-enc', 'UTF-8', fp, '-']);
    else if (meta.ext === '.docx') text = xmlText(await run('unzip', ['-p', fp, 'word/document.xml']), /<\/w:p>/g);
    else if (meta.ext === '.pptx') {
      const list = (await run('unzip', ['-Z1', fp])).split('\n').filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
      for (const [i, f] of list.entries()) text += `\n--- 第 ${i + 1} 页 ---\n` + xmlText(await run('unzip', ['-p', fp, f]), /<\/a:p>/g);
    } else if (meta.ext === '.xlsx') {
      const shared = await run('unzip', ['-p', fp, 'xl/sharedStrings.xml']).catch(() => '');
      const strs = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decodeXml(m[1].replace(/<[^>]+>/g, '')));
      const sheets = (await run('unzip', ['-Z1', fp])).split('\n').filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
      for (const s of sheets) {
        const xml = await run('unzip', ['-p', fp, s]);
        text += `\n--- ${path.basename(s, '.xml')} ---\n`;
        for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
          const cells = [...row[1].matchAll(/<c([^>]*)>(?:[\s\S]*?<v>([\s\S]*?)<\/v>|[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>)?[\s\S]*?<\/c>/g)].map(c => {
            if (/t="s"/.test(c[1])) return strs[+c[2]] ?? '';
            return decodeXml(c[2] ?? c[3] ?? '');
          });
          text += cells.join('\t') + '\n';
        }
      }
    } else text = (await fsp.readFile(fp)).toString('utf8');
  } catch (e) { text = `（无法提取文字：${e.message}）`; }
  text = text.replace(/\u0000/g, '').trim();
  await fsp.writeFile(cache, text).catch(() => {});
  return text;
}
function decodeXml(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function xmlText(xml, paraEnd) { return decodeXml(xml.replace(paraEnd, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n'); }

async function imageDataUrl(fp, mime) { return `data:${mime};base64,${(await fsp.readFile(fp)).toString('base64')}`; }

// 视频抽帧（缓存为 <id>_fN.jpg）
async function videoFrames(meta) {
  const n = Math.max(1, Math.min(16, config.videoFrames | 0 || 6));
  const first = path.join(UPLOAD_DIR, `${meta.id}_f1.jpg`);
  if (!fs.existsSync(first)) {
    let dur = 0;
    try { dur = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath(meta)])) || 0; } catch {}
    const fps = dur > 0 ? n / dur : 1;
    await run('ffmpeg', ['-y', '-v', 'error', '-i', filePath(meta), '-vf', `fps=${fps.toFixed(5)},scale='min(768,iw)':-2`, '-frames:v', String(n), '-q:v', '4', path.join(UPLOAD_DIR, `${meta.id}_f%d.jpg`)]);
  }
  const frames = [];
  for (let i = 1; i <= n; i++) { const f = path.join(UPLOAD_DIR, `${meta.id}_f${i}.jpg`); if (fs.existsSync(f)) frames.push(f); }
  return frames;
}

// 把带附件的用户消息转成 OpenAI 多模态 content
async function buildContent(m, req) {
  const ids = Array.isArray(m.attachments) ? m.attachments.map(a => typeof a === 'string' ? a : a && a.id).filter(Boolean).slice(0, 10) : [];
  if (!ids.length) return m.content;
  const parts = [];
  let text = m.content || '';
  for (const id of ids) {
    const meta = await getMeta(id);
    if (!meta) { text += `\n\n[附件已过期或不存在]`; continue; }
    if (meta.kind === 'image') {
      if (config.vision) parts.push({ type: 'image_url', image_url: { url: await imageDataUrl(filePath(meta), meta.mime) } });
      else text += `\n\n[用户上传了图片：${meta.name}，当前未开启图片识别]`;
    } else if (meta.kind === 'video') {
      if (config.videoMode === 'video_url') parts.push({ type: 'video_url', video_url: { url: `${originOf(req)}/uploads/${meta.id}` } });
      else if (config.videoMode === 'frames' && config.vision) {
        try {
          const frames = await videoFrames(meta);
          text += `\n\n[视频 ${meta.name}：以下 ${frames.length} 张图片是按时间顺序均匀截取的画面]`;
          for (const f of frames) parts.push({ type: 'image_url', image_url: { url: await imageDataUrl(f, 'image/jpeg') } });
        } catch (e) { text += `\n\n[视频 ${meta.name} 抽帧失败：${e.message}]`; }
      } else text += `\n\n[用户上传了视频：${meta.name}，当前未开启视频识别]`;
    } else if (meta.kind === 'doc') {
      let t = await docText(meta);
      if (t.length > config.docMaxChars) t = t.slice(0, config.docMaxChars) + '\n…（内容过长已截断）';
      text += `\n\n<file name="${meta.name}">\n${t}\n</file>`;
    } else {
      text += `\n\n[用户上传了文件：${meta.name}（${meta.mime}，${(meta.size / 1024).toFixed(0)}KB），无法直接读取内容]`;
    }
  }
  if (!parts.length) return text;
  return [{ type: 'text', text: text || '请看附件' }, ...parts];
}

// 定期清理过期上传
async function cleanup() {
  const limit = Date.now() - config.retentionDays * 86400e3;
  try {
    for (const f of await fsp.readdir(UPLOAD_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5); const meta = await getMeta(id);
      if (meta && meta.t < limit) for (const g of await fsp.readdir(UPLOAD_DIR)) if (g.startsWith(id)) await fsp.rm(path.join(UPLOAD_DIR, g), { force: true });
    }
  } catch (e) { console.error('cleanup', e.message); }
}
setInterval(cleanup, 3600e3); setTimeout(cleanup, 10e3);

// ---------- Anthropic 兼容协议 ----------
// Base URL 填到 /v1 为止，如 https://api.anthropic.com/v1 或 https://maas-api.unisound.com/anthropic/v1
function toAnthropic(msgs) {
  const system = msgs.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean).join('\n\n');
  const out = [];
  for (const m of msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let parts;
    if (typeof m.content === 'string') parts = [{ type: 'text', text: m.content }];
    else parts = m.content.map(c => {
      if (c.type === 'text') return { type: 'text', text: c.text };
      if (c.type === 'image_url') {
        const u = c.image_url && c.image_url.url || '';
        const d = u.match(/^data:([^;]+);base64,(.*)$/s);
        return d ? { type: 'image', source: { type: 'base64', media_type: d[1], data: d[2] } } : { type: 'image', source: { type: 'url', url: u } };
      }
      if (c.type === 'video_url') return { type: 'text', text: '[附带视频：' + (c.video_url && c.video_url.url) + ']' };
      return null;
    }).filter(Boolean);
    parts = parts.filter(x => x.type !== 'text' || x.text);
    if (!parts.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...parts);   // Anthropic 要求角色交替
    else out.push({ role: m.role, content: parts });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '（继续）' }] });
  return { system, messages: out };
}
function anthropicHeaders(key, bearer) {
  const h = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (bearer) h['Authorization'] = 'Bearer ' + key; else h['x-api-key'] = key;
  return h;
}
async function anthropicFetch(url, key, init = {}) {
  let r = await fetch(url, { ...init, headers: anthropicHeaders(key, false) });
  if (r.status === 401 || r.status === 403) {   // 部分兼容平台只认 Authorization: Bearer
    const t = await r.text().catch(() => '');
    const r2 = await fetch(url, { ...init, headers: anthropicHeaders(key, true) });
    if (r2.ok || r2.status !== r.status) return r2;
    return { ok: false, status: r.status, text: async () => t };
  }
  return r;
}
// 把 Anthropic 流式事件转换成 OpenAI 格式，前端无需改动
async function* anthropicToOpenAI(body) {
  const dec = new TextDecoder(); let buf = '';
  const emit = delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta') yield emit({ content: ev.delta.text });
        else if (ev.delta.type === 'thinking_delta') yield emit({ reasoning_content: ev.delta.thinking });
      } else if (ev.type === 'error') yield emit({ content: '\n\n⚠️ ' + ((ev.error && ev.error.message) || '上游出错') });
      else if (ev.type === 'message_stop') { yield 'data: [DONE]\n\n'; return; }   // 有些平台发完不关连接
    }
  }
  yield 'data: [DONE]\n\n';
}

// ---------- Gemini 原生协议 ----------
// Base URL：https://generativelanguage.googleapis.com/v1beta
function toGemini(msgs) {
  const sys = msgs.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean).join('\n\n');
  const contents = [];
  for (const m of msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts = typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(c => {
      if (c.type === 'text') return { text: c.text };
      if (c.type === 'image_url') {
        const u = c.image_url && c.image_url.url || '';
        const d = u.match(/^data:([^;]+);base64,(.*)$/s);
        return d ? { inline_data: { mime_type: d[1], data: d[2] } } : { text: '[图片：' + u + ']' };
      }
      if (c.type === 'video_url') return { text: '[附带视频：' + (c.video_url && c.video_url.url) + ']' };
      return null;
    }).filter(Boolean);
    parts = parts.filter(x => !('text' in x) || x.text);
    if (!parts.length) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  }
  const body = { contents, generationConfig: { temperature: Number(config.temperature) } };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  return body;
}
function geminiHeaders(key) { return { 'Content-Type': 'application/json', 'x-goog-api-key': key }; }
async function* geminiToOpenAI(body) {
  const dec = new TextDecoder(); let buf = '';
  const emit = delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.error) { yield emit({ content: '\n\n⚠️ ' + (ev.error.message || '上游出错') }); continue; }
      const parts = (((ev.candidates || [])[0] || {}).content || {}).parts || [];
      for (const pt of parts) if (pt.text) yield emit(pt.thought ? { reasoning_content: pt.text } : { content: pt.text });
      const fr = ((ev.candidates || [])[0] || {}).finishReason;
      if (fr && !['STOP', 'MAX_TOKENS'].includes(fr)) yield emit({ content: `\n\n⚠️ 生成被终止（${fr}）` });
    }
  }
  yield 'data: [DONE]\n\n';
}

// ---------- SystemOne 决策模型 ----------
function pct(x) { return (Number(x) * 100).toFixed(1) + '%'; }
async function handleSystemOne(res, prov, model, messages) {
  const last = [...messages].reverse().find(m => m.role === 'user');
  let text = !last ? '' : typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  let state = text, questions = null;
  // 用户可直接发送 {"state": ..., "questions": {...}} 自定义问题
  try { const j = JSON.parse(text); if (j && typeof j === 'object' && j.questions) { questions = j.questions; state = j.state ?? ''; } } catch {}
  if (!questions) { try { questions = JSON.parse(prov.questions || DEFAULT_QUESTIONS); } catch { return json(res, 500, { error: '决策问题配置不是合法 JSON' }); } }
  if (!state || (typeof state === 'string' && !state.trim())) return json(res, 400, { error: '请输入需要判定的内容' });
  let r, t;
  try {
    r = await fetch(upstreamUrl(provBase(prov), '/systemone'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + prov.apiKey },
      body: JSON.stringify({ model, state, questions })
    });
    t = await r.text();
  } catch (e) { return json(res, 502, { error: '无法连接决策接口：' + e.message }); }
  if (!r.ok) return json(res, r.status, { error: `决策接口返回 ${r.status}：${t.slice(0, 500)}` });
  let data; try { data = JSON.parse(t); } catch { return json(res, 502, { error: '决策接口返回格式异常' }); }
  const lines = ['**决策结果**' + (data.latency_ms ? `（${data.latency_ms} ms）` : '')];
  for (const [k, a] of Object.entries(data.answers || {})) {
    const q = questions[k] || {};
    const title = q.instructions ? `${q.instructions}` : k;
    let main = '';
    if (a.type === 'choice') main = `**${a.choice}**` + (q.criteria && q.criteria[a.choice] ? `（${q.criteria[a.choice]}）` : '') + (a.confidence != null ? `，置信度 ${pct(a.confidence)}` : '');
    else if (a.type === 'noul') main = `**${a.noul >= 0.5 ? '是' : '否'}**（P(是) = ${pct(a.noul)}）`;
    else if (a.type === 'score') {
      const idx = Math.round(a.score); const legend = a.legend || {};
      main = `**${Number(a.score).toFixed(2)}**` + (legend[idx] ? `（≈ ${legend[idx]}）` : '') + (a.confidence != null ? `，置信度 ${pct(a.confidence)}` : '');
    } else main = '`' + JSON.stringify(a) + '`';
    lines.push('', `• ${title}：${main}`);
    if (a.probabilities && a.type !== 'noul') {
      const legend = a.legend || {};
      lines.push('  ' + Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([o, v]) => `${legend[o] || o} ${pct(v)}`).join(' · '));
    }
  }
  const out = lines.join('\n');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: out } }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

// ---------- 静态文件 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const h = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    if (pathname === '/widget.js') { h['Access-Control-Allow-Origin'] = '*'; h['Cache-Control'] = 'public, max-age=300'; }
    res.writeHead(200, h); res.end(data);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  try {
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, publicConfig());

    if (p === '/api/upload' && req.method === 'POST') {
      if (!checkAccess(req)) return json(res, 401, { error: '访问口令错误' });
      return await handleUpload(req, res);
    }
    const up = /^\/uploads\/([a-f0-9]{24})$/.exec(p);
    if (up && req.method === 'GET') return await serveUpload(req, res, up[1], url.searchParams.has('dl'));

    if (p === '/api/chat' && req.method === 'POST') {
      if (!checkAccess(req)) return json(res, 401, { error: '访问口令错误' });
      const body = await readBody(req);
      const sel = resolveModel(body.model);
      if (!sel || !sel.provider) return json(res, 500, { error: '管理员尚未配置模型' });
      const prov = sel.provider, model = sel.model;
      if (!prov.apiKey) return json(res, 500, { error: `服务商「${prov.name}」尚未配置 API Key` });
      let raw = Array.isArray(body.messages) ? body.messages.filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role)) : [];
      raw = raw.slice(-40);
      // 只给最近 3 条带附件的用户消息附上附件内容，避免历史图片反复占用上下文
      let withAtt = 0;
      const messages = [];
      for (let i = raw.length - 1; i >= 0; i--) {
        const m = raw[i];
        let content = m.content;
        if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
          if (withAtt < 3) { content = await buildContent(m, req); withAtt++; }
          else content = (m.content || '') + `\n[此前上传过 ${m.attachments.length} 个附件]`;
        }
        messages.unshift({ role: m.role, content });
      }
      if (prov.type === 'systemone') return await handleSystemOne(res, prov, model, messages);
      if (config.systemPrompt) messages.unshift({ role: 'system', content: config.systemPrompt });

      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const isAnth = prov.type === 'anthropic', isGem = prov.type === 'gemini';
      const callUpstream = msgs => isGem
        ? fetch(upstreamUrl(provBase(prov), `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`), {
            method: 'POST', signal: ac.signal, headers: geminiHeaders(prov.apiKey), body: JSON.stringify(toGemini(msgs))
          })
        : isAnth
        ? anthropicFetch(upstreamUrl(provBase(prov), '/messages'), prov.apiKey, {
            method: 'POST', signal: ac.signal,
            body: JSON.stringify({ model, ...toAnthropic(msgs), max_tokens: Number(prov.maxTokens) || 8192, stream: true, temperature: Math.min(1, Number(config.temperature)) })
          })
        : fetch(upstreamUrl(provBase(prov), '/chat/completions'), {
            method: 'POST', signal: ac.signal,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + prov.apiKey },
            body: JSON.stringify({ model, messages: msgs, stream: true, temperature: Number(config.temperature) })
          });
      let upr, notice = '';
      try {
        upr = await callUpstream(messages);
        // 模型不支持图片/视频时，自动去掉多媒体部分重试一次
        if (!upr.ok && upr.status === 400 && messages.some(m => Array.isArray(m.content))) {
          const t = await upr.text().catch(() => '');
          if (/image|video|multimodal|vision|content.*type|不支持/i.test(t)) {
            const stripped = messages.map(m => Array.isArray(m.content)
              ? { role: m.role, content: m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') + '\n[附带的图片/视频当前模型无法识别，已省略]' }
              : m);
            upr = await callUpstream(stripped);
            notice = `> ⚠️ 模型 ${model} 不支持图片/视频识别，本次只发送了文字内容。可在下拉框换一个视觉模型。\n\n`;
          } else upr = { ok: false, status: 400, text: async () => t };
        }
      } catch (e) { return json(res, 502, { error: '无法连接上游接口：' + e.message }); }
      if (!upr.ok) {
        const t = await upr.text().catch(() => '');
        return json(res, upr.status, { error: `上游返回 ${upr.status}：${t.slice(0, 500)}` });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (notice) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: notice } }] }) + '\n\n');
      try { for await (const chunk of (isAnth ? anthropicToOpenAI(upr.body) : isGem ? geminiToOpenAI(upr.body) : upr.body)) res.write(chunk); } catch (_) {}
      return res.end();
    }

    if (p === '/api/admin/login' && req.method === 'POST') {
      if (tooManyFails(ip)) return json(res, 429, { error: '尝试过多，请 10 分钟后再试' });
      const { password } = await readBody(req);
      if (checkPassword(password || '')) { loginFails.delete(ip); return json(res, 200, { token: newSession() }); }
      const r = loginFails.get(ip) || { count: 0, t: Date.now() }; r.count++; r.t = Date.now(); loginFails.set(ip, r);
      return json(res, 401, { error: '密码错误' });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: '未登录' });
      if (p === '/api/admin/config' && req.method === 'GET') {
        const { adminPasswordHash, ...rest } = config;
        return json(res, 200, { ...rest, providers: config.providers.map(pr => ({ ...pr, apiKey: '', apiKeyMasked: maskKey(pr.apiKey) })), passwordFromEnv: !adminPasswordHash });
      }
      if (p === '/api/admin/config' && req.method === 'POST') {
        const b = await readBody(req);
        const n = { ...config };
        const str = k => { if (typeof b[k] === 'string' && b[k].trim()) n[k] = b[k].trim(); };
        const num = (k, lo, hi) => { if (b[k] !== undefined && b[k] !== '' && !isNaN(Number(b[k]))) n[k] = Math.min(hi, Math.max(lo, Number(b[k]))); };
        if (Array.isArray(b.providers)) {
          const old = new Map(config.providers.map(pr => [pr.id, pr]));
          const provs = [];
          for (const x of b.providers) {
            if (!x || typeof x !== 'object') continue;
            const id = typeof x.id === 'string' && /^[a-z0-9]{1,16}$/.test(x.id) ? x.id : newProviderId();
            const prev = old.get(id) || {};
            const type = ['systemone', 'anthropic', 'gemini'].includes(x.type) ? x.type : 'openai';
            if (type === 'systemone' && x.questions) { try { JSON.parse(x.questions); } catch { return json(res, 400, { error: `服务商「${x.name || id}」的决策问题不是合法 JSON` }); } }
            provs.push({
              id, type,
              name: String(x.name || '').trim() || '未命名',
              baseUrl: String(x.baseUrl || '').trim() || prev.baseUrl || '',
              apiKey: String(x.apiKey || '').trim() || prev.apiKey || '',
              models: Array.isArray(x.models) ? [...new Set(x.models.map(String).map(v => v.trim()).filter(Boolean))] : (prev.models || []),
              questions: type === 'systemone' ? String(x.questions || '') : '',
              maxTokens: type === 'anthropic' ? Math.min(200000, Math.max(256, Number(x.maxTokens) || 8192)) : undefined
            });
          }
          if (!provs.length) return json(res, 400, { error: '至少保留一个服务商' });
          n.providers = provs;
        }
        str('defaultModel'); str('widgetTitle'); str('widgetColor');
        if (typeof b.systemPrompt === 'string') n.systemPrompt = b.systemPrompt;
        num('temperature', 0, 2); num('maxUploadMB', 1, 200); num('retentionDays', 1, 365); num('videoFrames', 1, 16); num('docMaxChars', 1000, 1000000);
        for (const k of ['publicAccess', 'vision']) if (typeof b[k] === 'boolean') n[k] = b[k];
        if (['frames', 'video_url', 'off'].includes(b.videoMode)) n.videoMode = b.videoMode;
        if (typeof b.accessCode === 'string') n.accessCode = b.accessCode.trim();
        config = n; saveConfig(config);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/models' && req.method === 'POST') {
        const b = await readBody(req);
        const prev = config.providers.find(pr => pr.id === b.providerId) || {};
        const base = provBase({ type: b.type || prev.type, baseUrl: String(b.baseUrl || prev.baseUrl || '').trim() }), key = String(b.apiKey || prev.apiKey || '').trim();
        if (!base) return json(res, 400, { error: '请先填写 Base URL' });
        try {
          const ptype = b.type || prev.type;
          if (ptype === 'gemini') {
            const r = await fetch(upstreamUrl(base, '/models?pageSize=1000'), { headers: geminiHeaders(key) });
            const t = await r.text();
            if (!r.ok) return json(res, r.status, { error: `上游返回 ${r.status}：${t.slice(0, 300)}` });
            const ms = (JSON.parse(t).models || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map(m => String(m.name).replace(/^models\//, ''));
            return json(res, 200, { models: ms.sort() });
          }
          const r = ptype === 'anthropic' ? await anthropicFetch(upstreamUrl(base, '/models?limit=1000'), key) : await fetch(upstreamUrl(base, '/models'), { headers: { 'Authorization': 'Bearer ' + key } });
          const t = await r.text();
          if (!r.ok) return json(res, r.status, { error: `上游返回 ${r.status}：${t.slice(0, 300)}` });
          const data = JSON.parse(t);
          return json(res, 200, { models: (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean).sort() });
        } catch (e) { return json(res, 502, { error: '获取失败：' + e.message }); }
      }
      if (p === '/api/admin/password' && req.method === 'POST') {
        const b = await readBody(req);
        if (!checkPassword(b.oldPassword || '')) return json(res, 400, { error: '当前密码不正确' });
        if (typeof b.newPassword !== 'string' || b.newPassword.length < 8) return json(res, 400, { error: '新密码至少 8 位' });
        config.adminPasswordHash = hashPassword(b.newPassword); saveConfig(config);
        const me = bearer(req); for (const t of [...sessions.keys()]) if (t !== me) sessions.delete(t);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/logout' && req.method === 'POST') { sessions.delete(bearer(req)); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
  }
});
server.requestTimeout = 0;
server.listen(PORT, HOST, () => console.log(`LLM WebChat 已启动：http://${HOST}:${PORT}  （设置页：/admin）`));
