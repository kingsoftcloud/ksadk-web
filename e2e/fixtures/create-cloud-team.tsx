import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateGroupDialog } from '../../src/public/team-components.js';
import { cloudBindingDirectorySchema, type ExecutionBinding, type GroupCreateInput } from '../../src/public/teams.js';
import '../../src/components/teams/teams.css';

const query = new URLSearchParams(location.search);
// Exact unverified CloudCatalog shape: every capability remains false until preflight.
const capabilities = { enqueue: false, cancel: false, steer: false, restore: false, interaction: false, leader: false };
const candidates = ['cloud-a', 'cloud-b'].map(agentId => ({ bindingRef: `cloud-agent:${agentId}:version-1`, providerRef: 'agentengine', kind: 'cloud', agentId, name: agentId, authorityRef: 'fixture-authority', revision: 1, capabilities: { ...capabilities, enqueue: query.has('ready') },
  availability: { state: query.has('ready') ? 'ready' : 'unchecked', code: 'preflight_required', reason: '创建团队前需验证固定运行版本', action: 'preflight' } }));
const directory = cloudBindingDirectorySchema.parse({ apiVersion: 'teams.ksadk.io/v1', scope: { authorityId: 'fixture-authority', ownerScopeRef: 'fixture-owner' }, items: candidates, nextCursor: null });
const selected = directory.items.map(binding => ({ memberId: binding.agentId, name: binding.name, binding: binding as ExecutionBinding }));
if (query.has('standby')) selected.unshift({ memberId: 'local-leader', name: '本地协调者', binding: { ...selected[0].binding, bindingRef: 'node_canonical', kind: 'local_build', agentId: 'local-a', capabilities: { ...capabilities, enqueue: true, leader: true }, availability: { state: 'ready' } } });
(window as unknown as { candidateSubmissions: GroupCreateInput[] }).candidateSubmissions = [];
createRoot(document.getElementById('root')!).render(<><p>目录合同交互测试 · 只记录请求并模拟 preflight 拒绝，不执行 Agent</p><CreateGroupDialog open candidates={selected} serverAuthority={!query.has('local')} onClose={() => {}} onCreate={async input => { (window as unknown as { candidateSubmissions: GroupCreateInput[] }).candidateSubmissions.push(input); throw new Error('服务端验证：该候选尚不支持 Leader，已保留草稿。'); }} /></>);
