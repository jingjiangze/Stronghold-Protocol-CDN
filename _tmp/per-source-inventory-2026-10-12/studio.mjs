import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(new URL('./studio.json', import.meta.url), 'utf8'));
const d = j.Data || {};
console.log('Code:', j.Code, 'Message:', j.Message);
const fields = [
  'Id', 'Name', 'Owner', 'Status', 'DeployMode', 'DeployedTime', 'CreatedTime',
  'LastDeployCommitId', 'LastDeployId', 'UpdatedTime', 'Visibility',
  'ChineseName', 'Hardware', 'Sdk', 'SdkVersion', 'IsRunning', 'Url',
];
for (const k of fields) if (d[k] !== undefined) console.log(k.padEnd(20), JSON.stringify(d[k]));
console.log('\n--- 全部字段 ---');
console.log(Object.keys(d).join(', '));
