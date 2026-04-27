/** PhoneChatDetail — wrapper for the chat thread + composer at phone
 *  breakpoint (M36).
 *
 *  Renders: back-arrow + title + (children = thread + composer).
 *  No tab strip, no secondary panes, no resource readout. Composer
 *  variant is handled by ChatComposer's own breakpoint logic (T8).
 *
 *  PhoneTabBar is hidden when this view is mounted (App.tsx).
 */
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  onBack: () => void;
  children: ReactNode;
}

export function PhoneChatDetail({ title, onBack, children }: Props) {
  return (
    <div className="bg-page flex h-full flex-col">
      <header className="border-edge bg-pane flex items-center gap-2 border-b px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to chat list"
          className="text-secondary hover:text-primary flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <h1 className="text-primary flex-1 truncate text-[14px] font-semibold">{title}</h1>
      </header>
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
