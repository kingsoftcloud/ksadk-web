import { describe, expect, it, vi } from 'vitest';
import { hydrateKernelRunHistory } from '../utils/kernel-run-history.js';
import type { ApiFacade } from '../core/api/types.js';
const event = (seq: number, kind='item.updated', run='target') => ({SeqId:seq,SessionId:'session',EventType:kind,InvocationId:run,EventId:`event-${seq}`});
const page = (Events: unknown[], extra={}) => ({Events,CursorSource:'runtime',HistoryEpoch:'epoch',SnapshotSeqId:1000,...extra});

describe('cold remote run hydration', () => {
  it('reads metadata and only the selected run boundary, keeping one snapshot', async () => {
    const read=vi.fn().mockResolvedValueOnce(page([event(950,'run.started','newer'),event(900,'run.started')]))
      .mockResolvedValueOnce(page([event(939),event(920)]))
      .mockResolvedValueOnce(page([event(919),event(900,'run.started')]));
    const result=await hydrateKernelRunHistory({listSessionEvents:read} as unknown as ApiFacade,'session','target',page([event(960),event(940)]),()=>true);
    expect(result.map(e=>e.SeqId)).toEqual([900,919,920,939,940,960]);
    expect(read).toHaveBeenNthCalledWith(1,'session',expect.objectContaining({eventTypes:['run.started'],historyEpoch:'epoch',snapshotSeqId:1000}));
    expect(read).toHaveBeenNthCalledWith(2,'session',expect.objectContaining({beforeSeqId:940,afterSeqId:899}));
    expect(read).toHaveBeenNthCalledWith(3,'session',expect.objectContaining({beforeSeqId:920,afterSeqId:899}));
  });
  it('does not reread an already complete or switched-away session',async()=>{
    const read=vi.fn();const api={listSessionEvents:read} as unknown as ApiFacade;
    await hydrateKernelRunHistory(api,'session','target',page([event(900,'run.started')]),()=>true);
    await hydrateKernelRunHistory(api,'session','target',page([event(960)]),()=>false);
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects a changed snapshot and nonadvancing data without mixing sources',async()=>{
    const read=vi.fn().mockResolvedValueOnce(page([event(900,'run.started')]))
      .mockResolvedValueOnce(page([event(930)],{HistoryEpoch:'changed'}));
    await expect(hydrateKernelRunHistory({listSessionEvents:read} as unknown as ApiFacade,'session','target',page([event(960)]),()=>true)).rejects.toThrow('snapshot changed');
  });
});
