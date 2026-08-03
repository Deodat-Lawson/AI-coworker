import { Fragment, type ReactNode } from 'react';

import {
  type Block,
  type Inline,
  handleFor,
  parseMessage,
} from '@ai-coworker/shared';

export interface MentionContext {
  /** Everyone in the workspace, for turning `@sarah` into a real name. */
  members: { address: string; displayName: string }[];
  /** The reader, so mentions of them can be highlighted. */
  me?: string;
  channels?: { id: string; name: string }[];
  onOpenChannel?: (channelId: string) => void;
  onOpenMember?: (address: string) => void;
}

/**
 * Render a message body. The parser lives in the shared package so the relay
 * and the app agree on what counts as a mention; this file is only about how
 * the result looks.
 */
export default function RichText({ text, ctx }: { text: string; ctx: MentionContext }) {
  const blocks = parseMessage(text);
  return (
    <div className="rich">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} ctx={ctx} />
      ))}
    </div>
  );
}

function BlockView({ block, ctx }: { block: Block; ctx: MentionContext }) {
  switch (block.type) {
    case 'code':
      return (
        <pre className="code-block">
          {block.lang ? <span className="code-lang">{block.lang}</span> : null}
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote className="quote">
          <InlineList nodes={block.children} ctx={ctx} />
        </blockquote>
      );
    case 'list':
      return block.ordered ? (
        <ol className="rich-list">
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineList nodes={item} ctx={ctx} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="rich-list">
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineList nodes={item} ctx={ctx} />
            </li>
          ))}
        </ul>
      );
    case 'paragraph':
    default:
      return (
        <p className="rich-p">
          <InlineList nodes={block.children} ctx={ctx} />
        </p>
      );
  }
}

function InlineList({ nodes, ctx }: { nodes: Inline[]; ctx: MentionContext }): ReactNode {
  return (
    <>
      {nodes.map((node, i) => (
        <Fragment key={i}>
          <InlineView node={node} ctx={ctx} />
        </Fragment>
      ))}
    </>
  );
}

function InlineView({ node, ctx }: { node: Inline; ctx: MentionContext }): ReactNode {
  switch (node.type) {
    case 'text':
      return <>{node.text}</>;
    case 'bold':
      return (
        <strong>
          <InlineList nodes={node.children} ctx={ctx} />
        </strong>
      );
    case 'italic':
      return (
        <em>
          <InlineList nodes={node.children} ctx={ctx} />
        </em>
      );
    case 'strike':
      return (
        <s>
          <InlineList nodes={node.children} ctx={ctx} />
        </s>
      );
    case 'code':
      return <code className="code-inline">{node.text}</code>;
    case 'link':
      return (
        <a href={node.href} target="_blank" rel="noreferrer noopener">
          {node.label}
        </a>
      );
    case 'emoji':
      return (
        <span className="emoji" title={`:${node.code}:`}>
          {node.char}
        </span>
      );
    case 'channel': {
      const channel = ctx.channels?.find((c) => c.name === node.name);
      if (!channel || !ctx.onOpenChannel) return <span className="chip-channel">#{node.name}</span>;
      return (
        <button className="chip-channel link" onClick={() => ctx.onOpenChannel!(channel.id)}>
          #{node.name}
        </button>
      );
    }
    case 'mention': {
      if (node.broadcast) {
        return <span className="chip-mention broadcast">@{node.handle}</span>;
      }
      const member = ctx.members.find(
        (m) =>
          m.address.toLowerCase() === node.handle ||
          handleFor(m.address).toLowerCase() === node.handle ||
          m.displayName.toLowerCase().split(' ')[0] === node.handle,
      );
      // An unmatched @word is just text — it never pinged anybody, so it should
      // not look like it did.
      if (!member) return <>@{node.handle}</>;
      const isMe = member.address === ctx.me;
      return (
        <button
          className={`chip-mention link ${isMe ? 'me' : ''}`}
          onClick={() => ctx.onOpenMember?.(member.address)}
        >
          @{member.displayName.split(' ')[0]}
        </button>
      );
    }
    default:
      return null;
  }
}
