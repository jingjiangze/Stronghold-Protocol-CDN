import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(new URL('./studio.json', import.meta.url), 'utf8'));
const d = j.Data || {};
const watch = [
  'Visibility', 'ProtectedMode', 'NeedLogin', 'IsPublished', 'SupportEdit',
  'Domain', 'IndependentUrl', 'Path', 'LastDeployedPlatform', 'InstanceTypeName',
  'InstanceTypeId', 'InstanceNumber', 'Hardware', 'ResourceLimits', 'DiskSize',
  'Revision', 'Type', 'SdkType', 'ServerSideRender', 'ServerSideRenderUrl',
  'McpServer', 'Predicts', 'Tags', 'License', 'ExpiredMinutes',
  'LastDeployConfig', 'FundingCampaign', 'FreeInstanceNumber', 'Privilege',
];
for (const k of watch) {
  if (d[k] === undefined) continue;
  console.log(k.padEnd(22), JSON.stringify(d[k]).slice(0, 400));
}
console.log('\n=== FailedMessage / EnglishFailedMessage ===');
console.log(' FailedMessage:', JSON.stringify(d.FailedMessage));
console.log(' EnglishFailedMessage:', JSON.stringify(d.EnglishFailedMessage));
console.log('\n=== Meta ===');
console.log(JSON.stringify(d.Meta).slice(0, 800));
console.log('\n=== ReadMeContent 前 300 ===');
console.log(String(d.ReadMeContent || '').slice(0, 300));
