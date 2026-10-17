// PUT /api/lineup/put —— 只收布阵学习库的专用数据通道（浏览器式一次请求：元数据走查询串，body 是文件）。
//
// 来源被钉死成 LINEUP_SOURCE，调用方传的 source 参数被忽略；key 仍必须命中
// packs/lineup-library/<模式>-<YYYY-MM-DD>.jsonl，否则 400。
import { onRequestPut as uploadPut, onRequestOptions } from '../cdn/upload/put.js';
import { LINEUP_SOURCE } from '../../../src/upload.mjs';

export function onRequestPut(context) { return uploadPut(context, { forcedSource: LINEUP_SOURCE }); }
export { onRequestOptions };
