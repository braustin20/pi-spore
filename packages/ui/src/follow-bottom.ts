import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Keeps a scrolling list at its bottom. Put `ref` and `onScroll` on the list's box.
 * Follow new output only while the reader is already at the bottom.
 * `toBottom` moves the reader down, for example when they send a message.
 */
export function useFollowBottom(): {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Go to the bottom on the next render, and follow from there. */
  toBottom: () => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const box = ref.current;
    if (box) stick.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
  };
  useLayoutEffect(() => {
    const box = ref.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  });
  const toBottom = () => {
    stick.current = true;
  };
  return { ref, onScroll, toBottom };
}
