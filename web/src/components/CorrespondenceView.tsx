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
  if (!peers.length) return null;
  const label = transferLabel(agentId, transfers);
  const peerIdentity = (peer: MessageActor) => <>
    <BotAvatar name={peer.name} color={peer.color} size={22} agentId={peer.id} />
    <span className="correspondence-peer-name">{peer.name}</span>
  </>;

  if (peers.length === 1) {
    const onlyPeer = peers[0]!;
    return <button type="button" className="correspondence-line correspondence-single-peer"
      aria-label={`${label}${onlyPeer.name}，查看双方消息往来`}
      title="查看双方实际发送的消息"
      onClick={() => onOpen(onlyPeer)}>
      <span>{label}</span>
      <span className="correspondence-peer-identity">{peerIdentity(onlyPeer)}</span>
      <span className="correspondence-enter" aria-hidden="true">›</span>
    </button>;
  }

  return <div className="correspondence-line">
    <span>{label}</span>
    <details className="correspondence-peers">
      <summary aria-label="选择智能体查看往来" title="只显示真实投递；已投递不代表任务完成">
        <span className="correspondence-avatars">{peers.slice(0, 3).map(peer =>
          <BotAvatar key={peer.id} name={peer.name} color={peer.color} size={22} agentId={peer.id} />)}</span>
        <span>{peers.length} 个智能体</span>
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

export function CorrespondencePanel({ agentId, agentName, peer, live, onClose }: {
  agentId: string; agentName: string; peer: MessageActor; live: Correspondence[]; onClose: () => void;
}) {
  const [messages, setMessages] = useState<Correspondence[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
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
  return <section className="correspondence-panel" aria-label={`${agentName} 与 ${peer.name} 的消息往来`}>
    <div className="correspondence-thread-scroll">
      <div className="correspondence-thread">
      <p className="correspondence-explanation">仅显示双方实际发送的消息，不含各自与用户的私聊。投递不代表任务已完成。</p>
      {before ? <button className="btn ghost" type="button" disabled={loading} onClick={() => void loadOlder()}>加载更早的往来</button> : null}
      {loading ? <p role="status">正在加载…</p> : null}
      {error ? <p role="alert">加载失败：{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button></p> : null}
      {!loading && !error && !merged.length ? <p>暂无可追溯的往来记录。</p> : null}
      {merged.map(item => <article className="correspondence-entry" key={item.id}>
        <BotAvatar name={item.from.name} color={item.from.color} size={32} />
        <div className="correspondence-entry-body">
          <div className="correspondence-entry-heading">
            <strong style={{ color: item.from.color }}>{item.from.name}</strong>
            <time>{formatMessageTime(new Date(item.createdAt).toISOString())}</time>
          </div>
          <div className="msg-bubble-box assistant-bubble"><RichText text={item.text} /><LetterImages images={item.images} /></div>
        </div>
      </article>)}
      </div>
    </div>
    <footer><span>🔒 此聊天仅供查看</span><button type="button" className="btn ghost" onClick={onClose}>关闭聊天</button></footer>
  </section>;
}
