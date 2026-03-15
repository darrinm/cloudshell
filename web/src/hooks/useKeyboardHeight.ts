import { useEffect, useState } from 'react';

export const IS_TOUCH = 'ontouchstart' in window;

const KEYBOARD_THRESHOLD = 100;

/**
 * Track mobile keyboard height via the visualViewport API.
 * Returns 0 when no keyboard is visible.
 */
export function useKeyboardHeight(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (!IS_TOUCH || !window.visualViewport) return;
    const vv = window.visualViewport;
    let baselineHeight = vv.height;
    const onResize = () => {
      if (vv.height > baselineHeight) baselineHeight = vv.height;
      const kbHeight = Math.max(0, baselineHeight - vv.height);
      if (kbHeight <= KEYBOARD_THRESHOLD) {
        baselineHeight = vv.height;
        setKeyboardHeight(0);
      } else {
        setKeyboardHeight(kbHeight);
      }
      window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, []);

  return keyboardHeight;
}
