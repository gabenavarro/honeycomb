/** Shared Markdown renderer for Library artifact bodies (M35).
 *
 * Uses react-markdown + remark-gfm.  All default HTML elements are
 * overridden with M31 semantic Tailwind tokens so the rendered output
 * matches the dashboard design system.
 *
 * react-markdown v10 API note: the `Components` type maps each HTML tag
 * to `ComponentType<JSX.IntrinsicElements[Key] & ExtraProps>`.  For
 * `code`, the intrinsic element is `React.HTMLAttributes<HTMLElement>`,
 * which does NOT include an `inline` prop.  Inline vs block code is
 * distinguished by wrapping context: react-markdown renders inline `code`
 * directly (no surrounding `pre`), and block code inside a `pre`.  We
 * handle block code in the `pre` override and inline code in the `code`
 * override — avoiding the `inline` prop entirely for type safety.
 */
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { ReactNode } from "react";

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="mb-3 mt-5 text-[20px] font-semibold text-primary" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mb-2 mt-4 text-[16px] font-semibold text-primary" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mb-1.5 mt-3 text-[14px] font-semibold text-secondary" {...props}>
      {children}
    </h3>
  ),
  p: ({ children, ...props }) => (
    <p className="mb-2 text-[13px] leading-relaxed text-primary" {...props}>
      {children}
    </p>
  ),
  a: ({ children, ...props }) => (
    <a className="text-accent underline underline-offset-2 hover:text-claude" {...props}>
      {children}
    </a>
  ),
  ul: ({ children, ...props }) => (
    <ul className="mb-2 list-disc pl-5 text-[13px] text-primary" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="mb-2 list-decimal pl-5 text-[13px] text-primary" {...props}>
      {children}
    </ol>
  ),
  /** Inline code — no wrapping `pre` */
  code: ({ children, ...props }: { children?: ReactNode } & React.HTMLAttributes<HTMLElement>) => (
    <code
      className="rounded bg-input px-1 py-0.5 font-mono text-[12px] text-tool"
      {...props}
    >
      {children}
    </code>
  ),
  /** Block code — react-markdown wraps fenced blocks in `pre > code` */
  pre: ({ children, ...props }) => (
    <pre
      className="mb-3 overflow-x-auto rounded border border-edge-soft bg-input p-3 font-mono text-[12px] text-primary"
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="mb-2 border-l-4 border-edge pl-4 text-[13px] text-secondary"
      {...props}
    >
      {children}
    </blockquote>
  ),
  table: ({ children, ...props }) => (
    <div className="mb-3 overflow-x-auto">
      <table
        className="w-full border-collapse text-[12px] text-primary"
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th
      className="border border-edge bg-chip px-3 py-1.5 text-left font-semibold text-secondary"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border border-edge-soft px-3 py-1.5 text-primary" {...props}>
      {children}
    </td>
  ),
};

interface Props {
  source: string;
}

export function MarkdownBody({ source }: Props) {
  return (
    <div className="prose-tight max-w-none text-[13px] text-primary">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  );
}
