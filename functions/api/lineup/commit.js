// POST /api/lineup/commit —— 只收布阵学习库的专用数据通道（presigned 直传之后的登记步骤）。
//
// commit 是另一条能自己拼 key 的入口，所以 source 同样被钉死、并在这里再拦一次：
// 只改 put 等于给 agent 通道留后门。
import { onRequestPost as uploadCommit, onRequestOptions } from '../cdn/upload/commit.js';
import { LINEUP_SOURCE } from '../../../src/upload.mjs';

export function onRequestPost(context) { return uploadCommit(context, { forcedSource: LINEUP_SOURCE }); }
export { onRequestOptions };
