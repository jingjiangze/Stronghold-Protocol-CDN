// POST /api/lineup/begin —— 只收布阵学习库的专用数据通道（照 /api/cdn/upload/* 的模式另起一条）。
//
// 与主通道的差别只有一处：来源被钉死成 LINEUP_SOURCE，key 因此只能落在
// packs/lineup-library/*.jsonl（assertSourceKeyPair 在 begin/put/commit 三步各拦一次）。
// 复用同一份 handler 而不是复制一份：判定只有一处实现，改一处三步同时生效。
import { onRequestPost as uploadBegin, onRequestOptions } from '../cdn/upload/begin.js';
import { LINEUP_SOURCE } from '../../../src/upload.mjs';

export function onRequestPost(context) { return uploadBegin(context, { forcedSource: LINEUP_SOURCE }); }
export { onRequestOptions };
