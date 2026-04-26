/** useLongPress — touch long-press detector (M36).
 *
 *  Returns event handlers to spread onto the target element. Fires
 *  the callback after the user holds for `delayMs` (default 500ms).
 *  touchMove cancels (so a scroll gesture doesn't trigger).
 *
 *  Default-export shape returns the three handlers as a plain object;
 *  callers spread them: `<div {...useLongPress(onLP)} />`.
 *
 *  T15 will wire this into the MessageActions consumer sites
 *  (MessageUser, MessageAssistantText, etc.) per the M36 spec
 *  ("long-press on any message → bottom action sheet").
 */
import { useRef } from "react";

interface Options {
  delayMs?: number;
}

export interface LongPressHandlers {
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
}

export function useLongPress(callback: () => void, options: Options = {}): LongPressHandlers {
  const { delayMs = 500 } = options;
  const timerRef = useRef<number | null>(null);

  const cancel = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const onTouchStart = () => {
    cancel();
    timerRef.current = window.setTimeout(() => {
      callback();
      timerRef.current = null;
    }, delayMs);
  };

  return {
    onTouchStart,
    onTouchEnd: cancel,
    onTouchMove: cancel,
  };
}
