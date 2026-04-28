import React, {
  cloneElement,
  isValidElement,
  ReactElement,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

// Custom tooltip — replaces the OS-default `title=` attribute which on
// macOS truncates to ~250px on a single line. Renders in a portal so it
// can overflow tight parent containers (table cells, sidebar list items),
// supports multi-line word-wrap, and shows after a short delay to avoid
// flickering during quick mouse passes.

const SHOW_DELAY_MS = 250;
const MAX_WIDTH = 480;

type Props = {
  content: ReactNode;
  children: ReactElement<{
    ref?: React.Ref<HTMLElement>;
    onMouseEnter?: (e: React.MouseEvent) => void;
    onMouseLeave?: (e: React.MouseEvent) => void;
    onFocus?: (e: React.FocusEvent) => void;
    onBlur?: (e: React.FocusEvent) => void;
  }>;
  // Keep the bubble pinned to the parent's coordinate system. Default is
  // 'top' (above), with auto-flip to 'bottom' if there's no room.
  placement?: 'top' | 'bottom';
};

export function Tooltip({ content, children, placement = 'top' }: Props) {
  const [shown, setShown] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; flipped: boolean }>({
    x: 0,
    y: 0,
    flipped: false,
  });
  const triggerRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const open = () => {
    cancelTimer();
    timerRef.current = setTimeout(() => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Default: bubble above the trigger, horizontally centered.
      const wantTop = placement === 'top';
      const flipped = wantTop ? r.top < 80 : r.bottom > window.innerHeight - 80;
      const useTop = wantTop ? !flipped : flipped;
      setPos({
        x: r.left + r.width / 2,
        y: useTop ? r.top - 6 : r.bottom + 6,
        flipped: !useTop,
      });
      setShown(true);
    }, SHOW_DELAY_MS);
  };

  const close = () => {
    cancelTimer();
    setShown(false);
  };

  useEffect(() => () => cancelTimer(), []);

  if (!isValidElement(children)) return children as unknown as ReactElement;
  if (content == null || content === '') return children;

  const merged = cloneElement(children, {
    ref: (el: HTMLElement | null) => {
      triggerRef.current = el;
      // Forward to the original ref if any (string, function, or RefObject).
      const prev = (children as ReactElement<{ ref?: React.Ref<HTMLElement> }>).props.ref;
      if (typeof prev === 'function') prev(el);
      else if (prev && typeof prev === 'object') {
        (prev as React.MutableRefObject<HTMLElement | null>).current = el;
      }
    },
    onMouseEnter: (e: React.MouseEvent) => {
      open();
      children.props.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      close();
      children.props.onMouseLeave?.(e);
    },
    onFocus: (e: React.FocusEvent) => {
      open();
      children.props.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      close();
      children.props.onBlur?.(e);
    },
  });

  return (
    <>
      {merged}
      {shown &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.y,
              left: pos.x,
              transform: pos.flipped
                ? 'translate(-50%, 0)'
                : 'translate(-50%, -100%)',
              maxWidth: MAX_WIDTH,
              padding: '8px 12px',
              background: 'rgba(34, 31, 26, 0.96)',
              color: '#f5f1e6',
              borderRadius: 7,
              border: '1px solid rgba(255, 255, 255, 0.06)',
              fontSize: 12,
              lineHeight: 1.5,
              zIndex: 10000,
              pointerEvents: 'none',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
              boxShadow:
                '0 12px 28px rgba(0, 0, 0, 0.32), 0 4px 8px rgba(0, 0, 0, 0.18)',
              animation: 'qbo-tip-in 120ms ease-out',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
      <style>{`
        @keyframes qbo-tip-in {
          from { opacity: 0; transform: translate(-50%, ${pos.flipped ? '4px' : 'calc(-100% + 4px)'}); }
          to   { opacity: 1; transform: translate(-50%, ${pos.flipped ? '0' : '-100%'}); }
        }
      `}</style>
    </>
  );
}
