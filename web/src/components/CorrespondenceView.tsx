import { useEffect, useRef, useState } from 'react';
import type { Correspondence, MessageActor } from '../../../src/shared/contracts/message-identity';
import { fetchCorrespondence } from '../api';
import { transferLabel, transferPeers } from '../features/chat/correspondence';
import { BotAvatar } from './BotAvatar';
import { RichText } from '../markdown';
import { formatMessageTime } from '../format';
import { validateInputImages, type InputImage } from '../../../src/shared/contracts/input-image';

function LetterImages({ images }: { images?: InputImage[] }) {
  let safe: InputImage[];
  try { safe = validateInputImages(images); } catch { return <p>图片引用无效，未加载。</p>; }
  return <>{safe.map((image, index) => <details key={`${index}:${image.url}`}>
    <summary>图片 {index + 1}{image.alt ? `：${image.alt}` : ''}</summary>
    <img src={image.url} alt={image.alt ?? '同事附图'} loading="lazy" referrerPolicy="no-referrer" style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }} />
  </details>)}</>;
}

export function CorrespondenceRow({ agentId, transfers, onOpen }: {
  agentId: string; transfers: Correspondence[]; onOpen: (peer: MessageActor) => void;
}) {
  const peers = transferPeers(agentId, transfers);
  return <div className="correspondence-line">
    <span>{transferLabel(agentId, transfers)}</span>
    <details className="correspondence-peers">
      <summary aria-label="选择智能体查看往来" title="只显示真实投递；已投递不代表任务完成">
        <span className="correspondence-avatars">{peers.slice(0, 3).map(peer =>
          <BotAvatar key={peer.id} name={peer.name} color={peer.color} size={22} shape="circle" />)}</span>
        {peers.length === 1 ? peers[0]!.name : `${peers.length} 个智能体`}
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="correspondence-peer-menu">
        {peers.map(peer => <button type="button" key={peer.id} aria-label={`查看与${peer.name}的消息往来`} onClick={event => {
          event.currentTarget.closest('details')?.removeAttribute('open'); onOpen(peer);
        }}><BotAvatar name={peer.name} color={peer.color} size={26} /><span>{peer.name}</span><span className="correspondence-open-hint">查看往来</span></button>)}
      </div>
    </details>
  </div>;
}

export function CorrespondenceDialog({ agentId, agentName, peer, live, onClose }: {
  agentId: string; agentName: string; peer: MessageActor; live: Correspondence[]; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [messages, setMessages] = useState<Correspondence[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const element = dialog.current!; element.showModal();
    return () => { request.current?.abort(); element.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setLoading(true); setError('');
    void fetchCorrespondence(agentId, peer.id, undefined, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setMessages(page.messages); setBefore(page.nextBefore);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [agentId, peer.id, refresh]);
  const merged = [...new Map([...messages, ...live.filter(item =>
    (item.from.id === agentId && item.to.id === peer.id) || (item.to.id === agentId && item.from.id === peer.id)).slice(-30)]
    .map(item => [item.id, item])).values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const loadOlder = async () => {
    if (!before || loading) return;
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try {
      const page = await fetchCorrespondence(agentId, peer.id, before, controller.signal);
      if (!controller.signal.aborted) { setMessages(current => [...page.messages, ...current]); setBefore(page.nextBefore); }
    } catch (reason) { if (!controller.signal.aborted) setError(String(reason)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  return <dialog ref={dialog} className="correspondence-dialog" aria-label={`${agentName} 与 ${peer.name} 的消息往来`}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2>{agentName} <span>↔</span> {peer.name}</h2><button type="button" className="btn ghost" onClick={onClose}>关闭</button></header>
    <div className="correspondence-thread">
      <p className="correspondence-explanation">仅显示双方实际发送的消息，不含各自与用户的私聊。投递不代表任务已完成。</p>
      {before ? <button className="btn ghost" type="button" disabled={loading} onClick={() => void loadOlder()}>加载更早的往来</button> : null}
      {loading ? <p role="status">正在加载…</p> : null}
      {error ? <p role="alert">加载失败：{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button></p> : null}
      {!loading && !error && !merged.length ? <p>暂无可追溯的往来记录。</p> : null}
      {merged.map(item => <article className="correspondence-entry" key={item.id}>
        <div className="correspondence-entry-heading"><BotAvatar name={item.from.name} color={item.from.color} size={28} />
          <strong>{item.from.name}</strong><span>→ {item.to.name}</span><time>{formatMessageTime(new Date(item.createdAt).toISOString())}</time></div>
        <div className="msg-bubble-box assistant-bubble"><RichText text={item.text} /><LetterImages images={item.images} /></div>
      </article>)}
    </div>
    <footer><span>🔒 此聊天仅供查看</span><button type="button" className="btn ghost" onClick={onClose}>关闭聊天</button></footer>
  </dialog>;
}
