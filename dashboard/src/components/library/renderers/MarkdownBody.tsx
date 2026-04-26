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
 * distinguished by the `className` prop: remark-gfm sets
 * `className="language-<lang>"` on fenced code blocks; bare inline code
 * has no className.  We branch on that to avoid the chip styling leaking
 * into fenced-block chrome.
 */
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="text-primary mt-5 mb-3 text-[20px] font-semibold" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="text-primary mt-4 mb-2 text-[16px] font-semibold" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-secondary mt-3 mb-1.5 text-[14px] font-semibold" {...props}>
      {children}
    </h3>
  ),
  p: ({ children, ...props }) => (
    <p className="text-primary mb-2 text-[13px] leading-relaxed" {...props}>
      {children}
    </p>
  ),
  a: (props) => (
    <a
      className="text-accent hover:text-claude underline"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: ({ children, ...props }) => (
    <ul className="text-primary mb-2 list-disc pl-5 text-[13px]" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="text-primary mb-2 list-decimal pl-5 text-[13px]" {...props}>
      {children}
    </ol>
  ),
  /**
   * Inline vs fenced code: remark-gfm sets `className="language-<lang>"` on
   * fenced blocks.  Bare inline code has no className.  Branch here so the
   * chip styling does NOT leak into the `pre` chrome for fenced blocks.
   */
  code: ({ className, children, ...props }) => {
    // Fenced code blocks (```ts, ```python, etc.) get a language-* class.
    // Render those as a bare <code> so the surrounding <pre> override
    // owns the chrome.  Inline code (no className) keeps the chip styling.
    if (className?.startsWith("language-")) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="bg-input text-tool rounded px-1 py-0.5 font-mono text-[12px]" {...props}>
        {children}
      </code>
    );
  },
  /** Block code — react-markdown wraps fenced blocks in `pre > code` */
  pre: ({ children, ...props }) => (
    <pre
      className="border-edge-soft bg-input text-primary mb-3 overflow-x-auto rounded border p-3 font-mono text-[12px]"
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="border-edge text-secondary mb-2 border-l-4 pl-4 text-[13px]" {...props}>
      {children}
    </blockquote>
  ),
  table: ({ children, ...props }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="text-primary w-full border-collapse text-[12px]" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th
      className="border-edge bg-chip text-secondary border px-3 py-1.5 text-left font-semibold"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border-edge-soft text-primary border px-3 py-1.5" {...props}>
      {children}
    </td>
  ),
};

interface Props {
  source: string;
}

export function MarkdownBody({ source }: Props) {
  return (
    <div className="prose-tight text-primary max-w-none text-[13px]">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  );
}
