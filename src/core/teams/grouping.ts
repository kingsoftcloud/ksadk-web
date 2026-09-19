import type { TeamMemberCandidate } from '../../components/teams/CreateGroupDialog.js';

export const candidateKey = (candidate: TeamMemberCandidate) => `${candidate.binding.kind}:${candidate.binding.agentId}`;
export const available = (candidate: TeamMemberCandidate) => candidate.binding.capabilities.enqueue && candidate.binding.availability?.state !== 'unavailable';

export function groupTeamCandidates(candidates: TeamMemberCandidate[]): TeamMemberCandidate[][] {
  const groups = new Map<string, TeamMemberCandidate[]>();
  for (const candidate of candidates) groups.set(candidateKey(candidate), [...(groups.get(candidateKey(candidate)) || []), candidate]);
  return [...groups.values()].map(versions => versions.sort((a, b) => Number(available(b)) - Number(available(a)) || (b.binding.createdAt || '').localeCompare(a.binding.createdAt || '')));
}
