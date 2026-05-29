import { useEffect, useCallback } from 'react';

export function useMobileViewport() {
  const updateViewportHeight = useCallback(() => {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);

    if (window.visualViewport) {
      const vvHeight = window.visualViewport.height;
      document.documentElement.style.setProperty('--vvh', `${vvHeight}px`);
      
      const isKeyboardOpen = vvHeight < window.innerHeight * 0.75;
      document.documentElement.classList.toggle('keyboard-open', isKeyboardOpen);
    }
  }, []);

  useEffect(() => {
    updateViewportHeight();

    const handleResize = () => {
      requestAnimationFrame(updateViewportHeight);
    };

    const handleOrientationChange = () => {
      setTimeout(updateViewportHeight, 150);
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.contentEditable === 'true'
      ) {
        setTimeout(() => {
          if (window.visualViewport) {
            const targetRect = target.getBoundingClientRect();
            const viewportHeight = window.visualViewport.height;
            const offsetTop = targetRect.top + (window.scrollY || document.documentElement.scrollTop);
            
            if (targetRect.bottom > viewportHeight * 0.9) {
              const scrollTarget = offsetTop - (viewportHeight * 0.3);
              window.scrollTo({
                top: Math.max(0, scrollTarget),
                behavior: 'smooth'
              });
            }
          }
        }, 100);
      }
    };

    const handleFocusOut = () => {
      setTimeout(() => {
        updateViewportHeight();
      }, 100);
    };

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('orientationchange', handleOrientationChange);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    if (window.visualViewport) {
      const handleVisualViewportResize = () => {
        requestAnimationFrame(updateViewportHeight);
      };
      const handleVisualViewportScroll = () => {
        requestAnimationFrame(updateViewportHeight);
      };
      
      window.visualViewport.addEventListener('resize', handleVisualViewportResize);
      window.visualViewport.addEventListener('scroll', handleVisualViewportScroll);
      
      return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('orientationchange', handleOrientationChange);
        document.removeEventListener('focusin', handleFocusIn);
        document.removeEventListener('focusout', handleFocusOut);
        window.visualViewport?.removeEventListener('resize', handleVisualViewportResize);
        window.visualViewport?.removeEventListener('scroll', handleVisualViewportScroll);
      };
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, [updateViewportHeight]);

  return null;
}
